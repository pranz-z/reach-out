import { and, eq, isNotNull } from 'drizzle-orm';
import { drafts, leads } from '../../db/schema';
import { db } from '../../db';
import { Suppression } from '../../suppression';
import { Tool, ToolResult } from './base';

/**
 * Already-saved leads with a public email and no first draft yet
 * (e.g. from CSV import or manual enrichment). Read-only.
 */
export class ListDraftableLeadsTool extends Tool {
  name() { return 'list_draftable_leads'; }
  description() {
    return 'List already-saved leads that have a public business email and no first email drafted yet (for example imported from CSV). Read-only. Use it to draft emails for leads that are already in the database.';
  }
  parameters() {
    return { type: 'object', properties: {} };
  }

  async execute(): Promise<ToolResult> {
    const rows = db().select().from(leads)
      .where(and(eq(leads.status, 'enriched'), isNotNull(leads.publicEmail)))
      .orderBy(leads.id).limit(10).all();

    const out = rows
      .filter((l) => !Suppression.blocks(l.publicEmail))
      .filter((l) => db().select({ id: drafts.id }).from(drafts)
        .where(and(eq(drafts.leadId, l.id), eq(drafts.kind, 'first'))).limit(1).all().length === 0)
      .map((l) => ({
        lead_id: l.id,
        name: l.name,
        category: l.category,
        city: l.city,
        website_url: l.websiteUrl,
        website_status: l.websiteStatus,
        signals: l.signals,
        facebook_url: l.facebookUrl,
        facebook_confidence: l.facebookConfidence,
        has_public_email: true,
      }));

    return { ok: true, count: out.length, leads: out };
  }
}
