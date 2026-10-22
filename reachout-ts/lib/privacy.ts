import { eq, like, or } from 'drizzle-orm';
import { agentSteps, draftRevisions, drafts, emails, leads, replies, suppressions } from './db/schema';
import { db } from './db';
import { audit } from './audit';
import { Suppression } from './suppression';

/**
 * Data-subject operations — ports of reachout:forget and reachout:export.
 */

/**
 * Erasure: delete the lead and every tied record (FK cascade covers
 * drafts/emails/replies), scrub the address out of agent step payloads,
 * and keep the opt-out alive as a SHA-256 hash so it can never be
 * emailed again. The audit row carries the hash, never the address.
 */
export function forgetLead(identifier: string): string {
  const key = identifier.trim();
  const lead = /^\d+$/.test(key)
    ? db().select().from(leads).where(eq(leads.id, Number(key))).get()
    : db().select().from(leads).where(eq(leads.publicEmail, key.toLowerCase())).get();

  const email = lead?.publicEmail ?? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) ? key.toLowerCase() : null);
  const suppressed = email
    ? db().select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.email, email)).limit(1).all().length > 0
    : false;

  if (!lead && !suppressed) return `Nothing to forget for ${key} — no lead, no suppression row.`;

  let scrubbed = 0;
  if (email) {
    // Agent steps embed tool args/results as JSON — blank any that still mention the address.
    const hits = db().select({ id: agentSteps.id }).from(agentSteps)
      .where(or(like(agentSteps.arguments, `%${email}%`), like(agentSteps.result, `%${email}%`))).all();
    for (const s of hits) {
      db().update(agentSteps).set({ arguments: { redacted: true }, result: { redacted: true } })
        .where(eq(agentSteps.id, s.id)).run();
    }
    scrubbed = hits.length;
  }

  const id = lead?.id;
  if (lead) db().delete(leads).where(eq(leads.id, lead.id)).run(); // cascades drafts, emails, replies

  let hash: string | null = null;
  if (email) {
    Suppression.addHashed(email, 'forgotten opt-out');
    hash = Suppression.hash(email);
  }

  audit('lead', id ?? null, 'forgotten', { email_hash: hash, agent_steps_scrubbed: scrubbed });
  return (lead ? `Lead #${id} deleted.` : 'No lead row — suppression hashed anyway.')
    + ` Suppression kept as sha256:${hash}.`;
}

/** Dump everything stored about one lead as JSON (data access request). */
export function exportLead(leadId: number): string | null {
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) return null;
  const leadDrafts = db().select().from(drafts).where(eq(drafts.leadId, lead.id)).all()
    .map((d) => ({
      ...d,
      revisions: db().select().from(draftRevisions).where(eq(draftRevisions.draftId, d.id)).all(),
    }));
  return JSON.stringify({
    exported_at: new Date().toISOString(),
    lead,
    drafts: leadDrafts,
    emails: db().select().from(emails).where(eq(emails.leadId, lead.id)).all(),
    replies: db().select().from(replies).where(eq(replies.leadId, lead.id)).all(),
  }, null, 2);
}
