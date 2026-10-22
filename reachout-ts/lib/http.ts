import { eq } from 'drizzle-orm';
import { settings } from './db/schema';
import { db } from './db';
import { config, ts } from './config';
import { ApiUsage, ApiBudgetExceeded } from './usage';

/** Minimal response wrapper mirroring the bits of Laravel's Response we use. */
export class Resp {
  constructor(
    public status: number,
    public body: string,
    private headers: Headers,
  ) {}

  static async from(res: Response): Promise<Resp> {
    return new Resp(res.status, await res.text(), res.headers);
  }

  ok(): boolean { return this.status >= 200 && this.status < 300; }
  failed(): boolean { return !this.ok(); }
  serverError(): boolean { return this.status >= 500; }
  header(name: string): string | null { return this.headers.get(name); }
  json(path?: string): unknown {
    const data = JSON.parse(this.body) as unknown;
    if (!path) return data;
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc === null || typeof acc !== 'object') return undefined;
      const idx = /^\d+$/.test(key) ? Number(key) : key;
      return (acc as Record<string | number, unknown>)[idx];
    }, data);
  }
}

export class CircuitOpen extends Error {
  constructor(service: string, until: number) {
    super(`Circuit open for ${service} until ${new Date(until * 1000).toISOString()}`);
    this.name = 'CircuitOpen';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Port of ResilientHttp: per-service daily call budget, retries on
 * 429/5xx/network errors with backoff + jitter honouring Retry-After,
 * and a circuit breaker persisted in the settings table.
 */
export class ResilientHttp {
  static async request(service: string, send: () => Promise<Resp>): Promise<Resp> {
    if (ApiUsage.callsExhausted(service)) {
      throw new ApiBudgetExceeded(service);
    }
    const openUntil = getSetting(`breaker:${service}:open_until`);
    if (openUntil && Number(openUntil) * 1000 > Date.now()) {
      throw new CircuitOpen(service, Number(openUntil));
    }

    const maxAttempts = config.resilience.maxAttempts;
    let last: Resp | Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleepBefore(last, attempt);
      }

      let response: Resp;
      try {
        response = await send();
      } catch (e) {
        ApiUsage.recordCall(service); // the attempt still hit the wire
        last = e instanceof Error ? e : new Error(String(e));
        recordFailure(service);
        continue;
      }

      ApiUsage.recordCall(service);

      if (response.ok() || !(response.status === 429 || response.serverError())) {
        recordSuccess(service);
        return response;
      }

      last = response;
      recordFailure(service);
    }

    recordSuccess(service);
    if (last instanceof Resp) return last;
    throw last ?? new Error(`${service} request failed`);
  }
}

async function sleepBefore(last: Resp | Error | null, attempt: number): Promise<void> {
  let delayMs: number | null = null;
  if (last instanceof Resp) {
    const ra = retryAfterSeconds(last);
    if (ra !== null) delayMs = Math.min(ra, config.resilience.retryAfterCap) * 1000;
  }
  delayMs ??= 500 * 2 ** (attempt - 2) + Math.floor(Math.random() * 250);
  await sleep(delayMs);
}

function retryAfterSeconds(res: Resp): number | null {
  const h = res.header('Retry-After');
  if (!h) return null;
  if (/^\d+$/.test(h)) return Number(h);
  const ts = Date.parse(h);
  return Number.isNaN(ts) ? null : Math.max(0, Math.round((ts - Date.now()) / 1000));
}

function recordSuccess(service: string): void {
  delSetting(`breaker:${service}:fails`);
}

function recordFailure(service: string): void {
  const fails = Number(getSetting(`breaker:${service}:fails`) ?? 0) + 1;
  if (fails >= config.resilience.breakerFailures) {
    setSetting(`breaker:${service}:open_until`, String(Math.floor(Date.now() / 1000) + config.resilience.breakerSeconds));
    delSetting(`breaker:${service}:fails`);
  } else {
    setSetting(`breaker:${service}:fails`, String(fails));
  }
}

function getSetting(key: string): string | null {
  return db().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db().insert(settings).values({ key, value, createdAt: ts(), updatedAt: ts() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: ts() } }).run();
}

export function delSetting(key: string): void {
  db().delete(settings).where(eq(settings.key, key)).run();
}
