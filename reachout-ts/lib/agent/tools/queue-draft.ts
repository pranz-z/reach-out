import { and, eq, inArray } from 'drizzle-orm';
import { agentRuns, drafts, leads } from '../../db/schema';
import { db } from '../../db';
import { audit } from '../../audit';
import { config, ts } from '../../config';
import { DraftBodyValidator } from '../../sending/draft-body-validator';
import { Suppression } from '../../suppression';
import { Tool, ToolResult } from './base';

/**
 * The ONLY way the agent can produce an email, and it only ever creates a
 * PENDING draft for human review. There is no send tool.
 */
export class QueueDraftTool extends Tool {
  name() { return 'queue_draft_for_review'; }
  description() {
    return 'Queue a cold proposal email draft for human review. Requires a saved lead with a public business email. The body must be plain text, under the word limit, include the sender name and portfolio link, and contain the opt-out line ("reply STOP"). Only state facts that were actually collected.';
  }
  parameters() {
    return {
      type: 'object',
      properties: {
        lead_id: { type: 'integer' },
        subject: { type: 'string' },
        body: { type: 'string' },
        suggestion: { type: 'string', description: 'Suggested system and one-line reasoning, for the reviewer.' },
        found: { type: 'array', items: { type: 'string' }, description: 'Facts actually collected about this business, for the reviewer.' },
      },
      required: ['lead_id', 'subject', 'body', 'suggestion', 'found'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const lead = db().select().from(leads).where(eq(leads.id, Number(args['lead_id'] ?? 0))).get();
    if (!lead) return this.error('Unknown lead_id. Call save_lead first.');
    if (!lead.publicEmail) return this.error('Lead has no public business email. Do not draft an email for it.');
    if (Suppression.blocks(lead.publicEmail)) return this.error('Lead email is on the suppression list.');
    if (!['enriched', 'drafted'].includes(lead.status)) {
      return this.error(`Lead status is '${lead.status}', so it cannot receive a new draft.`);
    }
    const existing = db().select({ id: drafts.id }).from(drafts)
      .where(and(eq(drafts.leadId, lead.id), eq(drafts.kind, 'first'), inArray(drafts.status, ['pending', 'approved', 'sent'])))
      .limit(1).all();
    if (existing.length) return this.error('This lead already has a first email. Only one first email per business.');

    const subject = String(args['subject'] ?? '').trim();
    const body = String(args['body'] ?? '').trim();
    const errors = DraftBodyValidator.errors(subject, body);
    if (errors.length) return this.error('Invalid draft body: ' + errors.join('; '));

    const found = (Array.isArray(args['found']) ? args['found'] : []).map(String).filter(Boolean);
    const id = db().insert(drafts).values({
      leadId: lead.id, kind: 'first', subject, body,
      suggestion: String(args['suggestion'] ?? '').trim(),
      found, status: 'pending', model: config.llm.model,
      createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid;
    db().update(leads).set({ status: 'drafted', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
    db().update(agentRuns).set({ draftsQueued: this.run.draftsQueued + 1 }).where(eq(agentRuns.id, this.run.id)).run();
    this.run.draftsQueued += 1;
    audit('draft', Number(id), 'queued', { by: 'agent', run_id: this.run.id, lead_id: lead.id });

    return { ok: true, draft_id: Number(id), status: 'pending' };
  }
}
