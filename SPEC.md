# ReachOut: Automated Outreach Tool (Spec v0.2)

An internal tool that finds local businesses in the Philippines, checks what they publicly have online, suggests a tech solution (e.g. POS with an AI agent), and drafts a short cold proposal email. **A human reviews and approves every email before it sends.**

**v0.2 change: hybrid agent design.** An LLM agent (a small harness: model + tools + loop) handles the judgment steps. Fixed code handles everything that must always behave the same: discovery queries, website checks, suppression, limits, and sending. See section 4A.

## 1. Goals and non-goals

**Goals**
- Automatically discover local business leads from a search profile.
- Show, per lead, the public facts found and a suggested solution.
- Draft a personalized, short email per lead, ready for approval.
- Send approved emails safely, with opt-out handling and follow-up.

**Non-goals (v1)**
- No scraping of Facebook or any social platform. No reading of Facebook page content.
- No collection of personal information, only public business details.
- No fully automatic sending (manual approval is required).
- No emailing outside the Philippines.

## 2. Compliance rules (hard requirements)

1. Philippines-only targets. Lead profiles are limited to Philippine cities or provinces.
2. Email **business addresses only** that the business itself publishes (info@, sales@, contact page). No personal emails.
3. Stored lead data is limited to: business name, category, address/city, phone, website URL, public business email, Facebook link (URL only), notes.
4. Every email states who the sender is and why they are writing, and includes a clear opt-out line ("reply STOP and I won't email again").
5. A **suppression list** blocks all future emails to any opted-out address or domain. It is checked at send time, not just at draft time.
6. Maximum one email plus one follow-up per business.
7. Respect `robots.txt` when reading a business's own website.
8. Keep an audit log of every draft, approval, send, and opt-out.

Note: this is an engineering spec, not legal advice. Review the Data Privacy Act of 2012 obligations (and NPC guidance) before sending at volume.

## 3. Tech stack

| Layer | Choice |
|---|---|
| Backend | Laravel (queues, scheduler, Mailables, Eloquent) |
| Database | SQLite for dev, MySQL later |
| Queue | Laravel database queue driver |
| Dashboard | Laravel Blade + Alpine/Tailwind (simple, server-rendered) |
| LLM | Any OpenAI-compatible endpoint, configured in `.env` |
| Email sending | Transactional provider (Brevo, Resend, or Amazon SES), verify current free-tier limits |
| Lead discovery | Google Places API (primary), OpenStreetMap Overpass (free fallback) |
| Search (Facebook link) | Official search API (Google Programmable Search or Brave Search API) |

## 4. LLM configuration

All model calls go through one interface, `LlmClient`, configured by:

```
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b
```

Supported presets: Ollama (local, default), an official free API key (Groq or Gemini), a local OmniRoute gateway, or the Claude API. Switching providers changes only `.env`.

Rules for using free routers:
- Use official API keys only. Avoid routes that depend on logging in with subscription accounts or on proxy and fingerprint-masking features (terms-of-service risk).
- Pin the router version, and bind it to localhost only.
- Prompts contain only public business facts. Never send sensitive data.

Hardware note: local models in the 3B to 8B range at 4-bit quantization fit comfortably within 6GB VRAM (RTX 3050 / 4050).

## 4A. Agent harness (hybrid design)

**What the agent does.** A run is started per search profile (`php artisan reachout:run {profile}`, or on a schedule). The agent receives a goal ("find up to N good-fit leads in these cities and queue drafts for review") plus a toolset, and decides the order of calls itself. It judges fit, resolves ambiguous Facebook matches, writes the suggestion, and drafts the email.

**Loop.** `AgentRunner` sends the conversation and tool schemas to the model, executes any tool calls it returns, appends the results, and repeats until the model stops calling tools, the step limit is hit, or the lead cap is reached.

**Tools (all implemented as PHP classes with their own validation):**

