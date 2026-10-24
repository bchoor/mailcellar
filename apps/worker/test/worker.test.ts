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
