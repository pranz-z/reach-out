'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { discoveryCache, leads } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { ts } from '@/lib/config';
import { audit } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { Suppression } from '@/lib/suppression';
import { SafeFetcher } from '@/lib/discovery/safe-fetcher';
import { PublicEmailFinder } from '@/lib/discovery/email-finder';
import { FirstEmailDrafter } from '@/lib/sending/first-email-drafter';
import { LlmClient } from '@/lib/llm/client';
import { addEmail, setFacebook, parseCsv, classifyRow, insertLead, CsvRow, Verdict } from '@/lib/leads';
import { queueLeadDraft } from '@/lib/jobs';
import { randomUUID } from 'node:crypto';

async function requireAuth() {
  if (!(await currentUser())) redirect('/login');
}

function back(params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(`/leads?${q}`);
}

export async function leadAddEmail(formData: FormData) {
  await requireAuth();
  const r = addEmail(Number(formData.get('lead_id')), String(formData.get('email') ?? ''));
  back(r.ok ? { status: r.message } : { error: r.error });
}

export async function leadSetFacebook(formData: FormData) {
  await requireAuth();
  const r = setFacebook(Number(formData.get('lead_id')), String(formData.get('facebook_url') ?? ''));
  back(r.ok ? { status: r.message } : { error: r.error });
}

export async function leadAddWebsite(formData: FormData) {
  await requireAuth();
  const leadId = Number(formData.get('lead_id'));
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) back({ error: 'Lead not found.' });
  if (lead!.websiteUrl) back({ error: 'This lead already has a website.' });

  const url = String(formData.get('website_url') ?? '').trim();
  if (!/^https?:\/\//i.test(url) || url.length > 500) back({ error: 'Enter a valid http(s) URL.' });
  if (SafeFetcher.isSocial(url)) back({ error: 'That is a social page — paste it in the Facebook field instead.' });

  db().update(leads).set({ websiteUrl: url, websiteStatus: 'unknown', updatedAt: ts() }).where(eq(leads.id, lead!.id)).run();
  audit('lead', lead!.id, 'website_added', { url });

  const result = await new PublicEmailFinder().find(url);
  const email = result.public_email ?? null;
  if (email) {
    db().update(leads).set({ publicEmail: email, emailSource: 'website', status: 'enriched', updatedAt: ts() })
      .where(eq(leads.id, lead!.id)).run();
    audit('lead', lead!.id, 'email_added', { by: 'website', email });
    back({ status: `Website saved — found published email ${email}; ${lead!.name} is now draftable.` });
  }
  back({ status: 'Website saved. No published email found on it — you can still add one manually.' });
}

export async function leadDraftNow(formData: FormData) {
  await requireAuth();
  const leadId = Number(formData.get('lead_id'));
  const lead = db().select().from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) back({ error: 'Lead not found.' });
  if (!lead!.publicEmail || Suppression.blocks(lead!.publicEmail)) back({ error: 'Lead needs a public email first.' });
  if (!new FirstEmailDrafter(new LlmClient()).draftable(lead!)) {
    back({ error: 'This lead already has a draft, or is not in a draftable state.' });
  }
  queueLeadDraft(leadId);
  back({ status: `Draft queued for ${lead!.name} — check Review shortly (queue worker must be running).` });
}

/** Import step 1: classify every row, stash them, show the preview. */
export async function importPreview(formData: FormData) {
  await requireAuth();
  const file = formData.get('csv');
  if (!(file instanceof File) || file.size === 0) back({ error: 'Choose a CSV file first.' });
  if (file!.size > 2 * 1024 * 1024) back({ error: 'CSV too large (2MB max).' });

  const rows = parseCsv(await file!.text());
  if (!rows) back({ error: 'CSV needs at least "name" and "city" columns.' });

  const classified = rows!.map((data) => ({ data, ...classifyRow(data) }));
  const counts: Record<Verdict, number> = { new: 0, duplicate: 0, invalid: 0, suppressed: 0 };
  for (const c of classified) counts[c.verdict]++;

  const token = randomUUID();
  db().insert(discoveryCache).values({
    key: `import:${token}`, payload: rows as unknown as never,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    createdAt: ts(), updatedAt: ts(),
  }).run();

  redirect(`/leads/import?token=${token}&new=${counts.new}&dup=${counts.duplicate}&inv=${counts.invalid}&sup=${counts.suppressed}`);
}

/** Import step 2: re-classify fresh, save only rows still 'new'. */
export async function importConfirm(formData: FormData) {
  await requireAuth();
  const token = String(formData.get('token') ?? '');
  const stash = db().select().from(discoveryCache).where(eq(discoveryCache.key, `import:${token}`)).get();
  if (!stash) back({ error: 'Nothing to import — upload the CSV again.' });
  db().delete(discoveryCache).where(eq(discoveryCache.key, `import:${token}`)).run();

  const rows = stash!.payload as unknown as CsvRow[];
  const counts: Record<Verdict, number> = { new: 0, duplicate: 0, invalid: 0, suppressed: 0 };
  for (const data of rows) {
    const { verdict } = classifyRow(data);
    counts[verdict]++;
    if (verdict === 'new') insertLead(data);
  }
  audit('lead', null, 'imported', counts);
  back({ status: `Import finished — ${counts.new} new, ${counts.duplicate} duplicate, ${counts.invalid} invalid, ${counts.suppressed} suppressed.` });
}
