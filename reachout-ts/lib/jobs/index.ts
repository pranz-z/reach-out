import { and, eq } from 'drizzle-orm';
import { agentRuns, leads, searchProfiles } from '../db/schema';
import { db } from '../db';
import { audit } from '../audit';
import { ts } from '../config';
import { enqueue, handle } from '../queue';
import { Setting } from '../settings';
import { LlmClient } from '../llm/client';
import { AgentRunner } from '../agent/runner';
import { FirstEmailDrafter } from '../sending/first-email-drafter';
import { sendDraft, sendDraftFailed } from './send-draft';
import type { Profile } from '../agent/tools/base';

let registered = false;

/** Register every job handler once per process (idempotent). */
export function registerHandlers(): void {
  if (registered) return;
  registered = true;

  handle('run_profile_agent', async (payload) => {
    const profileRow = db().select().from(searchProfiles)
      .where(eq(searchProfiles.id, Number(payload.profile_id))).get();
    if (!profileRow || !profileRow.active) return;
    const profile: Profile = profileRow;
    const run = await new AgentRunner(new LlmClient()).run(profile, Number(payload.max_seconds) || undefined);
    console.log(`[jobs] run_profile_agent → run #${run.id}: ${run.status} (${run.leadsSaved} leads, ${run.draftsQueued} drafts)`);
  });

  handle('draft_lead_email', async (payload) => {
    const lead = db().select().from(leads).where(eq(leads.id, Number(payload.lead_id))).get();
    if (!lead) return;
    const draft = await new FirstEmailDrafter(new LlmClient()).draftFor(lead);
    if (draft) console.log(`[jobs] draft_lead_email → draft #${draft.id} pending for lead #${lead.id}`);
  });

  handle('send_draft', async (payload) => {
    const draftId = Number(payload.draft_id);
    try {
      const result = await sendDraft(draftId);
      if (result?.held) enqueue('send_draft', payload, result.held); // outside window — re-queue
    } catch (e) {
      sendDraftFailed(draftId, (e as Error).message);
      throw e;
    }
  });
}

/** Queue a profile agent run — same refusals as the Laravel controller. */
export function queueProfileRun(profileId: number): { ok: true } | { ok: false; error: string } {
  if (Setting.bool('discovery_paused')) {
    return { ok: false, error: 'Discovery is paused — resume it in Settings first.' };
  }
  const profile = db().select().from(searchProfiles).where(eq(searchProfiles.id, profileId)).get();
  if (!profile) return { ok: false, error: 'Profile not found.' };
  if (!profile.active) return { ok: false, error: 'This profile is inactive.' };
  const running = db().select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.profileId, profileId), eq(agentRuns.status, 'running'))).limit(1).all();
  if (running.length) return { ok: false, error: 'A run for this profile is already in progress.' };
  enqueue('run_profile_agent', { profile_id: profileId });
  audit('search_profile', profileId, 'run_queued', { via: 'web' });
  return { ok: true };
}

/** Queue a first-email draft for a lead. */
export function queueLeadDraft(leadId: number): { ok: true } | { ok: false; error: string } {
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) return { ok: false, error: 'Lead not found.' };
  enqueue('draft_lead_email', { lead_id: leadId });
  audit('lead', leadId, 'draft_queued', { via: 'web' });
  return { ok: true };
}