| Tool | Purpose | Guardrail enforced in code |
|---|---|---|
| `search_places(category, city)` | Google Places text search | City must be in the profile's list; request is pinned to region PH; results must have a Philippine address |
| `check_website(url)` | Classify website status and signals | robots.txt respected, http/https only, private IP ranges blocked, flags stored, page content discarded |
| `find_facebook_link(name, city)` | Official search API, URL only | Never fetches facebook.com; result labelled `unverified` or `likely` |
| `find_public_email(website_url)` | Read the business's own contact pages | robots.txt respected; no guessing of addresses; suppressed addresses rejected |
| `check_suppression(email)` | Look up opt-outs | Read-only |
| `list_draftable_leads()` | Read-only: saved leads (e.g. from CSV) with a public email and no first email yet | Only `enriched` leads, suppressed addresses excluded, max 10 per call |
| `save_lead(...)` | Persist a lead | Deduplicates by place ID; stores only allowed fields |
| `queue_draft_for_review(lead_id, subject, body, suggestion, found)` | Put a draft in the review queue | Requires a public email, not suppressed, opt-out line present, sender name present, max length; status is always `pending` |

**There is no send tool.** Only an explicit human approval in the dashboard moves a draft toward sending, and the sender is ordinary code that re-checks suppression and limits.

**Run limits (config):** `max_steps` (default 40), `max_leads_per_run` (default 10), per-tool call caps, request timeouts. Exceeding a limit ends the run cleanly.

**Observability:** every run is stored in `agent_runs`, and every model message and tool call/result is stored in `agent_steps`, so you can see why a lead was chosen.

**Model requirement:** the agent loop needs a model that follows tool schemas reliably. 7B local models on 6GB VRAM can be inconsistent here. The endpoint is configurable, so a hosted model (free API tier with tool calling, or a cheap paid one) can be used for the agent run while a local model remains an option for plain drafting.

**What stays plain code (not agent-controlled):** scheduling, suppression enforcement, daily caps, warm-up, sending, reply and opt-out handling, audit log.

## 5. Pipeline

```
Search profile -> [Agent run: search_places -> check_website -> find_facebook_link
 -> find_public_email -> save_lead -> queue_draft_for_review] -> Review queue
 -> Approve -> Throttled send -> Reply/opt-out tracking -> Follow-up
```

The agent run is one queued job per profile. Sending, reply polling, and follow-up are separate fixed jobs. Stage descriptions 5.1 to 5.5 below define what each tool and the drafting step must do, whether called by the agent or by code.

### 5.1 Discovery
- Input: a **search profile** (categories + cities, e.g. "restaurants, cafés, pharmacies" in Guagua, Lubao, Angeles, San Fernando).
- Source: Google Places text search, falling back to OSM Overpass.
- Output: leads with name, category, address, phone, website (if listed).
- Deduplicate by place ID, then by normalized name + city.
- Scheduled run (default: daily) with a per-run lead cap.

### 5.2 Website check
Classify each lead:
- `none`: no website listed.
- `social_only`: the listed site is a social media page, or the site fails to load.
- `basic`: a site loads but has weak signals.
- `modern`: a site loads with good signals.

Signals read from the homepage (own site only, robots.txt respected): HTTPS, mobile viewport tag, visible online ordering or booking, copyright or last-updated year. Store the flags, never the page content.

### 5.3 Facebook link lookup
- Search `"{name}" {city} facebook` through an official search API.
- Take the first `facebook.com` result whose page name and city plausibly match.
- Save the **URL only** with a `match_confidence` of `unverified`, `likely`, or `none`.
- The tool **never fetches** the Facebook page, and the AI never sees its content. The reviewer opens the link manually.
- If the Places "website" field is itself a Facebook link, set `website_status = social_only` automatically.

### 5.4 Public email finder
- Read the business's own website contact page for a published address.
- Accept role-style addresses and any address the business clearly publishes as its contact.
- No email found: set the lead status to `phone_only` (parked, never emailed).
- The reviewer may add an email manually (for example from the Facebook About section), marked `source = manual`.

### 5.5 AI suggestion and draft
Input to the model: category, city, website status, the signal flags, and whether a Facebook link was found. Nothing else.

Output (structured JSON):
- `fit_score`: high / medium / low
- `found`: bullet list of facts that were actually collected
- `suggestion`: recommended system and one-line reasoning
- `email_subject`, `email_body`

Prompt rules:
- Only state facts present in the input. Never invent details about the business.
- Keep a tentative tone ("I noticed...", "would this be useful?").
- Under 120 words, plain text, one clear offer, include the sender's name, a portfolio **link** (not a heavy attachment), and the opt-out line.
- Validate that the opt-out line is present before a draft can enter the queue.

### 5.6 Review queue
Per lead card:
- Business name, category, city
- **Found** list (website status, signals, phone, Facebook link with "Open page" button and confidence label)
- Suggested system with reasoning
- Editable subject and body
- Actions: Approve and schedule, Regenerate, Reject

