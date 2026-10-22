'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { draftRevisions, drafts, leads } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { ts, config } from '@/lib/config';
import { audit } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { Suppression } from '@/lib/suppression';
import { LlmClient } from '@/lib/llm/client';
import { DraftRegenerator } from '@/lib/sending/draft-regenerator';

async function requireAuth() {
  if (!(await currentUser())) redirect('/login');
}

function back(params: Record<string, string>): never {
  redirect(`/review?${new URLSearchParams(params).toString()}`);
}

export async function draftApprove(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('draft_id'));
  const draft = db().select().from(drafts).where(eq(drafts.id, id)).get();
  if (!draft || draft.status !== 'pending') back({ error: 'Draft is not pending.' });

  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  if (subject === '' || subject.length > 120 || body === '' || body.length > 3000) {
    back({ error: 'Subject (≤120 chars) and body (≤3000 chars) are required.' });
  }

  // Re-validate after human edits: the opt-out line must survive editing.
  const marker = config.requiredOptOutMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`reply\\s+"?${marker}"?`, 'i').test(body)) {
    back({ error: `The email must keep an opt-out line (reply ${config.requiredOptOutMarker}).` });
  }
  const lead = db().select().from(leads).where(eq(leads.id, draft!.leadId)).get();
  if (lead?.publicEmail && Suppression.blocks(lead.publicEmail)) {
    back({ error: 'This address is on the suppression list.' });
  }

  // Human edits are kept in the revision history too.
  const edited = subject !== draft!.subject || body !== draft!.body;
  if (edited) {
    db().insert(draftRevisions).values({
      draftId: draft!.id, subject: draft!.subject, body: draft!.body,
      source: draft!.source ?? 'agent', createdAt: ts(),
    }).run();
  }
  db().update(drafts).set({
    subject, body, status: 'approved', approvedAt: ts(),
    source: edited ? 'human_edit' : draft!.source, updatedAt: ts(),
  }).where(eq(drafts.id, draft!.id)).run();
  if (lead) db().update(leads).set({ status: 'approved', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
  audit('draft', draft!.id, 'approved', { edited });

  back({ status: 'Approved. It will go out in the next send window (Manila business hours, daily cap applies).' });
}

export async function draftRegenerate(formData: FormData) {
  await requireAuth();
  const draft = db().select().from(drafts).where(eq(drafts.id, Number(formData.get('draft_id')))).get();
  if (!draft) back({ error: 'Draft not found.' });
  const result = await new DraftRegenerator(new LlmClient()).regenerate(draft!);
  back(result.ok
    ? { status: 'Regenerated — check the new wording before approving.' }
    : { error: result.error! });
}

export async function draftReject(formData: FormData) {
  await requireAuth();
  const draft = db().select().from(drafts).where(eq(drafts.id, Number(formData.get('draft_id')))).get();
  if (!draft || draft.status !== 'pending') back({ error: 'Draft is not pending.' });
  db().update(drafts).set({ status: 'rejected', updatedAt: ts() }).where(eq(drafts.id, draft!.id)).run();
  if (draft!.leadId) {
    db().update(leads).set({ status: 'rejected', updatedAt: ts() }).where(eq(leads.id, draft!.leadId)).run();
  }
  audit('draft', draft!.id, 'rejected');
  back({ status: 'Draft rejected.' });
}
