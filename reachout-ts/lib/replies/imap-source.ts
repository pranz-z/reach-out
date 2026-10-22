import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { config } from '../config';
import { IncomingMessage } from './incoming';

const KEEP_HEADERS = ['content-type', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'x-failed-recipients', 'return-path'];

/**
 * Pulls UNSEEN messages from the reply inbox over IMAP. Read-only like
 * Laravel's FT_PEEK — ImapFlow fetches without ever setting \Seen, so
 * nothing is marked read, moved, or deleted. Dedup by Message-ID lives
 * in ReplyProcessor.
 */
export const ImapSource = {
  configured(): boolean {
    return Boolean(config.replies.imap.host && config.replies.imap.user && config.replies.imap.password);
  },

  /** Connectivity check for `reachout doctor`. */
  async probe(): Promise<boolean> {
    try {
      const client = this.client();
      await client.connect();
      await client.logout();
      return true;
    } catch {
      return false;
    }
  },

  async fetch(): Promise<IncomingMessage[]> {
    const client = this.client();
    await client.connect();
    const out: IncomingMessage[] = [];
    const lock = await client.getMailboxLock(config.replies.imap.folder ?? 'INBOX');
    try {
      for await (const msg of client.fetch({ seen: false }, { envelope: true, source: true })) {
        if (!msg.source) continue;
        const env = msg.envelope;
        const parsed = await PostalMime.parse(msg.source);
        const headers: Record<string, string> = {};
        for (const h of parsed.headers) {
          if (KEEP_HEADERS.includes(h.key)) headers[h.key] = h.value;
        }
        const refs = parsed.headers.find((h) => h.key === 'references')?.value;
        out.push({
          messageId: (env?.messageId ?? '').trim(),
          inReplyTo: env?.inReplyTo?.trim() ?? null,
          references: refs ? refs.trim().split(/\s+/) : [],
          fromAddress: (env?.from?.[0]?.address ?? '').toLowerCase(),
          subject: env?.subject ?? '',
          receivedAt: env?.date ? new Date(env.date) : new Date(),
          body: parsed.text ?? parsed.html ?? '',
          headers,
        });
      }
    } finally {
      lock.release();
      await client.logout();
    }
    return out;
  },

  client(): ImapFlow {
    const imap = config.replies.imap;
    return new ImapFlow({
      host: imap.host!,
      port: imap.port,
      secure: imap.encryption !== 'none' && imap.encryption !== 'starttls',
      auth: { user: imap.user!, pass: imap.password! },
      logger: false,
    });
  },
};
