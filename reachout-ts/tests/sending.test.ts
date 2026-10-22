import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { drafts, emails, leads } from '@/lib/db/schema';
import { ts } from '@/lib/config';
import { SendPolicy } from '@/lib/sending/send-policy';
import { Setting } from '@/lib/settings';
import { Suppression } from '@/lib/suppression';
import { sendDraft } from '@/lib/jobs/send-draft';

const BODY = `Hi,
short.

If it's not relevant, just reply STOP and I won't email again.

Franz
https://example.com/portfolio`;

// Monday 2025-06-16 14:00 Asia/Manila = 06:00 UTC — inside the 09–17 window.
const IN_WINDOW = new Date('2025-06-16T06:00:00Z');

function seedLead(over: Partial<typeof leads.$inferInsert> = {}) {
  return Number(db().insert(leads).values({
    name: 'Cafe A', city: 'Guagua', category: 'cafe', status: 'approved',
    publicEmail: 'owner@cafe.test', emailSource: 'manual',
    createdAt: ts(), updatedAt: ts(), ...over,
  }).run().lastInsertRowid);
}

function seedDraft(leadId: number, over: Partial<typeof drafts.$inferInsert> = {}) {
  return Number(db().insert(drafts).values({
    leadId, kind: 'first', subject: 'quick thought', body: BODY,
    status: 'approved', createdAt: ts(), updatedAt: ts(), ...over,
  }).run().lastInsertRowid);
}

afterEach(() => vi.useRealTimers());

describe('SendPolicy window (Asia/Manila)', () => {
  it('Mon–Fri 09–17 is inside; evenings and weekends are outside', () => {
    expect(SendPolicy.withinWindow(IN_WINDOW)).toBe(true);                    // Mon 14:00
    expect(SendPolicy.withinWindow(new Date('2025-06-16T00:30:00Z'))).toBe(false); // Mon 08:30
    expect(SendPolicy.withinWindow(new Date('2025-06-16T10:00:00Z'))).toBe(false); // Mon 18:00
    expect(SendPolicy.withinWindow(new Date('2025-06-21T06:00:00Z'))).toBe(false); // Sat 14:00
    expect(SendPolicy.withinWindow(new Date('2025-06-22T06:00:00Z'))).toBe(false); // Sun 14:00 — was a port bug (Sun=0 < 5)
  });

  it('nextWindowStart skips the weekend', () => {
    // Friday evening → Monday 09:00 Manila = 01:00 UTC.
    const fri = new Date('2025-06-20T12:00:00Z'); // Fri 20:00 Manila
    expect(SendPolicy.nextWindowStart(fri).toISOString()).toBe('2025-06-23T01:00:00.000Z');
    // Same-day before window → today 09:00 Manila.
    const early = new Date('2025-06-16T00:30:00Z'); // Mon 08:30 Manila
    expect(SendPolicy.nextWindowStart(early).toISOString()).toBe('2025-06-16T01:00:00.000Z');
  });
});

describe('SendPolicy caps and compliance', () => {
  it('warm-up ramps: week1 = 5, week2 = 10, then the daily limit', () => {
    expect(SendPolicy.dailyLimit()).toBe(5); // no sends yet → week 1
    const leadId = seedLead();
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    db().insert(emails).values({ leadId, sentAt: daysAgo(8), deliveryStatus: 'sent', createdAt: ts(), updatedAt: ts() }).run();
    expect(SendPolicy.dailyLimit()).toBe(10); // week 2
    db().update(emails).set({ sentAt: daysAgo(20) }).where(eq(emails.leadId, leadId)).run();
    expect(SendPolicy.dailyLimit()).toBe(20); // week 3+ → DAILY_SEND_LIMIT
  });

  it('paused() reads the sending_paused setting', () => {
    expect(SendPolicy.paused()).toBe(false);
    Setting.setBool('sending_paused', true);
    expect(SendPolicy.paused()).toBe(true);
  });

  it('bodyCompliant re-checks opt-out, sender name, and portfolio link', () => {
    expect(SendPolicy.bodyCompliant(BODY)).toBe(true);
    expect(SendPolicy.bodyCompliant(BODY.replace('reply STOP', 'reply something else'))).toBe(false);
    expect(SendPolicy.bodyCompliant(BODY.replace('Franz', 'Someone'))).toBe(false);
    expect(SendPolicy.bodyCompliant(BODY.replace('https://example.com/portfolio', ''))).toBe(false);
  });
});

