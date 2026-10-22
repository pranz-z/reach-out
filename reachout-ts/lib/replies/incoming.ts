/** One inbound message, normalized — same shape for IMAP, fake, and manual entry. */
export interface IncomingMessage {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  body: string;
  headers: Record<string, string>;
}

export function header(m: IncomingMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(m.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
