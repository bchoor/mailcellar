// Basin (R2 Data Catalog, Apache Iceberg): the system of record for every copied message,
// one `messages` table per user under basinNamespace(user). The sync writes each batch here.
// Only the catalog's REST calls leave the Worker; data and metadata files are read and
// written through the R2 binding, so a commit costs a few of a run's 50 outside requests.
import { BASIN_TABLES, basinNamespace, type UserId } from '@mailcellar/schema';
import { ByteWriter } from 'hyparquet-writer';
import { parquetReadObjects } from 'hyparquet';
import { icebergAppend, icebergCreateTable, restCatalogConnect, restCatalogCreateNamespace, restCatalogListTables, restCatalogLoadTable } from 'icebird';
import { fetchManifestEntries, icebergManifestList } from 'icebird/src/manifest.js';
import type { Env } from './env';

type AppendOptions = Parameters<typeof icebergAppend>[0];
export type Catalog = AppendOptions['catalog'];
type RestCatalog = Awaited<ReturnType<typeof restCatalogConnect>>;
type Resolver = NonNullable<AppendOptions['resolver']>;
type Schema = NonNullable<Parameters<typeof icebergCreateTable>[0]['schema']>;

/** Outside requests a commit needs at most: config, namespace and table checks, load, commit, one retry. */
export const COMMIT_CALLS = 7;
export const MESSAGES_TABLE = 'messages';

/** One row of the messages table, as the sync stages it (timestamps as ISO strings). */
export interface BasinRow {
  account: string;
  id: string;
  thread_id: string;
  ts: string;
  from_addr: string;
  from_name: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  snippet: string;
  body_text: string;
  labels: string[];
  size: number;
  attachments: number;
  raw_key: string;
  synced_at: string;
}

type Column = { name: string; type: string; required?: boolean };
/** The messages table: the shared schema plus the Gmail account each message came from. */
const COLUMNS: readonly Column[] = [{ name: 'account', type: 'string', required: true }, ...(BASIN_TABLES.messages.columns as readonly Column[])];

/** COLUMNS as an Iceberg schema. List columns get element IDs after the field IDs. */
export function icebergSchema(): Schema {
  let nextId = COLUMNS.length + 1;
  return {
    type: 'struct',
    'schema-id': 0,
    fields: COLUMNS.map((c, i) => {
      const list = /^list<(\w+)>$/.exec(c.type);
      return {
        id: i + 1,
        name: c.name,
        required: !!c.required,
        type: list ? { type: 'list', 'element-id': nextId++, element: list[1], 'element-required': false } : c.type,
      };
    }),
  } as Schema;
}

/** Rows as Iceberg wants them: Dates for timestamps, BigInts for longs. */
export function toRecords(rows: BasinRow[]) {
  return rows.map((r) => ({ ...r, ts: new Date(r.ts), synced_at: new Date(r.synced_at), size: BigInt(r.size) }));
}

/** Reads and writes the catalog's files (s3://<bucket>/<key>) through the R2 binding. */
export function r2Resolver(bucket: R2Bucket, bucketName: string): Resolver {
  const key = (path: string) => {
    const prefix = `s3://${bucketName}/`;
    if (!path.startsWith(prefix)) throw new Error(`outside the bucket: ${path}`);
    return path.slice(prefix.length);
  };
  return {
    async reader(path, byteLength) {
      const k = key(path);
      const size = byteLength ?? (await bucket.head(k))?.size;
      if (size === undefined) throw new Error(`missing ${path}`);
      return {
        byteLength: size,
        async slice(start: number, end?: number) {
          const obj = await bucket.get(k, { range: { offset: start, length: (end ?? size) - start } });
          if (!obj) throw new Error(`missing ${path}`);
          return obj.arrayBuffer();
        },
      };
    },
    writer(path, options) {
      const w = new ByteWriter();
      w.finish = async () => {
        const put = await bucket.put(key(path), w.getBytes().slice(), options?.ifNoneMatch ? { onlyIf: { etagDoesNotMatch: '*' } } : {});
        if (!put) throw Object.assign(new Error(`exists: ${path}`), { status: 412 });
      };
      return w;
    },
    async deleter(path) {
      await bucket.delete(key(path));
    },
  };
}

/** Where a user's rows go: create the table once, then append batches; and one month read back. */
export interface BasinTarget {
  ensure(): Promise<void>;
  append(rows: BasinRow[]): Promise<void>;
  /** One account's rows for a month, without body text: what the search index is built from. */
  monthRows(account: string, month: string): Promise<IndexColumns[]>;
}

/** The columns the search index is built from. */
export const INDEX_COLUMNS = ['account', 'id', 'thread_id', 'ts', 'from_addr', 'from_name', 'subject', 'snippet', 'size', 'attachments', 'labels'] as const;
export type IndexColumns = Pick<BasinRow, (typeof INDEX_COLUMNS)[number]>;

type TableMetadata = Parameters<typeof icebergManifestList>[0]['metadata'];

/** Months since January 1970: Iceberg's `month` partition value. */
const monthOrdinal = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return (y - 1970) * 12 + (m - 1);
};
/** A manifest's partition bound: a 4-byte little-endian int for the month transform. */
const boundInt = (b: unknown) => (b instanceof Uint8Array && b.byteLength >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true) : null);

