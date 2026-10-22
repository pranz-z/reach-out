import { and, eq } from 'drizzle-orm';
import { leads } from './db/schema';
import { db } from './db';
import { ts } from './config';
import { audit } from './audit';
import { Suppression } from './suppression';
import { SafeFetcher } from './discovery/safe-fetcher';

export interface CsvRow {
  name: string;
  city: string;
  category: string | null;
  public_email: string | null;
  phone: string | null;
  website: string | null;
  facebook_url: string | null;
}

export type Verdict = 'new' | 'duplicate' | 'invalid' | 'suppressed';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FB_RE = /^https:\/\/([a-z0-9-]+\.)?facebook\.com(\/|$)/i;

/** CSV template — headers only. */
export const CSV_TEMPLATE = 'name,city,category,public_email,phone,website,facebook_url\n';

/** Minimal CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text: string): CsvRow[] | null {
  const records: string[][] = [];
  let field = '', row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) records.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) records.push(row); }
  if (records.length === 0) return null;

  const header = records[0].map((h) => h.trim().toLowerCase());
  if (!header.includes('name') || !header.includes('city')) return null;

  return records.slice(1).map((r) => {
    const data = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
    const website = (data['website'] ?? data['website_url'] ?? '').trim();
    return {
      name: (data['name'] ?? '').trim(),
      city: (data['city'] ?? '').trim(),
      category: (data['category'] ?? '').trim() || null,
      public_email: (data['public_email'] ?? '').trim().toLowerCase() || null,
      phone: (data['phone'] ?? '').trim() || null,
      website: website || null,
      facebook_url: (data['facebook_url'] ?? '').trim() || null,
    };
  });
}

/** One row → verdict + reason. Order: invalid shape, suppression, duplicate. */
export function classifyRow(data: CsvRow): { verdict: Verdict; reason: string } {
  if (data.name === '' || data.city === '') return { verdict: 'invalid', reason: 'missing name or city' };
  if (data.public_email && !EMAIL_RE.test(data.public_email)) return { verdict: 'invalid', reason: 'bad email format' };
  if (data.website && !/^https?:\/\//i.test(data.website)) return { verdict: 'invalid', reason: 'website must start with http(s)://' };
  if (data.facebook_url && !FB_RE.test(data.facebook_url)) return { verdict: 'invalid', reason: 'facebook url must be https facebook.com' };
  if (data.public_email && Suppression.blocks(data.public_email)) return { verdict: 'suppressed', reason: 'address or domain is on the suppression list' };
  const dupe = db().select({ id: leads.id }).from(leads)
    .where(and(eq(leads.name, data.name), eq(leads.city, data.city))).limit(1).all();
  if (dupe.length) return { verdict: 'duplicate', reason: 'a lead with this name and city already exists' };
  return { verdict: 'new', reason: '' };
}

/** Insert a classified-new row as a lead. */
export function insertLead(data: CsvRow): number {
  const email = data.public_email;
  const website = data.website;
  const facebook = data.facebook_url;
  const id = db().insert(leads).values({
    name: data.name, city: data.city, category: data.category, phone: data.phone,
    websiteUrl: website,
    websiteStatus: website ? (SafeFetcher.isSocial(website) ? 'social_only' : 'unknown') : 'none',
    facebookUrl: facebook,
    facebookConfidence: facebook ? 'unverified' : 'none',
    publicEmail: email, emailSource: email ? 'csv' : null,
    status: email ? 'enriched' : 'phone_only',
    createdAt: ts(), updatedAt: ts(),
  }).run().lastInsertRowid;
  audit('lead', Number(id), 'created', { by: 'csv' });
  return Number(id);
}

/** addEmail — attach an owner-found published email. */
export function addEmail(leadId: number, email: string): { ok: true; message: string } | { ok: false; error: string } {
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) return { ok: false, error: 'Lead not found.' };
  if (lead.publicEmail) return { ok: false, error: 'This lead already has a public email.' };
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.length > 190) return { ok: false, error: 'Enter a valid email address.' };
  if (Suppression.blocks(normalized)) return { ok: false, error: 'That address is on the suppression list — do not contact this business.' };

  db().update(leads).set({
    publicEmail: normalized, emailSource: 'manual', status: 'enriched', updatedAt: ts(),
  }).where(eq(leads.id, lead.id)).run();
  audit('lead', lead.id, 'email_added', { by: 'manual', email: normalized });
  return { ok: true, message: `Email saved — ${lead.name} is now draftable.` };
}

/** setFacebook — paste an owner-confirmed facebook.com URL. */
export function setFacebook(leadId: number, url: string): { ok: true; message: string } | { ok: false; error: string } {
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) return { ok: false, error: 'Lead not found.' };
  const u = url.trim();
  if (!FB_RE.test(u) || u.length > 500) return { ok: false, error: 'Only https facebook.com URLs are accepted.' };
  db().update(leads).set({ facebookUrl: u, facebookConfidence: 'confirmed', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
  audit('lead', lead.id, 'facebook_confirmed', { url: u });
  return { ok: true, message: 'Facebook page saved as confirmed.' };
}
