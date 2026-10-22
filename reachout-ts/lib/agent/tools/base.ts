import type { agentRuns, searchProfiles } from '../../db/schema';

export type Profile = typeof searchProfiles.$inferSelect;
export type Run = typeof agentRuns.$inferSelect;
export type ToolResult = Record<string, unknown>;

/**
 * A tool the agent may call. Every guardrail lives INSIDE execute(),
 * never only in the prompt — the model cannot talk its way around it.
 */
export abstract class Tool {
  constructor(protected profile: Profile, protected run: Run) {}

  abstract name(): string;
  abstract description(): string;
  abstract parameters(): Record<string, unknown>;
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  schema(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: this.description(),
        parameters: this.nullableParameters(),
      },
    };
  }

  /**
   * Models sometimes echo null for "no value". Declaring every optional
   * property nullable keeps the provider's schema validator from
   * rejecting the whole call; tools treat null like an omitted field.
   */
  private nullableParameters(): Record<string, unknown> {
    const params = this.parameters();
    const required = new Set((params.required as string[] | undefined) ?? []);
    const properties = (params.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown[] }>;
    for (const [key, prop] of Object.entries(properties)) {
      if (required.has(key)) continue;
      if (typeof prop.type === 'string') {
        prop.type = [...new Set([prop.type, 'null'])];
      }
      if (Array.isArray(prop.enum) && !prop.enum.includes(null)) {
        prop.enum.push(null);
      }
      properties[key] = prop;
    }
    params.properties = properties;
    return params;
  }

  protected error(message: string): ToolResult {
    return { ok: false, error: message };
  }

  /** Daily-budget errors end the agent run cleanly, not as a crash. */
  protected budget(message: string): ToolResult {
    return { ok: false, error: message, budget: true };
  }
}
