import { config } from '../../config';
import { OverpassClient } from '../../discovery/overpass';
import { ResilientHttp, Resp, CircuitOpen } from '../../http';
import { ApiBudgetExceeded } from '../../usage';
import { Tool, ToolResult } from './base';

export class SearchPlacesTool extends Tool {
  name() { return 'search_places'; }
  description() {
    return 'Search public map data (OpenStreetMap by default, Google Places when configured) for businesses of one category in one city from the profile. Returns name, address, phone, website and email only when publicly listed. Coverage of small Philippine shops is patchy.';
  }
  parameters() {
    return {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Business category, e.g. "restaurant". Must be one of the profile categories.' },
        city: { type: 'string', description: 'City or municipality. Must be one of the profile cities.' },
      },
      required: ['category', 'city'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const category = String(args['category'] ?? '').trim();
    const city = String(args['city'] ?? '').trim();

    // Guardrail: only profile categories and cities (Philippines only).
    if (!this.profile.cities.map((c) => c.toLowerCase()).includes(city.toLowerCase())) {
      return this.error('City is not in this profile. Allowed: ' + this.profile.cities.join(', '));
    }
    if (!this.profile.categories.map((c) => c.toLowerCase()).includes(category.toLowerCase())) {
      return this.error('Category is not in this profile. Allowed: ' + this.profile.categories.join(', '));
    }

    if (config.discovery.provider !== 'google') {
      return new OverpassClient().search(category, city);
    }

    const key = config.places.apiKey;
    if (!key) return this.error('DISCOVERY_PROVIDER=google requires PLACES_API_KEY.');

    let response: Resp;
    try {
      response = await ResilientHttp.request('places', async () => {
        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ textQuery: `${category} in ${city}, Philippines`, regionCode: 'PH', maxResultCount: 10 }),
          signal: AbortSignal.timeout(15000),
        });
        return Resp.from(res);
      });
    } catch (e) {
      if (e instanceof ApiBudgetExceeded) return this.budget(e.message);
      if (e instanceof CircuitOpen) return this.error('Places temporarily unavailable (circuit open).');
      return this.error('Places request failed.');
    }
    if (response.failed()) return this.error(`Places API returned HTTP ${response.status}`);

    const results: Record<string, unknown>[] = [];
    const places = (response.json('places') ?? []) as Array<Record<string, any>>;
    for (const place of places) {
      const address = String(place['formattedAddress'] ?? '');
      if (!address.toLowerCase().includes('philippines')) continue; // PH-only guardrail
      results.push({
        place_id: place['id'] ?? null,
        name: place['displayName']?.['text'] ?? null,
        category: place['primaryTypeDisplayName']?.['text'] ?? category,
        address,
        city,
        phone: place['nationalPhoneNumber'] ?? null,
        website_url: place['websiteUri'] ?? null,
      });
    }
    return { ok: true, count: results.length, places: results };
  }
}
