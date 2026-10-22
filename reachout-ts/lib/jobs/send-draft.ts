import { and, eq, ne } from 'drizzle-orm';
import { drafts, emails, leads, replies } from '../db/schema';
import { db } from '../db';
import { audit } from '../audit';
import { config, ts } from '../config';
import { Suppression } from '../suppression';
import { sendMail } from '../sending/mailer';
import { SendPolicy } from '../sending/send-policy';
import { randomUUID } from 'node:crypto';

/**
 * Sends one approved draft. Every guardrail is re-checked at send time.
 * Permanent violations mark the draft failed/cancelled; transient holds
 * (paused, outside window, over cap) leave it approved for the next run —
 * the caller re-enqueues with the returned delay.
 */
export async function sendDraft(draftId: number): Promise<{ held?: number } | void> {
  const draft = db().select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft || draft.status !== 'approved') return; // rejected, cancelled, sent, or deleted meanwhile

  const lead = draft.leadId ? db().select().from(leads).where(eq(leads.id, draft.leadId)).get() : undefined;

  if (lead?.publicEmail && Suppression.blocks(lead.publicEmail)) {
    db().update(leads).set({ status: 'opted_out', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
    db().update(drafts).set({ status: 'cancelled', failureReason: 'address suppressed before send', updatedAt: ts() })
      .where(eq(drafts.id, draft.id)).run();
    audit('email', null, 'send_blocked', { reason: 'suppressed', lead_id: lead.id, draft_id: draft.id });
    return;
  }

  const reason = abortReason(draft, lead);
  if (reason) {
    db().update(drafts).set({ status: 'failed', failureReason: reason, updatedAt: ts() }).where(eq(drafts.id, draft.id)).run();
    audit('email', null, 'send_blocked', { reason, lead_id: lead?.id, draft_id: draft.id });
    return;
  }

  if (SendPolicy.paused() || !SendPolicy.withinWindow() || SendPolicy.remainingToday() <= 0) {
    // Held, not failed: re-run at the next window.
    return { held: SendPolicy.secondsUntilNextWindow() };
  }

  const messageId = `${randomUUID()}@${String(config.senderAddress).split('@')[1] ?? 'localhost'}`;

  try {
    await sendMail({ to: lead!.publicEmail!, subject: draft.subject, body: draft.body, messageId });
  } catch (e) {
    audit('email', null, 'send_failed', {
      lead_id: lead!.id, draft_id: draft.id, error: (e as Error).message.slice(0, 300),
    });
    throw e; // transient provider errors retry via the queue's backoff
  }

  const emailId = db().insert(emails).values({
    leadId: lead!.id, draftId: draft.id, messageId: `<${messageId}>`,
    sentAt: ts(), deliveryStatus: 'sent', createdAt: ts(), updatedAt: ts(),
  }).run().lastInsertRowid;
  db().update(drafts).set({ status: 'sent', failureReason: null, updatedAt: ts() }).where(eq(drafts.id, draft.id)).run();
  db().update(leads).set({ status: 'sent', updatedAt: ts() }).where(eq(leads.id, lead!.id)).run();
  audit('email', Number(emailId), 'sent', {
    lead_id: lead!.id, draft_id: draft.id, to: lead!.publicEmail, message_id: `<${messageId}>`,
  });
}

/** Called when the transport gave up after all tries. */
export function sendDraftFailed(draftId: number, error: string): void {
  const draft = db().select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (draft && draft.status === 'approved') {
    db().update(drafts).set({
      status: 'failed', failureReason: `send failed after 3 attempts: ${error.slice(0, 200)}`, updatedAt: ts(),
    }).where(eq(drafts.id, draft.id)).run();
  }
  if (draft?.leadId) {
    audit('email', null, 'send_failed_permanent', {
      lead_id: draft.leadId, draft_id: draft.id, error: error.slice(0, 300),
    });
  }
}

/** Permanent abort reasons (marked on the draft). Null = clear to send. */
function abortReason(draft: typeof drafts.$inferSelect, lead: typeof leads.$inferSelect | undefined): string | null {
  if (!lead?.publicEmail) return 'lead has no public email';

  if (draft.kind === 'first') {
    if (lead.status !== 'approved') return `lead status is '${lead.status}', not approved`;
    if (sentOfKind(lead.id, 'first')) return 'a first email was already sent to this lead';
  } else if (draft.kind === 'followup') {
    if (lead.status !== 'sent') return `lead status is '${lead.status}', not sent (follow-ups need an untouched sent lead)`;
    const first = latestSentOfKind(lead.id, 'first');
    if (!first) return 'no first email was sent to this lead';
    const days = config.send.followupDays;
    if (Date.parse(first.sentAt!.replace(' ', 'T') + 'Z') > Date.now() - days * 86400000) {
      return `first email is not ${days} days old yet`;
    }
    if (sentOfKind(lead.id, 'followup')) return 'a follow-up was already sent to this lead';
    const replied = db().select({ id: replies.id }).from(replies)
      .where(and(eq(replies.leadId, lead.id), ne(replies.classification, 'auto_reply'))).limit(1).all();
    if (replied.length) return 'lead has replied';
  } else {
    return `kind '${draft.kind}' is not sendable`;
  }

  if (!SendPolicy.bodyCompliant(draft.body)) {
    return 'body is missing the opt-out line, sender name, or portfolio link';
  }
  return null;
}

function sentOfKind(leadId: number, kind: string): boolean {
  return latestSentOfKind(leadId, kind) !== undefined;
}

function latestSentOfKind(leadId: number, kind: string) {
  return db().select().from(emails)
    .innerJoin(drafts, eq(emails.draftId, drafts.id))
    .where(and(eq(emails.leadId, leadId), eq(drafts.kind, kind)))
    .orderBy(emails.id)
    .all().pop()?.emails;
}
