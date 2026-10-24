// A Basin table for tests: an Iceberg file catalog in the test R2 bucket, written by the same
// resolver and records as production; only the catalog differs (no R2 Data Catalog in tests).
import type { UserId } from '@mailcellar/schema';
import { env } from 'cloudflare:workers';
import { fileCatalog, icebergAppend, icebergCreateTable, icebergRead } from 'icebird';
import { icebergSchema, partitionSpec, r2Resolver, toRecords, type BasinTarget } from '../../src/basin';

export function fileTarget(user: UserId) {
  const resolver = r2Resolver(env.ARCHIVE, env.BASIN_BUCKET);
  const catalog = fileCatalog({ resolver });
  const tableUrl = `s3://${env.BASIN_BUCKET}/test-basin/${user}/messages`;
  const target: BasinTarget = {
    ensure: async () => void (await icebergCreateTable({ catalog, tableUrl, schema: icebergSchema(), partitionSpec: partitionSpec() })),
    append: async (rows) => void (await icebergAppend({ catalog, tableUrl, records: toRecords(rows) })),
  };
  const read = async () => (await icebergRead({ tableUrl, resolver })) as Record<string, unknown>[];
  return { target, read };
}
