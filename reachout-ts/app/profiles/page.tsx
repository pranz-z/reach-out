import { desc, eq, count } from 'drizzle-orm';
import { leads, searchProfiles } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { profileCreate, profileRunNow, profileToggle, profileUpdate } from './actions';

const input = { maxWidth: 220 };
const inputSm = { maxWidth: 90 };

export default async function ProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const profiles = db().select().from(searchProfiles).orderBy(desc(searchProfiles.id)).all();
  const leadCounts = new Map(
    db().select({ profileId: leads.profileId, n: count() }).from(leads).groupBy(leads.profileId).all()
      .map((r) => [r.profileId, r.n]),
  );

  return (
    <>
      <h1>Search profiles</h1>
      <p className="sub">
        What the agent looks for on its weekday-morning runs.{' '}
        <b>This tool is for Philippine businesses only</b> — cities should be PH cities/municipalities.
      </p>

      {status && <div className="flash">{status}</div>}
      {error && <div className="note">{error}</div>}

      <div className="card">
        <h2>New profile</h2>
        <form action={profileCreate}>
          <div className="actions" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="text" name="name" placeholder="Profile name" required className="subject-input" style={input} />
            <input type="text" name="categories" placeholder="categories, e.g. cafe, bakery" required className="subject-input" style={{ maxWidth: 320 }} />
            <input type="text" name="cities" placeholder="cities, e.g. Guagua, Bacolor" required className="subject-input" style={{ maxWidth: 320 }} />
            <input type="number" name="daily_cap" placeholder="cap/day" defaultValue={10} min={0} className="subject-input" style={inputSm} />
            <button className="btn primary" type="submit">Create</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Profiles</h2>
        {profiles.length === 0 ? (
          <div className="empty">No profiles yet.</div>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Categories</th><th>Cities</th><th>Cap/day</th><th>Leads</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>
                    <form action={profileUpdate} id={`p${p.id}`}>
                      <input type="hidden" name="profile_id" value={p.id} />
                      <input type="text" name="name" defaultValue={p.name} required className="subject-input" style={{ maxWidth: 160 }} />
                    </form>
                  </td>
                  <td><input form={`p${p.id}`} type="text" name="categories" defaultValue={p.categories.join(', ')} required className="subject-input" style={{ maxWidth: 220 }} /></td>
                  <td><input form={`p${p.id}`} type="text" name="cities" defaultValue={p.cities.join(', ')} required className="subject-input" style={{ maxWidth: 220 }} /></td>
                  <td><input form={`p${p.id}`} type="number" name="daily_cap" defaultValue={p.dailyCap} min={0} className="subject-input" style={{ maxWidth: 80 }} /></td>
                  <td>{leadCounts.get(p.id) ?? 0}</td>
                  <td><span className={`pill ${p.active ? 'p-ok' : 'p-warn'}`}>{p.active ? 'active' : 'inactive'}</span></td>
                  <td>
                    <button className="btn small" type="submit" form={`p${p.id}`}>Save</button>
                    <form action={profileToggle} className="inline-form">
                      <input type="hidden" name="profile_id" value={p.id} />
                      <button className="btn small" type="submit">{p.active ? 'Deactivate' : 'Activate'}</button>
                    </form>
                    {p.active && (
                      <form action={profileRunNow} className="inline-form">
                        <input type="hidden" name="profile_id" value={p.id} />
                        <button className="btn small primary" type="submit" title="Run the agent for this profile now (queued)">Run now</button>
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
