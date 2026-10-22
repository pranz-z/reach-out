import { and, desc, eq, lte, ne } from 'drizzle-orm';
import { drafts, emails, leads, replies } from '../db/schema';
import { db } from '../db';
import { audit } from '../audit';
import { config, ts } from '../config';
import { LlmClient } from '../llm/client';
import { Suppression } from '../suppression';
import { DraftBodyValidator } from './draft-body-validator';

type Lead = typeof leads.$inferSelect;
type Draft = typeof drafts.$inferSelect;

/**
 * Drafts the single allowed follow-up for eligible leads. Plain LLM
 * completion (never the agent loop), same DraftBodyValidator rules,
 * one retry, then a fixed template — mirrors Laravel's FollowupDrafter.
 */
export class FollowupDrafter {
  constructor(private llm: LlmClient) {}

  /**
   * Leads due for a follow-up: first email sent >= N days ago, status
   * still `sent`, no human reply, not suppressed, no follow-up draft.
   */
  eligibleLeads(): Lead[] {
    const cutoff = ts(new Date(Date.now() - config.send.followupDays * 86400000));
    return db().select().from(leads)
      .where(and(eq(leads.status, 'sent')))
      .all()
      .filter((l) => l.publicEmail !== null)
      .filter((l) => this.firstEmail(l.id, cutoff) !== undefined)
      .filter((l) => !Suppression.blocks(l.publicEmail!))
      .filter((l) => !this.hasFollowupDraft(l.id))
      .filter((l) => db().select({ id: replies.id }).from(replies)
        .where(and(eq(replies.leadId, l.id), ne(replies.classification, 'auto_reply')))
        .limit(1).all().length === 0);
  }

  /** Generate and store a pending follow-up draft, or null when ineligible/failed. */
  async draftFor(lead: Lead): Promise<Draft | null> {
    const first = this.latestFirstEmail(lead.id);
    const suggestion = first?.suggestion || 'the setup I mentioned';
    if (!first) return null;

    const [subject, body, model] = await this.generate(lead, suggestion);
    if (body === null) {
      audit('lead', lead.id, 'followup_skipped', { reason: 'generation failed validation twice' });
      return null;
    }

    const id = db().insert(drafts).values({
      leadId: lead.id, kind: 'followup', subject, body,
      suggestion: 'Follow-up nudge for the first email.',
      found: first.found, status: 'pending', model,
      createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid;
    audit('draft', Number(id), 'followup_queued', { lead_id: lead.id, model });
    return db().select().from(drafts).where(eq(drafts.id, Number(id))).get()!;
  }

  /** A first-kind email was sent on or before `cutoff`. */
  private firstEmail(leadId: number, cutoff: string): Draft | undefined {
    return db().select({ draft: drafts }).from(emails)
      .innerJoin(drafts, eq(emails.draftId, drafts.id))
      .where(and(eq(emails.leadId, leadId), eq(drafts.kind, 'first'), lte(emails.sentAt, cutoff)))
      .limit(1).all()[0]?.draft;
  }

  /** The draft row of the most recently sent first email. */
  private latestFirstEmail(leadId: number): Draft | undefined {
    const rows = db().select({ draft: drafts }).from(emails)
      .innerJoin(drafts, eq(emails.draftId, drafts.id))
      .where(and(eq(emails.leadId, leadId), eq(drafts.kind, 'first')))
      .orderBy(desc(emails.sentAt)).limit(1).all();
    return rows[0]?.draft;
  }

  private hasFollowupDraft(leadId: number): boolean {
    return db().select({ id: drafts.id }).from(drafts)
      .where(and(eq(drafts.leadId, leadId), eq(drafts.kind, 'followup')))
      .limit(1).all().length > 0;
  }

  /** [subject, body|null, model-label] */
  private async generate(lead: Lead, suggestion: string): Promise<[string, string | null, string]> {
    const subject = 'Re: quick thought for ' + lead.name;
    const prompt = [
      `Write a short follow-up email to ${lead.name}, a ${lead.category} in ${lead.city}, Philippines.`,
      `I emailed them a week ago suggesting ${suggestion} and got no reply.`,
      'Rules: 2-4 short sentences. Reference my earlier email. Add no new claims or offers.',
      'Plain text only — no HTML, no subject line, no greeting research needed, just "Hi again,".',
      `End with the opt-out line: If it's not relevant, just reply ${config.requiredOptOutMarker} and I won't email again.`,
      'Then sign off with the sender name and portfolio URL on their own lines.',
      'Sender name: ' + config.senderName,
      'Portfolio URL: ' + config.portfolioUrl,
      'Output only the email body.',
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      let body = '';
      try {
        const res = await this.llm.chat([{ role: 'user', content: prompt }]);
        body = (res.content ?? '').trim();
      } catch (e) {
        console.info('FollowupDrafter LLM attempt failed', { lead: lead.id, error: (e as Error).message });
      }
      if (body !== '') {
        const errors = DraftBodyValidator.errors(subject, body);
        if (errors.length === 0) return [subject, body, config.llm.model];
        console.info('FollowupDrafter validation failed', { lead: lead.id, errors });
      }
    }

    const body = this.template(lead, suggestion);
    const errors = DraftBodyValidator.errors(subject, body);
    return errors.length === 0 ? [subject, body, 'template'] : [subject, null, 'template'];
  }

  /** Fixed fallback — still carries every required marker. */
  private template(lead: Lead, suggestion: string): string {
    return [
      'Hi again,',
      '',
      `I emailed ${lead.name} last week about ${suggestion} — just following up in case it got buried.`,
      'Happy to send details or answer questions if useful.',
      '',
      `If it's not relevant, just reply ${config.requiredOptOutMarker} and I won't email again.`,
      '',
      config.senderName,
      config.portfolioUrl,
    ].join('\n');
  }
}
