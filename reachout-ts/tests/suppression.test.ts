import { describe, expect, it } from 'vitest';
import { Suppression } from '@/lib/suppression';
import { db } from '@/lib/db';
import { suppressions } from '@/lib/db/schema';

describe('Suppression', () => {
  it('blocks an exact address added with add()', () => {
    Suppression.add('Owner@Biz.test');
    expect(Suppression.blocks('owner@biz.test')).toBe(true);
  });

  it('blocks the whole domain after add()', () => {
    Suppression.add('owner@domain-blocked.test');
    expect(Suppression.blocks('anything@domain-blocked.test')).toBe(true);
  });

  it('addAddress blocks only the address, not the domain', () => {
    Suppression.addAddress('sole@addronly.test');
    expect(Suppression.blocks('sole@addronly.test')).toBe(true);
    expect(Suppression.blocks('other@addronly.test')).toBe(false);
  });

  it('blocks a forgotten address by hash', () => {
    Suppression.addHashed('ghost@hashed.test');
    expect(Suppression.blocks('ghost@hashed.test')).toBe(true);
    // and the plaintext is not stored
    const row = db().select().from(suppressions).all().find((r) => r.emailHash === Suppression.hash('ghost@hashed.test'));
    expect(row?.email).toBeNull();
  });

  it('does not block unrelated addresses', () => {
    expect(Suppression.blocks('free@clear.test')).toBe(false);
    expect(Suppression.blocks(null)).toBe(false);
    expect(Suppression.blocks('')).toBe(false);
  });
});
