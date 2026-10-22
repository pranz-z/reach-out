import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { drafts, emails, leads, replies } from '../db/schema';
import { db } from '../db';
import { audit } from '../audit';
import { config, ts } from '../config';
import { Suppression } from '../suppression';
import { ReplyClassifier, LABELS, Label } from './classifier';
import { header, IncomingMessage } from './incoming';
import { randomUUID } from 'node:crypto';

type Reply = typeof replies.$inferSelect;
type Lead = typeof leads.$inferSelect;

const ADDR = '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}';
const EMAIL_RX = new RegExp(ADDR, 'i');

/**
 * One code path for every inbound message: manual entry (and later,
 * polled IMAP) funnels through handle(). Deduplicates by Message-ID,
 * matches a lead, classifies deterministically, stores a 500-char
 * snippet (never the full body), then applies actions.
 */
export class ReplyProcessor {
  private classifier = new ReplyClassifier();

  /** The stored reply, or null when skipped as a duplicate. */
  handle(m: IncomingMessage, source = 'manual', forcedLabel: Label | null = null): Reply | null {
    const messageId = m.messageId.trim() !== '' ? m.messageId.trim() : `no-id-${randomUUID()}`;
    const dupe = db().select({ id: replies.id }).from(replies).where(eq(replies.messageId, messageId)).limit(1).all();
    if (dupe.length) return null;

    // Normalize the failed recipient into a header before matching —
    // it is the address a bounce actually belongs to.
    if (this.classifier.looksLikeBounce(m) && (header(m, 'x-failed-recipients') ?? '') === '') {
      const failed = this.extractFailedRecipient(m);
      if (failed) m.headers['x-failed-recipients'] = failed;
    }

    const [lead, rule] = this.matchLead(m);
    let label: string = forcedLabel ?? this.classifier.classify(m);
    if (!LABELS.includes(label as Label)) label = 'unknown';
    const needsReview = forcedLabel === null
      && label === 'bounce_soft'
      && this.classifier.isUnrecognizedBounce(m);

    const id = db().insert(replies).values({
      leadId: lead?.id ?? null,
      receivedAt: ts(m.receivedAt ?? new Date()),
      classification: label,
      snippet: limit(this.classifier.cleanBody(m.body), 500),
      messageId,
      inReplyTo: m.inReplyTo,
      fromAddress: m.fromAddress.toLowerCase(),
      subject: limit(m.subject, 255),
      matched: lead !== null,
      needsReview,
      source,
      headers: Object.keys(m.headers).length ? m.headers : null,
      createdAt: ts(), updatedAt: ts(),
    }).run().lastInsertRowid;
    const reply = db().select().from(replies).where(eq(replies.id, Number(id))).get()!;

    audit('reply', reply.id, 'received', {
      from: reply.fromAddress, label, match_rule: rule, lead_id: lead?.id,
    });

    if (lead) this.applyActions(reply, lead);
    return reply;
  }

  /**
   * Re-run the action half after a human overrides a label. Only
   * `stop`/`bounce_hard` create suppressions; moving away from `stop`
   * never removes one automatically.
   */
  relabel(reply: Reply, newLabel: string): void {
    if (!LABELS.includes(newLabel as Label)) {
      throw new Error(`Unknown label ${newLabel}`);
    }
    const old = reply.classification;
    db().update(replies).set({ classification: newLabel, needsReview: false, updatedAt: ts() })
      .where(eq(replies.id, reply.id)).run();
    audit('reply', reply.id, 'relabelled', { from: old, to: newLabel });

    const lead = reply.leadId ? db().select().from(leads).where(eq(leads.id, reply.leadId)).get() : undefined;
    if (lead && old !== newLabel) {
      this.applyActions({ ...reply, classification: newLabel }, lead, true);
    }
  }

