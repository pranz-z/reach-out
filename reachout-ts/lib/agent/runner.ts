import { eq } from 'drizzle-orm';
import { agentRuns, agentSteps } from '../db/schema';
import { db } from '../db';
import { config, ts } from '../config';
import { ApiBudgetExceeded } from '../usage';
import { ApiUsage } from '../usage';
import { CircuitOpen } from '../http';
import { stripEmpty } from '../strip-empty';
import { ChatMessage, LlmClient, LlmToolValidation, ToolCall } from '../llm/client';
import { Tool, Profile, Run } from './tools/base';
import { SearchPlacesTool } from './tools/search-places';
import { CheckWebsiteTool } from './tools/check-website';
import { FindFacebookLinkTool } from './tools/find-facebook-link';
import { FindPublicEmailTool } from './tools/find-public-email';
import { CheckSuppressionTool } from './tools/check-suppression';
import { SaveLeadTool } from './tools/save-lead';
import { QueueDraftTool } from './tools/queue-draft';
import { ListDraftableLeadsTool } from './tools/list-draftable-leads';

/** Provider-side tool-call rejections we correct before stopping. */
const MAX_TOOL_CORRECTIONS = 3;

/**
 * The harness: model + tools + loop. Limits (steps, per-tool caps, lead
 * cap) are enforced here and in the tools. There is deliberately no
 * send tool.
 */
export class AgentRunner {
  constructor(private llm: LlmClient) {}

  async run(profile: Profile, maxSeconds?: number): Promise<Run> {
    const deadline = maxSeconds ? Date.now() + maxSeconds * 1000 : null;
    const run = db().insert(agentRuns).values({
      profileId: profile.id, status: 'running', model: this.llm.model(),
      startedAt: ts(), createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid;
    const runId = Number(run);
    const getRun = (): Run => db().select().from(agentRuns).where(eq(agentRuns.id, runId)).get()!;
    const update = (patch: Partial<Run>) => {
      db().update(agentRuns).set({ ...patch, updatedAt: ts() }).where(eq(agentRuns.id, runId)).run();
      Object.assign(current, patch);
    };
    let current = getRun();

    const tools: Record<string, Tool> = {};
    for (const Cls of AgentRunner.toolClasses()) {
      const tool = new Cls(profile, current);
      tools[tool.name()] = tool;
    }
    const schemas = Object.values(tools).map((t) => t.schema());

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: this.goal(profile) },
    ];

    const maxSteps = config.agent.maxSteps;
    const caps = config.agent.toolCallCaps;
    const calls: Record<string, number> = {};
    let step = 0;
    let corrections = 0;

    try {
      while (step < maxSteps) {
        if (deadline && Date.now() > deadline) {
          update({ status: 'stopped', error: 'Time limit reached.' });
          break;
        }
        if (ApiUsage.tokensExhausted('llm')) {
          update({ status: 'stopped', error: 'Daily LLM token budget reached.' });
          break;
        }
        step++;
        let reply: ChatMessage;
        try {
          reply = await this.llm.chat(this.compactForApi(messages), schemas);
        } catch (e) {
          if (!(e instanceof LlmToolValidation)) throw e;
          // The model sent a malformed tool call — nudge it to retry.
          corrections++;
          if (e.usage) this.billTokens({ _usage: e.usage });
          this.log(runId, step, 'assistant', 'llm_validation', undefined, { error: e.message });
          if (corrections > MAX_TOOL_CORRECTIONS) {
            update({ status: 'stopped', error: `Model kept producing invalid tool calls (${corrections} rejected); stopped cleanly.` });
            break;
          }
          messages.push({ role: 'user', content: `Your last tool call was rejected by the API: ${e.message} Retry it, omitting fields you have no value for — never send null or empty values.` });
          continue;
        }
        this.billTokens(reply);
        this.log(runId, step, 'assistant', undefined, undefined, { content: reply.content ?? null, tool_calls: reply.tool_calls ?? null });
        messages.push(this.cleanAssistant(reply));

        const toolCalls = reply.tool_calls ?? [];
        if (toolCalls.length === 0) {
          update({ status: 'finished' });
          break;
        }

        let budgetStop = false;
        for (const call of toolCalls) {
          const name = call.function?.name ?? '';
          let args = parseJson(call.function?.arguments ?? '{}');
          args = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};

          let result: Record<string, unknown>;
          if (!tools[name]) {
            result = { ok: false, error: `Unknown tool '${name}'.` };
          } else if ((calls[name] = (calls[name] ?? 0) + 1) > (caps[name] ?? Number.MAX_SAFE_INTEGER)) {
            result = { ok: false, error: `Call limit for ${name} reached in this run.` };
          } else {
            try {
              // null behaves exactly like an omitted field.
              result = await tools[name].execute(stripEmpty(args) as Record<string, unknown>);
            } catch (e) {
              result = { ok: false, error: `Tool crashed: ${(e as Error).name}` };
            }
          }

          this.log(runId, step, 'tool', name, args as Record<string, unknown>, result);
          messages.push({
            role: 'tool',
            tool_call_id: call.id ?? name,
            // The model never sees null/empty fields — it copies them into
            // the next call. agent_steps keeps the full result.
            content: JSON.stringify(stripEmpty(result)),
          });

          // A daily API budget was reached — end the run cleanly.
          if (result['budget']) {
            update({ status: 'stopped', error: 'Daily API budget reached: ' + String(result['error']) });
            budgetStop = true;
            break;
          }
        }
        if (budgetStop) break;

        current = getRun();
        if (current.leadsSaved >= config.agent.maxLeadsPerRun && current.draftsQueued >= current.leadsSaved) {
          update({ status: 'finished' });
          break;
        }
      }

      current = getRun();
      if (current.status === 'running') {
        update({ status: 'stopped', error: 'Step limit reached.' });
      }
    } catch (e) {
      if (e instanceof ApiBudgetExceeded || e instanceof CircuitOpen) {
        update({ status: 'stopped', error: 'Stopped cleanly: ' + e.message.slice(0, 300) });
      } else {
        update({ status: 'failed', error: (e as Error).message.slice(0, 500) });
      }
    }

