// Body snippets for search results: the line of a message's body where the search words are. Bodies
// are not kept in the mailbox, so each snippet reads the message's first bytes from its raw file
// (R2 object): one small read a message, only for the rows a page shows.
import { r2Keys, type BodySnippet, type UserId } from '@mailcellar/schema';
import type { Env } from './env';
import { BODY_SCAN, searchText } from './gmail';
import { accountMailbox } from './sync';

/** Snippets one call makes, at most: a page of results. */
export const SNIPPETS_MAX = 50;
/** Characters a snippet shows, about. */
const SNIPPET_LEN = 200;
/** Raw-file reads in flight at once. */
const FLIGHT = 8;

/** A string lower-cased and without accents, as search's tokenizer sees it, with where each of its characters came from. */
function fold(s: string): { text: string; from: number[] } {
  let text = '';
  const from: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    text += f;
    for (let k = 0; k < f.length; k++) from.push(i);
  }
  from.push(s.length);
  return { text, from };
}

/** The search's words as the tokenizer splits them: letters and digits. */
export function searchWords(q: string): string[] {
  return [...new Set(fold(q).text.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16);
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where in `text` the words stand as whole words, and the part of it around the first: null when none does. */
export function snippetOf(body: string, words: string[]): BodySnippet | null {
  if (!words.length) return null;
  const text = body.replace(/\s+/g, ' ').trim();
  const f = fold(text);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${words.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  const all = [...f.text.matchAll(re)].map((m) => [f.from[m.index!], f.from[m.index! + m[0].length]] as [number, number]);
  if (!all.length) return null;
  let start = Math.max(0, all[0][0] - 30);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let end = Math.min(text.length, start + SNIPPET_LEN);
  if (end < text.length) end = text.lastIndexOf(' ', end) > all[0][1] ? text.lastIndexOf(' ', end) : end;
  const head = start > 0 ? '…' : '';
  const hits = all.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - start + head.length, b - start + head.length] as [number, number]);
  return { text: head + text.slice(start, end) + (end < text.length ? '…' : ''), hits };
}

/**
 * GET /api/accounts/:id/snippets?ids=&q=: for each message ID, the part of its body where the
 * search words are, with each word's place. IDs whose body doesn't hold them are left out.
 */
export async function bodySnippets(env: Env, user: UserId, account: string, ids: string[], q: string): Promise<Record<string, BodySnippet>> {
  const words = searchWords(q);
  if (!words.length || !ids.length) return {};
  const at = await accountMailbox(env, user, account).locations(ids.slice(0, SNIPPETS_MAX));
  const prefix = r2Keys.prefix(user);
  const out: Record<string, BodySnippet> = {};
  const todo = Object.entries(at);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const [id, loc] = todo[next++];
      const key = loc?.key ?? r2Keys.raw(user, account, id);
      if (!key.startsWith(prefix)) continue;
      const placed = loc && loc.offset >= 0 && loc.len >= 0;
      const obj = await env.ARCHIVE.get(key, placed ? { range: { offset: loc.offset, length: Math.min(loc.len, BODY_SCAN) } } : undefined);
      if (!obj) continue;
      const raw =
        obj.httpMetadata?.contentEncoding === 'gzip'
          ? new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
          : new Uint8Array(await obj.arrayBuffer());
      const s = snippetOf(searchText(raw), words);
      if (s) out[id] = s;
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLIGHT, todo.length) }, worker));
  return out;
}
