// Basin (R2 Data Catalog, Apache Iceberg): the system of record for every copied message,
// one `messages` table per user under basinNamespace(user). The sync writes each batch here.
// Only the catalog's REST calls leave the Worker; data and metadata files are read and
// written through the R2 binding, so a commit costs a few of a run's 50 outside requests.
import { BASIN_TABLES, basinNamespace, type UserId } from '@mailcellar/schema';
import { ByteWriter } from 'hyparquet-writer';
import { icebergAppend, icebergCreateTable, restCatalogConnect, restCatalogCreateNamespace, restCatalogListTables } from 'icebird';
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

/** Where a user's rows go: create the table once, then append batches. */
export interface BasinTarget {
  ensure(): Promise<void>;
  append(rows: BasinRow[]): Promise<void>;
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
  return {
    ensure: () => ensureTable(catalog, namespace),
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
