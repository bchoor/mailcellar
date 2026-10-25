// One-time move off Basin (Bikram, 2026-10-25): the mailbox becomes the record, so each copied
// message's raw location (raw file, offset, length) moves from its Basin row into the mailbox
// DO. A message Basin has and the mailbox lacks is indexed from its Basin row. Runs chain a few
// months at a time; `check` then reports what still has no location and reads one message a
// month back from its raw file. This file goes when Basin is torn down.
import { basinNamespace, type UserId } from '@mailcellar/schema';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { restCatalogLoadTable } from 'icebird';
import { basinCatalog, INDEX_COLUMNS, MESSAGES_TABLE, monthFiles, r2Resolver, type BasinRow, type TableMetadata } from './basin';
import type { Env } from './env';
import { accountQuota } from './quota';
import { accountMailbox, indexedFromBasin, INDEX_ROWS, syncDeps } from './sync';

/** Months one locate run moves before handing the rest to the next run (each reads its month's Basin files). */
export const LOCATE_MONTHS = 6;

export interface LocateResult {
  month: string;
  /** Rows Basin has for the month (each message once). */
  basin: number;
  /** Locations filled in; rows indexed that the mailbox lacked; rows with no raw file named. */
  set: number;
  added: number;
  noKey: number;
}

/** Every month the mailbox knows, newest first: what a locate with no months moves. */
export async function locateMonths(env: Env, user: UserId, account: string): Promise<string[]> {
  return (await accountMailbox(env, user, account).coverageMonths()).map((m) => m.month).sort().reverse();
}

/** Move one month's raw locations from Basin into the mailbox. */
export async function runLocate(env: Env, user: UserId, account: string, month: string): Promise<LocateResult> {
  const out: LocateResult = { month, basin: 0, set: 0, added: 0, noKey: 0 };
  if (!env.BASIN_TOKEN) throw new Error('Basin has no token: nothing to move from');
  const catalog = await basinCatalog(env);
  let metadata;
  try {
    ({ metadata } = await restCatalogLoadTable(catalog, { namespace: basinNamespace(user), table: MESSAGES_TABLE }));
  } catch (e) {
    if (/404|not ?found|NoSuch/i.test(String(e))) return out;
    throw e;
  }
  const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
  const byId = new Map<string, BasinRow>();
  for (const f of await monthFiles(metadata as TableMetadata, resolver, month)) {
    const file = await resolver.reader(f.path, f.size);
    const meta = await parquetMetadataAsync(file);
    // Files written before raw_offset and raw_len were added hold whole-file messages only.
    const has = new Set(meta.schema.map((c) => c.name));
    const rows = (await parquetReadObjects({
      file,
      metadata: meta,
      columns: [...INDEX_COLUMNS, 'raw_key', 'raw_offset', 'raw_len'].filter((c) => has.has(c)),
      filter: { account: { $eq: account } },
    })) as Record<string, unknown>[];
    for (const r of rows) {
      if (r.account !== account) continue;
      const ts = r.ts instanceof Date ? r.ts.toISOString() : new Date(Number(r.ts) / 1000).toISOString();
      byId.set(String(r.id), { ...(r as unknown as BasinRow), ts, labels: (r.labels as string[] | null) ?? [] });
    }
  }
  out.basin = byId.size;
  const mailbox = accountMailbox(env, user, account);
  const quota = accountQuota(env);
  const all = [...byId.values()];
  for (let i = 0; i < all.length; i += 1000) {
    const chunk = all.slice(i, i + 1000);
    const located = chunk.filter((r) => r.raw_key);
    out.noKey += chunk.length - located.length;
    const r = await mailbox.setLocations(
      located.map((x) => ({ id: x.id, key: x.raw_key, offset: x.raw_offset == null ? null : Number(x.raw_offset), len: x.raw_len == null ? null : Number(x.raw_len) })),
    );
    out.set += r.set;
    let written = r.set;
    if (r.absent.length) {
      const absent = new Set(r.absent);
      const ing = await mailbox.ingest(located.filter((x) => absent.has(x.id)).map(indexedFromBasin), false);
      out.added += ing.added;
      written += ing.rowsWritten;
    }
    await quota.add({ do_rows_written: written, do_rows_read: chunk.length * 2 });
  }
  console.log(JSON.stringify({ locate: { account, ...out } }));
  return out;
}

/** Locate these months, LOCATE_MONTHS a run; the rest go to the next run. */
export async function runLocateChain(env: Env, user: UserId, account: string, months: string[], runId: string): Promise<{ done: LocateResult[]; nextId: string | null }> {
  const todo = months.length ? months : await locateMonths(env, user, account);
  const quota = accountQuota(env);
  const done: LocateResult[] = [];
  for (const m of todo.slice(0, LOCATE_MONTHS)) {
    // About one row written a message; indexing a missing one takes INDEX_ROWS.
    const full = await quota.reserve({ do_rows_written: 3000 * INDEX_ROWS });
    if (full) throw new Error(`Paused before the daily DO write limit (${full.label}); run again after ${full.resumesAt}`);
    done.push(await runLocate(env, user, account, m));
  }
  const rest = todo.slice(LOCATE_MONTHS);
  if (!rest.length) return { done, nextId: null };
  const nextId = `${account}-locate-${Date.now().toString(36)}`;
  await syncDeps.launch(env, { user, account, locate: rest }, nextId);
  console.log(JSON.stringify({ locateNext: { account, runId, nextId, left: rest.length } }));
  return { done, nextId };
}

/** What still has no raw location, and one message a month read back from its raw file. */
export async function locateCheck(env: Env, user: UserId, account: string) {
  const mailbox = accountMailbox(env, user, account);
  const missing = await mailbox.unlocated();
  const sample = await mailbox.locatedSample();
  const failed: { month: string; id: string; why: string }[] = [];
  for (const s of sample) {
    const obj = await env.ARCHIVE.get(s.key, s.offset >= 0 && s.len > 0 ? { range: { offset: s.offset, length: Math.min(s.len, 2048) } } : undefined);
    if (!obj) {
      failed.push({ month: s.month, id: s.id, why: 'raw file missing' });
      continue;
    }
    let bytes = new Uint8Array(await obj.arrayBuffer());
    if (obj.httpMetadata?.contentEncoding === 'gzip') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    // A message starts with header lines ("Name: value").
    const head = new TextDecoder().decode(bytes.subarray(0, 2048));
    if (!/^[\x21-\x39\x3b-\x7e]+:/m.test(head)) failed.push({ month: s.month, id: s.id, why: 'bytes are not a message' });
  }
  return { ...missing, opened: sample.length, failed };
}
