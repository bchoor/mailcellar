// Gmail settings for one connected account, read live from the Gmail API with its token.
// Nothing is stored: each page load asks Gmail again.
import {
  type FiltersResponse,
  type GmailError,
  type GmailFilter,
  type GmailLabels,
  parseFrom,
  SUBSCRIPTION_SCAN,
  type Subscription,
  type SubscriptionsResponse,
} from '@mailcellar/schema';
import { accessTokenFor } from './auth';
import type { Env } from './env';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';
/** Gmail suggests at most 50 calls a batch; 500 messages is then 10 subrequests, inside the Free plan's 50. */
const BATCH = 50;

class GmailFailure extends Error {
  constructor(readonly code: GmailError) {
    super(code);
  }
}

const failure = (status: number) => new GmailFailure(status === 401 ? 'token' : status === 403 ? 'scope' : 'gmail');

async function get<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw failure(res.status);
  return res.json();
}

/** Run `call` with an access token for the account; a Gmail or Google refusal becomes its error code. */
export async function withGmail<T>(env: Env, refreshToken: string, call: (token: string) => Promise<T>): Promise<T | { error: GmailError }> {
  const access = await accessTokenFor(env, refreshToken);
  if ('error' in access) return { error: access.revoked ? 'token' : 'gmail' };
  try {
    return await call(access.token);
  } catch (e) {
    if (e instanceof GmailFailure) return { error: e.code };
    throw e;
  }
}

/** The account's filters, with its label names so actions can name the labels they apply. */
export async function filters(token: string): Promise<FiltersResponse> {
  const [f, l] = await Promise.all([
    get<{ filter?: GmailFilter[] }>(token, '/settings/filters'),
    get<{ labels?: { id: string; name: string }[] }>(token, '/labels?fields=labels(id,name)'),
  ]);
  return {
    filters: (f.filter ?? []).map(({ id, criteria, action }) => ({ id, criteria: criteria ?? {}, action: action ?? {} })),
    labels: Object.fromEntries((l.labels ?? []).map((x) => [x.id, x.name])),
  };
}

/** The account's labels as Gmail has them now: names (including ones made since the last sync) and colours. */
export async function gmailLabels(token: string): Promise<GmailLabels> {
  const l = await get<{ labels?: { id: string; name: string; type?: string; color?: { backgroundColor?: string; textColor?: string } }[] }>(
    token,
    '/labels?fields=labels(id,name,type,color)',
  );
  return Object.fromEntries(
    (l.labels ?? []).map((x) => [
      x.id,
      {
        name: x.name,
        type: x.type === 'system' ? 'system' : 'user',
        ...(x.color?.backgroundColor && x.color.textColor ? { bg: x.color.backgroundColor, fg: x.color.textColor } : {}),
      },
    ]),
  );
}

interface Meta {
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

/** Read many messages' headers in Gmail batch calls; a message Gmail didn't return is left out. */
async function metadata(token: string, ids: string[]): Promise<Meta[]> {
  const out: Meta[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const boundary = `mc${crypto.randomUUID()}`;
    const body =
      ids
        .slice(i, i + BATCH)
        .map(
          (id) =>
            `--${boundary}\r\nContent-Type: application/http\r\n\r\n` +
            `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata` +
            `&metadataHeaders=From&metadataHeaders=List-Id&metadataHeaders=List-Unsubscribe&fields=internalDate,payload/headers\r\n\r\n`,
        )
        .join('') + `--${boundary}--`;
    const res = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/mixed; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw failure(res.status);
    out.push(...parseBatch(res.headers.get('content-type') ?? '', new TextDecoder().decode(await res.arrayBuffer())));
  }
  return out;
}

/** The JSON bodies of a batch response's parts that answered 200. */
export function parseBatch(contentType: string, text: string): Meta[] {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundary) return [];
  const out: Meta[] = [];
  for (const part of text.split(`--${boundary[1] ?? boundary[2]}`)) {
    if (!/HTTP\/1\.1 200/.test(part)) continue;
    const start = part.indexOf('{');
    const end = part.lastIndexOf('}');
    if (start < 0 || end < start) continue;
    try {
      out.push(JSON.parse(part.slice(start, end + 1)));
    } catch {}
  }
  return out;
}

/**
 * Mailing lists and newsletters: senders of the newest messages that carry List-Unsubscribe
 * or List-Id, grouped by sender. Gmail has no API for its own Subscriptions page; these
 * headers are what it reads too.
 */
export async function subscriptions(token: string): Promise<SubscriptionsResponse> {
  const q = encodeURIComponent('-in:sent -in:chats -in:drafts');
  const list = await get<{ messages?: { id: string }[] }>(token, `/messages?maxResults=${SUBSCRIPTION_SCAN}&q=${q}&fields=messages/id`);
  const metas = await metadata(token, (list.messages ?? []).map((m) => m.id));
  const by = new Map<string, Subscription>();
  for (const m of metas) {
    const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    const listId = header('List-Id') ?? null;
    if (!listId && !header('List-Unsubscribe')) continue;
    const from = parseFrom(header('From') ?? '');
    if (!from.addr) continue;
    const ts = Number(m.internalDate ?? 0);
    const s = by.get(from.addr) ?? { addr: from.addr, name: from.name, listId, n: 0, lastTs: ts };
    s.n += 1;
    if (ts >= s.lastTs) {
      s.lastTs = ts;
      s.name = from.name || s.name;
      s.listId = listId ?? s.listId;
    }
    by.set(from.addr, s);
  }
  return { scanned: metas.length, subscriptions: [...by.values()].sort((a, b) => b.n - a.n || b.lastTs - a.lastTs) };
}