describe('sendDraft send-time re-checks', () => {
  it('ignores a draft that is not approved', async () => {
    const leadId = seedLead();
    const id = seedDraft(leadId, { status: 'pending' });
    await sendDraft(id);
    expect(db().select().from(emails).where(eq(emails.leadId, leadId)).all()).toHaveLength(0);
  });

  it('cancels the draft and opts out the lead when the address is suppressed', async () => {
    Suppression.add('gone@away.test');
    const leadId = seedLead({ publicEmail: 'gone@away.test', emailSource: 'manual' });
    const draftId = seedDraft(leadId);
    await sendDraft(draftId);
    expect(db().select().from(drafts).where(eq(drafts.id, draftId)).get()?.status).toBe('cancelled');
    expect(db().select().from(leads).where(eq(leads.id, leadId)).get()?.status).toBe('opted_out');
  });

  it('fails when the lead status is not approved (first emails)', async () => {
    const draftId = seedDraft(seedLead({ status: 'drafted' }));
    await sendDraft(draftId);
    const d = db().select().from(drafts).where(eq(drafts.id, draftId)).get()!;
    expect(d.status).toBe('failed');
    expect(d.failureReason).toMatch(/not approved/);
  });

  it('fails a non-compliant body even though it was approved earlier', async () => {
    const draftId = seedDraft(seedLead(), { body: 'no opt-out, no sender, no link' });
    await sendDraft(draftId);
    const d = db().select().from(drafts).where(eq(drafts.id, draftId)).get()!;
    expect(d.status).toBe('failed');
    expect(d.failureReason).toMatch(/opt-out/);
  });

  it('holds (does not fail) when sending is paused', async () => {
    vi.setSystemTime(IN_WINDOW);
    vi.useFakeTimers({ now: IN_WINDOW });
    Setting.setBool('sending_paused', true);
    const leadId = seedLead();
    const draftId = seedDraft(leadId);
    const res = await sendDraft(draftId);
    expect(res).toHaveProperty('held');
    expect(db().select().from(drafts).where(eq(drafts.id, draftId)).get()?.status).toBe('approved');
    expect(db().select().from(emails).where(eq(emails.leadId, leadId)).all()).toHaveLength(0);
  });

  it('holds outside the send window', async () => {
    vi.useFakeTimers({ now: new Date('2025-06-21T06:00:00Z') }); // Saturday
    const leadId = seedLead();
    const draftId = seedDraft(leadId);
    const res = await sendDraft(draftId);
    expect(res).toHaveProperty('held');
    expect(db().select().from(emails).where(eq(emails.leadId, leadId)).all()).toHaveLength(0);
  });

  it('sends via the log mailer: emails row, draft sent, lead sent', async () => {
    vi.useFakeTimers({ now: IN_WINDOW });
    Setting.setBool('sending_paused', false);
    const leadId = seedLead();
    const draftId = seedDraft(leadId);
    await sendDraft(draftId);
    const sent = db().select().from(emails).where(eq(emails.leadId, leadId)).all();
    expect(sent).toHaveLength(1);
    expect(sent[0].messageId).toMatch(/^<.+@.+>$/);
    expect(db().select().from(drafts).where(eq(drafts.id, draftId)).get()?.status).toBe('sent');
    expect(db().select().from(leads).where(eq(leads.id, leadId)).get()?.status).toBe('sent');
  });

  it('refuses a second first email to the same lead', async () => {
    vi.useFakeTimers({ now: IN_WINDOW });
    Setting.setBool('sending_paused', false);
    const leadId = seedLead({ status: 'sent' });
    // Simulate the already-sent first email.
    const sentDraftId = seedDraft(leadId, { status: 'sent' });
    db().insert(emails).values({
      leadId, draftId: sentDraftId, sentAt: '2025-06-01 01:00:00', deliveryStatus: 'sent',
      createdAt: ts(), updatedAt: ts(),
    }).run();
    // A new approved first draft must never produce a duplicate send.
    const lead2 = seedLead(); // approved lead, but re-point a first draft? No — same lead, status approved is required.
    db().update(leads).set({ status: 'approved' }).where(eq(leads.id, leadId)).run();
    const dupId = seedDraft(leadId);
    await sendDraft(dupId);
    expect(db().select().from(drafts).where(eq(drafts.id, dupId)).get()?.failureReason).toMatch(/already sent/);
    expect(db().select().from(emails).where(eq(emails.leadId, leadId)).all()).toHaveLength(1);
    expect(lead2).toBeGreaterThan(0);
  });
});
