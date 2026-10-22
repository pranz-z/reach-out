import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { failedJobs, jobs } from './db/schema';
import { db } from './db';
import { ts } from './config';
import { randomUUID } from 'node:crypto';

export type JobType = 'run_profile_agent' | 'draft_lead_email' | 'send_draft';

/**
 * Replaces Laravel's database queue. enqueue() writes a row; the worker
 * (a plain Node loop — `npm run worker`) claims due rows and runs the
 * matching handler. reserved_at gives a cheap visibility timeout.
 */
export function enqueue(type: JobType, payload: Record<string, unknown>, delaySeconds = 0): number {
  const runAt = new Date(Date.now() + delaySeconds * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  return Number(db().insert(jobs).values({
    type, payload, runAt, createdAt: ts(),
  }).run().lastInsertRowid);
}

type Handler = (payload: Record<string, unknown>) => Promise<void>;
const handlers = new Map<JobType, Handler>();

export function handle(type: JobType, fn: Handler): void {
  handlers.set(type, fn);
}

/** Claim and run one due job. Returns false when nothing was due. */
export async function workOnce(): Promise<boolean> {
  const now = ts();
  // A job reserved >10min ago is considered crashed — reclaimable.
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const job = db().select().from(jobs).where(
    // <= like Laravel's available_at — runAt has second resolution, so
    // a job enqueued this second must be claimable immediately.
    and(lte(jobs.runAt, now), or(isNull(jobs.reservedAt), lt(jobs.reservedAt, stale))),
  ).orderBy(asc(jobs.id)).limit(1).get();
  if (!job) return false;

  // Compare-and-swap on the reserved_at we read — another worker racing
  // us either sees our stamp or fails this update.
  const cas = job.reservedAt === null
    ? isNull(jobs.reservedAt)
    : eq(jobs.reservedAt, job.reservedAt);
  db().update(jobs).set({ reservedAt: now, attempts: job.attempts + 1 })
    .where(and(eq(jobs.id, job.id), cas)).run();
  // If another worker won the race, our update hit 0 rows — recheck.
  const claimed = db().select().from(jobs).where(eq(jobs.id, job.id)).get();
  if (!claimed || claimed.reservedAt !== now || claimed.attempts !== job.attempts + 1) return false;

  const handler = handlers.get(job.type as JobType);
  try {
    if (!handler) throw new Error(`No handler for job type '${job.type}'`);
    await handler(job.payload ?? {});
    db().delete(jobs).where(eq(jobs.id, job.id)).run();
  } catch (e) {
    if (job.attempts + 1 >= 3) {
      // Move to dead letters — same visibility Laravel's failed_jobs gives.
      db().insert(failedJobs).values({
        uuid: randomUUID(), connection: 'database', queue: job.queue,
        payload: JSON.stringify({ type: job.type, payload: job.payload }),
        exception: (e as Error).message.slice(0, 2000), failedAt: ts(),
      }).run();
      db().delete(jobs).where(eq(jobs.id, job.id)).run();
      console.error(`[jobs] ${job.type}#${job.id} failed permanently:`, (e as Error).message);
    } else {
      // Exponential backoff: 30s, 120s
      const retry = new Date(Date.now() + [0, 30, 120][job.attempts + 1] * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      db().update(jobs).set({ reservedAt: null, runAt: retry }).where(eq(jobs.id, job.id)).run();
    }
  }
  return true;
}

/** Run the worker loop. Stops when `stop()` resolves true. */
export async function workLoop(intervalMs = 2000): Promise<void> {
  for (;;) {
    const did = await workOnce();
    if (!did) await new Promise((r) => setTimeout(r, intervalMs));
  }
}
