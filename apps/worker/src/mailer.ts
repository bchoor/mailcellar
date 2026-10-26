// Sends MailCellar's own email (invites, built by the people kit) over SMTP with STARTTLS, straight from the Worker.
// The relay and its send-only login are Worker variables and secrets (SMTP_*); unset: no email.
import { connect } from 'cloudflare:sockets';
import type { MailMessage } from '@columenlabs/lumen-people';
import type { MailOutcome } from '@columenlabs/lumen-ui-types/people';
import type { Env } from './env';

export const canSend = (env: Env) => !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD && env.MAIL_FROM);

/** One SMTP conversation: send a line, read the reply, insist on the code expected. */
class Smtp {
  private buffer = '';
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  constructor(private socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** A whole reply (the last line has a space after its code); throws unless its code is `expect`. */
  async reply(expect: number): Promise<string> {
    const decoder = new TextDecoder();
    for (;;) {
      const lines = this.buffer.split('\r\n');
      const last = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (last >= 0) {
        const text = lines.slice(0, last + 1).join('\n');
        this.buffer = lines.slice(last + 1).join('\r\n');
        if (!text.startsWith(String(expect))) throw new Error(`SMTP: ${text.slice(0, 200)}`);
        return text;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('SMTP: connection closed');
      this.buffer += decoder.decode(value, { stream: true });
    }
  }

  async send(line: string, expect: number): Promise<string> {
    await this.writer.write(new TextEncoder().encode(`${line}\r\n`));
    return this.reply(expect);
  }

  /** Swap the plain connection for TLS (after STARTTLS). */
  upgrade() {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }

  close() {
    void this.socket.close().catch(() => {});
  }
}

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const header = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`);

const lines = (text: string) => (b64(text).match(/.{1,76}/g) ?? []).join('\r\n');

/** Send one email (text and HTML). Never throws: says whether it went, and why not. */
export async function sendMail(env: Env, m: MailMessage): Promise<MailOutcome> {
  if (!canSend(env)) return { ok: false, detail: 'Email isn’t set up' };
  const smtp = new Smtp(connect({ hostname: env.SMTP_HOST!, port: Number(env.SMTP_PORT ?? 587) }, { secureTransport: 'starttls', allowHalfOpen: false }));
  try {
    await smtp.reply(220);
    await smtp.send('EHLO mailcellar', 250);
    await smtp.send('STARTTLS', 220);
    smtp.upgrade();
    await smtp.send('EHLO mailcellar', 250);
    await smtp.send(`AUTH PLAIN ${b64(`\0${env.SMTP_USER}\0${env.SMTP_PASSWORD}`)}`, 235);
    await smtp.send(`MAIL FROM:<${env.MAIL_FROM}>`, 250);
    await smtp.send(`RCPT TO:<${m.to}>`, 250);
    await smtp.send('DATA', 354);
    const boundary = `mc-${crypto.randomUUID()}`;
    const message = [
      `From: MailCellar <${env.MAIL_FROM}>`,
      `To: <${m.to}>`,
      `Subject: ${header(m.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${env.MAIL_FROM!.split('@')[1]}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      lines(m.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      lines(m.html),
      `--${boundary}--`,
    ].join('\r\n');
    await smtp.send(`${message}\r\n.`, 250);
    await smtp.send('QUIT', 221).catch(() => '');
    return { ok: true, detail: `Sent to ${m.to}` };
  } catch (e) {
    console.log(JSON.stringify({ mail: 'failed', error: String(e) }));
    return { ok: false, detail: 'The email didn’t send. Resend to try again.' };
  } finally {
    smtp.close();
  }
}
