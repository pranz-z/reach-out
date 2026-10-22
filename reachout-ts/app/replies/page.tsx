import { desc, eq, and, inArray, count } from 'drizzle-orm';
import { leads, replies } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { LABELS } from '@/lib/replies/classifier';
import { replyRelabel, replyStore } from './actions';

const HUMAN_LABELS = ['stop', 'interested', 'not_interested', 'unknown'];

function rel(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const PILL: Record<string, string> = {
  stop: 'p-bad', bounce_hard: 'p-bad', bounce_soft: 'p-warn',
  interested: 'p-ok', auto_reply: 'p-info', not_interested: 'p-warn', unknown: 'p-warn',
};

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const matched = db().select().from(replies).where(eq(replies.matched, true))
    .orderBy(desc(replies.receivedAt)).limit(200).all();
  const unmatched = db().select().from(replies).where(eq(replies.matched, false))
    .orderBy(desc(replies.receivedAt)).limit(100).all();
  const awaiting = db().select({ n: count() }).from(replies)
    .where(and(eq(replies.matched, true), inArray(replies.classification, HUMAN_LABELS))).get()?.n ?? 0;
  const leadById = new Map(db().select().from(leads).all().map((l) => [l.id, l]));

  const relabelForm = (r: typeof replies.$inferSelect, enabled: boolean) => (
    <form action={replyRelabel} className="inline-form">
      <input type="hidden" name="reply_id" value={r.id} />
      <select name="label" defaultValue={r.classification ?? 'unknown'} disabled={!enabled}>
        {LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      {enabled && <button className="btn small" type="submit">Set label</button>}
    </form>
  );

  return (
    <>
      <h1>Replies</h1>
      <p className="sub">
        {awaiting} repl{awaiting === 1 ? 'y' : 'ies'} to answer. Paste an email below when no inbox is connected —
        it goes through the same classifier as polled mail.
      </p>

      {status && <div className="flash">{status}</div>}
      {error && <div className="note">{error}</div>}

      <div className="card">
        <h2>Add a reply manually</h2>
        <form action={replyStore}>
          <div className="actions" style={{ alignItems: 'flex-start', gap: 8 }}>
            <input type="email" name="from_address" placeholder="From address" required style={{ maxWidth: 260 }} />
            <input type="text" name="subject" placeholder="Subject (optional)" style={{ maxWidth: 320 }} />
            <select name="label" defaultValue="auto">
              <option value="auto">Classify automatically</option>
              {LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <textarea name="body" className="body" placeholder="Paste the reply text…" required style={{ minHeight: 110, marginTop: 8 }} />
          <div className="actions"><button className="btn primary" type="submit">Process reply</button></div>
        </form>
      </div>

      <div className="card">
        <h2>Matched replies</h2>
        {matched.length === 0 ? <div className="empty">No replies yet.</div> : (
          <table>
            <thead><tr><th>Received</th><th>From</th><th>Lead</th><th>Snippet</th><th>Label</th></tr></thead>
            <tbody>
              {matched.map((r) => (
                <tr key={r.id}>
                  <td><span className="meta">{rel(r.receivedAt)}</span></td>
                  <td>{r.fromAddress}</td>
                  <td>{r.leadId ? leadById.get(r.leadId)?.name : '—'}</td>
                  <td>
                    <span className="meta">{r.snippet?.slice(0, 140)}</span>
                    {r.needsReview ? <div className="meta" style={{ color: 'var(--warn)' }}>bounce format unrecognized — check it</div> : null}
                  </td>
                  <td>
                    <span className={`pill ${PILL[r.classification ?? 'unknown']}`}>{r.classification}</span>
                    {relabelForm(r, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Unmatched</h2>
        <p className="sub">Messages that matched no lead — no automatic action was taken. Relabelling here only stores the label.</p>
        {unmatched.length === 0 ? <div className="empty">None.</div> : (
          <table>
            <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Label</th></tr></thead>
            <tbody>
              {unmatched.map((r) => (
                <tr key={r.id}>
                  <td><span className="meta">{rel(r.receivedAt)}</span></td>
                  <td>{r.fromAddress}</td>
                  <td><span className="meta">{r.subject}</span></td>
                  <td>{relabelForm(r, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
