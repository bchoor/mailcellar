// A Basin table for tests: an Iceberg file catalog in the test R2 bucket, written by the same
// resolver and records as production; only the catalog differs (no R2 Data Catalog in tests).
import type { UserId } from '@mailcellar/schema';
import { env } from 'cloudflare:workers';
import { fileCatalog, icebergAppend, icebergCreateTable, icebergRead, loadLatestFileCatalogMetadata } from 'icebird';
import { icebergSchema, partitionSpec, r2Resolver, readMonth, toRecords, type BasinTarget } from '../../src/basin';

/** R2 can't be listed the S3 way here; icebird falls back to the version hint. */
const noList = async (): Promise<string[]> => {
  throw new Error('no listing');
};

export function fileTarget(user: UserId) {
  const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
  const catalog = fileCatalog({ resolver });
  const tableUrl = `s3://${env.BASIN_BUCKET}/test-basin/${user}/messages`;
  const target: BasinTarget = {
    ensure: async () => void (await icebergCreateTable({ catalog, tableUrl, schema: icebergSchema(), partitionSpec: partitionSpec() })),
    append: async (rows) => void (await icebergAppend({ catalog, tableUrl, records: toRecords(rows) })),
    monthRows: async (account, month) => readMonth((await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister: noList })).metadata, resolver, account, month),
  };
  const read = async () => (await icebergRead({ tableUrl, resolver })) as Record<string, unknown>[];
  return { target, read };
}
