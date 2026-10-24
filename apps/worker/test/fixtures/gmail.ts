// A stand-in for Gmail, for tests only: synthetic messages, answered the way Gmail's API
// answers (list pages, batch gets as multipart, profile, labels, history).
import { mockFetch } from '../helpers';

const b64url = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export interface FakeMessage {
  id: string;
  raw: string;
  labels?: string[];
}

export function fakeRaw(i: number, opts: { subject?: string; from?: string; attachments?: number; pad?: number } = {}) {
  const parts = ['Content-Type: text/plain', '', `Body ${i}`, ''];
  for (let a = 0; a < (opts.attachments ?? 0); a++)
    parts.push('--b', 'Content-Type: application/pdf', `Content-Disposition: attachment; filename="f${a}.pdf"`, '', 'JVBERi0=');
  return [
    `From: ${opts.from ?? `"Sender ${i}" <s${i}@example.com>`}`,
    `Subject: ${opts.subject ?? `Test ${i}`}`,
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    ...parts,
    'x'.repeat(opts.pad ?? 0),
    '--b--',
  ].join('\r\n');
}

export const fakeMessages = (n: number, from = 1): FakeMessage[] =>
  Array.from({ length: n }, (_, k) => ({ id: (0x1000 + from + k).toString(16), raw: fakeRaw(from + k) }));

/** Install the fake. `opts.fail` answers a batch part with that status, once per message ID. */
export function fakeGmail(mail: FakeMessage[], opts: { pageSize?: number; historyAdded?: string[]; failOnce?: Record<string, number>; tokenError?: string; estimate?: number } = {}) {
  const calls: string[] = [];
  const failed = new Set<string>();
  const byId = new Map(mail.map((m) => [m.id, m]));
  const pageSize = opts.pageSize ?? 500;
  mockFetch(async (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return opts.tokenError ? Response.json({ error: opts.tokenError }, { status: 400 }) : Response.json({ access_token: 'at', expires_in: 3600 });
    if (u.pathname === '/gmail/v1/users/me/profile') return Response.json({ emailAddress: 'me@example.com', messagesTotal: mail.length, historyId: '100' });
    if (u.pathname === '/gmail/v1/users/me/labels')
      return Response.json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }] });
    if (u.pathname === '/gmail/v1/users/me/messages') {
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const ids = mail.slice(start, start + pageSize).map((m) => ({ id: m.id, threadId: m.id }));
      const next = start + pageSize < mail.length ? String(start + pageSize) : undefined;
      const q = u.searchParams.get('q');
      if (q) calls.push(`q=${q}`);
      return Response.json({ messages: ids, nextPageToken: next, resultSizeEstimate: opts.estimate ?? mail.length });
    }
    if (u.pathname === '/gmail/v1/users/me/history')
      return Response.json({ history: (opts.historyAdded ?? []).map((id) => ({ messagesAdded: [{ message: { id } }] })), historyId: '200' });
    if (u.pathname === '/batch/gmail/v1') {
      const ids = [...String(init?.body).matchAll(/messages\/([0-9a-f]+)\?format=(raw|minimal)/g)].map((m) => [m[1], m[2]]);
      const parts = ids.map(([id, format]) => {
        const m = byId.get(id);
        if (format === 'minimal')
          return `--batch_x\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${m ? 200 : 404} X\r\n\r\n${m ? JSON.stringify({ id, sizeEstimate: m.raw.length }) : '{}'}\r\n`;
        const fail = opts.failOnce?.[id];
        let status = m ? 200 : 404;
        let body = m
          ? JSON.stringify({ id, threadId: id, labelIds: m.labels ?? ['INBOX'], snippet: 'It&#39;s a test', sizeEstimate: m.raw.length, internalDate: String(Date.UTC(2024, 0, 1) + Number.parseInt(id, 16) * 1000), raw: b64url(m.raw) })
          : '{"error":{"code":404}}';
        if (fail && !failed.has(id)) {
          failed.add(id);
          status = fail;
          body = '{"error":{}}';
        }
        return `--batch_x\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`;
      });
      return new Response(parts.join('') + '--batch_x--', { headers: { 'content-type': 'multipart/mixed; boundary=batch_x' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}
