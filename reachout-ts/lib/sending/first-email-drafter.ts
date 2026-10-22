import { and, eq, inArray } from 'drizzle-orm';
import { drafts, leads } from '../db/schema';
import { db } from '../db';
import { audit } from '../audit';
import { config, ts } from '../config';
import { LlmClient } from '../llm/client';
import { Suppression } from '../suppression';
import { DraftBodyValidator } from './draft-body-validator';

type Lead = typeof leads.$inferSelect;
type Draft = typeof drafts.$inferSelect;

/**
 * Drafts the FIRST outreach email for a single lead, on demand, without a
 * full agent run. Same eligibility and body rules QueueDraftTool enforces;
 * retries the LLM once, then falls back to a fixed template so the feature
 * works even when the model endpoint is unreachable.
 */
export class FirstEmailDrafter {
  constructor(private llm: LlmClient) {}

  /** Mirror of QueueDraftTool's eligibility: public email, not suppressed, draftable status, no blocking first draft. */
  draftable(lead: Lead): boolean {
    if (!lead.publicEmail || Suppression.blocks(lead.publicEmail)) return false;
    if (!['enriched', 'drafted'].includes(lead.status)) return false;
    const existing = db().select({ id: drafts.id }).from(drafts)
      .where(and(eq(drafts.leadId, lead.id), eq(drafts.kind, 'first'), inArray(drafts.status, ['pending', 'approved', 'sent'])))
      .limit(1).all();
    return existing.length === 0;
  }

  /** Generate and store a pending first-email draft, or null when not draftable / generation failed. */
  async draftFor(lead: Lead): Promise<Draft | null> {
    if (!this.draftable(lead)) return null;

    const [subject, body, model] = await this.generate(lead);
    if (body === null) {
      audit('lead', lead.id, 'draft_skipped', { reason: 'generation failed validation twice' });
      return null;
    }

    const id = db().insert(drafts).values({
      leadId: lead.id, kind: 'first', subject, body,
      suggestion: 'Manual draft: ' + this.hint(lead),
      found: this.foundFacts(lead),
      status: 'pending', model,
      createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid;
    db().update(leads).set({ status: 'drafted', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
    audit('draft', Number(id), 'first_queued', { lead_id: lead.id, model, via: 'draft_now' });

    return db().select().from(drafts).where(eq(drafts.id, Number(id))).get()!;
  }

  /** Facts actually known about the business — recorded on the draft for the reviewer. */
  private foundFacts(lead: Lead): string[] {
    const facts = [
      `Listed as a ${lead.category} in ${lead.city}`,
      lead.websiteUrl ? `Own website: ${lead.websiteUrl}` : null,
      lead.facebookUrl ? `Facebook page: ${lead.facebookUrl}` : null,
      lead.phone ? `Phone: ${lead.phone}` : null,
      `Email found via ${lead.emailSource}`,
    ].filter((f): f is string => f !== null);
    const signals = Array.isArray(lead.signals) ? lead.signals : [];
    for (const signal of signals) facts.push(`Signal: ${signal}`);
    return facts;
  }

  /** [subject, body|null, model-label] */
  private async generate(lead: Lead): Promise<[string, string | null, string]> {
    const subject = 'quick thought for ' + lead.name;
    const hint = this.hint(lead);

    const facts = [`${lead.name} is a ${lead.category} business in ${lead.city}, Philippines.`];
    if (lead.websiteUrl) {
      facts.push(`Their website is ${lead.websiteUrl}.`);
    } else if (['enriched', 'phone_only'].includes(lead.status) && ['none', 'social_only'].includes(lead.websiteStatus)) {
      facts.push(`I could not find a website for them — only mention this tentatively ("I couldn't find a website"), never claim they lack one.`);
    }
    if (lead.facebookUrl) facts.push(`They have a Facebook page at ${lead.facebookUrl}.`);
    const signals = Array.isArray(lead.signals) ? lead.signals : [];
    for (const signal of signals) facts.push(`Observed signal: ${signal}.`);

    const prompt = [
      `Write a short cold outreach email to ${lead.name}.`,
      'Facts you may use — state nothing else about them: ' + facts.join(' '),
      `I build small systems for local businesses. Possible angle (suggestion, not a fact): ${hint}.`,
      'Rules: 3-5 short sentences, tentative tone ("I might be able to help", "would this be useful?"), one concrete offer, no invented facts, no pressure.',
      'Plain text only — no HTML. Start with "Hi,".',
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
        console.info('FirstEmailDrafter LLM attempt failed', { lead: lead.id, error: (e as Error).message });
      }
      if (body !== '') {
        const errors = DraftBodyValidator.errors(subject, body);
        if (errors.length === 0) return [subject, body, config.llm.model];
        console.info('FirstEmailDrafter validation failed', { lead: lead.id, errors });
      }
    }

    const body = this.template(lead, hint);
    const errors = DraftBodyValidator.errors(subject, body);
    return errors.length === 0 ? [subject, body, 'template'] : [subject, null, 'template'];
  }

  /** Per-category pitch idea used as the draft's angle (a suggestion, never a claimed fact). */
  private hint(lead: Lead): string {
    return config.discovery.solutionHints[(lead.category ?? '').trim().toLowerCase()]
      ?? 'a small business system with an AI assistant';
  }

  /** Fixed fallback — carries every required marker, states only recorded facts. */
  private template(lead: Lead, hint: string): string {
    const angle = hint.split(';')[0];
    return [
      'Hi,',
      '',
      `I found ${lead.name} while looking at ${lead.category} businesses in ${lead.city}.`,
      `I build small systems for local shops — I might be able to help with ${angle}, if that's ever useful for you.`,
      'Happy to send details or answer questions.',
      '',
      `If it's not relevant, just reply ${config.requiredOptOutMarker} and I won't email again.`,
      '',
      config.senderName,
      config.portfolioUrl,
    ].join('\n');
  }
}
