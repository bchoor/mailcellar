import { describe, expect, it } from 'vitest';
import { bodyText, countAttachments, decodeWords, headers, indexRow, parseAddresses, parseBatch, parseFrom, unescapeSnippet } from '../src/gmail';
import { fakeRaw } from './fixtures/gmail';

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('gmail parsing', () => {
  it('splits a batch answer into its parts', () => {
    const text = '--b\r\nContent-Type: application/http\r\nContent-ID: <response-a1>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"a1"}\r\n--b\r\nContent-Type: application/http\r\nContent-ID: <response-a2>\r\n\r\nHTTP/1.1 429 Too Many\r\n\r\n{}\r\n--b--';
    expect(parseBatch(text, 'multipart/mixed; boundary=b')).toEqual([
      { contentId: 'response-a1', status: 200, body: '{"id":"a1"}' },
      { contentId: 'response-a2', status: 429, body: '{}' },
    ]);
  });

  it('reads folded headers and encoded words', () => {
    const h = headers(bytes('Subject: =?UTF-8?B?SGVsbG8g4pyT?=\r\n =?UTF-8?Q?w=C3=B6rld?=\r\nFrom: a@b.c\r\n\r\nbody'));
    expect(decodeWords(h.get('subject')!)).toBe('Hello ✓wörld');
    expect(h.get('from')).toBe('a@b.c');
  });

  it('splits senders into name and address', () => {
    expect(parseFrom('"Doe, Jane" <jane@example.com>')).toEqual({ addr: 'jane@example.com', name: 'Doe, Jane' });
    expect(parseFrom('jane@example.com (Jane)')).toEqual({ addr: 'jane@example.com', name: '' });
    expect(parseFrom('=?ISO-8859-1?Q?Andr=E9?= <a@example.com>')).toEqual({ addr: 'a@example.com', name: 'André' });
  });

  it('reads UTF-8 sent without encoding', () => {
    const raw = new TextEncoder().encode('From: Zoë <z@example.com>\r\nSubject: Café\r\n\r\n');
    const row = indexRow({ id: 'a1', threadId: 't', sizeEstimate: 9, internalDate: '1000', raw: '' }, raw);
    expect([row.fromName, row.subject]).toEqual(['Zoë', 'Café']);
  });

  it('unescapes snippets and counts attachments', () => {
    expect(unescapeSnippet('It&#39;s &amp; &lt;b&gt; &#x2713;')).toBe("It's & <b> ✓");
    expect(countAttachments(bytes(fakeRaw(1, { attachments: 2 })))).toBe(2);
  });

  it('reads recipients', () => {
    expect(parseAddresses('"Doe, Jane" <Jane@Example.com>, bob@example.com, (none)')).toEqual(['jane@example.com', 'bob@example.com']);
  });

  it('finds the body text, decoding the part and skipping attachments', () => {
    const qp = 'Content-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 au l=\r\nait\r\n--x\r\nContent-Type: text/html\r\n\r\n<p>ignored</p>\r\n--x--';
    expect(bodyText(bytes(qp))).toBe('Café au lait');
    const html = 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + btoa('<style>p{}</style><p>Hello&nbsp;there</p><p>Bye</p>');
    expect(bodyText(bytes(html))).toBe('Hello there\nBye');
    expect(bodyText(bytes(fakeRaw(7, { attachments: 1 })))).toBe('Body 7');
  });
});