  private matchLead(m: IncomingMessage): [Lead | null, string] {
    // 1. In-Reply-To / References against our stored Message-IDs.
    const bare = (id: string | null | undefined) => (id ?? '').trim().replace(/[<>]/g, '');
    const targets = [...m.references, m.inReplyTo].map(bare).filter((x) => x !== '');
    if (targets.length) {
      const hit = db().select().from(emails)
        .where(sql`TRIM(${emails.messageId}, '<>') IN (${sql.join(targets.map((t) => sql`${t}`), sql`, `)})`)
        .limit(1).get();
      if (hit?.leadId) {
        const lead = db().select().from(leads).where(eq(leads.id, hit.leadId)).get();
        if (lead) return [lead, 'header'];
      }
    }

    // 2. Exact sender address.
    let lead = db().select().from(leads).where(eq(leads.publicEmail, m.fromAddress.toLowerCase())).limit(1).get();
    if (lead) return [lead, 'address'];

    // 2b. Bounces come from MAILER-DAEMON — the failed recipient is
    // the address that actually belongs to a lead.
    const failed = this.failedRecipient(m);
    if (failed) {
      lead = db().select().from(leads).where(eq(leads.publicEmail, failed)).limit(1).get();
      if (lead) return [lead, 'failed-recipient'];
    }

    // 3. Domain — only when exactly one lead uses it.
    const domain = m.fromAddress.toLowerCase().split('@')[1] ?? '';
    if (domain) {
      const rows = db().select({ id: leads.id }).from(leads)
        .where(like(leads.publicEmail, `%@${domain}`)).all();
      if (rows.length === 1) {
        return [db().select().from(leads).where(eq(leads.id, rows[0].id)).get()!, 'domain'];
      }
    }

    return [null, 'unmatched'];
  }

