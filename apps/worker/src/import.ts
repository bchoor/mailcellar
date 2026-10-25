// Archive import: an mbox file the person uploaded (r2Keys.upload) becomes an archive mailbox's
// mail, the way a backfill copies Gmail. A chain of runs, each with a fresh budget:
//   1. scan: read the file in slices, find where each message starts ("From " lines) and its month;
//   2. copy: read messages in file order, write them end to end as pack files (raw files), and
//      append their rows to Basin;
//   3. index: build each month's search index from Basin (runIndex, as for Gmail).
// The chain's progress is a raw file (import.json), so the copy path reads no Durable Object rows;
// each run reports its counts to the archive's DO in one call, for the Backfill page.
import { MAX_LANES, r2Keys, paidNow, type MailLabel, type UserId } from '@mailcellar/schema';
import type { BasinRow } from './basin';
import { copyCpuMs } from './copy';
import type { Env } from './env';
import { bodyText, headers } from './gmail';
import { accountMailbox, basinRow, runDied, runIndex, syncDeps } from './sync';

/** An archive mailbox's file and how far its upload and import are, as the user's DO keeps it. */
export interface ArchiveRecord {
  file: string;
  bytes: number;
  /** The R2 multipart upload the parts go to, and each part's size (the last may be smaller). */
  uploadId: string;
  partSize: number;
  status: 'uploading' | 'importing' | 'done' | 'failed';
  /** Messages the file holds, once the import has read it all. */
  messages: number | null;
  error: string | null;
}

/** Upload part size: R2 takes up to 10,000 parts, so files up to about 640 GB; a Worker takes 100 MB a request. */
export const PART_SIZE = 64 * 1024 * 1024;

/** The file is read this much at a time, with OVER more so a message's headers are whole. */
const SLICE = 8 * 1024 * 1024;
const OVER = 64 * 1024;
/** A pack holds messages up to this size all told, or PACK_MAX of them. */
const PACK_BYTES = 8 * 1024 * 1024;
const PACK_MAX = 400;
/** A message bigger than this isn't imported (a Worker has 128 MB); it is counted and logged. */
const MESSAGE_MAX = 40 * 1024 * 1024;
/** CPU a run may spend, in estimated ms (as a lane's), and its wall time. */
const RUN_CPU_MS = () => (paidNow() ? 10_000 : 900);
const RUN_WALL_MS = () => (paidNow() ? 90_000 : 25_000);
/** Rows a run appends to Basin at most: the append's own CPU grows with them. */
const RUN_ROWS = () => (paidNow() ? 4000 : 400);
/** A run that hasn't saved for this long has died, and the watchdog starts the chain again. */
const IMPORT_STALE_MS = 15 * 60_000;

/** The import's progress, kept in its raw file. */
export interface ImportState {
  /** The run that owns the chain now, and the one before it (a retry of that one hands over again). */
  runId: string;
  prev: string | null;
  phase: 'scan' | 'copy' | 'index' | 'done' | 'failed';
  file: string;
  bytes: number;
  /** Scan: the next byte to read, scan files written, messages found, Spam and Trash left out. */
  pos: number;
  scans: number;
  messages: number;
  skipped: number;
  months: Record<string, number>;
  /** Gmail label IDs made for the file's own labels (X-Gmail-Labels), with their names. */
  labels: Record<string, string>;
  /** The job the months are queued under (the archive DO's), once the scan is done. */
  job: number | null;
  /** Copy: the scan file and the entry in it to copy next, and what is copied. */
  scanAt: number;
  at: number;
  packs: number;
  copied: number;
  /** Messages too big to import, by month. */
  tooBig: Record<string, number>;
  /** Staged row files not yet in Basin, oldest first. */
  unstaged: string[];
  basinReady: boolean;
  /** Index: months left to build, newest first, and where the first one resumes. */
  toIndex: string[];
  indexFrom: number;
  runs: number;
  startedAt: string;
  updatedAt: string;
  resumesAt: string | null;
  error: string | null;
}

/** Where each message of one scan run starts, and its month ('' for Spam and Trash, left out). */
interface ScanFile {
  starts: number[];
  months: string[];
}

