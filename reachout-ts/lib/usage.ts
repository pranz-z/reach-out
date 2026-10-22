import { sql } from 'drizzle-orm';
import { apiUsage } from './db/schema';
import { db } from './db';
import { config, ts, todayManila } from './config';

/** Port of ApiUsage — daily per-service call counts + token budgets. */
export const ApiUsage = {
  recordCall(service: string, n = 1) {
    bump(service, n, 0);
  },

  recordTokens(service: string, tokens: number) {
    if (tokens > 0) bump(service, 1, tokens);
  },

  used(service: string): { count: number; tokens: number } {
    const row = db().select().from(apiUsage)
      .where(sql`${apiUsage.service} = ${service} AND ${apiUsage.date} = ${todayManila()}`)
      .get();
    return { count: row?.count ?? 0, tokens: row?.tokens ?? 0 };
  },

  callsExhausted(service: string): boolean {
    const budget = config.budgets[service] ?? 0;
    return budget > 0 && ApiUsage.used(service).count >= budget;
  },

  tokensExhausted(service: string): boolean {
    const budget = config.tokenBudgets[service] ?? 0;
    return budget > 0 && ApiUsage.used(service).tokens >= budget;
  },

  summary(): Record<string, { used: number; tokens: number; budget: number }> {
    const out: Record<string, { used: number; tokens: number; budget: number }> = {};
    for (const service of Object.keys(config.budgets)) {
      const u = ApiUsage.used(service);
      out[service] = { used: u.count, tokens: u.tokens, budget: config.budgets[service] };
    }
    return out;
  },
};

function bump(service: string, calls: number, tokens: number) {
  db().run(sql`
    INSERT INTO api_usage (service, date, count, tokens, created_at, updated_at)
    VALUES (${service}, ${todayManila()}, ${calls}, ${tokens}, ${ts()}, ${ts()})
    ON CONFLICT(service, date) DO UPDATE SET
      count = count + ${calls}, tokens = tokens + ${tokens}, updated_at = ${ts()}
  `);
}

export class ApiBudgetExceeded extends Error {
  constructor(public service: string) {
    super(`Daily API budget reached for ${service}.`);
    this.name = 'ApiBudgetExceeded';
  }
}
