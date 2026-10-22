import { Suppression } from '../../suppression';
import { Tool, ToolResult } from './base';

export class CheckSuppressionTool extends Tool {
  name() { return 'check_suppression'; }
  description() {
    return 'Check whether an email address (or its domain) has opted out. If suppressed, never email it.';
  }
  parameters() {
    return {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const email = String(args['email'] ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return this.error('not a valid email address');
    }
    return { ok: true, suppressed: Suppression.blocks(email) };
  }
}
