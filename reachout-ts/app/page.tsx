import Link from 'next/link';
import { desc, eq, inArray, and, count } from 'drizzle-orm';
import { agentRuns, drafts, leads, replies } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { healthReport } from '@/lib/health';

const HUMAN_LABELS = ['stop', 'interested', 'not_interested', 'unknown'];

function rel(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pill(status: string) {
  const cls = status === 'ok' || status === 'finished' || status === 'sent' ? 'p-ok'
    : status === 'fail' || status === 'failed' ? 'p-bad' : 'p-warn';
  return <span className={`pill ${cls}`}>{status}</span>;
}

export default function OverviewPage() {
  const d = db();
  const c = (t: any) => d.select({ n: count() }).from(t).get()?.n ?? 0;
  const cw = (t: any, where: any) => d.select({ n: count() }).from(t).where(where).get()?.n ?? 0;

  const stats = [
    ['Leads', c(leads)],
    ['Awaiting review', cw(drafts, eq(drafts.status, 'pending'))],
    ['Approved', cw(drafts, eq(drafts.status, 'approved'))],
    ['Replies to answer', cw(replies, and(eq(replies.matched, true), inArray(replies.classification, HUMAN_LABELS)))],
    ['Bounces', cw(replies, inArray(replies.classification, ['bounce_hard', 'bounce_soft']))],
    ['Opted out / bounced', cw(leads, inArray(leads.status, ['opted_out', 'bounced']))],
    ['Follow-ups to review', cw(drafts, and(eq(drafts.kind, 'followup'), eq(drafts.status, 'pending')))],
  ];

  const health = healthReport();
  const runs = d.select().from(agentRuns).orderBy(desc(agentRuns.id)).limit(5).all();

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">Leads, drafts waiting for you, and recent agent runs.</p>

      <div className="stats">
        {stats.map(([label, n]) => (
          <div className="stat" key={label}><small>{label}</small><b>{n}</b></div>
        ))}
      </div>

      <div className="card">
        <h2>System health</h2>
        <table>
          <tbody>
            {health.map((h) => (
              <tr key={h.name}>
                <td>{pill(h.status)}</td>
                <td>{h.name}</td>
                <td><span className="meta">{h.detail}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Recent agent runs</h2>
        {runs.length === 0 ? (
          <div className="empty">No runs yet. Create a search profile on the Profiles page, then press Run now.</div>
        ) : (
          <table>
            <thead><tr><th>Started</th><th>Status</th><th>Steps</th><th>Leads</th><th>Drafts</th><th>Model</th><th></th></tr></thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{rel(run.startedAt)}</td>
                  <td>{pill(run.status)}</td>
                  <td>{run.stepsUsed}</td>
                  <td>{run.leadsSaved}</td>
                  <td>{run.draftsQueued}</td>
                  <td>{run.model}</td>
                  <td><Link className="meta" href={`/runs/${run.id}`}>View steps</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