Nothing sends without an explicit approval.

### 5.7 Sending
- Send through the transactional provider from a dedicated sending domain.
- Required DNS: SPF, DKIM, DMARC.
- Throttle: start at about 10 to 20 emails per day, increasing gradually (warm-up).
- Random delay between sends, business hours in Asia/Manila only.
- Before every send, re-check the suppression list.
- Include `List-Unsubscribe` header and the visible opt-out line.

### 5.8 Replies, opt-outs, follow-up
- Poll the reply inbox (IMAP or provider webhook). Classify replies as interested, not interested, STOP, or unknown.
- A STOP or unsubscribe reply immediately adds the address and domain to the suppression list and cancels any scheduled follow-up.
- Follow-up: one email, 7 days after the first, only if there was no reply. It also goes through review.
- Bounces are marked and the address is suppressed.

## 6. Data model

- `search_profiles` (id, name, categories, cities, daily_cap, active)
- `leads` (id, profile_id, place_id, name, category, address, city, phone, website_url, website_status, signals json, facebook_url, facebook_confidence, public_email, email_source, fit_score, status)
- `drafts` (id, lead_id, kind [first|followup], subject, body, status [pending|approved|rejected|sent], model, approved_at)
- `emails` (id, lead_id, draft_id, message_id, sent_at, delivery_status)
- `replies` (id, lead_id, received_at, classification, snippet)
- `suppressions` (id, email, domain, reason, created_at)
- `audit_log` (id, entity, entity_id, action, meta json, created_at)
- `agent_runs` (id, profile_id, status, steps_used, leads_saved, drafts_queued, model, error, started_at, finished_at)
- `agent_steps` (id, run_id, step, role, tool, arguments json, result json, created_at)

Lead `status`: `new` -> `enriched` -> `drafted` -> `approved` -> `sent` -> `replied` | `opted_out` | `phone_only` | `rejected`.

## 7. Dashboard pages

Overview, Leads, Review queue, Sent and replies, Settings (LLM endpoint, sending limits, domain, suppression list). The approved visual direction is `outreach-dashboard-preview.html`, to be extended with the "Found" section and the Facebook link button on each review card.

## 8. Configuration

```
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
AGENT_MAX_STEPS=40
AGENT_MAX_LEADS_PER_RUN=10
PLACES_API_KEY=
SEARCH_PROVIDER=brave        # brave | google
SEARCH_API_KEY=
SEARCH_ENGINE_ID=            # google only
MAIL_MAILER=
SENDER_NAME=
SENDER_ADDRESS=
PORTFOLIO_URL=
DAILY_SEND_LIMIT=20
REQUIRE_APPROVAL=true
```

## 9. Milestones

1. **Scaffold**: Laravel project, migrations, models, dashboard shell from the mockup. (Auth: add before exposing beyond localhost.)
2. **Manual leads**: CSV import, lead list, suppression list.
3. **Agent harness**: `LlmClient`, `AgentRunner`, tool classes, `reachout:run`, review queue with edit/approve/reject.
4. **Sending**: sending domain setup, throttled queue, opt-out handling, audit log.
5. **Reply handling and follow-up**: inbox polling, classification, one follow-up.
6. **Hardening**: warm-up schedule, bounce handling, per-tool tests, scheduled runs.

Milestones 1 to 3 are delivered in the starter kit (see SETUP.md). Approval stays required through every milestone.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Emails land in spam | Dedicated domain, SPF/DKIM/DMARC, slow warm-up, short plain-text emails, links over attachments |
| AI invents facts | Structured input, "only use provided facts" rule, "Found" list shown to reviewer |
| Wrong Facebook match | URL-only, `unverified` label, manual review |
| Free LLM tier changes or rate limits | Configurable endpoint, retry later instead of sending fallback drafts |
| Agent loops, wanders, or misuses a tool | Step and tool-call limits, guardrails inside tools (not the prompt), no send tool, full step log |
| Small local model fails tool calling | Use a hosted model for agent runs; keep the endpoint configurable |
| Privacy or terms violations | No social scraping, business emails only, minimal stored data, suppression list, audit log |
| Many leads have no public email | Park as `phone_only`, never guess addresses |

## 11. Open decisions

- Which transactional email provider to use.
- Whether to use Google Places (needs a billing card) or start with OSM only.
- Sending domain name.
- Portfolio URL and email signature wording.
