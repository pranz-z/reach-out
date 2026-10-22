import { eq } from 'drizzle-orm';
import { agentRuns, leads } from '../../db/schema';
import { db } from '../../db';
import { audit } from '../../audit';
import { config, ts } from '../../config';
import { SafeFetcher } from '../../discovery/safe-fetcher';
import { Suppression } from '../../suppression';
import { Tool, ToolResult } from './base';

const STATUSES = ['none', 'social_only', 'basic', 'modern', 'unknown'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SaveLeadTool extends Tool {
  name() { return 'save_lead'; }
  description() {
    return 'Save or update a lead with the facts collected so far. Only these fields are stored. Duplicate place_ids update the existing lead. Returns lead_id.';
  }
  parameters() {
    return {
      type: 'object',
      properties: {
        place_id: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        phone: { type: 'string' },
        website_url: { type: 'string' },
        website_status: { type: 'string', enum: STATUSES },
        signals: { type: 'object' },
        facebook_url: { type: 'string' },
        facebook_confidence: { type: 'string', enum: ['none', 'unverified', 'likely'] },
        public_email: { type: 'string' },
        fit_score: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['name', 'city'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.run.leadsSaved >= config.agent.maxLeadsPerRun) {
      return this.error('Lead cap for this run reached. Stop and finish.');
    }

    const name = String(args['name'] ?? '').trim();
    const city = String(args['city'] ?? '').trim();
    if (name === '' || city === '') return this.error('name and city are required');
    if (!this.profile.cities.map((c) => c.toLowerCase()).includes(city.toLowerCase())) {
      return this.error('city is not in this profile');
    }

    let email = args['public_email'] ? String(args['public_email']).trim().toLowerCase() : null;
    if (email) {
      if (!EMAIL_RE.test(email)) return this.error('public_email is not a valid address');
      if (Suppression.blocks(email)) return this.error('That email is on the suppression list. Do not save it.');
    } else {
      email = null;
    }

    let facebook = args['facebook_url'] ? String(args['facebook_url']) : null;
    if (facebook && !/^https:\/\/([a-z]+\.)?facebook\.com\//i.test(facebook)) {
      facebook = null; // only accept facebook.com links, URL only
    }

    const website = args['website_url'] ? String(args['website_url']) : null;
    let websiteStatus = STATUSES.includes(String(args['website_status'])) ? String(args['website_status']) : 'unknown';
    if (website && SafeFetcher.isSocial(website)) websiteStatus = 'social_only';

    const attributes = {
      profileId: this.profile.id,
      name,
      category: args['category'] ? String(args['category']) : null,
      address: args['address'] ? String(args['address']) : null,
      city,
      phone: args['phone'] ? String(args['phone']) : null,
      websiteUrl: website || null,
      websiteStatus,
      signals: (args['signals'] && typeof args['signals'] === 'object') ? args['signals'] as Record<string, unknown> : null,
      facebookUrl: facebook,
      facebookConfidence: facebook ? String(args['facebook_confidence'] ?? 'unverified') : 'none',
      publicEmail: email,
      emailSource: email ? 'website' : null,
      fitScore: ['high', 'medium', 'low'].includes(String(args['fit_score'])) ? String(args['fit_score']) : null,
      status: email ? 'enriched' : 'phone_only',
      updatedAt: ts(),
    };

    const placeId = args['place_id'] ? String(args['place_id']) : null;
    const lead = placeId ? db().select().from(leads).where(eq(leads.placeId, placeId)).get() : undefined;

    if (lead) {
      // Never let the agent resurrect or alter a lead past enrichment.
      if (!['new', 'enriched', 'phone_only'].includes(lead.status)) {
        return { ok: true, lead_id: lead.id, note: 'lead already past enrichment; unchanged' };
      }
      db().update(leads).set(attributes).where(eq(leads.id, lead.id)).run();
      audit('lead', lead.id, 'updated', { by: 'agent', run_id: this.run.id });
      return { ok: true, lead_id: lead.id, status: attributes.status };
    }

    const id = db().insert(leads).values({ ...attributes, placeId, createdAt: ts() }).run().lastInsertRowid;
    db().update(agentRuns).set({ leadsSaved: this.run.leadsSaved + 1 }).where(eq(agentRuns.id, this.run.id)).run();
    this.run.leadsSaved += 1;
    audit('lead', Number(id), 'created', { by: 'agent', run_id: this.run.id });

    return { ok: true, lead_id: Number(id), status: attributes.status };
  }
}
