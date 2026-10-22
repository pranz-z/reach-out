import { Suppression } from '../suppression';
import { SafeFetcher } from './safe-fetcher';

const PATHS = ['', '/contact', '/contact-us', '/about', '/about-us'];

export interface FindResult extends Record<string, unknown> {
  ok: boolean;
  public_email?: string | null;
  email_source?: string;
  reason?: string;
  error?: string;
}

/**
 * Port of PublicEmailFinder — reads a business's OWN website (homepage +
 * common contact pages) for a published email. Never guesses addresses.
 * Shared by the find_public_email tool and the "Add website" action.
 */
export class PublicEmailFinder {
  async find(rawUrl: string): Promise<FindResult> {
    const url = rawUrl.trim();
    if (url === '' || SafeFetcher.isSocial(url)) {
      return { ok: true, public_email: null, reason: 'no_own_website' };
    }

    let parts: URL;
    try {
      parts = new URL(url);
      if (!parts.protocol || !parts.hostname) throw new Error();
    } catch {
      return { ok: false, error: 'invalid url' };
    }
    const origin = parts.origin;
    const siteDomain = SafeFetcher.host(url);

    const found = new Map<string, true>();
    for (const path of PATHS) {
      const page = await SafeFetcher.get(origin + path);
      if (!page.ok || !page.body) continue;
      const html = decodeEntities(page.body);
      for (const m of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
        const email = m[0].toLowerCase();
        if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(email) || email.includes('example.') || email.includes('sentry')) continue;
        found.set(email, true);
      }
      if (found.size) break;
    }

    const emails = [...found.keys()];
    // Prefer an address on the business's own domain, then role-style prefixes.
    emails.sort((a, b) => score(a) - score(b));
    function score(e: string): number {
      return (siteDomain && e.endsWith('@' + siteDomain) ? 0 : 2)
        + (/^(info|sales|contact|hello|admin|enquir|inquir|support|office)/.test(e) ? 0 : 1);
    }

    for (const email of emails) {
      if (Suppression.blocks(email)) continue; // opted out: never surface it
      return { ok: true, public_email: email, email_source: 'website' };
    }

    return { ok: true, public_email: null, reason: 'none_published' };
  }
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#64;/g, '@').replace(/&#x40;/gi, '@')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
