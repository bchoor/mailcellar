import { describe, expect, it } from 'vitest';
import { countAttachments, decodeWords, headers, indexRow, parseBatch, parseFrom, unescapeSnippet } from '../src/gmail';
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
});
