import { mailboxName, asUserId, r2Keys, basinNamespace } from '@mailcellar/schema';
import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/mailbox';
import { signIn } from './helpers';

describe('api', () => {
  it('reports health', async () => {
    const res = await exports.default.fetch('https://mailcellar.icaruslab.dev/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'mailcellar', version: 'dev' });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await (await signIn('nope@example.com')).api('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('no made-up data', () => {
  it('serves a new user an empty archive until real mail arrives', async () => {
    const { api } = await signIn('newcomer@example.com');
    for (const view of ['months', 'labels', 'domains', 'senders', 'messages']) {
      const res = await api(`/api/archive/${view}`);
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

describe("what's new", () => {
  it('lists merged PRs newest first, in pages', async () => {
    const page = async (q: string) =>
      ((await (await exports.default.fetch(`https://mailcellar.icaruslab.dev/api/releases?${q}`)).json()) as {
        releases: { tag: string; published_at: string }[];
      }).releases;
    const first = await page('limit=2');
    expect(first).toHaveLength(2);
    expect(first[0].tag).toMatch(/^#\d+ · [0-9a-f]{7}$/);
    expect(first[0].published_at >= first[1].published_at).toBe(true);
    const next = await page(`limit=2&before=${encodeURIComponent(first[1].published_at)}`);
    expect(next[0].published_at < first[1].published_at).toBe(true);
  });
});
