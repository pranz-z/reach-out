# ReachOut (TypeScript port)

Private cold-outreach console for Philippine small businesses. The agent
discovers businesses (OpenStreetMap by default), checks their public web
presence, drafts a short proposal email — and **nothing is ever sent without
human approval**. This is the Next.js/TypeScript port of the Laravel app in
`../reachout`; it reads and writes the **same SQLite database** for all
business data, so both apps can run against one dataset while the port
catches up to parity.

## Safety model (unchanged from Laravel)

- Philippines-only discovery; only public business data is used.
- Email addresses are **never guessed** — they come from the business's own
  website, a manual entry you confirm, or an import you supply.
- Social media is not scraped; a Facebook URL is stored as a hint only.
- The agent has no send tool. Sending is a separate, approval-gated path:
  draft → your approval → send inside Manila business hours (Mon–Fri
  09:00–17:00), under warm-up/daily caps, with suppression checks re-run
  at send time.
- `MAIL_MAILER=log` writes mail to `storage/logs/mail.log` instead of
  sending. Keep it `log` in development. `smtp` sends real mail.
- Every lead/draft/email/suppression/reply/privacy action is written to
  `audit_log`. API usage budgets (LLM, Places, search, OSM) are enforced
  per service per day.

## Requirements

- Node.js 24+ (uses `process.loadEnvFile`, built-in type-aware tooling)
- The Laravel app's SQLite database (default `../reachout/database/database.sqlite`)
- An OpenAI-compatible LLM endpoint (Groq free tier is the default)

## Setup

```bash
npm install
cp .env.example .env        # fill in SENDER_* / PORTFOLIO_URL / LLM_API_KEY
npm run cli -- create-admin you@example.com 'a-strong-password'
npm run cli -- doctor       # fix any [FAIL] before continuing
```

## Running

Three processes, same as the Laravel app:

```bash
npm run dev          # dashboard → http://localhost:3000
npm run worker       # queue worker: agent runs, drafting, sending
npm run scheduler    # discovery, reply polling, follow-ups, prune, backups, heartbeat
```

Or run any single operation from the CLI:

```bash
npm run cli -- <command>
```

| Command | What it does |
|---|---|
| `run <id|name> [--force]` | Run the agent loop for a profile in the foreground (`--force` overrides paused discovery) |
| `discover` | Scheduled discovery pass (pause/back-pressure aware) |
| `send-approved` | Queue sends for approved drafts inside the send window |
| `poll-replies` | Poll IMAP for replies and bounces, classify them |
| `draft-followups` | Draft follow-ups for sent leads past `FOLLOWUP_AFTER_DAYS` |
| `prune` | Retention cleanup (old snippets, dead leads) |
| `backup` | Consistent SQLite backup into `storage/backups` |
| `export <lead_id>` / `forget <id\|email>` | Data-subject export / erasure (opt-out kept as a hash) |
| `doctor` | Environment + heartbeat + failed-job health check |
| `show-run <id>` | Print an agent run's step trace |
| `create-admin <email> <pw>` | Create a dashboard user |
| `work-once` | Claim and run one queued job (debugging) |

## Dashboard flow

1. **Profiles** — create a search profile, or hit **Run now** to queue an agent run.
2. **Leads** — import CSV (preview-first), or paste a business's **website**
   (the app scans it for a published email) / **Add public email** manually.
   `phone_only` leads become `enriched` once a public email exists.
3. **Leads → Draft now** — queues a first-email draft for an enriched lead.
4. **Review** — edit subject/body, approve (or reject). Approving marks the
   draft; `send-approved` (scheduler or CLI) queues it inside the window.
5. **Sent & replies** — sent log plus inbound replies; replies are stored as
   bounded snippets and classified (bounce / unsubscribe / human / auto).
6. **Settings** — pause discovery or sending; manage the suppression list.

## Database layout

All Laravel business tables are shared read/write: `users`, `leads`,
`search_profiles`, `agent_runs`, `agent_steps`, `drafts`, `emails`,
`replies`, `suppressions`, `settings`, `audit_log`, `api_usage`,
`overpass_cache`, `overpass_cities`.

The queue is intentionally **separate**: `reachout_jobs` /
`reachout_failed_jobs` (TypeScript) vs Laravel's `jobs` / `failed_jobs` —
the payload formats are incompatible, and sharing would let one worker eat
the other's jobs. Don't rename them back.

## Environment keys

See `.env.example` for the full annotated list. The groups:

- **Identity** — `SENDER_NAME`, `SENDER_ADDRESS`, `REPLY_TO_ADDRESS`,
  `PORTFOLIO_URL` (required before drafts validate)
- **App** — `DB_PATH`, `SESSION_SECRET` (32+ random chars)
- **LLM** — `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, optional
  `LLM_FALLBACK_*`; agent limits via `AGENT_MAX_STEPS`,
  `AGENT_MAX_LEADS_PER_RUN`, `AGENT_RUN_MINUTES`
- **Discovery** — `DISCOVERY_PROVIDER` (`osm`|`google`),
  `DISCOVERY_PROVINCE`, `PLACES_API_KEY`, `SEARCH_PROVIDER`,
  `SEARCH_API_KEY`, `OVERPASS_*`
- **Sending** — `MAIL_MAILER` (`log`|`smtp`), `MAIL_HOST/PORT/USERNAME/
  PASSWORD/ENCRYPTION`, `DAILY_SEND_LIMIT`, `SEND_WINDOW_*`,
  `SEND_WARMUP_*`, `SEND_MIN/MAX_DELAY_SECONDS`, `FOLLOWUP_AFTER_DAYS`,
  `REQUIRE_APPROVAL` (keep `true`)
- **Replies** — `IMAP_HOST/PORT/USER/PASSWORD/ENCRYPTION/FOLDER`,
  `SOFT_BOUNCE_THRESHOLD`, `LLM_REPLY_SUGGEST`
- **Budgets** — `LLM_DAILY_CALLS`, `LLM_DAILY_TOKENS`,
  `PLACES_DAILY_CALLS`, `SEARCH_DAILY_CALLS`, `OSM_DAILY_CALLS`
- **Resilience / retention** — `RESILIENT_*`, `RETENTION_*`, `BACKUP_KEEP`

## Verification

```bash
npm test           # vitest suite (temp SQLite; never touches the real DB)
npm run typecheck  # tsc --noEmit
npm run build      # next build — all routes are dynamic by design
```

## Notes for agents

- `AGENTS.md` here points at the bundled Next.js 16 docs under
  `node_modules/next/dist/docs/` — read them before changing app code; this
  Next version differs from training data (`proxy.ts`, not `middleware.ts`;
  no `cacheComponents` — the app is fully dynamic).
- `lib/env.ts` must be imported **first** in any non-Next entry point
  (cli/worker/scheduler) — `config.ts` reads `process.env` at module load
  and Next only auto-loads `.env` inside the app itself.
