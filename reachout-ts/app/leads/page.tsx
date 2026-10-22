import Link from 'next/link';
import { desc, eq, and, inArray } from 'drizzle-orm';
import { drafts, leads } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { leadAddEmail, leadAddWebsite, leadSetFacebook, leadDraftNow, importPreview } from './actions';

function host(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const rows = db().select().from(leads).orderBy(desc(leads.id)).limit(200).all();

  // Blocking first drafts per lead (pending/approved/sent kind='first').
  const blocking = new Set(
    db().select({ leadId: drafts.leadId }).from(drafts)
      .where(and(eq(drafts.kind, 'first'), inArray(drafts.status, ['pending', 'approved', 'sent'])))
      .all().map((r) => r.leadId),
  );

  const gSearch = (name: string, city: string | null) =>
    `https://www.google.com/search?q=${encodeURIComponent(`"${name}" ${city ?? ''} facebook`)}`;

  const statusPill = (s: string) =>
    `pill ${['opted_out', 'rejected'].includes(s) ? 'p-bad' : ['drafted', 'approved'].includes(s) ? 'p-warn' : 'p-info'}`;
  const webPill = (s: string) => `pill ${['none', 'social_only'].includes(s) ? 'p-warn' : 'p-info'}`;

  return (
    <>
      <h1>Leads</h1>
      <p className="sub">Public business details only. Import a CSV, or let the agent find leads.</p>

      {status && <div className="flash">{status}</div>}
      {error && <div className="note">{error}</div>}

      <form action={importPreview} className="inline-form">
        <input type="file" name="csv" accept=".csv,.txt" required />
        <button className="btn primary" type="submit">Preview import</button>
        <a className="btn" href="/leads/template" download>Download CSV template</a>
      </form>
      <p className="meta">
        Columns: name, city (required); category, public_email, phone, website, facebook_url.
        Imports show a preview of new / duplicate / invalid / suppressed rows before anything is saved.
        Emails must be addresses the business itself publishes as its contact — never guessed.
      </p>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No leads yet.</div>
        ) : (
          <table>
            <thead><tr><th>Business</th><th>Category</th><th>City</th><th>Website</th><th>Facebook</th><th>Public email</th><th>Fit</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((lead) => (
                <tr key={lead.id}>
                  <td>{lead.name}</td>
                  <td>{lead.category}</td>
                  <td>{lead.city}</td>
                  <td>
                    {lead.websiteUrl ? (
                      <>
                        <a href={lead.websiteUrl} target="_blank" rel="noopener noreferrer">{host(lead.websiteUrl)}</a>{' '}
                        <span className={webPill(lead.websiteStatus)}>{lead.websiteStatus}</span>
                      </>
                    ) : (
                      <>
                        <span className={webPill(lead.websiteStatus)}>{lead.websiteStatus}</span>
                        <form action={leadAddWebsite} className="inline-form">
                          <input type="hidden" name="lead_id" value={lead.id} />
                          <input type="url" name="website_url" placeholder="https://business.com" maxLength={500} required style={{ width: '10rem' }} />
                          <button className="btn small" type="submit">Add website</button>
                        </form>
                        <div className="meta">Saves the URL and checks it for a published contact email.</div>
                      </>
                    )}
                  </td>
                  <td>
                    {lead.facebookUrl && (
                      <><a href={lead.facebookUrl} target="_blank" rel="noopener noreferrer">Open page</a>{' '}
                        <span className="meta">({lead.facebookConfidence})</span></>
                    )}
                    <a className="meta" href={gSearch(lead.name, lead.city)} target="_blank" rel="noopener noreferrer">Search on Google</a>
                    <form action={leadSetFacebook} className="inline-form">
                      <input type="hidden" name="lead_id" value={lead.id} />
                      <input type="url" name="facebook_url" placeholder="https://facebook.com/…" maxLength={500} style={{ width: '10rem' }} />
                      <button className="btn small" type="submit">Confirm</button>
                    </form>
                  </td>
                  <td>
                    {lead.publicEmail ? lead.publicEmail : lead.status === 'phone_only' ? (
                      <>
                        <form action={leadAddEmail} className="inline-form">
                          <input type="hidden" name="lead_id" value={lead.id} />
                          <input type="email" name="email" placeholder="contact@business.example" maxLength={190} required style={{ width: '11rem' }} />
                          <button className="btn small" type="submit">Add public email</button>
                        </form>
                        <div className="meta">Only an address the business itself publishes.</div>
                      </>
                    ) : '—'}
                  </td>
                  <td>{lead.fitScore ?? '—'}</td>
                  <td>
                    <span className={statusPill(lead.status)}>{lead.status}</span>
                    {lead.status === 'enriched' && lead.publicEmail && !blocking.has(lead.id) && (
                      <form action={leadDraftNow} className="inline-form">
                        <input type="hidden" name="lead_id" value={lead.id} />
                        <button className="btn small" type="submit">Draft now</button>
                      </form>
                    )}
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