export async function readImport(env: Env, user: UserId, account: string): Promise<{ s: ImportState; etag: string } | null> {
  const obj = await env.ARCHIVE.get(r2Keys.importState(user, account));
  return obj ? { s: (await obj.json()) as ImportState, etag: obj.etag } : null;
}

async function saveImport(env: Env, user: UserId, account: string, s: ImportState, etag: string | null): Promise<string | null> {
  const put = await env.ARCHIVE.put(r2Keys.importState(user, account), JSON.stringify(s), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
  });
  return put?.etag ?? null;
}

const nextRunId = (account: string) => `${account}-import-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** The upload is complete: start the import chain (once). */
export async function startImport(env: Env, user: UserId, account: string, record: ArchiveRecord): Promise<void> {
  const at = new Date().toISOString();
  const runId = nextRunId(account);
  const s: ImportState = {
    runId, prev: null, phase: 'scan', file: record.file, bytes: record.bytes, pos: 0, scans: 0, messages: 0, skipped: 0, months: {}, labels: {},
    job: null, scanAt: 0, at: 0, packs: 0, copied: 0, tooBig: {}, unstaged: [], basinReady: false, toIndex: [], indexFrom: 0,
    runs: 0, startedAt: at, updatedAt: at, resumesAt: null, error: null,
  };
  if (await saveImport(env, user, account, s, null)) await syncDeps.launch(env, { user, account, import: true }, runId);
}

/**
 * The watchdog's check: start the chain again where it stood if its run died. Returns the phase
 * while the import is going, null once it is done (or failed, or there is none).
 */
export async function keepImporting(env: Env, user: UserId, account: string): Promise<string | null> {
  const got = await readImport(env, user, account);
  if (!got || got.s.phase === 'done' || got.s.phase === 'failed') return null;
  const { s } = got;
  const now = Date.now();
  const waiting = !!s.resumesAt && Date.parse(s.resumesAt) > now;
  if (!waiting && now - Date.parse(s.updatedAt) > IMPORT_STALE_MS && (await runDied(env, s.runId))) {
    const runId = nextRunId(account);
    if (await saveImport(env, user, account, { ...s, runId, prev: null, updatedAt: new Date().toISOString() }, got.etag)) {
      console.log(JSON.stringify({ importRestarted: { account, phase: s.phase, was: s.runId } }));
      await syncDeps.launch(env, { user, account, import: true }, runId);
    }
  }
  return s.phase;
}

export interface ImportResult {
  phase: ImportState['phase'];
  nextId: string | null;
  resumesAt: string | null;
}

/** One run of the import chain: as much of its phase as the run's budget allows, then hand over. */
export async function runImport(env: Env, user: UserId, account: string, runId: string): Promise<ImportResult> {
  const started = Date.now();
  const got = await readImport(env, user, account);
  const none = (phase: ImportState['phase'] = 'done'): ImportResult => ({ phase, nextId: null, resumesAt: null });
  if (!got) return none();
  const { s } = got;
  if (s.prev === runId && s.runId) return { phase: s.phase, nextId: s.runId, resumesAt: s.resumesAt };
  if (s.runId !== runId) return none(s.phase);
  s.resumesAt = null;
  const owner = env.MAILBOX.getByName(`${user}:default`);
  // The archive was removed: the chain stops (from memory in the user's DO; no row read).
  if ((await owner.accountKind(account)) !== 'archive') return none(s.phase);
  const fail = async (error: string) => {
    s.phase = 'failed';
    s.error = error;
    await owner.setArchive(account, { status: 'failed', error });
    await accountMailbox(env, user, account).importFailed(error);
  };
  const budget = { wall: started + RUN_WALL_MS(), cpu: RUN_CPU_MS() };
  try {
    if (s.phase === 'scan') await scanRun(env, user, account, s, budget, fail);
    else if (s.phase === 'copy') await copyRun(env, user, account, s, budget);
    else if (s.phase === 'index') await indexRun(env, user, account, s, budget);
  } catch (e) {
    // Anything unexpected: keep what is saved, and try again in a minute.
    console.error('import', account, s.phase, e);
    s.error = `Import paused (${String(e).slice(0, 160)}). Trying again shortly.`;
    s.resumesAt = new Date(Date.now() + 60_000).toISOString();
  }
  if (s.phase === 'done' && !s.error) await finish(env, user, account, s);
  const more = s.phase !== 'done' && s.phase !== 'failed';
  const next = more ? nextRunId(account) : '';
  const saved = await saveImport(env, user, account, { ...s, runId: next, prev: runId, runs: s.runs + 1, updatedAt: new Date().toISOString() }, got.etag);
  console.log(JSON.stringify({ importRun: { account, phase: s.phase, pos: s.pos, messages: s.messages, copied: s.copied, toIndex: s.toIndex.length, ms: Date.now() - started, error: s.error } }));
  if (!saved) return none(s.phase);
  return { phase: s.phase, nextId: more ? next : null, resumesAt: s.resumesAt };
}

type Budget = { wall: number; cpu: number };

// ---- Scan ----

const NL = 10;
const isFromAt = (b: Uint8Array, i: number) => b[i] === 70 && b[i + 1] === 114 && b[i + 2] === 111 && b[i + 3] === 109 && b[i + 4] === 32;
/** An mbox separator line: "From " then a sender and a date with a time and a year. */
const FROM_LINE = /^From \S*\s.*\d{1,2}:\d{2}.*\b(19|20)\d{2}\b/;

const latin1 = (b: Uint8Array) => {
  let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return out;
};

/** The line starting at `i`, up to 300 bytes, without its line end. */
function lineAt(b: Uint8Array, i: number): string {
  let end = i;
  while (end < b.length && end - i < 300 && b[end] !== NL) end++;
  return latin1(b.subarray(i, end)).replace(/\r$/, '');
}

/** A message's time: its Date header, else its "From " line's date, else 0. */
function messageTime(date: string | undefined, fromLine: string): number {
  const max = Date.now() + 366 * 86_400_000;
  const ok = (t: number) => Number.isFinite(t) && t >= Date.UTC(1971, 0) && t <= max;
  if (date) {
    const t = Date.parse(date.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim());
    if (ok(t)) return t;
  }
  const t = Date.parse(fromLine.slice(5).replace(/^\S+\s+/, '').replace(/\s+/g, ' '));
  return ok(t) ? t : 0;
}

const monthOfTime = (t: number) => new Date(t).toISOString().slice(0, 7);

/** Google Takeout's X-Gmail-Labels names, as Gmail's label IDs; the file's own labels get IDs of their own. */
const SYSTEM_LABELS: Record<string, string> = {
  inbox: 'INBOX', sent: 'SENT', 'sent mail': 'SENT', important: 'IMPORTANT', starred: 'STARRED', draft: 'DRAFT', drafts: 'DRAFT',
  unread: 'UNREAD', spam: 'SPAM', trash: 'TRASH', chat: 'CHAT', chats: 'CHAT',
};
/** Takeout marks mail it has seen "Opened": not a label. */
const NOT_LABELS = new Set(['opened', 'archived']);

async function hex16(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d.subarray(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function labelIds(value: string | undefined, names: Record<string, string>): Promise<string[]> {
  if (!value) return [];
  const out = new Set<string>();
  for (const raw of value.split(',')) {
    const name = raw.trim().replace(/^"|"$/g, '');
    const key = name.toLowerCase();
    if (!name || NOT_LABELS.has(key)) continue;
    const category = /^category[ _](\w+)$/i.exec(name);
    if (SYSTEM_LABELS[key]) out.add(SYSTEM_LABELS[key]);
    else if (category) out.add(`CATEGORY_${category[1].toUpperCase()}`);
    else {
      const id = `Label_${(await hex16(name)).slice(0, 10)}`;
      names[id] = name;
      out.add(id);
    }
  }
  return [...out];
}

const notKept = (labels: string[]) => labels.includes('SPAM') || labels.includes('TRASH');

async function scanRun(env: Env, user: UserId, account: string, s: ImportState, budget: Budget, fail: (e: string) => Promise<void>): Promise<void> {
  const key = r2Keys.upload(user, account);
  const found: ScanFile = { starts: [], months: [] };
  let cpu = 0;
  while (s.pos < s.bytes && Date.now() < budget.wall && cpu < budget.cpu) {
    const from = Math.max(0, s.pos - 1);
    const end = Math.min(s.bytes, s.pos + SLICE);
    const obj = await env.ARCHIVE.get(key, { range: { offset: from, length: Math.min(s.bytes, end + OVER) - from } });
    if (!obj) return fail('The uploaded file is gone. Remove this archive and upload the file again.');
    const b = new Uint8Array(await obj.arrayBuffer());
    if (s.pos === 0 && !isFromAt(b, 0)) return fail('This isn’t an mbox file: it doesn’t start with a "From " line.');
    const at = (abs: number) => abs - from;
    const candidates: number[] = s.pos === 0 ? [0] : [];
    for (let i = b.indexOf(NL); i >= 0 && from + i + 1 < end; i = b.indexOf(NL, i + 1)) if (isFromAt(b, i + 1) && from + i + 1 >= s.pos) candidates.push(from + i + 1);
    for (const start of candidates) {
      const line = lineAt(b, at(start));
      if (!FROM_LINE.test(line)) continue;
      const head = at(start) + line.length + 1;
      const h = headers(b.subarray(head, Math.min(b.length, head + OVER)));
      const labels = await labelIds(h.get('x-gmail-labels'), s.labels);
      found.starts.push(start);
      if (notKept(labels)) {
        found.months.push('');
        s.skipped++;
        continue;
      }
      const month = monthOfTime(messageTime(h.get('date'), line));
      found.months.push(month);
      s.months[month] = (s.months[month] ?? 0) + 1;
      s.messages++;
    }
    cpu += (end - s.pos) / (1024 * 1024) * 2 + candidates.length * 0.2;
    s.pos = end;
  }
  if (found.starts.length) {
    await env.ARCHIVE.put(r2Keys.importScan(user, account, s.scans), JSON.stringify(found));
    s.scans++;
  }
  if (s.pos < s.bytes) return;
  if (!s.messages) return fail(s.skipped ? 'Every message in this file is Spam or Trash, which MailCellar doesn’t keep.' : 'No messages found in this file.');
  // The whole file is read: the months stand in for Gmail's count, queued as one job.
  s.job = await accountMailbox(env, user, account).importPlan(`Import ${s.file}`, s.months, s.messages);
  await env.MAILBOX.getByName(`${user}:default`).setArchive(account, { messages: s.messages });
  s.phase = 'copy';
}

// ---- Copy ----

/** A message as the mbox holds it, without its "From " line and the blank line after it, with ">From " lines unquoted (mboxrd). */
function messageBytes(b: Uint8Array): Uint8Array {
  const start = b.indexOf(NL) + 1;
  let end = b.length;
  if (end > start && b[end - 1] === NL) end--;
  if (end > start && b[end - 1] === 13) end--;
  const body = b.subarray(start, end);
  // Lines starting ">From " (or ">>From " …) were quoted when the file was written: one ">" comes off.
  const cuts: number[] = [];
  for (let i = 0; i < body.length; ) {
    let j = i;
    while (body[j] === 62) j++;
    if (j > i && isFromAt(body, j)) cuts.push(i);
    const nl = body.indexOf(NL, i);
    if (nl < 0) break;
    i = nl + 1;
  }
  if (!cuts.length) return body;
  const out = new Uint8Array(body.length - cuts.length);
  let o = 0;
  let from = 0;
  for (const c of cuts) {
    out.set(body.subarray(from, c), o);
    o += c - from;
    from = c + 1;
  }
  out.set(body.subarray(from), o);
  return out;
}

async function messageId(raw: Uint8Array, h: Map<string, string>): Promise<string> {
  const mid = h.get('message-id')?.trim().toLowerCase();
  return hex16(mid ? `mid:${mid}` : `raw:${raw.length}:${latin1(raw.subarray(0, 4096))}`);
}

/** The thread a message belongs to: its first reference, else what it replies to, else itself. */
async function threadId(h: Map<string, string>, id: string): Promise<string> {
  const first = /<[^>]+>/.exec(h.get('references') ?? '')?.[0] ?? /<[^>]+>/.exec(h.get('in-reply-to') ?? '')?.[0];
  return first ? hex16(`mid:${first.slice(1, -1).trim().toLowerCase()}`) : id;
}

async function copyRun(env: Env, user: UserId, account: string, s: ImportState, budget: Budget): Promise<void> {
  const target = await syncDeps.basin(env, user);
  if (!target) {
    s.resumesAt = new Date(Date.now() + 5 * 60_000).toISOString();
    s.error = 'Waiting for Basin write access.';
    return;
  }
  if (!s.basinReady) {
    await target.ensure();
    s.basinReady = true;
  }
  s.error = null;
  // Rows a run before this one staged but couldn't append: they go first.
  while (s.unstaged.length) {
    const obj = await env.ARCHIVE.get(s.unstaged[0]);
    if (obj) await target.append((await obj.json()) as BasinRow[]);
    await env.ARCHIVE.delete(s.unstaged[0]);
    s.unstaged.shift();
  }
  const scans = new Map<number, ScanFile>();
  const scan = async (n: number): Promise<ScanFile> => {
    let f = scans.get(n);
    if (!f) {
      const obj = await env.ARCHIVE.get(r2Keys.importScan(user, account, n));
      if (!obj) throw new Error(`scan file ${n} is missing`);
      scans.set(n, (f = (await obj.json()) as ScanFile));
    }
    return f;
  };
  /** Where message `i` of scan file `n` ends: where the next one starts, or the file's end. */
  const endOf = async (n: number, i: number) => {
    const f = await scan(n);
    if (i + 1 < f.starts.length) return f.starts[i + 1];
    return n + 1 < s.scans ? (await scan(n + 1)).starts[0] : s.bytes;
  };
  const key = r2Keys.upload(user, account);
  const syncedAt = new Date().toISOString();
  const rows: BasinRow[] = [];
  const copied: Record<string, number> = {};
  const touched = new Set<string>();
  let bytes = 0;
  let cpu = 0;
  while (s.scanAt < s.scans && Date.now() < budget.wall && cpu < budget.cpu && rows.length < RUN_ROWS()) {
    const f = await scan(s.scanAt);
    if (s.at >= f.starts.length) {
      s.scanAt++;
      s.at = 0;
      continue;
    }
    // A pack: messages in file order up to PACK_BYTES, read in one go.
    const first = s.at;
    let last = first;
    let stop = await endOf(s.scanAt, first);
    while (last + 1 < f.starts.length && last + 1 - first < PACK_MAX) {
      const e = await endOf(s.scanAt, last + 1);
      if (e - f.starts[first] > PACK_BYTES) break;
      last++;
      stop = e;
    }
    const begin = f.starts[first];
    if (stop - begin > MESSAGE_MAX) {
      // One message too big for a Worker: counted, and the import goes on.
      const month = f.months[first];
      if (month) s.tooBig[month] = (s.tooBig[month] ?? 0) + 1;
      console.log(JSON.stringify({ importTooBig: { account, offset: begin, bytes: stop - begin, month } }));
      s.at = first + 1;
      continue;
    }
    const obj = await env.ARCHIVE.get(key, { range: { offset: begin, length: stop - begin } });
    if (!obj) throw new Error('the uploaded file is gone');
    const b = new Uint8Array(await obj.arrayBuffer());
    const packKey = r2Keys.importPack(user, account, s.packs);
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let i = first; i <= last; i++) {
      const month = f.months[i];
      if (!month) continue;
      const msgEnd = i < last ? f.starts[i + 1] : stop;
      const raw = messageBytes(b.subarray(f.starts[i] - begin, msgEnd - begin));
      const h = headers(raw);
      const id = await messageId(raw, h);
      const line = lineAt(b, f.starts[i] - begin);
      const ts = messageTime(h.get('date'), line);
      const labels = await labelIds(h.get('x-gmail-labels'), s.labels);
      const snippet = bodyText(raw, 4096).replace(/\s+/g, ' ').trim().slice(0, 200);
      const row = basinRow(account, { id, threadId: await threadId(h, id), labelIds: labels, snippet, sizeEstimate: raw.length, internalDate: String(ts), raw: '' }, raw, packKey, syncedAt, { offset, len: raw.length });
      rows.push(row);
      parts.push(raw);
      offset += raw.length;
      copied[month] = (copied[month] ?? 0) + 1;
      touched.add(month);
      cpu += copyCpuMs(raw.length) * 2;
    }
    if (parts.length) {
      const pack = new Uint8Array(offset);
      let o = 0;
      for (const p of parts) {
        pack.set(p, o);
        o += p.length;
      }
      await env.ARCHIVE.put(packKey, pack, { httpMetadata: { contentType: 'application/octet-stream' } });
      s.packs++;
      bytes += offset;
    }
    s.at = last + 1;
  }
  if (rows.length) {
    // Staged first, so rows Basin doesn't take this time are appended by the next run.
    const staged = r2Keys.importStaged(user, account, `${s.packs}-${Date.now().toString(36)}`);
    await env.ARCHIVE.put(staged, JSON.stringify(rows));
    s.unstaged.push(staged);
    s.copied += rows.length;
    try {
      await target.append(rows);
      await env.ARCHIVE.delete(staged);
      s.unstaged.pop();
    } catch (e) {
      s.error = `Basin didn't take the rows yet (${String(e).slice(0, 120)}). Trying again shortly.`;
      s.resumesAt = new Date(Date.now() + 2 * 60_000).toISOString();
    }
  }
  const mailbox = accountMailbox(env, user, account);
  // Newest months in this run first, as the map's Copying months.
  const months = [...touched].sort().reverse().slice(0, MAX_LANES);
  if (rows.length || s.scanAt >= s.scans) await mailbox.importProgress({ job: s.job!, copied, bytes, months, error: s.error });
  if (s.scanAt < s.scans || s.unstaged.length) return;
  // Every message is in Basin: the months land, and their indexes are built next, newest first.
  const all = Object.keys(s.months).sort().reverse();
  await mailbox.importLand(s.job!, all);
  const labels: MailLabel[] = Object.entries(s.labels).map(([id, name]) => ({ id, name, type: 'user' }));
  if (labels.length) await mailbox.putLabels(labels);
  s.toIndex = all;
  s.indexFrom = 0;
  s.phase = 'index';
}

