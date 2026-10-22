import { lookup } from 'node:dns/promises';
import { config } from '../config';

export interface FetchPage {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

const BLOCKED_HOSTS = ['facebook.com', 'fb.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com'];

/**
 * Port of SafeFetcher — fetches a business's OWN public website politely:
 * http/https only, refuses private/reserved IPs, respects robots.txt,
 * never touches social platforms.
 */
export const SafeFetcher = {
  isSocial(url?: string | null): boolean {
    const host = SafeFetcher.host(url);
    if (!host) return false;
    return BLOCKED_HOSTS.some((b) => host === b || host.endsWith('.' + b));
  },

  host(url?: string | null): string | null {
    if (!url) return null;
    try {
      const h = new URL(url).hostname;
      return h ? h.toLowerCase().replace(/^www\./i, '') : null;
    } catch {
      return null;
    }
  },

  async get(url: string): Promise<FetchPage> {
    let parts: URL;
    try {
      parts = new URL(url);
    } catch {
      return { ok: false, error: 'invalid_url' };
    }
    if (!['http:', 'https:'].includes(parts.protocol) || !parts.hostname) {
      return { ok: false, error: 'invalid_url' };
    }
    if (SafeFetcher.isSocial(url)) {
      return { ok: false, error: 'social_platform_not_fetched' };
    }
    if (!(await publicHost(parts.hostname))) {
      return { ok: false, error: 'blocked_private_address' };
    }
    if (!(await allowedByRobots(parts))) {
      return { ok: false, error: 'disallowed_by_robots_txt' };
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': config.http.userAgent },
        signal: AbortSignal.timeout(config.http.timeout * 1000),
        redirect: 'follow',
      });
    } catch {
      return { ok: false, error: 'fetch_failed' };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `http_${response.status}` };
    }
    return { ok: true, status: response.status, body: (await response.text()).slice(0, 400000) };
  },
};

/** Host must resolve to a public IP — SSRF guard. */
async function publicHost(host: string): Promise<boolean> {
  try {
    const { address } = await lookup(host);
    return !isNonPublicIp(address);
  } catch {
    return false; // did not resolve
  }
}

/** Private/reserved ranges: RFC1918, loopback, link-local, CGNAT, multicast, IPv6 ULA/loopback/link-local. */
function isNonPublicIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')
      || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('ff'); // link-local, ULA, multicast
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Minimal robots.txt check for the '*' user-agent. Unreachable = allowed. */
async function allowedByRobots(parts: URL): Promise<boolean> {
  const origin = parts.origin;
  const path = parts.pathname || '/';
  let res: Response;
  try {
    res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': config.http.userAgent },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return true;
  }
  if (!res.ok) return true;

  let applies = false;
  for (const raw of (await res.text()).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line.includes(':')) continue;
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (key.trim().toLowerCase() === 'user-agent') {
      applies = value === '*';
    } else if (applies && key.trim().toLowerCase() === 'disallow' && value !== '' && path.startsWith(value)) {
      return false;
    }
  }
  return true;
}
