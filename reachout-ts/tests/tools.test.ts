import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { drafts, leads, searchProfiles } from '@/lib/db/schema';
import { Suppression } from '@/lib/suppression';
import { ts } from '@/lib/config';
import { stripEmpty } from '@/lib/strip-empty';
import { SaveLeadTool } from '@/lib/agent/tools/save-lead';
import { QueueDraftTool } from '@/lib/agent/tools/queue-draft';
import { DraftBodyValidator } from '@/lib/sending/draft-body-validator';
import type { Profile, Run } from '@/lib/agent/tools/base';

function makeProfile(): Profile {
  const id = db().insert(searchProfiles).values({
    name: 'Test', categories: ['cafe'], cities: ['Guagua'], dailyCap: 10, active: true,
    createdAt: ts(), updatedAt: ts(),
  }).run().lastInsertRowid;
  return db().select().from(searchProfiles).where(eq(searchProfiles.id, Number(id))).get()!;
}

const profile = makeProfile();
const run: Run = {
  id: 1, profileId: 1, status: 'running', stepsUsed: 0, leadsSaved: 0,
  draftsQueued: 0, model: 'test', error: null, startedAt: ts(), finishedAt: null,
  createdAt: ts(), updatedAt: ts(),
};

function seedLead(over: Partial<typeof leads.$inferInsert> = {}) {
  return db().insert(leads).values({
    name: 'Cafe A', city: 'Guagua', category: 'cafe', status: 'enriched',
    publicEmail: 'owner@cafe.test', emailSource: 'manual',
    createdAt: ts(), updatedAt: ts(), ...over,
  }).run().lastInsertRowid;
}

describe('stripEmpty', () => {
  it('drops null/empty recursively, keeps falsy-but-real values', () => {
    const out = stripEmpty({ a: null, b: '', c: [], d: 0, e: false, f: { g: null, h: 'x' } });
    expect(out).toEqual({ d: 0, e: false, f: { h: 'x' } });
  });
});

describe('save_lead guardrails', () => {
  it('refuses a city outside the profile', async () => {
    const r = await new SaveLeadTool(profile, run).execute({ name: 'X', city: 'Manila' });
    expect(r['ok']).toBe(false);
  });

  it('null optional fields behave like omitted fields (no crash, phone_only save)', async () => {
    const r = await new SaveLeadTool(profile, run).execute({
      name: 'Jollibee Guagua', city: 'Guagua',
      phone: null, website_url: null, public_email: null, signals: null,
    });
    expect(r['ok']).toBe(true);
    const lead = db().select().from(leads).where(eq(leads.id, Number(r['lead_id']))).get();
    expect(lead?.status).toBe('phone_only');
    expect(lead?.publicEmail).toBeNull();
  });

  it('refuses a suppressed public email', async () => {
    Suppression.add('bad@gone.test');
    const r = await new SaveLeadTool(profile, run).execute({ name: 'Y', city: 'Guagua', public_email: 'bad@gone.test' });
    expect(r['ok']).toBe(false);
  });

  it('strips non-facebook social URLs instead of saving them', async () => {
    const r = await new SaveLeadTool(profile, run).execute({
      name: 'Z', city: 'Guagua', facebook_url: 'https://instagram.com/z',
    });
    expect(r['ok']).toBe(true);
    const lead = db().select().from(leads).where(eq(leads.id, Number(r['lead_id']))).get();
    expect(lead?.facebookUrl).toBeNull();
  });
});

describe('queue_draft_for_review guardrails', () => {
  it('refuses a lead with no public email', async () => {
    const leadId = seedLead({ publicEmail: null, emailSource: null, status: 'phone_only' });
    const r = await new QueueDraftTool(profile, run).execute({
      lead_id: Number(leadId), subject: 's', body: 'b', suggestion: 'x', found: [],
    });
    expect(r['ok']).toBe(false);
  });

  it('stores only a PENDING draft with a compliant body', async () => {
    const leadId = seedLead();
    const body = `Hi,\nI might be able to help.\n\nIf it's not relevant, just reply STOP and I won't email again.\n\nFranz\nhttps://example.com/portfolio`;
    const r = await new QueueDraftTool(profile, run).execute({
      lead_id: Number(leadId), subject: 'quick thought', body, suggestion: 'POS', found: ['has phone'],
    });
    expect(r['ok']).toBe(true);
    const d = db().select().from(drafts).where(eq(drafts.leadId, Number(leadId))).get()!;
    expect(d.status).toBe('pending');
    // never a send path: no emails row created by this tool
  });
});

describe('DraftBodyValidator', () => {
  const good = `Hi,\nshort.\n\nIf it's not relevant, just reply STOP and I won't email again.\n\nFranz\nhttps://example.com/portfolio`;
  it('passes a compliant body', () => {
    expect(DraftBodyValidator.errors('quick thought', good)).toEqual([]);
  });
  it('rejects a missing opt-out, missing sender, missing portfolio', () => {
    const errs = DraftBodyValidator.errors('s', 'just some words');
    expect(errs.join(';')).toMatch(/opt-out/);
    expect(errs.join(';')).toMatch(/sender name/);
    expect(errs.join(';')).toMatch(/portfolio/);
  });
});
