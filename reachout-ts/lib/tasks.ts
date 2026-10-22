import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, asc, count, eq, gte, inArray, lt } from 'drizzle-orm';
import { agentRuns, agentSteps, drafts, emails, leads, replies, searchProfiles } from './db/schema';
import { db, raw } from './db';
import { audit } from './audit';
import { config, manilaNow, todayManila, ts } from './config';
import { enqueue } from './queue';
import { Setting } from './settings';
import { Suppression } from './suppression';
import { SendPolicy } from './sending/send-policy';
import { FollowupDrafter } from './sending/followup-drafter';
import { LlmClient } from './llm/client';
import { ImapSource } from './replies/imap-source';
import { ReplyProcessor } from './replies/processor';

/**
 * The scheduled operations Laravel ran via `Schedule::command(...)`.
 * cli.ts exposes them as one-shot commands; scheduler.ts runs them on
 * the same intervals as routes/console.php.
 */

/** reachout:send-approved — queue approved drafts inside the send window. */
export function sendApproved(): string {
  if (SendPolicy.paused()) return 'Sending is paused (Settings). Nothing queued.';
  if (!SendPolicy.withinWindow()) {
    return `Outside the send window (Mon-Fri ${config.send.windowStart}:00-${config.send.windowEnd}:00 Asia/Manila). Nothing queued.`;
  }
  const quota = SendPolicy.remainingToday();
  if (quota <= 0) return `Daily send limit reached (${SendPolicy.dailyLimit()}). Nothing queued.`;

  const due = db().select().from(drafts)
    .where(eq(drafts.status, 'approved'))
    .orderBy(asc(drafts.approvedAt)).limit(quota).all();

  let queued = 0, offset = 0;
  for (const draft of due) {
    const lead = db().select().from(leads).where(eq(leads.id, draft.leadId)).get();
    if (!lead?.publicEmail) continue;
    if (Suppression.blocks(lead.publicEmail)) {
      // Same pre-check sendDraft does — an opted-out lead never reaches the job.
      db().update(leads).set({ status: 'opted_out', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
      db().update(drafts).set({ status: 'cancelled', failureReason: 'address suppressed before send', updatedAt: ts() })
        .where(eq(drafts.id, draft.id)).run();
      audit('email', null, 'send_blocked', { reason: 'suppressed', lead_id: lead.id, draft_id: draft.id });
      continue;
    }
    const { minDelaySeconds: min, maxDelaySeconds: max } = config.send;
    offset += min + Math.floor(Math.random() * (max - min + 1));
    enqueue('send_draft', { draft_id: draft.id }, offset);
    queued++;
  }
  return `Queued ${queued} send job(s). Sent today: ${SendPolicy.sentToday()} / ${SendPolicy.dailyLimit()}.`;
}

/** reachout:poll-replies — fetch UNSEEN inbox messages into the processor. */
export async function pollReplies(): Promise<string> {
  if (!ImapSource.configured()) return 'IMAP not configured (IMAP_HOST unset) — skipping reply poll.';
  const processor = new ReplyProcessor();
  const fetched = await ImapSource.fetch();
  let stored = 0;
  for (const m of fetched) {
    if (processor.handle(m, 'imap')) stored++;
  }
  return `Polled replies: ${fetched.length} fetched, ${stored} new.`;
}

/** reachout:draft-followups — one reviewed follow-up per eligible sent lead. */
export async function draftFollowups(): Promise<string> {
  const drafter = new FollowupDrafter(new LlmClient());
  const eligible = drafter.eligibleLeads();
  let created = 0;
  for (const lead of eligible) {
    if (await drafter.draftFor(lead)) created++;
  }
  return `Follow-ups: ${eligible.length} eligible, ${created} drafted.`;
}

/**
 * reachout:discover — one agent run per active profile, enqueued for the
 * worker. Back-pressure: skipped entirely when discovery is paused or
 * the review queue is full; per-profile skips on daily_cap or a run
 * already in progress. Deadline semantics (AGENT_RUN_MINUTES) travel
 * with the job payload.
 */
export function discover(): string {
  if (Setting.bool('discovery_paused')) return 'Discovery is paused (Settings).';

  const pending = db().select({ n: count() }).from(drafts).where(eq(drafts.status, 'pending')).get()!.n;
  if (pending >= config.discovery.reviewQueueMax) {
    return `Review queue holds ${pending} pending drafts (max ${config.discovery.reviewQueueMax}) — run skipped.`;
  }

  const profiles = db().select().from(searchProfiles).where(eq(searchProfiles.active, true)).all();
  if (!profiles.length) return 'No active search profiles.';

  const maxSeconds = config.discovery.runMinutes * 60;
  const utcToday = new Date().toISOString().slice(0, 10); // leads.created_at is UTC — Laravel used today() the same way
  let queued = 0, skipped = 0;
  for (const p of profiles) {
    const savedToday = db().select({ n: count() }).from(leads)
      .where(and(eq(leads.profileId, p.id), gte(leads.createdAt, `${utcToday} 00:00:00`))).get()!.n;
    if (p.dailyCap > 0 && savedToday >= p.dailyCap) { skipped++; continue; }
    const running = db().select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.profileId, p.id), eq(agentRuns.status, 'running'))).limit(1).all();
    if (running.length) { skipped++; continue; }
    enqueue('run_profile_agent', { profile_id: p.id, max_seconds: maxSeconds });
    audit('search_profile', p.id, 'run_queued', { via: 'scheduler' });
    queued++;
  }
  return `Discovery: queued ${queued} profile run(s)` + (skipped ? ` (${skipped} skipped — cap or already running).` : '.');
}