/**
 * Read one month of one account back from the messages table: only the manifests whose month
 * range covers it, only that month's data files, and only the index columns. A message
 * committed twice (a retried batch) comes back once.
 */
export async function readMonth(metadata: TableMetadata, resolver: Resolver, account: string, month: string): Promise<IndexColumns[]> {
  if (metadata['current-snapshot-id'] == null || Number(metadata['current-snapshot-id']) < 0) return [];
  const target = monthOrdinal(month);
  const { manifests } = await icebergManifestList({ metadata, resolver });
  const files: { path: string; size: number }[] = [];
  for (const m of manifests) {
    if (m.content === 1) continue;
    const range = (m as { partitions?: { lower_bound?: unknown; upper_bound?: unknown }[] }).partitions?.[0];
    const lo = boundInt(range?.lower_bound);
    const hi = boundInt(range?.upper_bound);
    if (lo !== null && hi !== null && (target < lo || target > hi)) continue;
    for (const e of await fetchManifestEntries(m, resolver)) {
      const part = (e.data_file.partition as Record<string, unknown> | undefined)?.ts_month;
      if (e.status === 2 || e.data_file.content || (part !== undefined && part !== null && Number(part) !== target)) continue;
      files.push({ path: e.data_file.file_path, size: Number(e.data_file.file_size_in_bytes) });
    }
  }
  const byId = new Map<string, IndexColumns>();
  for (const f of files) {
    const file = await resolver.reader(f.path, f.size);
    const rows = (await parquetReadObjects({ file, columns: [...INDEX_COLUMNS] })) as Record<string, unknown>[];
    for (const r of rows) {
      if (r.account !== account) continue;
      const ts = r.ts instanceof Date ? r.ts.toISOString() : new Date(Number(r.ts) / 1000).toISOString();
      if (ts.slice(0, 7) !== month) continue;
      byId.set(String(r.id), { ...(r as unknown as IndexColumns), ts, size: Number(r.size), attachments: Number(r.attachments), labels: (r.labels as string[] | null) ?? [] });
    }
  }
  return [...byId.values()];
}

/** The user's table in the R2 Data Catalog, or null while the write token isn't set. */
export async function catalogTarget(env: Env, user: UserId): Promise<BasinTarget | null> {
  if (!env.BASIN_TOKEN) return null;
  const catalog = await restCatalogConnect({
    url: env.BASIN_CATALOG_URI,
    warehouse: env.BASIN_WAREHOUSE,
    requestInit: { headers: { authorization: `Bearer ${env.BASIN_TOKEN}` } },
  });
  const namespace = basinNamespace(user);
  const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
  return {
    ensure: () => ensureTable(catalog, namespace),
    monthRows: async (account, month) => readMonth((await restCatalogLoadTable(catalog, { namespace, table: MESSAGES_TABLE })).metadata, resolver, account, month),
    append: (rows) =>
      icebergAppend({ catalog, namespace, table: MESSAGES_TABLE, resolver: r2Resolver(env.ARCHIVE, env.BASIN_BUCKET), records: toRecords(rows) }).then(() => {}),
  };
}

/** The messages table's partitioning: by month of the message date. */
export function partitionSpec() {
  const tsId = icebergSchema().fields.find((f) => f.name === 'ts')!.id;
  return { 'spec-id': 0, fields: [{ 'source-id': tsId, 'field-id': 1000, name: 'ts_month', transform: 'month' as const }] };
}

/** Create the namespace and messages table if they don't exist yet. */
async function ensureTable(catalog: RestCatalog, namespace: string): Promise<void> {
  let tables: unknown[];
  try {
    tables = await restCatalogListTables(catalog, { namespace });
  } catch (e) {
    if (!/404|not ?found|NoSuchNamespace/i.test(String(e))) throw e;
    await restCatalogCreateNamespace(catalog, { namespace });
    tables = [];
  }
  if (tables.some((t) => (t as { name?: string }).name === MESSAGES_TABLE)) return;
  await icebergCreateTable({ catalog, namespace, table: MESSAGES_TABLE, schema: icebergSchema(), partitionSpec: partitionSpec() });
}

/** Who the Basin check writes as: a namespace of its own, never a user's. */
export const BASIN_CHECK_USER = 'basin-check' as UserId;

/**
 * Prove the catalog takes writes with the deployed token: create the check table if needed and
 * append one made-up row. Run as a SYNC instance with `check: true`; touches no one's mail.
 */
export async function basinCheck(env: Env): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const target = await catalogTarget(env, BASIN_CHECK_USER);
    if (!target) return { ok: false, ms: 0, error: 'BASIN_TOKEN is not set' };
    await target.ensure();
    const now = new Date().toISOString();
    await target.append([{
      account: 'check', id: `check-${Date.now().toString(16)}`, thread_id: 'check', ts: now, from_addr: 'check@mailcellar.invalid',
      from_name: 'Basin check', to_addrs: [], cc_addrs: [], subject: 'Basin check', snippet: '', body_text: '', labels: [],
      size: 0, attachments: 0, raw_key: '', synced_at: now,
    }]);
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: String(e).slice(0, 500) };
  }
}
