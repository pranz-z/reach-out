import { asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { agentRuns, agentSteps, searchProfiles } from '@/lib/db/schema';
import { db } from '@/lib/db';

function j(v: unknown, n: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = db().select().from(agentRuns).where(eq(agentRuns.id, Number(id))).get();
  if (!run) notFound();
  const profile = run.profileId
    ? db().select().from(searchProfiles).where(eq(searchProfiles.id, run.profileId)).get()
    : undefined;
  const steps = db().select().from(agentSteps).where(eq(agentSteps.runId, run.id))
    .orderBy(asc(agentSteps.id)).all();

  const pill = `pill ${run.status === 'finished' ? 'p-ok' : run.status === 'failed' ? 'p-bad' : 'p-warn'}`;

  return (
    <>
      <h1>Run #{run.id}</h1>
      <p className="sub">
        {profile?.name ?? `profile ${run.profileId}`} ·{' '}
        <span className={pill}>{run.status}</span> ·{' '}
        {run.stepsUsed} steps · {run.leadsSaved} leads · {run.draftsQueued} drafts · {run.model}
        {run.error && <span className="meta"> · {run.error}</span>}
      </p>

      <div className="card">
        {steps.length === 0 ? <div className="empty">No steps recorded.</div> : (
          <table>
            <thead><tr><th>#</th><th>Step</th><th>Detail</th></tr></thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.id}>
                  <td className="meta">{s.id}</td>
                  <td>{s.tool ?? s.role}</td>
                  <td>
                    {s.arguments != null && <div className="meta">{j(s.arguments, 220)}</div>}
                    {s.result != null && <div>{j(s.result, 400)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
