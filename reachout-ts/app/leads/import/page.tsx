import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { discoveryCache } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { classifyRow, CsvRow, Verdict } from '@/lib/leads';
import { importConfirm } from '../actions';

const PILLS: Record<Verdict, string> = {
  new: 'p-ok', duplicate: 'p-info', invalid: 'p-warn', suppressed: 'p-bad',
};

export default async function ImportPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const stash = token
    ? db().select().from(discoveryCache).where(eq(discoveryCache.key, `import:${token}`)).get()
    : undefined;
  if (!stash) redirect('/leads?error=' + encodeURIComponent('Nothing to import — upload the CSV again.'));

  const rows = (stash!.payload as unknown as CsvRow[]).map((data) => ({ data, ...classifyRow(data) }));
  const counts: Record<Verdict, number> = { new: 0, duplicate: 0, invalid: 0, suppressed: 0 };
  for (const r of rows) counts[r.verdict]++;

  return (
    <>
      <h1>Import preview</h1>
      <p className="sub">Nothing is saved yet — review the verdicts, then confirm or cancel.</p>

      <div className="stats">
        <div className="stat"><small>New</small><b>{counts.new}</b></div>
        <div className="stat"><small>Duplicate</small><b>{counts.duplicate}</b></div>
        <div className="stat"><small>Invalid</small><b>{counts.invalid}</b></div>
        <div className="stat"><small>Suppressed</small><b>{counts.suppressed}</b></div>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>City</th><th>Email</th><th>Verdict</th><th>Reason</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.data.name}</td>
                <td>{r.data.city}</td>
                <td>{r.data.public_email ?? '—'}</td>
                <td><span className={`pill ${PILLS[r.verdict]}`}>{r.verdict}</span></td>
                <td><span className="meta">{r.reason || '—'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {counts.new > 0 ? (
          <form action={importConfirm} className="inline-form pad">
            <input type="hidden" name="token" value={token} />
            <button className="btn primary" type="submit">Save {counts.new} new lead(s)</button>
            <a className="btn" href="/leads">Cancel</a>
          </form>
        ) : (
          <div className="empty">No importable rows — every row is duplicate, invalid, or suppressed. <a href="/leads">Back to leads</a></div>
        )}
      </div>
    </>
  );
}
