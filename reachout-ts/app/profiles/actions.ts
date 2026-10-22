'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { searchProfiles } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { ts } from '@/lib/config';
import { audit } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { Setting } from '@/lib/settings';
import { queueProfileRun } from '@/lib/jobs';

async function requireAuth() {
  if (!(await currentUser())) redirect('/login');
}

function back(params: Record<string, string>): never {
  redirect(`/profiles?${new URLSearchParams(params).toString()}`);
}

function validated(formData: FormData): { name: string; categories: string[]; cities: string[]; dailyCap: number } | string {
  const name = String(formData.get('name') ?? '').trim();
  const split = (raw: string) => raw.split(',').map((s) => s.trim()).filter((s) => s !== '' && s.length <= 60);
  const categories = split(String(formData.get('categories') ?? ''));
  const cities = split(String(formData.get('cities') ?? ''));
  const dailyCap = Math.min(1000, Math.max(0, Number(formData.get('daily_cap') ?? 10) || 10));
  if (name === '' || name.length > 80) return 'Name is required (≤80 chars).';
  if (categories.length === 0) return 'At least one category is required.';
  if (cities.length === 0) return 'At least one city is required.';
  return { name, categories, cities, dailyCap };
}

export async function profileCreate(formData: FormData) {
  await requireAuth();
  const v = validated(formData);
  if (typeof v === 'string') back({ error: v });
  const id = db().insert(searchProfiles).values({ ...v, createdAt: ts(), updatedAt: ts() }).run().lastInsertRowid;
  audit('search_profile', Number(id), 'created', { name: v.name });
  back({ status: `Profile "${v.name}" created.` });
}

export async function profileUpdate(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('profile_id'));
  const v = validated(formData);
  if (typeof v === 'string') back({ error: v });
  db().update(searchProfiles).set({ ...v, updatedAt: ts() }).where(eq(searchProfiles.id, id)).run();
  audit('search_profile', id, 'updated', { name: v.name });
  back({ status: `Profile "${v.name}" updated.` });
}

export async function profileToggle(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('profile_id'));
  const p = db().select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
  if (!p) back({ error: 'Profile not found.' });
  db().update(searchProfiles).set({ active: !p!.active, updatedAt: ts() }).where(eq(searchProfiles.id, id)).run();
  audit('search_profile', id, p!.active ? 'deactivated' : 'activated');
  back({ status: `Profile "${p!.name}" ${p!.active ? 'deactivated.' : 'activated.'}` });
}

export async function profileRunNow(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('profile_id'));
  const r = queueProfileRun(id);
  if (!r.ok) back({ error: r.error });

  const profile = db().select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
  let status = `Run queued for "${profile?.name}" — watch Overview for the result.`;
  const hb = Setting.get('queue_heartbeat');
  if (!hb || Date.parse(hb) < Date.now() - 3 * 60 * 1000) {
    status += ' Note: the queue worker does not seem to be running — start it (npm run worker) or the run will wait.';
  }
  back({ status });
}
