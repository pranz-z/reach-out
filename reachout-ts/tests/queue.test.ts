import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns, agentSteps, failedJobs, jobs, leads, replies } from '@/lib/db/schema';

function makeRunId(): number {
  return Number(db().insert(agentRuns).values({
    status: 'running', startedAt: ts(), createdAt: ts(), updatedAt: ts(),
  }).run().lastInsertRowid);
}
import { ts } from '@/lib/config';
import { enqueue, handle, workOnce } from '@/lib/queue';
import { backup, discover, prune } from '@/lib/tasks';
import { forgetLead } from '@/lib/privacy';
import { Suppression } from '@/lib/suppression';
import { Setting } from '@/lib/settings';

describe('queue', () => {
  it('enqueue → workOnce runs the handler and removes the row', async () => {
    let seen: Record<string, unknown> | null = null;
    handle('send_draft', async (p) => { seen = p; });
    enqueue('send_draft', { draft_id: 42 });
    expect(await workOnce()).toBe(true);
    expect(seen).toEqual({ draft_id: 42 });
    expect(db().select().from(jobs).all()).toHaveLength(0);
  });

  it('future jobs are not claimed early', async () => {
    handle('send_draft', async () => {});
    enqueue('send_draft', { draft_id: 1 }, 3600);
    expect(await workOnce()).toBe(false);
  });

  it('a failing handler retries, then dead-letters into reachout_failed_jobs', async () => {
    handle('draft_lead_email', async () => { throw new Error('boom'); });
    const id = enqueue('draft_lead_email', { lead_id: 7 });
    await workOnce(); // attempt 1 → backoff
    let row = db().select().from(jobs).where(eq(jobs.id, id)).get()!;
    expect(row.attempts).toBe(1);
    expect(row.runAt > ts()).toBe(true); // delayed 30s

    // Fast-forward: make the job due again for attempts 2 and 3.
    db().update(jobs).set({ runAt: '2000-01-01 00:00:00' }).where(eq(jobs.id, id)).run();
    await workOnce(); // attempt 2 → backoff
    db().update(jobs).set({ runAt: '2000-01-01 00:00:00' }).where(eq(jobs.id, id)).run();
    await workOnce(); // attempt 3 → dead letter

    expect(db().select().from(jobs).where(eq(jobs.id, id)).all()).toHaveLength(0);
    const dead = db().select().from(failedJobs).all();
    expect(dead).toHaveLength(1);
    expect(dead[0].exception).toBe('boom');
    expect(JSON.parse(dead[0].payload)).toMatchObject({ type: 'draft_lead_email' });
  });
});

describe('tasks.discover back-pressure', () => {
  it('skips when discovery is paused', () => {
    Setting.setBool('discovery_paused', true);
    expect(discover()).toMatch(/paused/);
    Setting.setBool('discovery_paused', false);
  });
});

describe('tasks.prune retention', () => {
  it('clears old snippets + steps and deletes dead leads, keeps suppressions', () => {
    const old = '2000-01-01 00:00:00';
    db().insert(leads).values({
      name: 'Old Cafe', city: 'Guagua', status: 'phone_only',
      createdAt: old, updatedAt: old,
    }).run();
    const leadId = db().select({ id: leads.id }).from(leads).where(eq(leads.name, 'Old Cafe')).get()!.id;
    db().insert(replies).values({
      leadId, classification: 'interested', snippet: 'yes tell me more', source: 'imap',
      receivedAt: old, createdAt: old, updatedAt: old,
    }).run();
    db().insert(agentSteps).values({
      runId: makeRunId(), step: 1, role: 'tool', tool: 'x', createdAt: old,
    }).run();
    Suppression.add('never@gone.test');

    const msg = prune();
    expect(msg).toMatch(/1 snippet/);
    expect(msg).toMatch(/1 agent step/);
    expect(msg).toMatch(/1 dead lead/);
    expect(Suppression.blocks('never@gone.test')).toBe(true); // never pruned
  });
});

describe('privacy.forgetLead', () => {
  it('deletes the lead + data, hashes the opt-out, scrubs step payloads', () => {
    const id = Number(db().insert(leads).values({
      name: 'Forget Me', city: 'Guagua', status: 'sent',
      publicEmail: 'gone@lead.test', emailSource: 'website',
      createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid);
    db().insert(agentSteps).values({
      runId: makeRunId(), step: 1, role: 'tool', tool: 'save_lead',
      arguments: { public_email: 'gone@lead.test' }, result: { ok: true }, createdAt: ts(),
    }).run();

    const msg = forgetLead('gone@lead.test');
    expect(msg).toMatch(/deleted/);
    expect(db().select().from(leads).where(eq(leads.id, id)).all()).toHaveLength(0);
    expect(Suppression.blocks('gone@lead.test')).toBe(true); // hash survives
    const step = db().select().from(agentSteps).all().find((s) => s.tool === 'save_lead')!;
    expect(step.arguments).toEqual({ redacted: true });
  });
});

describe('tasks.backup', () => {
  it('writes a consistent dated sqlite copy', async () => {
    const msg = await backup();
    expect(msg).toMatch(/Backed up to reachout-/);
  });
});
