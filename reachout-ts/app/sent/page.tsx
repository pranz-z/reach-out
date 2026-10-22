import { desc, eq, inArray } from 'drizzle-orm';
import { drafts, emails, failedJobs, leads } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { SendPolicy } from '@/lib/sending/send-policy';
import { enqueue } from '@/lib/queue';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { revalidatePath } from 'next/cache';

function rel(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function SentPage() {
  const d = db();
  const approved = d.select().from(drafts).where(eq(drafts.status, 'approved')).orderBy(desc(drafts.id)).all();
  const failed = d.select().from(drafts).where(inArray(drafts.status, ['failed', 'cancelled'])).orderBy(desc(drafts.id)).limit(100).all();
  const sent = d.select().from(emails).orderBy(desc(emails.id)).limit(200).all();
  const failedJobsRows = d.select().from(failedJobs).orderBy(desc(failedJobs.failedAt)).limit(50).all();
  const leadById = new Map(d.select().from(leads).all().map((l) => [l.id, l]));

  const windowOpen = SendPolicy.withinWindow();
  const paused = SendPolicy.paused();
  const sentToday = SendPolicy.sentToday();
  const dailyLimit = SendPolicy.dailyLimit();
  const nextWindow = SendPolicy.nextWindowStart();

  async function retryFailedJob(formData: FormData) {
    'use server';
    if (!(await currentUser())) redirect('/login');
    const id = Number(formData.get('job_id'));
    const row = db().select().from(failedJobs).where(eq(failedJobs.id, id)).get();
    if (!row) return;
    const payload = JSON.parse(row.payload) as { type?: string; payload?: Record<string, unknown> };
    if (payload.type) enqueue(payload.type as never, payload.payload ?? {});
    db().delete(failedJobs).where(eq(failedJobs.id, id)).run();
    audit('job', id, 'retried');
    revalidatePath('/sent');
  }

  async function forgetFailedJob(formData: FormData) {
    'use server';
    if (!(await currentUser())) redirect('/login');
    const id = Number(formData.get('job_id'));
    db().delete(failedJobs).where(eq(failedJobs.id, id)).run();
    audit('job', id, 'forgotten');
    revalidatePath('/sent');
  }

  return (
    <>
      <h1>Sent &amp; replies</h1>
      <p className="sub">
        Sends go out Mon–Fri {config.send.windowStart}:00–{config.send.windowEnd}:00 Asia/Manila with a warm-up daily cap.{' '}
        <span className={`pill ${windowOpen ? 'p-ok' : 'p-warn'}`}>{windowOpen ? 'window open' : 'window closed'}</span>{' '}
        {paused && <span className="pill p-warn">sending paused</span>}{' '}
        <span className="meta">sent today: {sentToday} / {dailyLimit}</span>{' '}
        {!windowOpen && <span className="meta">next window: {nextWindow.toLocaleString('en-US', { timeZone: config.send.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} Manila</span>}
      </p>
      {paused && <div className="card pad"><strong>Sending is paused.</strong> No emails will go out until you resume from Settings.</div>}

      <div className="card">
        <h2>Approved, awaiting send</h2>
        {approved.length === 0 ? <div className="empty">Nothing approved yet.</div> : (
          <table>
            <thead><tr><th>Business</th><th>To</th><th>Subject</th><th>Approved</th></tr></thead>
            <tbody>
              {approved.map((draft) => {
                const lead = draft.leadId ? leadById.get(draft.leadId) : undefined;
                return (
                  <tr key={draft.id}>
                    <td>{lead?.name}</td>
                    <td>{lead?.publicEmail}</td>
                    <td>{draft.subject}</td>
                    <td>{rel(draft.approvedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Failed / cancelled</h2>
        {failed.length === 0 ? <div className="empty">None.</div> : (
          <table>
            <thead><tr><th>Business</th><th>To</th><th>Subject</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {failed.map((draft) => {
                const lead = draft.leadId ? leadById.get(draft.leadId) : undefined;
                return (
                  <tr key={draft.id}>
                    <td>{lead?.name ?? '—'}</td>
                    <td>{lead?.publicEmail ?? '—'}</td>
                    <td>{draft.subject}</td>
                    <td><span className="pill p-warn">{draft.status}</span></td>
                    <td><span className="meta">{draft.failureReason ?? '—'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Sent</h2>
        {sent.length === 0 ? <div className="empty">No emails sent yet.</div> : (
          <table>
            <thead><tr><th>Business</th><th>To</th><th>Sent</th><th>Status</th><th>Message-ID</th></tr></thead>
            <tbody>
              {sent.map((email) => {
                const lead = email.leadId ? leadById.get(email.leadId) : undefined;
                return (
                  <tr key={email.id}>
                    <td>{lead?.name ?? '—'}</td>
                    <td>{lead?.publicEmail ?? '—'}</td>
                    <td>{rel(email.sentAt)}</td>
                    <td><span className="pill p-ok">{email.deliveryStatus}</span></td>
                    <td><span className="meta">{email.messageId ? email.messageId.slice(0, 28) : '—'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Failed queue jobs</h2>
        {failedJobsRows.length === 0 ? <div className="empty">None — the queue is clean.</div> : (
          <table>
            <thead><tr><th>Job</th><th>Queue</th><th>Failed</th><th>Error</th><th></th></tr></thead>
            <tbody>
              {failedJobsRows.map((job) => {
                let name = 'job';
                try { name = (JSON.parse(job.payload) as { type?: string }).type ?? 'job'; } catch { /* raw payload */ }
                return (
                  <tr key={job.id}>
                    <td><span className="meta">{name}</span></td>
                    <td>{job.queue}</td>
                    <td><span className="meta">{rel(job.failedAt)}</span></td>
                    <td><span className="meta">{job.exception.slice(0, 120)}</span></td>
                    <td>
                      <form action={retryFailedJob} className="inline-form">
                        <input type="hidden" name="job_id" value={job.id} />
                        <button className="btn small" type="submit">Retry</button>
                      </form>
                      <form action={forgetFailedJob} className="inline-form">
                        <input type="hidden" name="job_id" value={job.id} />
                        <button className="btn small" type="submit">Forget</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
