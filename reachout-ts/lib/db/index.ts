import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config, ts } from '../config';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;

export function db(): DB {
  if (_db) return _db;
  // Path is runtime-configured (shared Laravel SQLite file lives outside
  // the app dir) — opt out of Turbopack's static file tracing.
  const path = resolve(/* turbopackIgnore: true */ process.cwd(), config.dbPath);
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA_SQL);
  _db = drizzle(sqlite, { schema });
  return _db;
}

/** Raw handle for the few queries drizzle doesn't express cleanly. */
export function raw(): Database.Database {
  db(); // ensure initialized
  return (_db as unknown as { $client: Database.Database }).$client;
}

/**
 * Idempotent DDL — CREATE TABLE IF NOT EXISTS for the whole schema.
 * On the shared Laravel DB it is a no-op; on a fresh file it builds
 * everything. Mirrors the Laravel migrations exactly (column names and
 * JSON-as-text included).
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  password TEXT NOT NULL,
  remember_token TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS search_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  categories TEXT NOT NULL,
  cities TEXT NOT NULL,
  daily_cap INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER REFERENCES search_profiles(id) ON DELETE SET NULL,
  place_id TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT, address TEXT, city TEXT, phone TEXT,
  website_url TEXT, website_status TEXT NOT NULL DEFAULT 'unknown',
  signals TEXT, facebook_url TEXT, facebook_confidence TEXT NOT NULL DEFAULT 'none',
  public_email TEXT, email_source TEXT, fit_score TEXT,
  status TEXT NOT NULL DEFAULT 'new', notes TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS leads_status_index ON leads(status);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'first',
  subject TEXT NOT NULL, body TEXT NOT NULL, suggestion TEXT, found TEXT,
  status TEXT NOT NULL DEFAULT 'pending', model TEXT, failure_reason TEXT,
  regeneration_count INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'agent',
  approved_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS drafts_status_index ON drafts(status);
CREATE UNIQUE INDEX IF NOT EXISTS drafts_one_followup_per_lead ON drafts(lead_id, kind) WHERE kind='followup';
CREATE TABLE IF NOT EXISTS draft_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS draft_revisions_draft_id_index ON draft_revisions(draft_id);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  message_id TEXT, sent_at TEXT, delivery_status TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  received_at TEXT, classification TEXT, snippet TEXT,
  message_id TEXT UNIQUE, in_reply_to TEXT, from_address TEXT, subject TEXT,
  matched INTEGER NOT NULL DEFAULT 0, suggested_label TEXT,
  source TEXT NOT NULL DEFAULT 'imap', headers TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT, email_hash TEXT, domain TEXT, reason TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS suppressions_email_index ON suppressions(email);
CREATE INDEX IF NOT EXISTS suppressions_email_hash_index ON suppressions(email_hash);
CREATE INDEX IF NOT EXISTS suppressions_domain_index ON suppressions(domain);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, meta TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER REFERENCES search_profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  steps_used INTEGER NOT NULL DEFAULT 0, leads_saved INTEGER NOT NULL DEFAULT 0,
  drafts_queued INTEGER NOT NULL DEFAULT 0,
  model TEXT, error TEXT, started_at TEXT, finished_at TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step INTEGER NOT NULL, role TEXT NOT NULL, tool TEXT,
  arguments TEXT, result TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL, date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS api_usage_service_date_unique ON api_usage(service, date);
CREATE TABLE IF NOT EXISTS discovery_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, expires_at TEXT NOT NULL,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS discovery_cache_expires_at_index ON discovery_cache(expires_at);
-- TS-owned queue. Deliberately not Laravel jobs/failed_jobs tables:
-- different shape, and sharing would let each worker claim the other's
-- payloads and crash on foreign formats.
CREATE TABLE IF NOT EXISTS reachout_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL DEFAULT 'default', type TEXT NOT NULL,
  payload TEXT NOT NULL, run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, reserved_at TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS reachout_jobs_due_index ON reachout_jobs(run_at, reserved_at);
CREATE TABLE IF NOT EXISTS reachout_failed_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE, connection TEXT NOT NULL, queue TEXT NOT NULL,
  payload TEXT NOT NULL, exception TEXT NOT NULL, failed_at TEXT NOT NULL
);
`;

/** Convenience for new rows: set both timestamps. */
export function timestamps<T extends Record<string, unknown>>(row: T): T {
  const now = ts();
  return { createdAt: now, updatedAt: now, ...row } as T;
}