  private applyActions(reply: Reply, lead: Lead, relabel = false): void {
    const label = reply.classification ?? 'unknown';

    if (label === 'stop' || label === 'bounce_hard') {
      for (const address of this.addressesToSuppress(reply, lead)) {
        if (reply.needsReview) Suppression.addAddress(address, 'bounce');
        else Suppression.add(address, label === 'stop' ? 'opt_out' : 'bounce');
      }
      db().update(leads).set({ status: label === 'stop' ? 'opted_out' : 'bounced', updatedAt: ts() })
        .where(eq(leads.id, lead.id)).run();
      this.cancelDrafts(lead, `reply#${reply.id} ${label}`);
    } else if (label === 'bounce_soft') {
      this.markBounced(reply);
      const threshold = config.replies.softBounceThreshold;
      const key = this.bounceRecipient(reply, lead);
      const bounces = db().select({ id: replies.id }).from(replies)
        .where(and(
          eq(replies.classification, 'bounce_soft'),
          key ? or(eq(replies.fromAddress, key), eq(replies.leadId, lead.id)) : eq(replies.leadId, lead.id),
        )).all().length;
      if (bounces >= threshold) {
        // A bounce shape we never decoded never widens to the domain.
        for (const address of this.addressesToSuppress(reply, lead)) {
          if (reply.needsReview) Suppression.addAddress(address, 'bounce');
          else Suppression.add(address, 'bounce');
        }
        db().update(leads).set({ status: 'bounced', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
        this.cancelDrafts(lead, `reply#${reply.id} soft bounce #${bounces}`);
        audit('lead', lead.id, 'escalated_hard_bounce', { reply_id: reply.id, soft_bounces: bounces });
      }
    } else if (label === 'auto_reply') {
      // Record only — explicitly no status or follow-up changes.
    } else {
      // interested / not_interested / unknown: human replied.
      db().update(leads).set({ status: 'replied', updatedAt: ts() }).where(eq(leads.id, lead.id)).run();
      this.cancelFollowups(lead, `reply#${reply.id}`);
    }

    if (!relabel || label === 'stop' || label === 'bounce_hard') {
      audit('lead', lead.id, 'reply_action', {
        reply_id: reply.id, label, match_rule: reply.matched ? 'matched' : 'manual',
      });
    }
  }

  /**
   * Addresses a stop/bounce should suppress. For human replies that is
   * the sender plus the lead's own address (they may write back from a
   * different mailbox). For bounces it is the failed recipient or the
   * lead's emailed address — never the MAILER-DAEMON sender, whose
   * domain (e.g. gmail.com) must not land on the suppression list.
   */
  private addressesToSuppress(reply: Reply, lead: Lead): string[] {
    const out: string[] = [];
    const label = reply.classification;
    if ((label === 'stop' || label === 'unknown') && reply.fromAddress) {
      out.push(reply.fromAddress.toLowerCase());
    }
    if (label === 'bounce_hard' || label === 'bounce_soft') {
      const r = this.bounceRecipient(reply, lead);
      if (r) out.push(r);
    }
    if (lead.publicEmail) out.push(lead.publicEmail.toLowerCase());
    return [...new Set(out.filter(Boolean))];
  }

  /** The address that actually bounced — recipient, not the daemon. */
  private bounceRecipient(reply: Reply, lead: Lead): string | null {
    const h = reply.headers?.['x-failed-recipients'];
    const m = h ? EMAIL_RX.exec(h) : null;
    return m ? m[0].toLowerCase() : lead.publicEmail;
  }

  private failedRecipient(m: IncomingMessage): string | null {
    const h = header(m, 'x-failed-recipients');
    const direct = h ? EMAIL_RX.exec(h) : null;
    if (direct) return direct[0].toLowerCase();
    return this.extractFailedRecipient(m);
  }

  /**
   * Dig the failed recipient out of a bounce body — DSN fields, Gmail
   * and Exchange phrasings, then a last-resort address scan limited to
   * bounce-origin mail so a human quoting an address never misleads it.
   */
  private extractFailedRecipient(m: IncomingMessage): string | null {
    const hay = m.body + '\n' + Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const patterns = [
      new RegExp(`final-recipient:\\s*rfc822;\\s*<?(${ADDR})>?`, 'i'),
      new RegExp(`the following (?:address|recipient)s? (?:failed|did not reach)[:\\s]*<?(${ADDR})`, 'i'),
      new RegExp(`delivery to the following recipients? (?:has |permanently )?failed[^<]*<?(${ADDR})`, 'i'),
      new RegExp(`(?:wasn'?t|was not) delivered to\\s+<?(${ADDR})`, 'i'),
      new RegExp(`undeliverable (?:to|address)[:\\s]*<?(${ADDR})`, 'i'),
      new RegExp(`<(${ADDR})>:\\s*(?:address not found|user unknown|does not exist|mailbox|\\d{3}\\s)`, 'i'),
    ];
    for (const rx of patterns) {
      const x = rx.exec(hay);
      if (x) return x[1].toLowerCase();
    }

    if (!this.classifier.looksLikeBounce(m)) return null;
    // Last resort: first address that is not a daemon, not us.
    const self = new Set([
      config.senderAddress.toLowerCase(),
      config.replyToAddress.toLowerCase(),
      m.fromAddress.toLowerCase(),
    ]);
    const all = hay.match(new RegExp(ADDR, 'gi')) ?? [];
    for (const addr of new Set(all.map((a) => a.toLowerCase()))) {
      if (!/mailer-daemon|postmaster|no-?reply/i.test(addr) && !self.has(addr)) return addr;
    }
    return null;
  }

  private markBounced(reply: Reply): void {
    if (!reply.inReplyTo) return;
    const bare = reply.inReplyTo.trim().replace(/[<>]/g, '');
    db().update(emails).set({ deliveryStatus: 'bounced_soft', updatedAt: ts() })
      .where(sql`TRIM(${emails.messageId}, '<>') = ${bare}`).run();
  }

  private cancelDrafts(lead: Lead, reason: string): void {
    const rows = db().select().from(drafts)
      .where(and(eq(drafts.leadId, lead.id), inArray(drafts.status, ['pending', 'approved']))).all();
    for (const d of rows) {
      db().update(drafts).set({ status: 'cancelled', failureReason: reason, updatedAt: ts() })
        .where(eq(drafts.id, d.id)).run();
      audit('draft', d.id, 'cancelled', { reason });
    }
  }

  private cancelFollowups(lead: Lead, reason: string): void {
    const rows = db().select().from(drafts)
      .where(and(eq(drafts.leadId, lead.id), eq(drafts.kind, 'followup'), inArray(drafts.status, ['pending', 'approved']))).all();
    for (const d of rows) {
      db().update(drafts).set({ status: 'cancelled', failureReason: reason, updatedAt: ts() })
        .where(eq(drafts.id, d.id)).run();
      audit('draft', d.id, 'cancelled', { reason });
    }
  }
}

function limit(s: string | null | undefined, n: number): string {
  const v = s ?? '';
  return v.length > n ? v.slice(0, n) : v;
}
