import { config } from '../config';
import { ResilientHttp, Resp } from '../http';

/** Provider-side tool-call rejection — the model's mistake, recoverable. */
export class LlmToolValidation extends Error {
  constructor(message: string, public usage?: Record<string, unknown>) {
    super(message);
    this.name = 'LlmToolValidation';
  }
}

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  _usage?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * Port of LlmClient — any OpenAI-compatible /chat/completions endpoint.
 * Switch providers via LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
 */
export class LlmClient {
  model(): string {
    return config.llm.model;
  }

  async chat(messages: ChatMessage[], tools: Record<string, unknown>[] = [], toolChoice: string | Record<string, unknown> = 'auto'): Promise<ChatMessage> {
    const payload: Record<string, unknown> = {
      model: this.model(),
      messages,
      temperature: 0.3,
    };
    if (tools.length) {
      payload.tools = tools;
      payload.tool_choice = toolChoice;
    }

    const response = await ResilientHttp.request('llm', async () => {
      const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.llm.apiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.llm.timeout * 1000),
      });
      return Resp.from(res);
    });

    if (response.failed()) {
      if (this.isToolValidationError(response)) {
        let message = String(response.json('error.message') ?? 'tool call validation failed');
        // Only the provider's message is quoted — never the request
        // payload — so no keys or args leak into prompts.
        message = message.replace(/([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$3');
        throw new LlmToolValidation(message.slice(0, 240), response.json('usage') as Record<string, unknown> | undefined);
      }
      throw new Error(`LLM request failed: HTTP ${response.status} ${response.body.slice(0, 300)}`);
    }

    const message = response.json('choices.0.message') as ChatMessage | undefined;
    if (!message || typeof message !== 'object') {
      throw new Error('LLM response had no message.');
    }
    const usage = response.json('usage');
    if (usage) message._usage = usage as Record<string, unknown>;

    return message;
  }

  /** HTTP 400 whose body says the tool call itself was malformed. */
  private isToolValidationError(response: Resp): boolean {
    if (response.status !== 400) return false;
    const code = String(response.json('error.code') ?? '');
    if (code === 'tool_use_failed' || code.includes('tool')) return true;
    const message = String(response.json('error.message') ?? '').toLowerCase();
    return message.includes('tool')
      && (message.includes('did not match schema')
        || message.includes('validation')
        || message.includes('parameter'));
  }
}
