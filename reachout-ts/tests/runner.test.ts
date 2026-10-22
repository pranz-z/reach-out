import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns, agentSteps, leads, searchProfiles } from '@/lib/db/schema';
import { ts } from '@/lib/config';
import { AgentRunner } from '@/lib/agent/runner';
import { ChatMessage, LlmClient, LlmToolValidation } from '@/lib/llm/client';
import { SaveLeadTool } from '@/lib/agent/tools/save-lead';
import type { Profile } from '@/lib/agent/tools/base';

function makeProfile(): Profile {
  const id = db().insert(searchProfiles).values({
    name: 'Test', categories: ['cafe'], cities: ['Guagua'], dailyCap: 10, active: true,
    createdAt: ts(), updatedAt: ts(),
  }).run().lastInsertRowid;
  return db().select().from(searchProfiles).where(eq(searchProfiles.id, Number(id))).get()!;
}

/** Scriptable stand-in for LlmClient. */
class FakeLlm {
  calls: ChatMessage[][] = [];
  constructor(private script: Array<ChatMessage | Error>) {}
  model() { return 'fake-model'; }
  async chat(messages: ChatMessage[]): Promise<ChatMessage> {
    this.calls.push(messages);
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}

const done = (text = 'All done.'): ChatMessage => ({ role: 'assistant', content: text });

describe('AgentRunner resilience', () => {
  it('recovers from a provider tool-use 400 by nudging the model', async () => {
    const llm = new FakeLlm([
      new LlmToolValidation('Tool call validation failed: /website_url expected string, got null'),
      done('Summary.'),
    ]);
    const run = await new AgentRunner(llm as unknown as LlmClient).run(makeProfile());
    expect(run.status).toBe('finished');
    // The corrective nudge was appended to the conversation.
    const nudge = llm.calls[1].find((m) => m.role === 'user' && m.content?.includes('rejected by the API'));
    expect(nudge).toBeTruthy();
    // Logged as an llm_validation step, not a failure.
    const steps = db().select().from(agentSteps).where(eq(agentSteps.runId, run.id)).all();
    expect(steps.some((s) => s.tool === 'llm_validation')).toBe(true);
  });

  it('stops cleanly (not failed) after 4 rejected tool calls', async () => {
    const err = () => new LlmToolValidation('tool validation failed');
    const llm = new FakeLlm([err(), err(), err(), err(), done()]);
    const run = await new AgentRunner(llm as unknown as LlmClient).run(makeProfile());
    expect(run.status).toBe('stopped');
    expect(run.error).toMatch(/invalid tool calls/);
    expect(llm.calls).toHaveLength(4); // the 5th script entry is never reached
  });

  it('marks the run failed on a non-validation LLM error', async () => {
    const llm = new FakeLlm([new Error('LLM request failed: HTTP 500')]);
    const run = await new AgentRunner(llm as unknown as LlmClient).run(makeProfile());
    expect(run.status).toBe('failed');
  });

  it('strips nulls from tool results before the model sees them; agent_steps keeps everything', async () => {
    const toolCall: ChatMessage = {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'c1', type: 'function',
        function: { name: 'save_lead', arguments: JSON.stringify({ name: 'Cafe Z', city: 'Guagua', phone: null, public_email: null }) },
      }],
    };
    const llm = new FakeLlm([toolCall, done('Done.')]);
    const run = await new AgentRunner(llm as unknown as LlmClient).run(makeProfile());
    expect(run.status).toBe('finished');
    expect(run.leadsSaved).toBe(1);

    // The tool message sent back to the API must not contain null keys.
    const toolMsg = llm.calls[1].find((m) => m.role === 'tool')!;
    const payload = JSON.parse(String(toolMsg.content));
    expect(JSON.stringify(payload)).not.toContain('null');
    expect(payload.ok).toBe(true);

    // agent_steps retained the full record (result) and the raw args.
    const steps = db().select().from(agentSteps).where(eq(agentSteps.runId, run.id)).all();
    const toolStep = steps.find((s) => s.tool === 'save_lead')!;
    expect(toolStep.arguments?.['phone']).toBeNull(); // raw args preserved for inspection
    expect(toolStep.result?.['ok']).toBe(true);

    const lead = db().select().from(leads).all()[0];
    expect(lead.status).toBe('phone_only');
  });

  it('every tool schema declares optional properties nullable', () => {
    const profile = makeProfile();
    const runId = db().insert(agentRuns).values({
      profileId: profile.id, status: 'running', startedAt: ts(), createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid;
    const run = db().select().from(agentRuns).where(eq(agentRuns.id, Number(runId))).get()!;
    const schema = new SaveLeadTool(profile, run).schema() as {
      function: { parameters: { properties: Record<string, { type: unknown }> } };
    };
    const props = schema.function.parameters.properties;
    expect(props['phone'].type).toEqual(['string', 'null']);
    expect(props['name'].type).toBe('string'); // required stays strict
  });
});
