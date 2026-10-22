/**
 * The TS equivalent of Laravel's routes/console.php schedule. One
 * long-running loop; each task fires on its own interval, gated by
 * "did it already run today" markers in the settings table (the same
 * place Laravel's scheduler heartbeat lives).
 *
 *   every minute   → scheduler_heartbeat
 *   every 5 min    → send-approved
 *   every 10 min   → poll-replies
 *   weekdays ~DISCOVERY_START_HOUR Manila → discover
 *   daily 08:30 Manila → draft-followups
 *   daily          → backup
 *   Sundays        → prune
 *
 * Run it beside the worker: `npm run scheduler` (or start both via
 * npm run dev:all).
 */
import './lib/env';
import { config, manilaNow } from './lib/config';
import { Setting } from './lib/settings';
import * as tasks from './lib/tasks';

const TICK_MS = 60_000;
let tickCount = 0;

async function tick(): Promise<void> {
  tickCount++;
  tasks.beat('scheduler_heartbeat');

  if (tickCount % 5 === 0) safe('send-approved', () => tasks.sendApproved());
  if (tickCount % 10 === 0) await safeAsync('poll-replies', () => tasks.pollReplies());

  const manila = manilaNow();
  const [date, hour, dow] = [
    manila.toISOString().slice(0, 10),
    Number(manila.toISOString().slice(11, 13)),
    manila.getUTCDay(),
  ];

  // Discovery: once per weekday morning at/after the start hour.
  if (dow >= 1 && dow <= 5 && hour >= config.discovery.startHour && Setting.get('last_discover_date') !== date) {
    Setting.set('last_discover_date', date);
    safe('discover', () => tasks.discover());
  }

  // Follow-ups: once per day at/after 08:30 Manila.
  if ((hour > 8 || (hour === 8 && manila.getUTCMinutes() >= 30)) && Setting.get('last_followups_date') !== date) {
    Setting.set('last_followups_date', date);
    await safeAsync('draft-followups', () => tasks.draftFollowups());
  }

  // Backup: once per day.
  if (Setting.get('last_backup_date') !== date) {
    Setting.set('last_backup_date', date);
    await safeAsync('backup', () => tasks.backup());
  }

  // Prune: once per week, on Sundays.
  const isoWeek = `${manila.getUTCFullYear()}-W${String(isoWeekNum(manila)).padStart(2, '0')}`;
  if (dow === 0 && Setting.get('last_prune_week') !== isoWeek) {
    Setting.set('last_prune_week', isoWeek);
    safe('prune', () => tasks.prune());
  }
}

function safe(name: string, fn: () => string): void {
  try { console.log(`[scheduler] ${name}: ${fn()}`); }
  catch (e) { console.error(`[scheduler] ${name} failed:`, (e as Error).message); }
}

async function safeAsync(name: string, fn: () => Promise<string>): Promise<void> {
  try { console.log(`[scheduler] ${name}: ${await fn()}`); }
  catch (e) { console.error(`[scheduler] ${name} failed:`, (e as Error).message); }
}

/** ISO-8601 week number — the marker for "already pruned this week". */
function isoWeekNum(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

console.log('[scheduler] reachout-ts scheduler running (1/min tick)');
void tick();
setInterval(() => { void tick(); }, TICK_MS);
