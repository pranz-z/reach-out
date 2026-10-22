import { PublicEmailFinder } from '../../discovery/email-finder';
import { Tool, ToolResult } from './base';

/**
 * Reads the business's OWN website (homepage + common contact pages) for an
 * email address the business publishes. It never guesses addresses.
 */
export class FindPublicEmailTool extends Tool {
  name() { return 'find_public_email'; }
  description() {
    return "Find a business email address that the business itself publishes on its own website's home or contact pages. Returns null if none is published. Never guesses addresses.";
  }
  parameters() {
    return {
      type: 'object',
      properties: {
        website_url: { type: 'string', description: "The business's own website URL (not a social media page)." },
      },
      required: ['website_url'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return new PublicEmailFinder().find(String(args['website_url'] ?? ''));
  }
}
