import { gte, min } from 'drizzle-orm';
import { emails } from '../db/schema';
import { db } from '../db';
import { config } from '../config';
import { Setting } from '../settings';

/**
 * Send-time policy: a Mon-Fri business-hours window in Asia/Manila, a
 * warm-up daily cap that ramps toward DAILY_SEND_LIMIT, a global pause
 * switch, and the send-time re-check that the approved body still
 * carries the opt-out line, sender name, and portfolio link.
 */
export const SendPolicy = {
  withinWindow(now = new Date()): boolean {
    const t = manila(now);
    return t.weekday < 5 && t.hour >= config.send.windowStart && t.hour < config.send.windowEnd;
  },

  /** Next moment when the send window opens (Asia/Manila wall time → Date). */
  nextWindowStart(now = new Date()): Date {
    const { hour, minute } = { hour: config.send.windowStart, minute: 0 };
    const t = manila(now);
    const candidate = atManila(t.y, t.m, t.d, hour, minute);
    if (t.weekday < 5 && now < candidate) return candidate;

    let y = t.y, m = t.m, d = t.d + 1;
    for (let i = 0; i < 9; i++) {
      const c = atManila(y, m, d, hour, minute);
      if (manila(c).weekday < 5) return c;
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
    }
    return new Date(now.getTime() + 3 * 86400000);
  },

  secondsUntilNextWindow(now = new Date()): number {
    return Math.max(60, Math.round((this.nextWindowStart(now).getTime() - now.getTime()) / 1000));
  },

  /**
   * Effective daily cap: warm-up from the date of the first send.
   * Week 1 = warmup_week1, week 2 = warmup_week2, week 3+ = DAILY_SEND_LIMIT.
   */
  dailyLimit(): number {
    const max = config.dailySendLimit;
    const first = db().select({ first: min(emails.sentAt) }).from(emails).get()?.first;
    const week = first
      ? Math.floor((Date.now() - Date.parse(first.replace(' ', 'T') + 'Z')) / (7 * 86400000))
      : 0;
    const cap = week === 0 ? config.send.warmupWeek1 : week === 1 ? config.send.warmupWeek2 : max;
    return Math.min(max, cap);
  },

  sentToday(): number {
    const todayUtc = new Date().toISOString().slice(0, 10) + ' 00:00:00';
    return db().select().from(emails).where(gte(emails.sentAt, todayUtc)).all().length;
  },

  remainingToday(): number {
    return Math.max(0, this.dailyLimit() - this.sentToday());
  },

  /** Global kill switch set from the Settings page. */
  paused(): boolean {
    return Setting.bool('sending_paused');
  },

  /**
   * The approved body must still carry the opt-out line, the sender
   * name, and the portfolio link. Re-checked at send time in case the
   * config changed since drafting.
   */
  bodyCompliant(body: string): boolean {
    const marker = config.requiredOptOutMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`reply\\s+"?${marker}"?`, 'i').test(body)
      && body.toLowerCase().includes(config.senderName.toLowerCase())
      && body.toLowerCase().includes(config.portfolioUrl.toLowerCase());
  },
};

/** Wall-clock components in the configured send timezone (default Asia/Manila). */
function manila(now: Date): { y: number; m: number; d: number; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.send.timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!);
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour % 24, weekday };
}

/** Interpret a Manila wall time as an instant. */
function atManila(y: number, m: number, d: number, hour: number, minute: number): Date {
  // Asia/Manila is a fixed UTC+8 — no DST. For other configured zones, iterate once.
  const offsetMs = config.send.timezone === 'Asia/Manila'
    ? 8 * 3600000
    : new Date().getTimezoneOffset() * -60000; // fallback: local zone
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - offsetMs);
}
