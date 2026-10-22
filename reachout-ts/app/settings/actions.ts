'use server';

import { and, eq, isNull, like, or, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { drafts, leads, suppressions } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { ts } from '@/lib/config';
import { audit } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { Setting } from '@/lib/settings';
import { Suppression } from '@/lib/suppression';

async function requireAuth() {
  if (!(await currentUser())) redirect('/login');
}

function back(params: Record<string, string>): never {
  redirect(`/settings?${new URLSearchParams(params).toString()}`);
}

export async function toggleSending() {
  await requireAuth();
  Setting.setBool('sending_paused', !Setting.bool('sending_paused'));
  audit('settings', null, Setting.bool('sending_paused') ? 'sending_paused' : 'sending_resumed');
  back({ status: Setting.bool('sending_paused') ? 'Sending paused.' : 'Sending resumed.' });
}

export async function toggleDiscovery() {
  await requireAuth();
  Setting.setBool('discovery_paused', !Setting.bool('discovery_paused'));
  audit('settings', null, Setting.bool('discovery_paused') ? 'discovery_paused' : 'discovery_resumed');
  back({ status: Setting.bool('discovery_paused') ? 'Discovery paused.' : 'Discovery resumed.' });
}

/** Manually record an opt-out. Blocks the address and its domain; cancels queued approved drafts. */
export async function suppressionAdd(formData: FormData) {
  await requireAuth();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) back({ error: 'Enter a valid email address.' });
  const domain = email.split('@')[1] ?? '';

  Suppression.add(email, 'manual opt-out');

  const affected = db().select().from(leads).where(
    domain !== ''
      ? or(eq(leads.publicEmail, email), like(leads.publicEmail, `%@${domain}`))
      : eq(leads.publicEmail, email),
  ).all();

  let cancelled = 0;
  for (const lead of affected) {
    db().update(leads).set({ status: 'opted_out', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
    const approved = db().select().from(drafts)
      .where(and(eq(drafts.leadId, lead.id), eq(drafts.status, 'approved'))).all();
    for (const draft of approved) {
      db().update(drafts).set({ status: 'cancelled', failureReason: 'recipient opted out before send', updatedAt: ts() })
        .where(eq(drafts.id, draft.id)).run();
      audit('draft', draft.id, 'cancelled_by_suppression', { lead_id: lead.id, email: lead.publicEmail });
      cancelled++;
    }
  }
  audit('suppression', null, 'added', { email });
  back({ status: `${email} added to the suppression list. ${cancelled} approved draft(s) cancelled.` });
}

/** One-click undo — removes the paired domain row only when no other suppressed address needs it. */
export async function suppressionRemove(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('suppression_id'));
  const row = db().select().from(suppressions).where(eq(suppressions.id, id)).get();
  if (!row) back({ error: 'Suppression not found.' });
  const email = row.email;
  const label = email ?? row.domain;
  db().delete(suppressions).where(eq(suppressions.id, id)).run();

  if (email) {
    const domain = email.split('@')[1] ?? '';
    if (domain !== '') {
      const others = db().select({ id: suppressions.id }).from(suppressions)
        .where(and(eq(suppressions.domain, domain), sql`email IS NOT NULL`)).limit(1).all();
      if (others.length === 0) {
        db().delete(suppressions).where(and(eq(suppressions.domain, domain), isNull(suppressions.email))).run();
      }
    }
  }
  audit('suppression', null, 'removed', { target: label });
  back({ status: `${label} removed from the suppression list.` });
}

