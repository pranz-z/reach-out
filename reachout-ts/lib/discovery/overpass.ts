import { eq } from 'drizzle-orm';
import { discoveryCache } from '../db/schema';
import { db } from '../db';
import { config, ts } from '../config';
import { ResilientHttp, Resp, CircuitOpen } from '../http';
import { ApiBudgetExceeded } from '../usage';

type OsmTags = Record<string, string | undefined>;

export interface OsmPlace {
  place_id: string;
  name: string;
  category: string;
  address: string | null;
  city: string;
  phone: string | null;
  website_url: string | null;
  email: string | null;
}

export interface OsmSearchResult extends Record<string, unknown> {
  ok: boolean;
  error?: string;
  budget?: boolean;
  count?: number;
  cached?: boolean;
  note?: string;
  places?: OsmPlace[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Port of OverpassClient — free lead discovery via OpenStreetMap.
 * Two-phase city matching: resolve the city's admin relation once
 * (preferring the one inside DISCOVERY_PROVINCE), then scan nwr inside
 * that single area. Caches per category+city and per city-area.
 */
export class OverpassClient {
  async search(category: string, city: string): Promise<OsmSearchResult> {
    const key = `osm:${category.toLowerCase()}:${city.toLowerCase()}`;
    const hours = config.discovery.overpass.cacheHours;
    const cached = cacheGet<OsmSearchResult>(key);
    if (cached) return { ...cached, cached: true };

    const tag = this.tagFor(category);
    if (!tag) return { ok: false, error: `No OSM tag mapping for category '${category}'.` };

    const areaId = await this.resolveCityArea(city);
    if (areaId !== null && typeof areaId === 'object') return areaId; // transport failure — real error
    if (!areaId) return { ok: false, error: `Could not locate an OSM admin area for '${city}' in the Philippines.` };

    const [tagKey, tagVal] = tag.split('=', 2);
    const query = `[out:json][timeout:25];\nnwr["${tagKey}"="${tagVal}"](area:${areaId});\nout tags center ${config.discovery.overpass.limit};`;

    const response = await this.post(query);
    if (!(response instanceof Resp)) return response;
    if (response.failed()) return { ok: false, error: `Overpass returned HTTP ${response.status}` };

    const places: OsmPlace[] = [];
    const elements = (response.json('elements') ?? []) as Array<{ type: string; id: number; tags?: OsmTags }>;
    for (const el of elements) {
      const tags = el.tags ?? {};
      const name = (tags['name'] ?? '').trim();
      if (name === '') continue; // an unnamed node is useless as a lead
      places.push({
        place_id: `${el.type}/${el.id}`,
        name,
        category,
        address: this.address(tags),
        city,
        phone: tags['contact:phone'] ?? tags['phone'] ?? null,
        website_url: tags['contact:website'] ?? tags['website'] ?? tags['url'] ?? null,
        email: tags['contact:email'] ?? tags['email'] ?? null,
      });
    }

    const result: OsmSearchResult = { ok: true, count: places.length, places, cached: false };
    if (places.length === 0) {
      result.note = 'OSM has few mapped businesses here — try another category/city or rely on CSV import.';
    } else if (places.every((p) => !p.email && !p.website_url)) {
      result.note = 'Results have no published email or website. Still save the best fits with save_lead (phone-only) — do not give up.';
    }
    cachePut(key, result, hours);
    return result;
  }

  /**
   * City name → Overpass area id (3600000000 + relation id), null when no
   * relation matches, or an error object on transport failure.
   */
  private async resolveCityArea(city: string): Promise<number | OsmSearchResult | null> {
    const cacheKey = `osm:area:${city.toLowerCase()}`;
    const cached = cacheGet<{ area_id?: number }>(cacheKey);
    if (cached) return cached.area_id ?? null;

    const esc = city.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const query = `[out:json][timeout:20];\narea["ISO3166-1"="PH"][admin_level="2"]->.ph;\nrel["name"~"^(${esc}|City of ${esc})$"]["boundary"="administrative"]["admin_level"~"^[4567]$"](area.ph);\nout tags 6;`;

    const response = await this.post(query);
    if (!(response instanceof Resp)) return response;
    if (response.failed()) return null;

    let best: { id: number; score: number } | null = null;
    const elements = (response.json('elements') ?? []) as Array<{ type?: string; id: number; tags?: OsmTags }>;
    for (const el of elements) {
      if (el.type !== 'relation') continue;
      const t = el.tags ?? {};
      const inside = Object.entries(t).some(([k, v]) => k.startsWith('is_in') && typeof v === 'string' && v.toLowerCase().includes(config.discovery.province.toLowerCase()));
      const level = Number(t['admin_level'] ?? 9);
      const score = (inside ? 0 : 100) + (level >= 5 ? level : 10);
      if (best === null || score < best.score) best = { id: el.id, score };
    }
    if (!best) return null;

    const areaId = 3600000000 + best.id;
    cachePut(cacheKey, { area_id: areaId }, 24 * 30);
    return areaId;
  }

  /** Try each configured Overpass endpoint in turn. */
  private async post(query: string): Promise<Resp | OsmSearchResult> {
    await this.courtesyDelay();
    let lastErr = 'Overpass request failed.';
    for (const url of config.discovery.overpass.urls) {
      try {
        const response = await ResilientHttp.request('osm', async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'User-Agent': config.http.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`,
            signal: AbortSignal.timeout(45000),
          });
          return Resp.from(res);
        });
        if (response.ok()) return response;
        if (response.status < 500) return response; // 4xx = our query is wrong; a mirror won't help
        lastErr = `Overpass returned HTTP ${response.status}`;
      } catch (e) {
        if (e instanceof ApiBudgetExceeded) return { ok: false, error: e.message, budget: true };
        if (e instanceof CircuitOpen) return { ok: false, error: 'Overpass temporarily unavailable (circuit open).' };
        lastErr = 'Overpass request failed (timeout/connection).';
      }
    }
    return { ok: false, error: lastErr };
  }

  /** Profile category → OSM tag via config, or amenity=<word> fallback. */
  private tagFor(category: string): string | null {
    const norm = category.trim().toLowerCase();
    const mapped = config.discovery.osmCategoryMap[norm];
    if (mapped) return mapped;
    return /^[a-z][a-z _-]*$/i.test(norm) ? 'amenity=' + norm.replace(/ /g, '_') : null;
  }

  private address(tags: OsmTags): string | null {
    const parts = [
      `${tags['addr:housenumber'] ?? ''} ${tags['addr:street'] ?? ''}`.trim(),
      tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'],
      tags['addr:province'],
    ].filter(Boolean);
    const base = tags['addr:full'] || parts.join(', ');
    return base !== '' ? `${base.replace(/[ ,]+$/, '')}, Philippines` : 'Philippines';
  }

  private async courtesyDelay(): Promise<void> {
    const ms = config.discovery.overpass.minDelayMs;
    if (ms > 0 && process.env.NODE_ENV !== 'test') await sleep(ms);
  }
}

function cacheGet<T>(key: string): T | null {
  const row = db().select().from(discoveryCache).where(eq(discoveryCache.key, key)).get();
  if (!row || new Date(row.expiresAt.replace(' ', 'T') + 'Z').getTime() <= Date.now()) return null;
  return row.payload as T;
}

function cachePut(key: string, payload: unknown, hours: number): void {
  const expires = new Date(Date.now() + hours * 3600 * 1000);
  db().insert(discoveryCache).values({
    key, payload, expiresAt: ts(expires), createdAt: ts(), updatedAt: ts(),
  }).onConflictDoUpdate({ target: discoveryCache.key, set: { payload, expiresAt: ts(expires), updatedAt: ts() } }).run();
}
