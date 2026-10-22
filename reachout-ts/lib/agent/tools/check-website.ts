import { SafeFetcher } from '../../discovery/safe-fetcher';
import { Tool, ToolResult } from './base';

const STATUSES_BLOCK = new Set(['disallowed_by_robots_txt', 'blocked_private_address', 'invalid_url']);

export class CheckWebsiteTool extends Tool {
  name() { return 'check_website'; }
  description() {
    return "Classify a business's website from its URL: none, social_only, basic or modern, plus simple signals (https, mobile viewport, online ordering/booking, copyright year). Pass an empty url if the business lists no website.";
  }
  parameters() {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Website URL, or empty string if none is listed.' },
      },
      required: ['url'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = String(args['url'] ?? '').trim();

    if (url === '') return { ok: true, website_status: 'none', signals: {} };
    if (SafeFetcher.isSocial(url)) {
      return { ok: true, website_status: 'social_only', signals: { social_page_only: true } };
    }

    const page = await SafeFetcher.get(url);
    if (!page.ok) {
      // Robots/private-address blocks are not "site is down": report the reason.
      const blocked = STATUSES_BLOCK.has(String(page.error));
      return {
        ok: true,
        website_status: blocked ? 'unknown' : 'social_only',
        signals: { fetch_error: page.error },
      };
    }

    const html = page.body!;
    const signals: Record<string, unknown> = {
      https: url.toLowerCase().startsWith('https://'),
      mobile_viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
      online_ordering_or_booking: /order online|add to cart|book (now|online|an appointment)|reserve a table|checkout/i.test(html),
      latest_year_seen: null as number | null,
    };
    const years = [...html.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,20}((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
    if (years.length) signals['latest_year_seen'] = Math.max(...years);

    const year = (signals['latest_year_seen'] as number | null) ?? 0;
    const score = Number(signals['https']) + Number(signals['mobile_viewport']) + Number(signals['online_ordering_or_booking'])
      + (year >= new Date().getFullYear() - 1 ? 1 : 0);

    return {
      ok: true,
      website_status: score >= 3 ? 'modern' : 'basic',
      signals,
    };
  }
}
