import { eq } from 'drizzle-orm';
import { settings } from './db/schema';
import { db } from './db';
import { ts } from './config';

/** Key/value store backed by the settings table — same as Laravel's Setting model. */
export const Setting = {
  get(key: string): string | null {
    const row = db().select().from(settings).where(eq(settings.key, key)).get();
    return row?.value ?? null;
  },

  set(key: string, value: string | null): void {
    db().insert(settings).values({ key, value, createdAt: ts(), updatedAt: ts() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: ts() } })
      .run();
  },

  bool(key: string): boolean {
    const v = this.get(key);
    return v === '1' || v === 'true';
  },

  setBool(key: string, on: boolean): void {
    this.set(key, on ? '1' : '0');
  },
};
