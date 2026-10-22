import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { suppressions } from './db/schema';
import { db } from './db';
import { ts } from './config';

/** Port of the Suppression model — exact email, domain, and SHA-256 hash checks. */
export const Suppression = {
  hash(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  },

  /** True if the address (exact or its domain, plaintext or hashed) is opted out. */
  blocks(email?: string | null): boolean {
    if (!email) return false;
    const addr = email.trim().toLowerCase();
    const domain = addr.split('@')[1] ?? '';
    const hash = Suppression.hash(addr);

    const d = db();
    if (Suppression.exists('email', addr)) return true;
    if (Suppression.exists('emailHash', hash)) return true;
    // Domain rules live on their own row (email IS NULL); the domain
    // column on an address row is informational only.
    if (domain !== '' && Suppression.domainBlocked(domain)) return true;
    return false;
  },

  /** Add an address and its domain to the list. */
  add(email: string, reason = 'opt-out') {
    const addr = email.trim().toLowerCase();
    const domain = addr.split('@')[1] ?? '';
    if (!Suppression.exists('email', addr)) {
      insert({ email: addr, domain: domain || null, reason });
    }
    if (domain !== '' && !Suppression.domainBlocked(domain)) {
      insert({ email: null, domain, reason });
    }
  },

  /**
   * Suppress only this address — used for bounces we could not fully
   * decode, where blocking a whole domain would overreach.
   */
  addAddress(email: string, reason = 'bounce') {
    const addr = email.trim().toLowerCase();
    const domain = addr.split('@')[1] ?? '';
    if (!Suppression.exists('email', addr)) {
      insert({ email: addr, domain: domain || null, reason });
    }
  },

  addHashed(email: string, reason = 'forgotten opt-out') {
    const addr = email.trim().toLowerCase();
    db().delete(suppressions).where(eq(suppressions.email, addr)).run();
    const hash = Suppression.hash(addr);
    if (!Suppression.exists('emailHash', hash)) {
      insert({ email: null, emailHash: hash, domain: null, reason });
    }
  },

  addDomain(domain: string, reason = 'opt-out') {
    const d = domain.trim().toLowerCase();
    if (!Suppression.domainBlocked(d)) {
      insert({ email: null, domain: d, reason });
    }
  },

  exists(col: 'email' | 'emailHash', value: string): boolean {
    return db().select({ id: suppressions.id }).from(suppressions)
      .where(eq(suppressions[col], value)).limit(1).all().length > 0;
  },

  /** A domain-only row exists (an address row carrying the domain doesn't count here). */
  domainBlocked(domain: string): boolean {
    return db().select({ id: suppressions.id }).from(suppressions)
      .where(and(eq(suppressions.domain, domain), isNullEmail())).limit(1).all().length > 0;
  },
};

function isNullEmail() {
  return sql`${suppressions.email} IS NULL`;
}

function insert(row: { email: string | null; emailHash?: string; domain: string | null; reason: string }) {
  db().insert(suppressions).values({ ...row, createdAt: ts(), updatedAt: ts() }).run();
}