/**
 * reachout:prune — retention sweep. Clears personal text (reply snippets
 * + headers) and agent step logs past the snippet window; deletes dead
 * leads (rejected/phone_only) past the dead-lead window. Suppressions
 * are never pruned.
 */
export function prune(): string {
  const snippetCutoff = ts(new Date(Date.now() - config.privacy.snippetDays * 86400000));
  const leadCutoff = ts(new Date(Date.now() - config.privacy.deadLeadDays * 86400000));

  const old = db().select().from(replies).where(lt(replies.receivedAt, snippetCutoff)).all();
  let snippets = 0;
  for (const r of old) {
    if (r.snippet !== null || r.headers !== null) {
      db().update(replies).set({ snippet: null, headers: null, updatedAt: ts() })
        .where(eq(replies.id, r.id)).run();
      snippets++;
    }
  }

  const stepsDeleted = db().delete(agentSteps).where(lt(agentSteps.createdAt, snippetCutoff)).run().changes;

  const dead = db().select().from(leads)
    .where(and(inArray(leads.status, ['rejected', 'phone_only']), lt(leads.updatedAt, leadCutoff))).all();
  for (const l of dead) db().delete(leads).where(eq(leads.id, l.id)).run();

  audit('system', null, 'pruned', {
    snippets_cleared: snippets, steps_deleted: stepsDeleted, leads_deleted: dead.length,
  });
  return `Pruned: ${snippets} snippet(s) cleared, ${stepsDeleted} agent step(s) deleted, ${dead.length} dead lead(s) removed.`;
}

/** reachout:backup — dated copy of the SQLite file under storage/backups. */
export async function backup(): Promise<string> {
  const src = resolve(process.cwd(), config.dbPath);
  if (!existsSync(src)) return `Database file not found at ${src} — nothing to back up.`;

  const dir = resolve(process.cwd(), 'storage/backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const target = resolve(dir, `reachout-${stamp}.sqlite`);
  // Online backup API — consistent even with data still in the WAL.
  await raw().backup(target);

  // Keep only the newest BACKUP_KEEP copies.
  const files = readdirSync(dir).filter((f) => /^reachout-.*\.sqlite$/.test(f)).sort().reverse();
  for (const old of files.slice(config.backup.keep)) unlinkSync(resolve(dir, old));

  return `Backed up to ${target.split(/[\\/]/).pop()} (${files.length} kept, max ${config.backup.keep}).`;
}

/** reachout:heartbeat support — the worker stamps itself every loop. */
export function beat(key: 'scheduler_heartbeat' | 'queue_heartbeat'): void {
  Setting.set(key, new Date().toISOString());
}
