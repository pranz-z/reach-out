'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { replies } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import { LABELS, Label } from '@/lib/replies/classifier';
import { ReplyProcessor } from '@/lib/replies/processor';
import { randomBytes } from 'node:crypto';

async function requireAuth() {
  if (!(await currentUser())) redirect('/login');
}

function back(params: Record<string, string>): never {
  redirect(`/replies?${new URLSearchParams(params).toString()}`);
}

/** Manual entry — same processor path as a polled message. */
export async function replyStore(formData: FormData) {
  await requireAuth();
  const from = String(formData.get('from_address') ?? '').trim().toLowerCase();
  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('body') ?? '');
  const labelRaw = String(formData.get('label') ?? 'auto');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) back({ error: 'A valid from address is required.' });
  if (body.trim() === '' || body.length > 20000) back({ error: 'Body is required (≤20000 chars).' });
  const label = labelRaw === 'auto' ? null : (LABELS.includes(labelRaw as Label) ? labelRaw as Label : null);

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const reply = new ReplyProcessor().handle({
    messageId: `manual-${stamp}-${randomBytes(4).toString('hex')}`,
    inReplyTo: null,
    references: [],
    fromAddress: from,
    subject: subject || '(manual entry)',
    receivedAt: new Date(),
    body,
    headers: {},
  }, 'manual', label);

  back({ status: reply ? `Reply saved as '${reply.classification}'.` : 'Duplicate message — already stored.' });
}

/** Human label override. `stop` triggers suppression; leaving `stop` never removes it. */
export async function replyRelabel(formData: FormData) {
  await requireAuth();
  const id = Number(formData.get('reply_id'));
  const label = String(formData.get('label') ?? '');
  const reply = db().select().from(replies).where(eq(replies.id, id)).get();
  if (!reply) back({ error: 'Reply not found.' });
  new ReplyProcessor().relabel(reply!, label);
  back({ status: `Reply #${id} relabelled '${label}'.` });
}
