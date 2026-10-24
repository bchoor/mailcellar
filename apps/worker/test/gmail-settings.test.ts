import { filterActions, filterCriteria, parseFrom, type FiltersResponse, type SubscriptionsResponse } from '@mailcellar/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBatch } from '../src/gmail-settings';
import { mockFetch, signIn } from './helpers';

afterEach(() => vi.restoreAllMocks());

const owner = signIn('gmail-settings@example.com', { account: true });
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** A Gmail batch response with one part per body; null stands for a part Gmail refused. */
function batch(bodies: (object | null)[]) {
  const b = 'batch_xyz';
  const text = bodies
    .map((body) =>
      body
        ? `--${b}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`
        : `--${b}\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 429 Too Many Requests\r\n\r\n{"error":{}}\r\n`,
    )
    .join('') + `--${b}--`;
  return new Response(text, { headers: { 'content-type': `multipart/mixed; boundary=${b}` } });
}

const headers = (h: Record<string, string>) => ({ internalDate: h.date ?? '1000', payload: { headers: Object.entries(h).map(([name, value]) => ({ name, value })) } });

/** Google's token endpoint and the Gmail API, as the test wants them to answer. */
function gmail(answer: (url: string) => Response) {
  mockFetch((url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
    return answer(url);
  });
}

describe('Gmail settings', () => {
  it('reads filters with their label names', async () => {
    const { api, accountId } = await owner;
    gmail((url) => {
      if (url === `${API}/settings/filters`)
        return Response.json({ filter: [{ id: 'f1', criteria: { from: 'news@x.example' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } }] });
      if (url.startsWith(`${API}/labels`)) return Response.json({ labels: [{ id: 'Label_1', name: 'News' }] });
      throw new Error(url);
    });
    const res = await api(`/api/accounts/${accountId}/filters`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FiltersResponse;
    expect(body.filters.map((f) => [filterCriteria(f), filterActions(f, body.labels)])).toEqual([
      ['From news@x.example', 'Skip the inbox · Apply label “News”'],
    ]);
  });

  it('finds subscriptions from list headers, grouped by sender', async () => {
    const { api, accountId } = await owner;
    gmail((url) => {
      if (url.startsWith(`${API}/messages?`)) return Response.json({ messages: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] });
      if (url.startsWith('https://gmail.googleapis.com/batch/gmail/v1'))
        return batch([
          headers({ From: 'Shop <deals@shop.example>', 'List-Unsubscribe': '<https://shop.example/u>', date: '2000' }),
          headers({ From: '"Shop Deals" <Deals@Shop.example>', 'List-Id': 'deals.shop.example', date: '3000' }),
          headers({ From: 'friend@x.example' }),
          null,
        ]);
      throw new Error(url);
    });
    const body = (await (await api(`/api/accounts/${accountId}/subscriptions`)).json()) as SubscriptionsResponse;
    expect(body).toEqual({
      scanned: 3,
      subscriptions: [{ addr: 'deals@shop.example', name: 'Shop Deals', listId: 'deals.shop.example', n: 2, lastTs: 3000 }],
    });
  });

  it('says why when Google refuses', async () => {
    const { api, accountId } = await owner;
    mockFetch((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      throw new Error(url);
    });
    const res = await api(`/api/accounts/${accountId}/filters`);
    expect([res.status, await res.json()]).toEqual([502, { error: 'token' }]);
  });

  it("404s an account that isn't the person's", async () => {
    const { api } = await owner;
    expect((await api(`/api/accounts/a${'z'.repeat(22)}/filters`)).status).toBe(404);
  });
});

describe('plain words', () => {
  it('describes criteria and actions', () => {
    const f = {
      id: 'x',
      criteria: { subject: 'invoice', hasAttachment: true, size: 5 * 1024 * 1024, sizeComparison: 'larger' as const },
      action: { addLabelIds: ['TRASH', 'CATEGORY_UPDATES'], removeLabelIds: ['UNREAD'], forward: 'me@x.example' },
    };
    expect(filterCriteria(f)).toBe('Subject has “invoice” · Has an attachment · Larger than 5 MB');
    expect(filterActions(f, {})).toBe('Mark as read · Delete it · Categorize as Updates · Forward to me@x.example');
  });

  it('parses senders', () => {
    expect(parseFrom('Ada <ADA@x.example>')).toEqual({ name: 'Ada', addr: 'ada@x.example' });
    expect(parseFrom('ada@x.example')).toEqual({ name: '', addr: 'ada@x.example' });
  });

  it('ignores a batch response without a boundary', () => {
    expect(parseBatch('application/json', '{}')).toEqual([]);
  });
});