// ---- Index ----

async function indexRun(env: Env, user: UserId, account: string, s: ImportState, budget: Budget): Promise<void> {
  while (s.toIndex.length && Date.now() < budget.wall) {
    const r = await runIndex(env, user, account, s.toIndex[0], s.indexFrom);
    if (r.resumesAt) {
      s.indexFrom = r.next ?? 0;
      s.resumesAt = r.resumesAt;
      return;
    }
    if (r.next === null) {
      s.toIndex.shift();
      s.indexFrom = 0;
    } else s.indexFrom = r.next;
  }
  if (!s.toIndex.length) s.phase = 'done';
}

/** Everything is searchable: the archive is done, and the uploaded file and scan files are deleted. */
async function finish(env: Env, user: UserId, account: string, s: ImportState): Promise<void> {
  // A message the file holds twice is kept once: each month counts what it keeps, and what was too big.
  await accountMailbox(env, user, account).importSettle(s.tooBig);
  await env.MAILBOX.getByName(`${user}:default`).setArchive(account, { status: 'done', error: null });
  await env.ARCHIVE.delete(r2Keys.upload(user, account));
  const scans = Array.from({ length: s.scans }, (_, n) => r2Keys.importScan(user, account, n));
  for (let i = 0; i < scans.length; i += 1000) await env.ARCHIVE.delete(scans.slice(i, i + 1000));
  const parts = await env.ARCHIVE.list({ prefix: r2Keys.uploadParts(user, account) });
  if (parts.objects.length) await env.ARCHIVE.delete(parts.objects.map((o) => o.key));
  console.log(JSON.stringify({ importDone: { account, messages: s.messages, copied: s.copied, skipped: s.skipped, tooBig: s.tooBig, packs: s.packs, runs: s.runs } }));
}
