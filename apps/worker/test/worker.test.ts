import { mailboxName, asUserId, r2Keys, basinNamespace } from '@mailcellar/schema';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/mailbox';

describe('api', () => {
  it('reports health', async () => {
    const res = await exports.default.fetch('https://mailcellar.icaruslab.dev/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'mailcellar', version: 'dev' });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await exports.default.fetch('https://mailcellar.icaruslab.dev/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('no made-up data', () => {
  it('serves an empty archive until real mail arrives', async () => {
    for (const view of ['months', 'labels', 'domains', 'senders', 'messages']) {
      const res = await exports.default.fetch(`https://mailcellar.icaruslab.dev/api/archive/${view}`);
      expect(await res.json(), view).toEqual([]);
    }
  });

  it("empties a mailbox phase 1 filled with sample mail, keeping its settings and usage", async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('old-sample')));
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO meta VALUES ('sample', '2400')`);
      sql.exec(`INSERT INTO months VALUES ('2020-01', 5, 100)`);
      sql.exec(`INSERT INTO usage_days VALUES ('2026-10-23', 'do_rows_written', 9)`);
      (instance as unknown as { dropSample(): void }).dropSample();
      expect(sql.exec(`SELECT count(*) AS n FROM months`).one().n).toBe(0);
      expect(sql.exec(`SELECT count(*) AS n FROM meta WHERE key = 'sample'`).one().n).toBe(0);
      expect(sql.exec(`SELECT count(*) AS n FROM usage_days`).one().n).toBe(1);
    });
  });
});

describe('mailbox DO', () => {
  it('applies every migration once', async () => {
    const stub = env.MAILBOX.getByName(mailboxName(asUserId('u1')));
    expect(await stub.schemaVersion()).toBe(MIGRATIONS.length);
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql.exec(`SELECT key FROM meta`).toArray();
      expect(rows).toEqual([{ key: 'schema_version' }]);
    });
  });

  it('keeps each user in their own object', async () => {
    const a = env.MAILBOX.idFromName(mailboxName(asUserId('alice')));
    const b = env.MAILBOX.idFromName(mailboxName(asUserId('bob')));
    expect(a.equals(b)).toBe(false);
  });
});

describe('schema helpers', () => {
  it('builds per-user keys', () => {
    const u = asUserId('u_42');
    expect(r2Keys.raw(u, 'abc')).toBe('u/u_42/raw/abc.eml.gz');
    expect(basinNamespace(u)).toBe('u_u_42');
  });

  it('rejects unsafe ids', () => {
    expect(() => asUserId('../x')).toThrow();
    expect(() => asUserId('a@b.com')).toThrow();
    expect(() => r2Keys.attachment(asUserId('u'), 'nothex')).toThrow();
  });
});
