import { desc, eq } from 'drizzle-orm';
import { draftRevisions, drafts, leads } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { DraftRegenerator } from '@/lib/sending/draft-regenerator';
import { draftApprove, draftRegenerate, draftReject } from './actions';
import { leadSetFacebook } from '../leads/actions';

function rel(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const maxRegens = DraftRegenerator.MAX_REGENERATIONS;

  const pending = db().select().from(drafts).where(eq(drafts.status, 'pending'))
    .orderBy(desc(drafts.id)).all();
  const leadById = new Map(
    db().select().from(leads).all().map((l) => [l.id, l]),
  );
  const revisionsByDraft = new Map<number, typeof draftRevisions.$inferSelect[]>();
  for (const rev of db().select().from(draftRevisions).orderBy(desc(draftRevisions.id)).all()) {
    revisionsByDraft.set(rev.draftId, [...(revisionsByDraft.get(rev.draftId) ?? []), rev]);
  }

  return (
    <>
      <h1>Review queue</h1>
      <p className="sub">The agent drafts. Nothing is approved until you do it. Check the facts and open the Facebook page yourself, then edit if needed.</p>

      {status && <div className="flash">{status}</div>}
      {error && <div className="note">{error}</div>}

      {pending.length === 0 ? (
        <div className="card"><div className="empty">All caught up. No drafts waiting.</div></div>
      ) : (
        <div className="card">
          {pending.map((draft) => {
            const lead = leadById.get(draft.leadId)!;
            const revisions = revisionsByDraft.get(draft.id) ?? [];
            const gSearch = `https://www.google.com/search?q=${encodeURIComponent(`"${lead.name}" ${lead.city} facebook`)}`;
            return (
              <div className="draft" key={draft.id}>
                <div className="draft-head">
                  <strong>{lead.name} <span className="meta">· {lead.category} · {lead.city}</span></strong>
                  <span>
                    {draft.kind === 'followup' && <span className="pill p-info">Follow-up</span>}{' '}
                    <span className="meta">to {lead.publicEmail} · model: {draft.model}</span>
                  </span>
                </div>

                <div className="found">
                  <div><b>Found</b></div>
                  <ul>
                    <li>Website: <span className={`pill ${['none', 'social_only'].includes(lead.websiteStatus) ? 'p-warn' : 'p-info'}`}>{lead.websiteStatus}</span>
                      {lead.websiteUrl && <span className="meta"> {lead.websiteUrl}</span>}</li>
                    <li>Facebook:{' '}
                      {lead.facebookUrl ? (
                        <>
                          <a className="btn small" href={lead.facebookUrl} target="_blank" rel="noopener noreferrer">Open page</a>{' '}
                          <span className="meta">{lead.facebookConfidence} match, check it yourself</span>
                        </>
                      ) : <span className="meta">no page found</span>}{' '}
                      <a className="btn small" href={gSearch} target="_blank" rel="noopener noreferrer">Search on Google</a>
                      <form action={leadSetFacebook} className="inline-form">
                        <input type="hidden" name="lead_id" value={lead.id} />
                        <input type="url" name="facebook_url" placeholder="https://facebook.com/…" maxLength={500} style={{ width: '11rem' }} />
                        <button className="btn small" type="submit">Confirm page</button>
                      </form>
                    </li>
                    {lead.phone && <li>Phone: {lead.phone}</li>}
                    {(draft.found ?? []).map((fact, i) => <li key={i}>{fact}</li>)}
                  </ul>
                  {draft.suggestion && <div className="suggest"><b>Suggested:</b> {draft.suggestion}</div>}
                </div>

                <form action={draftApprove}>
                  <input type="hidden" name="draft_id" value={draft.id} />
                  <input type="text" name="subject" defaultValue={draft.subject} className="subject-input" maxLength={120} />
                  <textarea name="body" className="body" defaultValue={draft.body} />
                  <div className="actions">
                    <button className="btn primary" type="submit">Approve &amp; queue</button>
                    <button className="btn" type="submit" formAction={draftRegenerate} formNoValidate
                      disabled={draft.regenerationCount >= maxRegens}>
                      Regenerate{draft.regenerationCount > 0 ? ` (${draft.regenerationCount}/${maxRegens})` : ''}
                    </button>
                    <button className="btn danger" type="submit" formAction={draftReject} formNoValidate>Reject</button>
                  </div>
                </form>

                {revisions.length > 0 && (
                  <details className="revisions">
                    <summary className="meta">Previous versions ({revisions.length})</summary>
                    {revisions.map((rev) => (
                      <div className="revision" key={rev.id}>
                        <div className="meta">{rev.source} · {rel(rev.createdAt)} · <b>{rev.subject}</b></div>
                        <pre className="meta" style={{ whiteSpace: 'pre-wrap', margin: '2px 0 8px' }}>
                          {rev.body.length > 300 ? rev.body.slice(0, 300) + '…' : rev.body}
                        </pre>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
