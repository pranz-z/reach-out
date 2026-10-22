import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config';

export interface OutboundMail {
  to: string;
  subject: string;
  body: string;
  messageId: string; // canonical "<id@domain>" is stored by the caller; we receive the bare id
}

/**
 * Mail transport. `log` (the required dev/test default) appends a formatted
 * message to storage/logs/mail.log — nothing leaves the machine. `smtp`
 * uses SMTP_URL (smtp[s]://user:pass@host:port). Mirrors Laravel's MAIL_MAILER
 * contract: MAIL_MAILER must be `log` unless real sending is intended.
 */
export async function sendMail(mail: OutboundMail): Promise<void> {
  if (config.mail.mailer === 'smtp') {
    const { createRequire } = await import('node:module');
    const nodemailer = createRequire(import.meta.url)('nodemailer') as {
      createTransport: (o: Record<string, unknown>) => { sendMail: (m: Record<string, unknown>) => Promise<unknown> };
    };
    const transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.encryption === 'ssl' || config.mail.encryption === 'tls',
      auth: config.mail.username ? { user: config.mail.username, pass: config.mail.password } : undefined,
    });
    await transport.sendMail({
      from: `"${config.senderName}" <${config.senderAddress}>`,
      replyTo: `"${config.senderName}" <${config.replyToAddress}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
      messageId: `<${mail.messageId}>`,
      headers: { 'List-Unsubscribe': `<mailto:${config.replyToAddress}?subject=STOP>` },
    });
    return;
  }

  // log mailer — append the full message, clearly delimited.
  const file = resolve(process.cwd(), 'storage/logs/mail.log');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, [
    '='.repeat(60),
    `Date: ${new Date().toISOString()}`,
    `Message-ID: <${mail.messageId}>`,
    `From: ${config.senderName} <${config.senderAddress}>`,
    `Reply-To: ${config.replyToAddress}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `List-Unsubscribe: <mailto:${config.replyToAddress}?subject=STOP>`,
    '',
    mail.body,
    '',
  ].join('\n'));
}
