import { header, IncomingMessage } from './incoming';

/**
 * Deterministic reply classification. No LLM involved: labels drive
 * suppression and status changes, so rules are conservative — when
 * opt-out intent is ambiguous, `stop` wins over letting mail continue.
 */
export const LABELS = [
  'bounce_hard', 'bounce_soft', 'auto_reply',
  'stop', 'interested', 'not_interested', 'unknown',
] as const;
export type Label = typeof LABELS[number];

export class ReplyClassifier {
  static LABELS = LABELS;

  classify(m: IncomingMessage): Label {
    const bounce = this.bounceLabel(m);
    if (bounce) return bounce;
    if (this.isAutoReply(m)) return 'auto_reply';

    const text = this.cleanBody(m.body) + ' ' + this.subject(m);
    if (matches(text, STOP_PATTERNS)) return 'stop';
    if (matches(text, INTERESTED_PATTERNS)) return 'interested';
    if (matches(text, NOT_INTERESTED_PATTERNS)) return 'not_interested';
    return 'unknown';
  }

  /**
   * Reply text with quoted history and signatures removed, so quoted
   * copies of our own email never influence classification.
   */
  cleanBody(body: string): string {
    const out: string[] = [];
    for (const line of body.split(/\r\n|\n|\r/)) {
      const t = line.trim();
      if (/^>+/.test(t)
        || /^On\s.{3,}wrote:?\s*$/i.test(t)
        || (/^(From|Sent|To|Cc|Subject|Date):\s/i.test(t) && out.length > 0)
        || /^-{2,}\s*$/.test(t)
        || /^(Sent from|Get Outlook|Inviato da|Nakuha mula)/i.test(t)
      ) break;
      out.push(line);
    }
    return out.join('\n').trim();
  }

  /** Daemon sender or a structured delivery report. */
  looksLikeBounce(m: IncomingMessage): boolean {
    const ct = (header(m, 'content-type') ?? '').toLowerCase();
    const from = m.fromAddress.toLowerCase();
    const returnPath = (header(m, 'return-path') ?? '').toLowerCase();

    return ct.includes('multipart/report')
      || ct.includes('message/delivery-status')
      || (header(m, 'x-failed-recipients') ?? '') !== ''
      || from.includes('mailer-daemon')
      || from.includes('postmaster@')
      || returnPath === '<>'
      || (/delivery status notification|undeliverable|delivery (failure|failed)|returned mail|failure notice/i.test(m.subject) && this.isDaemonAddress(from));
  }

  /** True for daemon mail whose shape we could not classify. */
  isUnrecognizedBounce(m: IncomingMessage): boolean {
    return this.looksLikeBounce(m) && this.bounceKind(m) === null;
  }

  private bounceLabel(m: IncomingMessage): Label | null {
    if (!this.looksLikeBounce(m)) return null;
    return this.bounceKind(m) ?? 'bounce_soft';
  }

  private isDaemonAddress(from: string): boolean {
    return from.includes('mailer-daemon') || from.includes('postmaster@');
  }

  private bounceKind(m: IncomingMessage): 'bounce_hard' | 'bounce_soft' | null {
    const hay = m.body + ' ' + this.subject(m);
    if (matches(hay, HARD_BOUNCE_PATTERNS)) return 'bounce_hard';
    if (matches(hay, SOFT_BOUNCE_PATTERNS)) return 'bounce_soft';
    return null;
  }

  private isAutoReply(m: IncomingMessage): boolean {
    const auto = (header(m, 'auto-submitted') ?? '').toLowerCase();
    if (auto !== '' && auto !== 'no') return true;
    if (header(m, 'x-autoreply') !== undefined || header(m, 'x-autorespond') !== undefined) return true;
    const prec = (header(m, 'precedence') ?? '').trim().toLowerCase();
    if (['bulk', 'auto_reply', 'auto-reply', 'junk'].includes(prec)) return true;
    return /out of (the )?office|automat(ic|ed) reply|auto.?reply|away from (my )?(office|desk|computer)|on (vacation|leave|holiday)|abwesenheit|wala sa opisina/i.test(this.subject(m));
  }

