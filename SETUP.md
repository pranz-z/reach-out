# ReachOut starter kit: setup

This kit holds milestones 1 to 3 from `SPEC.md`: database, models, dashboard, CSV import, suppression list, and the agent harness that finds leads and queues drafts for your review. It is an overlay for a fresh Laravel install.

## What is and is not done

| Done | Not yet |
|---|---|
| Migrations and models | **Sending** (milestone 4). Approved drafts wait in "Sent & replies" |
| Dashboard pages from the mockup | Reply tracking and follow-up (milestone 5) |
| CSV import, suppression list | Login/auth. **Run on localhost only** until you add it |
| `LlmClient` (any OpenAI-compatible endpoint) | A UI for search profiles (use the seeder or tinker) |
| `AgentRunner` and 8 tools, guardrails inside the code | |
| `php artisan reachout:run` | |
| Guardrail tests | |

The code was syntax-checked (`php -l`) but **could not be run end to end** where it was written, because Composer was blocked there. Expect to fix small things on first run. Run the tests first.

## Install

Requirements: PHP 8.2+, Composer.

```bash
composer create-project laravel/laravel reachout
cd reachout

# copy the kit on top (it replaces routes/web.php)
cp -r /path/to/reachout-kit/{app,config,database,public,resources,routes,tests} .
cat /path/to/reachout-kit/.env.reachout.example >> .env
mkdir -p docs && cp /path/to/reachout-kit/{SPEC.md,SETUP.md} docs/
```

Edit `.env`: set `SENDER_NAME`, `PORTFOLIO_URL`, and the `LLM_*` values.

```bash
php artisan migrate
php artisan db:seed --class=SearchProfileSeeder
php artisan test --filter=GuardrailsTest
php artisan serve        # http://localhost:8000
```

## Try it without any API keys

1. Open **Leads**, import a CSV of businesses you picked (`name,city` required; `category,website_url,public_email,phone,facebook_url` optional).
2. Leads with a public email are `enriched`. When you run the agent (below), it first looks at these saved leads and drafts emails for them. This route needs only the LLM endpoint, not the Places or search keys. Without those keys the discovery tools return a "not configured" error and the agent moves on.

## Run the agent

1. Pick a model. The agent loop needs reliable tool calling.
   - Local: `ollama pull qwen2.5:7b`, keep the default `.env`. A 7B model may be inconsistent at tool calls. If runs end with errors or empty results, use a hosted model by changing `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` only.
2. Add `PLACES_API_KEY` (Google Places, needs a billing card) and a search key for Facebook link lookup (`SEARCH_PROVIDER=brave` with `SEARCH_API_KEY`, or `google` with `SEARCH_API_KEY` + `SEARCH_ENGINE_ID`). Check current pricing and free allowances before enabling.
3. Run:
   ```bash
   php artisan reachout:run "Pampanga food and retail"
   ```
4. Open **Review queue**. Each card shows the facts found, the Facebook link (open it yourself), the suggested system, and an editable draft.

Every step of every run is stored in `agent_runs` and `agent_steps`, so you can see why a lead was chosen.

## Guardrails (enforced in code, not the prompt)

- No send tool exists. The agent can only create `pending` drafts.
- Cities and categories are limited to the search profile. Results must have a Philippine address.
- Websites are fetched only for the business's own site: robots.txt respected, private IP ranges blocked, social platforms never fetched.
- The Facebook step saves a URL only and never opens the page.
- Emails are never guessed. Suppressed addresses and domains cannot be saved or drafted.
- A draft needs: public business email, opt-out line (`reply STOP`), your name, your portfolio link, under 150 words, plain text.
- One first email per lead. Human edits are re-checked for the opt-out line on approval.
- Hard limits: max steps, max leads per run, per-tool call caps.

## Before you go further

- Add authentication before exposing this beyond your own machine.
- Review Data Privacy Act obligations before sending at volume. This kit is engineering, not legal advice.
- Next build step is milestone 4: sending domain (SPF/DKIM/DMARC), throttled queue, `List-Unsubscribe`, and re-checking suppression at send time.
