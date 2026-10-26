// Body search (Bikram, 2026-10-25): copying puts each new message's body words in search; the body
// pass does it once for mail copied before. It reads the raw files (R2 objects) in ID order from a
// bookmark the mailbox keeps, one read a pack, and only a message's first BODY_SCAN bytes, where
// its text is. No Gmail calls. Runs chain, each stopping before the daily DO write guard.
import { paidNow, r2Keys, type UserId } from '@mailcellar/schema';
import type { Env } from './env';
import { BODY_SCAN, searchText } from './gmail';
import { accountQuota } from './quota';
import { accountMailbox } from './sync';

/** Messages a batch reads from the bookmark. */
export const BODY_BATCH = 500;
/** Rows a body costs to write, about (the messages mark, the FTS size row, its share of index pages). */
export const BODY_ROWS = 6;
/** Raw bytes a run reads before handing over to the next. */
const RUN_BYTES = () => (paidNow() ? 256 : 16) * 1024 * 1024;
/** Raw-file reads in flight at once. */
const FLIGHT = 6;
/** A pack read whole when its messages' bytes, first to last, are at most this; else each message alone. */
const PACK_READ_MAX = 8 * 1024 * 1024;

export interface BodyResult {
  read: number;
  added: number;
  rowsWritten: number;
  bytes: number;
  rawReads: number;
  done: boolean;
  nextId: string | null;
  resumesAt?: string;
}

interface Todo {
  id: string;
  key: string | null;
  offset: number;
  len: number;
}

async function bytesOf(obj: R2ObjectBody): Promise<Uint8Array> {
  if (obj.httpMetadata?.contentEncoding === 'gzip') return new Uint8Array(await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return new Uint8Array(await obj.arrayBuffer());
}

/** Each message's search text, by reading its raw file: one read a pack where the pack is small enough. */
async function readBodies(env: Env, user: UserId, account: string, todo: Todo[]): Promise<{ bodies: { id: string; body: string }[]; bytes: number; reads: number }> {
  const prefix = r2Keys.prefix(user);
  const groups = new Map<string, Todo[]>();
  for (const t of todo) {
    const key = t.key ?? r2Keys.raw(user, account, t.id);
    // Locations point inside this person's prefix; anything else is skipped.
    if (!key.startsWith(prefix)) continue;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  // Each job is one read: a span of a pack covering several messages, or one message's first bytes.
  const jobs: { key: string; range?: { offset: number; length: number }; items: Todo[] }[] = [];
  for (const [key, items] of groups) {
    const placed = items.filter((t) => t.offset >= 0 && t.len >= 0);
    const whole = items.filter((t) => !(t.offset >= 0 && t.len >= 0));
    for (const t of whole) jobs.push({ key, items: [t] });
    if (!placed.length) continue;
    const start = Math.min(...placed.map((t) => t.offset));
    const end = Math.max(...placed.map((t) => t.offset + Math.min(t.len, BODY_SCAN)));
    if (end - start <= PACK_READ_MAX) jobs.push({ key, range: { offset: start, length: end - start }, items: placed });
    else for (const t of placed) jobs.push({ key, range: { offset: t.offset, length: Math.min(t.len, BODY_SCAN) }, items: [t] });
  }
  const bodies: { id: string; body: string }[] = [];
  let bytes = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const obj = await env.ARCHIVE.get(job.key, job.range ? { range: job.range } : undefined);
      // A message whose raw file is gone has no body to add; it is marked, so the pass moves on.
      if (!obj) {
        for (const t of job.items) bodies.push({ id: t.id, body: '' });
        continue;
      }
      const b = await bytesOf(obj);
      bytes += b.length;
      const base = job.range?.offset ?? 0;
      for (const t of job.items) {
        const raw = job.range ? b.subarray(t.offset - base, t.offset - base + Math.min(t.len, BODY_SCAN)) : b;
        bodies.push({ id: t.id, body: searchText(raw) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLIGHT, jobs.length) }, worker));
  return { bodies, bytes, reads: jobs.length };
}

/** One body pass run: batches from the bookmark until RUN_BYTES are read, the guard is near, or the pass is done. */
export async function runBodies(env: Env, user: UserId, account: string, runId: string): Promise<BodyResult> {
  const mailbox = accountMailbox(env, user, account);
  const quota = accountQuota(env);
  const out: BodyResult = { read: 0, added: 0, rowsWritten: 0, bytes: 0, rawReads: 0, done: false, nextId: null };
  while (out.bytes < RUN_BYTES()) {
    const full = await quota.reserve({ do_rows_written: BODY_BATCH * BODY_ROWS });
    if (full) {
      out.resumesAt = full.resumesAt;
      break;
    }
    const { todo, last } = await mailbox.bodyTodo(BODY_BATCH);
    const got = await readBodies(env, user, account, todo);
    const r = await mailbox.addBodies(got.bodies, last);
    await quota.add({ do_rows_written: r.rowsWritten, do_rows_read: BODY_BATCH + todo.length, r2_class_b: got.reads });
    out.read += todo.length;
    out.added += r.added;
    out.rowsWritten += r.rowsWritten;
    out.bytes += got.bytes;
    out.rawReads += got.reads;
    if (last === null) {
      out.done = true;
      break;
    }
  }
  // The workflow starts the next run, after the guard's reset when it stopped for it.
  if (!out.done) out.nextId = `${account}-bodies-${Date.now().toString(36)}`;
  console.log(JSON.stringify({ bodies: { account, runId, ...out, rowsPerBody: out.added ? +(out.rowsWritten / out.added).toFixed(2) : null } }));
  return out;
}
