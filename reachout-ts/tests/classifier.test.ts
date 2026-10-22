import { describe, expect, it } from 'vitest';
import { ReplyClassifier } from '@/lib/replies/classifier';
import { IncomingMessage } from '@/lib/replies/incoming';

const c = new ReplyClassifier();
const msg = (over: Partial<IncomingMessage>): IncomingMessage => ({
  messageId: 'x', inReplyTo: null, references: [], fromAddress: 'a@b.test',
  subject: 'Re: hi', receivedAt: new Date(), body: '', headers: {}, ...over,
});

describe('ReplyClassifier', () => {
  it('classifies English opt-outs as stop', () => {
    expect(c.classify(msg({ body: 'Please stop emailing me.' }))).toBe('stop');
    expect(c.classify(msg({ body: 'unsubscribe' }))).toBe('stop');
  });

  it('classifies Filipino opt-outs as stop', () => {
    expect(c.classify(msg({ body: 'Huwag na po kayong mag-email.' }))).toBe('stop');
    expect(c.classify(msg({ body: 'ayoko na po' }))).toBe('stop');
  });

  it('classifies interest', () => {
    expect(c.classify(msg({ body: 'Sounds interesting — how much?' }))).toBe('interested');
    expect(c.classify(msg({ body: 'Magkano po?' }))).toBe('interested');
  });

  it('classifies not-interested and unknown', () => {
    expect(c.classify(msg({ body: 'No thanks.' }))).toBe('not_interested');
    expect(c.classify(msg({ body: 'The meeting room is booked Tuesday.' }))).toBe('unknown');
  });

  it('daemon + 5xx body is a hard bounce', () => {
    expect(c.classify(msg({
      fromAddress: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      body: '550 5.1.1 The email account does not exist.',
    }))).toBe('bounce_hard');
  });

  it('daemon + full mailbox is a soft bounce needing review', () => {
    const m = msg({
      fromAddress: 'postmaster@mx.test',
      subject: 'Undeliverable: hi',
      body: '452 4.2.2 mailbox full',
    });
    expect(c.classify(m)).toBe('bounce_soft');
  });

  it('auto-submitted headers short-circuit to auto_reply', () => {
    expect(c.classify(msg({ headers: { 'Auto-Submitted': 'auto-replied' }, body: 'stop' }))).toBe('auto_reply');
  });

  it('quoted STOP in history does not suppress the sender', () => {
    expect(c.classify(msg({ body: "Yes, let's talk.\n\n> If it's not relevant, just reply STOP" }))).not.toBe('stop');
  });
});
