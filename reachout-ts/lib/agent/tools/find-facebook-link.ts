import { config } from '../../config';
import { ResilientHttp, Resp } from '../../http';
import { ApiBudgetExceeded } from '../../usage';
import { Tool, ToolResult } from './base';

interface SearchItem { url: string; title: string; snippet: string }

/**
 * Finds a likely Facebook page URL through an OFFICIAL search API.
 * Never fetches facebook.com or reads page content — returns a link
 * for the human reviewer to open.
 */
export class FindFacebookLinkTool extends Tool {
  name() { return 'find_facebook_link'; }
  description() {
    return 'Look up a business name in a web search API and return a facebook.com page URL if one matches. Returns URL only, labelled unverified or likely. The page itself is never opened.';
  }
  parameters() {
    return {
      type: 'object',
      properties: {
        name: { type: 'string' },
        city: { type: 'string' },
      },
      required: ['name', 'city'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args['name'] ?? '').trim();
    const city = String(args['city'] ?? '').trim();
    if (name === '') return this.error('name is required');

    const query = `"${name}" ${city} facebook`;
    let items: SearchItem[] | null;
    try {
      items = config.search.provider === 'google'
        ? await this.searchGoogle(query)
        : await this.searchBrave(query);
    } catch (e) {
      if (e instanceof ApiBudgetExceeded) return this.budget(e.message);
      return this.error('Search request failed.');
    }
    if (items === null) return this.error('Search API is not configured (SEARCH_API_KEY).');

    const nameTokens = name.toLowerCase().split(/\W+/u).filter((t) => t.length > 2);

    for (const item of items) {
      let host: string;
      try {
        host = new URL(item.url).hostname.toLowerCase().replace(/^(www|m|web)\./, '');
      } catch { continue; }
      if (host !== 'facebook.com') continue;

      const haystack = `${item.title} ${item.snippet}`.toLowerCase();
      const matched = nameTokens.filter((t) => haystack.includes(t)).length;
      if (nameTokens.length === 0 || matched === 0) continue;
      const allTokens = matched === nameTokens.length;
      const cityHit = city !== '' && haystack.includes(city.toLowerCase());

      return {
        ok: true,
        facebook_url: item.url,
        facebook_confidence: allTokens && cityHit ? 'likely' : 'unverified',
      };
    }

    return { ok: true, facebook_url: null, facebook_confidence: 'none' };
  }

  private async searchBrave(query: string): Promise<SearchItem[] | null> {
    const key = config.search.apiKey;
    if (!key) return null;
    const res = await ResilientHttp.request('search', async () => {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.search = new URLSearchParams({ q: query, count: '10', country: 'PH' }).toString();
      return Resp.from(await fetch(url, {
        headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      }));
    });
    const results = (res.json('web.results') ?? []) as Array<Record<string, string>>;
    return results.map((r) => ({ url: r['url'] ?? '', title: r['title'] ?? '', snippet: r['description'] ?? '' }));
  }

  private async searchGoogle(query: string): Promise<SearchItem[] | null> {
    const key = config.search.apiKey;
    const cx = config.search.engineId;
    if (!key || !cx) return null;
    const res = await ResilientHttp.request('search', async () => {
      const url = new URL('https://www.googleapis.com/customsearch/v1');
      url.search = new URLSearchParams({ key, cx, q: query, num: '10', gl: 'ph' }).toString();
      return Resp.from(await fetch(url, { signal: AbortSignal.timeout(10000) }));
    });
    const items = (res.json('items') ?? []) as Array<Record<string, string>>;
    return items.map((r) => ({ url: r['link'] ?? '', title: r['title'] ?? '', snippet: r['snippet'] ?? '' }));
  }
}
