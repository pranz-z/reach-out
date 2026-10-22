import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { desc, count } from 'drizzle-orm';
import { failedJobs } from './db/schema';
import { db } from './db';
import { config } from './config';
import { Setting } from './settings';

export interface Check { name: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string }

/** Shallow readiness checks for the Overview health card (deep checks are a CLI concern). */
export function healthReport(): Check[] {
  return [
    envFile(), senderIdentity(), mailMailer(), apiKeys(),
    heartbeat('scheduler_heartbeat', 'Scheduler'),
    heartbeat('queue_heartbeat', 'Queue worker'),
    failedJobsCheck(),
  ];
}

function check(name: string, status: Check['status'], detail: string): Check {
  return { name, status, detail };
}

function envFile(): Check {
  const ok = existsSync(resolve(process.cwd(), '.env')) || existsSync(resolve(process.cwd(), '.env.local'));
  return check('.env file', ok ? 'ok' : 'fail', ok ? 'present' : 'missing — copy .env.example and fill it in');
}

function senderIdentity(): Check {
  const defaults = ['Your Name', 'you@example.com', 'https://example.com/portfolio'];
  const values = [config.senderName, config.senderAddress, config.portfolioUrl];
  const unset = values.filter((v, i) => !v || v === defaults[i]).length;
  return unset === 0
    ? check('Sender identity', 'ok', 'name, address and portfolio URL set')
    : check('Sender identity', 'fail', `SENDER_NAME / SENDER_ADDRESS / PORTFOLIO_URL not fully set (${unset} placeholder(s))`);
}

function mailMailer(): Check {
  const mailer = config.mail.mailer;
  if (mailer === 'log') return check('Mail transport', 'warn', 'MAIL_MAILER=log — NOTHING is actually sent (safe for dev)');
  if (!mailer) return check('Mail transport', 'fail', 'MAIL_MAILER is empty');
  return check('Mail transport', 'ok', `MAIL_MAILER=${mailer} — real email will be sent`);
}

function apiKeys(): Check {
  const provider = config.discovery.provider;
  const missing: string[] = [];
  if (provider === 'google' && !config.places.apiKey) missing.push('PLACES_API_KEY');
  if (!config.search.apiKey) missing.push('SEARCH_API_KEY');
  return missing.length === 0
    ? check('Discovery API keys', 'ok', provider === 'osm' ? 'osm provider — no keys needed' : 'places and search keys present')
    : check('Discovery API keys', 'warn', `missing ${missing.join(', ')} — discovery is degraded`);
}

function heartbeat(key: string, label: string): Check {
  const raw = Setting.get(key);
  const cmd = key === 'queue_heartbeat' ? 'npm run worker' : 'npm run scheduler';
  if (!raw) return check(`${label} heartbeat`, 'warn', `never seen — is \`${cmd}\` running?`);
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(raw)) / 1000));
  return age <= 300
    ? check(`${label} heartbeat`, 'ok', `seen ${age}s ago`)
    : check(`${label} heartbeat`, 'warn', `last seen ${age >= 3600 ? Math.round(age / 3600) + 'h' : Math.round(age / 60) + 'min'} ago — probably not running`);
}

function failedJobsCheck(): Check {
  const n = db().select({ n: count() }).from(failedJobs).get()?.n ?? 0;
  return n === 0
    ? check('Failed jobs', 'ok', 'none')
    : check('Failed jobs', 'warn', `${n} failed job(s) — review on the Sent page`);
}