    update({ stepsUsed: step, finishedAt: ts() });
    return getRun();
  }

  /**
   * The toolset for a run. find_facebook_link needs a search API key —
   * without one it is simply absent so the model never expects it.
   */
  static toolClasses(): Array<new (p: Profile, r: Run) => Tool> {
    return [
      SearchPlacesTool,
      CheckWebsiteTool,
      ...(config.search.apiKey ? [FindFacebookLinkTool] : []),
      FindPublicEmailTool,
      CheckSuppressionTool,
      SaveLeadTool,
      QueueDraftTool,
      ListDraftableLeadsTool,
    ];
  }

  private systemPrompt(): string {
    const sender = config.senderName;
    const portfolio = config.portfolioUrl;
    const marker = config.requiredOptOutMarker;
    const words = config.maxEmailWords;
    const fbStep = config.search.apiKey
      ? '3. If the business has no real own website, find_facebook_link (it returns a URL only, never open it).'
      : '3. If the business has no real own website, save it with the facts you have — no Facebook lookup tool is configured.';
    const emailStep = '4. find_public_email on its own website if it has one. Never guess an email address.';

    return `You are a lead-research assistant for ${sender}, a freelance developer in the Philippines who builds POS systems with AI assistants and other business software.

Your job: find local businesses, check what they publicly have online, and queue a short, honest cold proposal email for HUMAN review. You cannot send email.

First call list_draftable_leads: those leads are already saved (for example imported by the owner) and only need a draft. Queue a first-email draft for EVERY lead it returns with queue_draft_for_review using only the facts returned — do that before any discovery.

Workflow per newly discovered business:
1. search_places for a category and city from the profile.
2. check_website on its website_url (empty string if none).
${fbStep}
${emailStep}
5. save_lead with ONLY facts you actually collected. Set fit_score from what you found.
6. If the lead has a public email, queue_draft_for_review.

Rules:
- Only state facts present in tool results. Never invent details about a business.
- The goal lists "solution hints" per category — ideas for what to offer. Use them to pick the suggestion and shape the email, but NEVER state that a business lacks a feature, has no website, or does something a certain way unless a tool result actually says so. Offer, don't diagnose.
- A business WITHOUT a public email is still a lead: save it with save_lead (status phone_only) so the owner can follow up by phone, then move on.
- Skip businesses that already have a modern website with online ordering or booking (save them anyway as phone_only if they have a phone).
- Tentative tone ("I noticed...", "would this be useful?"), plain text, under ${words} words, one concrete offer.
- Every email must be signed "${sender}", include ${portfolio}, and include an opt-out line such as: If it's not relevant, just reply ${marker} and I won't email again.
- queue_draft_for_review's "found" list must contain only facts from tool results; "suggestion" is the system you recommend and why in one line.
- When you have processed enough leads or tools report a limit, stop calling tools and give a one-paragraph summary.`;
  }

  private goal(profile: Profile): string {
    const cap = config.agent.maxLeadsPerRun;
    let goal = `Profile "${profile.name}". Categories: ${profile.categories.join(', ')}. Cities: ${profile.cities.join(', ')}. Find up to ${cap} good-fit leads in total and queue drafts for review.`;

    const hints: string[] = [];
    for (const cat of profile.categories) {
      const hint = config.discovery.solutionHints[cat.trim().toLowerCase()];
      if (hint) hints.push(`- ${cat}: ${hint}`);
    }
    if (hints.length) {
      goal += `\nSolution hints (ideas only, never claim a business lacks these):\n${hints.join('\n')}`;
    }
    return goal;
  }

  /** Keep only the fields the API expects when echoing the assistant message back. */
  private cleanAssistant(reply: ChatMessage): ChatMessage {
    const msg: ChatMessage = { role: 'assistant', content: reply.content ?? '' };
    if (reply.tool_calls?.length) {
      msg.tool_calls = reply.tool_calls.map((call: ToolCall) => {
        const args = parseJson(call.function?.arguments ?? 'null');
        if (args && typeof args === 'object') {
          call = { ...call, function: { ...call.function, arguments: JSON.stringify(stripEmpty(args)) } };
        }
        return call;
      });
    }
    return msg;
  }

  /**
   * Groq's free tier is ~8K tokens/minute: only the newest
   * AGENT_FULL_TOOL_RESULTS tool messages keep their full JSON; older
   * ones are replaced by a short summary. The list sent to the API is a
   * COPY — internal history and agent_steps keep everything.
   */
  private compactForApi(messages: ChatMessage[]): ChatMessage[] {
    const keepFull = config.agent.fullToolResults;
    const toolIdx: number[] = [];
    messages.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
    const fresh = new Set(toolIdx.slice(-keepFull));

    return messages.map((m, i) => {
      if (m.role !== 'tool' || typeof m.content !== 'string') return m;
      const decoded = parseJson(m.content);
      if (fresh.has(i)) {
        return { ...m, content: JSON.stringify(decoded && typeof decoded === 'object' ? this.pruneBulky(decoded as Record<string, unknown>) : m.content) };
      }
      const summary = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? `${(decoded as Record<string, unknown>)['ok'] ? 'ok' : 'failed'}: ${this.summarize(decoded as Record<string, unknown>)}`
        : m.content.slice(0, 120);
      return { ...m, content: JSON.stringify({ summary: summary.slice(0, 160) }) };
    });
  }

  private summarize(result: Record<string, unknown>): string {
    for (const k of ['error', 'url', 'name', 'email']) {
      const v = result[k];
      if (typeof v === 'string' && v !== '') return v.slice(0, 100);
    }
    if (result['count'] !== undefined) return `${result['count']} result(s)`;
    if (result['lead_id']) return `lead #${result['lead_id']}`;
    return 'done';
  }

  /** Drop fields that bloat tokens without helping the model decide. */
  private pruneBulky(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (['signals', 'raw', 'raw_response', 'debug'].includes(k)) continue;
      if (typeof v === 'string' && v.length > 400) out[k] = v.slice(0, 400) + '…';
      else if (v !== null && typeof v === 'object' && !Array.isArray(v)) out[k] = this.pruneBulky(v as Record<string, unknown>);
      else out[k] = v;
    }
    return out;
  }

  /** Bill provider-reported tokens for this turn into api_usage. */
  private billTokens(reply: ChatMessage | { _usage?: Record<string, unknown> }): void {
    const usage = reply._usage;
    if (usage && typeof usage === 'object') {
      const total = Number(usage['total_tokens']
        ?? (Number(usage['prompt_tokens'] ?? 0) + Number(usage['completion_tokens'] ?? 0)));
      if (total > 0) ApiUsage.recordTokens('llm', total);
    }
  }

  private log(runId: number, step: number, role: string, tool?: string, args?: Record<string, unknown>, result?: Record<string, unknown>): void {
    db().insert(agentSteps).values({
      runId, step, role, tool: tool ?? null,
      arguments: args ?? null, result: result ?? null, createdAt: ts(),
    }).run();
  }
}

function parseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
