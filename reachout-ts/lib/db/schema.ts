import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Mirrors the Laravel schema 1:1 — the TS app can point at the same
 * database/database.sqlite file. Timestamps are TEXT 'YYYY-MM-DD HH:MM:SS'
 * (UTC) to match what Laravel writes; JSON columns are TEXT with a JSON
 * payload for the same reason.
 */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: text('email_verified_at'),
  password: text('password').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const searchProfiles = sqliteTable('search_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  categories: text('categories', { mode: 'json' }).$type<string[]>().notNull(),
  cities: text('cities', { mode: 'json' }).$type<string[]>().notNull(),
  dailyCap: integer('daily_cap').notNull().default(10),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const leads = sqliteTable('leads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').references(() => searchProfiles.id, { onDelete: 'set null' }),
  placeId: text('place_id').unique(),
  name: text('name').notNull(),
  category: text('category'),
  address: text('address'),
  city: text('city'),
  phone: text('phone'),
  websiteUrl: text('website_url'),
  websiteStatus: text('website_status').notNull().default('unknown'), // none|social_only|basic|modern|unknown
  signals: text('signals', { mode: 'json' }).$type<Record<string, unknown> | string[]>(),
  facebookUrl: text('facebook_url'),
  facebookConfidence: text('facebook_confidence').notNull().default('none'), // none|unverified|likely|confirmed
  publicEmail: text('public_email'),
  emailSource: text('email_source'), // website|manual|csv
  fitScore: text('fit_score'), // high|medium|low
  status: text('status').notNull().default('new'), // new|enriched|drafted|approved|sent|replied|opted_out|phone_only|rejected|bounced
  notes: text('notes'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
}, (t) => [index('leads_status_index').on(t.status)]);

export const drafts = sqliteTable('drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leadId: integer('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('first'), // first|followup
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  suggestion: text('suggestion'),
  found: text('found', { mode: 'json' }).$type<string[]>(),
  status: text('status').notNull().default('pending'), // pending|approved|rejected|cancelled|sent|failed
  model: text('model'),
  failureReason: text('failure_reason'),
  regenerationCount: integer('regeneration_count').notNull().default(0),
  source: text('source').notNull().default('agent'), // agent|regenerated|human_edit|manual
  approvedAt: text('approved_at'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
}, (t) => [
  index('drafts_status_index').on(t.status),
  uniqueIndex('drafts_one_followup_per_lead').on(t.leadId, t.kind).where(sql`kind = 'followup'`),
]);

export const draftRevisions = sqliteTable('draft_revisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  draftId: integer('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  source: text('source').notNull().default('agent'), // agent|regenerated|human_edit
  createdAt: text('created_at'),
}, (t) => [index('draft_revisions_draft_id_index').on(t.draftId)]);

export const emails = sqliteTable('emails', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leadId: integer('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  draftId: integer('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
  messageId: text('message_id'),
  sentAt: text('sent_at'),
  deliveryStatus: text('delivery_status'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const replies = sqliteTable('replies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leadId: integer('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  receivedAt: text('received_at'),
  classification: text('classification'), // interested|not_interested|stop|unknown|bounce_hard|bounce_soft|auto_reply
  snippet: text('snippet'),
  messageId: text('message_id').unique(),
  inReplyTo: text('in_reply_to'),
  fromAddress: text('from_address'),
  subject: text('subject'),
  matched: integer('matched', { mode: 'boolean' }).notNull().default(false),
  suggestedLabel: text('suggested_label'),
  source: text('source').notNull().default('imap'), // imap|manual|test
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>(),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const suppressions = sqliteTable('suppressions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email'),
  emailHash: text('email_hash'),
  domain: text('domain'),
  reason: text('reason'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
}, (t) => [
  index('suppressions_email_index').on(t.email),
  index('suppressions_email_hash_index').on(t.emailHash),
  index('suppressions_domain_index').on(t.domain),
]);

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  action: text('action').notNull(),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at'),
});

export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').references(() => searchProfiles.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('running'), // running|finished|stopped|failed
  stepsUsed: integer('steps_used').notNull().default(0),
  leadsSaved: integer('leads_saved').notNull().default(0),
  draftsQueued: integer('drafts_queued').notNull().default(0),
  model: text('model'),
  error: text('error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const agentSteps = sqliteTable('agent_steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  step: integer('step').notNull(),
  role: text('role').notNull(), // assistant|tool|llm_validation
  tool: text('tool'),
  arguments: text('arguments', { mode: 'json' }).$type<Record<string, unknown>>(),
  result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const apiUsage = sqliteTable('api_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull(), // llm|places|search|osm
  date: text('date').notNull(),
  count: integer('count').notNull().default(0),
  tokens: integer('tokens').notNull().default(0),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
}, (t) => [uniqueIndex('api_usage_service_date_unique').on(t.service, t.date)]);

export const discoveryCache = sqliteTable('discovery_cache', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
}, (t) => [index('discovery_cache_expires_at_index').on(t.expiresAt)]);

/**
 * Our own lightweight queue — deliberately NOT Laravel's `jobs` table:
 * that table has a different shape (payload blob + available_at epoch)
 * and sharing it would let each app's worker claim the other's payloads
 * and crash on foreign formats. TS-owned table name is reachout_jobs.
 */
export const jobs = sqliteTable('reachout_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  queue: text('queue').notNull().default('default'),
  type: text('type').notNull(), // run_profile_agent|draft_lead_email|send_draft|heartbeat
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  runAt: text('run_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  reservedAt: text('reserved_at'),
  createdAt: text('created_at'),
});

/** TS-side dead letters — kept out of Laravel's failed_jobs so its
 *  queue:failed/queue:retry tooling never sees non-PHP payloads. */
export const failedJobs = sqliteTable('reachout_failed_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uuid: text('uuid').notNull().unique(),
  connection: text('connection').notNull(),
  queue: text('queue').notNull(),
  payload: text('payload').notNull(),
  exception: text('exception').notNull(),
  failedAt: text('failed_at').notNull(),
});