  private subject(m: IncomingMessage): string {
    return m.subject.replace(/^(re|fw|fwd):\s*/i, '').trim();
  }
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Permanent-failure evidence: SMTP 5xx codes and "does not exist" phrasing. */
const HARD_BOUNCE_PATTERNS = [
  /\b5\.\d{1,3}\.\d{1,3}\b/, /\b5[0-9]{2}\b/,
  /address (not found|unknown|does not exist|doesn'?t exist|couldn'?t be found|invalid)/i,
  /user (unknown|does not exist|not found)/i, /no such (user|mailbox|address|recipient|person)/i,
  /mailbox (not found|unavailable|does not exist|disabled)/i,
  /recipient (address )?(rejected|not found|unknown|invalid)/i,
  /account (disabled|deactivated|does not exist|closed)/i,
  /delivery (to the following recipients? )?failed permanently/i,
];

/** Temporary-failure evidence: 4xx codes, full mailboxes, greylisting, rate limits. */
const SOFT_BOUNCE_PATTERNS = [
  /\b4\.\d{1,3}\.\d{1,3}\b/, /\b4[0-9]{2}\b/,
  /mailbox (full|over quota)|over quota|quota exceeded|storage (allocation|limit)/i,
  /greylist/i, /try again later|please retry|retry later|temporary failure/i,
  /temporarily (deferred|rejected|unavailable|refused|delayed)/i,
  /rate limit|too many (connections|messages|recipients|requests)/i,
  /server (is )?(busy|overloaded)|resources temporarily unavailable/i,
];

/**
 * Opt-out intent, English + Filipino/Tagalog. Anything that plausibly
 * asks us to stop emailing counts — missing a real opt-out is worse
 * than suppressing someone who only meant "not now".
 */
const STOP_PATTERNS = [
  /\bstop\b/i, /\bunsubscribe\b/i, /\bopt[\s-]?out\b/i,
  /\bremove (me|us)\b/i, /\btake (me|us) off\b/i,
  /\bdo not (e-?mail|contact|message)\b/i, /\bdon'?t (e-?mail|contact|message)\b/i,
  /\bno more (e-?mails?|messages)\b/i, /\bplease (stop|remove)\b/i,
  /\bdelete (my|our) (email|info|number|details)\b/i,
  /\bwag na\b/iu, /\bhuwag na( po)?\b/iu, /\bpaki?tigil( na|an)?( po)?\b/iu, /\btigilan\b/iu,
  /\btama na( po)?\b/iu, /\bitigil\b/iu, /\bayoko( na)?( po)?\b/iu,
  /\bayaw( na)?( namin| ko| niya)?( po)?\b/iu, /\bhwag\b/iu,
];

const INTERESTED_PATTERNS = [
  /\binterested\b/i, /\btell me more\b/i, /\bsend (me |us )?(the |more )?(details|info|information)\b/i,
  /\bhow much\b/i, /\bprice\b/i, /\bpricing\b/i, /\brates?\b/i, /\bquote\b/i, /\bquotation\b/i,
  /\bdemo\b/i, /\bschedule\b/i, /\bcall me\b/i, /\bphone me\b/i, /\blet'?s talk\b/i, /\bset (up|a) (a )?(call|meeting)\b/i,
  /\bmagkano\b/iu, /\bpresyo\b/iu,
];

const NOT_INTERESTED_PATTERNS = [
  /\bno thanks?\b/i, /\bnot interested\b/i, /\bno need(ed)?\b/i, /\bnot needed\b/i,
  /\bnot now\b/i, /\bmaybe later\b/i, /\bwe'?re (good|ok(ay)?|all set)\b/i,
  /\bpass\b/i, /\bhindi na( po)?\b/iu, /\bdi na( po)? (kailangan|needed)\b/iu,
];
