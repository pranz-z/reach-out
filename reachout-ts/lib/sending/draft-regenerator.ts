import { eq } from 'drizzle-orm';
import { draftRevisions, drafts, leads } from '../db/schema';
import { db } from '../db';
import { audit } from '../audit';
import { config, ts } from '../config';
import { LlmClient } from '../llm/client';
import { DraftBodyValidator } from './draft-body-validator';

type Draft = typeof drafts.$inferSelect;

/**
 * Re-drafts a pending draft with the configured LLM, using only facts
 * already stored on the lead — nothing new may be invented. Output is
 * validated with the shared DraftBodyValidator; on two failed attempts
 * the old draft stays untouched. History is kept in draft_revisions.
 */
export class DraftRegenerator {
  static MAX_REGENERATIONS = 3;

  constructor(private llm: LlmClient) {}

  async regenerate(draft: Draft): Promise<{ ok: boolean; error?: string }> {
    if (draft.status !== 'pending') {
      return { ok: false, error: `Only pending drafts can be regenerated (this one is '${draft.status}').` };
    }
    if (draft.regenerationCount >= DraftRegenerator.MAX_REGENERATIONS) {
      return { ok: false, error: `This draft was already regenerated ${DraftRegenerator.MAX_REGENERATIONS} times — edit it by hand or reject it.` };
    }

    const lead = db().select().from(leads).where(eq(leads.id, draft.leadId)).get()!;
    const facts = (draft.found ?? []).map((f) => `- ${f}`).join('\n');
    const prompt = [
      `Rewrite this cold outreach draft to ${lead.name}, a ${lead.category} in ${lead.city}, Philippines.`,
      'Keep the same offer: ' + (draft.suggestion || 'a business software proposal'),
      'Only use these collected facts — add nothing new:',
      facts || '- (no facts collected)',
      '',
      `Requirements: plain text; under ${config.maxEmailWords} words; tentative tone;`,
      `sign as ${config.senderName}; include ${config.portfolioUrl};`,
      `include the opt-out line: If it's not relevant, just reply ${config.requiredOptOutMarker} and I won't email again.`,
      '',
      'Output format: first line "Subject: <subject>", then a blank line, then the body.',
      'Current draft for reference (do not copy it verbatim):',
      `Subject: ${draft.subject}`,
      draft.body,
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      let text = '';
      try {
        const res = await this.llm.chat([{ role: 'user', content: prompt }]);
        text = (res.content ?? '').trim();
      } catch (e) {
        console.info('draft regenerate failed', { draft: draft.id, attempt, error: (e as Error).message });
        continue;
      }
      const [subject, body] = this.split(text);
      const errors = DraftBodyValidator.errors(subject, body);
      if (subject !== '' && body !== '' && errors.length === 0) {
        this.replace(draft, subject, body);
        return { ok: true };
      }
      console.info('draft regenerate validation failed', { draft: draft.id, attempt, errors });
    }

    return { ok: false, error: 'The model did not produce a valid draft after 2 attempts — keeping the current version.' };
  }

  private replace(draft: Draft, subject: string, body: string): void {
    db().insert(draftRevisions).values({
      draftId: draft.id, subject: draft.subject, body: draft.body,
      source: draft.source ?? 'agent', createdAt: ts(),
    }).run();
    db().update(drafts).set({
      subject, body, source: 'regenerated', model: config.llm.model,
      regenerationCount: draft.regenerationCount + 1, updatedAt: ts(),
    }).where(eq(drafts.id, draft.id)).run();
    audit('draft', draft.id, 'regenerated', { count: draft.regenerationCount + 1 });
  }

  private split(text: string): [string, string] {
    const m = /^Subject:\s*(.+?)\s*\r?\n\r?\n(.*)$/s.exec(text);
    return m ? [m[1].trim(), m[2].trim()] : ['', text];
  }
}
