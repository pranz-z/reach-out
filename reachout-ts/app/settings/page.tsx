import { desc, isNotNull, count } from 'drizzle-orm';
import { suppressions } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { Setting } from '@/lib/settings';
import { ApiUsage } from '@/lib/usage';
import { suppressionAdd, suppressionRemove, toggleDiscovery, toggleSending } from './actions';

function rel(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const { status, error } = await searchParams;
  const sendingPaused = Setting.bool('sending_paused');
  const discoveryPaused = Setting.bool('discovery_paused');
  const usage = ApiUsage.summary();
  const list = db().select().from(suppressions).where(isNotNull(suppressions.email))
    .orderBy(desc(suppressions.id)).limit(100).all();
  const hashed = db().select({ n: count() }).from(suppressions)
    .where(isNotNull(suppressions.emailHash)).get()?.n ?? 0;

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Read-only view of what is set in <code>.env</code>. Change values there, then restart the server.</p>

      {status && <div className="flash">{status}</div>}
      {error && <div className="note">{error}</div>}

      <div className="card">
        <h2>Sending</h2>
        <form action={toggleSending} className="inline-form pad">
          <button className="btn" type="submit">{sendingPaused ? 'Resume sending' : 'Pause sending'}</button>
          <span className={`pill ${sendingPaused ? 'p-warn' : 'p-ok'}`}>{sendingPaused ? 'paused — nothing sends' : 'active'}</span>
        </form>
        <div className="row"><label>Window</label><div>Mon–Fri {config.send.windowStart}:00–{config.send.windowEnd}:00 {config.send.timezone}</div></div>
        <div className="row"><label>Daily cap</label><div>week 1 = {config.send.warmupWeek1}/day, week 2 = {config.send.warmupWeek2}/day, then {config.dailySendLimit}/day</div></div>
        <div className="row"><label>Mailer</label><div>{config.mail.mailer} (from: {config.senderAddress}, replies to: {config.replyToAddress})</div></div>
      </div>

      <div className="card">
        <h2>Discovery</h2>
        <form action={toggleDiscovery} className="inline-form pad">
          <button className="btn" type="submit">{discoveryPaused ? 'Resume discovery' : 'Pause discovery'}</button>
          <span className={`pill ${discoveryPaused ? 'p-warn' : 'p-ok'}`}>{discoveryPaused ? 'paused — no agent runs' : 'active'}</span>
        </form>
        <div className="row"><label>Provider</label><div>{config.discovery.provider} · province default {config.discovery.province}</div></div>
      </div>

      <div className="card">
        <h2>API usage today</h2>
        <table>
          <thead><tr><th>Service</th><th>Used</th><th>Daily budget</th></tr></thead>
          <tbody>
            {Object.entries(usage).map(([service, u]) => (
              <tr key={service}>
                <td>{service}</td>
                <td>{u.used}{u.tokens > 0 ? ` (${u.tokens.toLocaleString()} tokens)` : ''}</td>
                <td>{u.budget > 0 ? u.budget : 'unlimited'}{' '}
                  {u.budget > 0 && u.used >= u.budget && <span className="pill p-warn">budget reached</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>LLM endpoint (OpenAI-compatible)</h2>
        <div className="row"><label>Base URL</label><div>{config.llm.baseUrl}</div></div>
        <div className="row"><label>Model</label><div>{config.llm.model}</div></div>
        <div className="row"><label>API key</label><div>{config.llm.apiKey ? 'set' : 'not set'}</div></div>
      </div>

      <div className="card">
        <h2>Agent limits</h2>
        <div className="row"><label>Max steps per run</label><div>{config.agent.maxSteps}</div></div>
        <div className="row"><label>Max leads per run</label><div>{config.agent.maxLeadsPerRun}</div></div>
        <div className="row"><label>Manual approval</label><div>{config.requireApproval ? 'required' : 'off'}</div></div>
      </div>

      <div className="card">
        <h2>Suppression list</h2>
        <form action={suppressionAdd} className="inline-form pad">
          <input type="email" name="email" placeholder="Add an opted-out address" required />
          <button className="btn" type="submit">Add</button>
        </form>
        {hashed > 0 && <p className="meta pad">{hashed} forgotten opt-out{hashed === 1 ? '' : 's'} kept only as hashes — they still block sends.</p>}
        {list.length === 0 ? (
          <div className="empty">No opted-out addresses.</div>
        ) : (
          <table>
            <thead><tr><th>Address</th><th>Reason</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{s.email}</td><td>{s.reason}</td><td>{rel(s.createdAt)}</td>
                  <td>
                    <form action={suppressionRemove} className="inline-form">
                      <input type="hidden" name="suppression_id" value={s.id} />
                      <button className="btn small" type="submit">Undo</button>
                    </form>
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
