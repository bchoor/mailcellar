import { ARCHIVE_VIEWS, type ArchiveView, type Health } from '@mailcellar/schema';
import { callback, connect, identity, revoke, testAccount, type Identity } from './auth';
import type { Env } from './env';

export { MailboxDO } from './mailbox';
export { SyncWorkflow } from './sync';

// Static assets serve the app; only /api/* reaches this handler (run_worker_first).
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const body: Health = { ok: true, service: 'mailcellar', version: env.APP_VERSION };
      return Response.json(body);
    }
    if (url.pathname === '/api/releases' && request.method === 'GET') return releases(request, env, url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // A change must come from this app's own pages; this refuses other sites' requests outright.
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin)
      return Response.json({ error: 'bad_origin' }, { status: 403 });
    // Cloudflare Access names the person; everything below is their own mailbox, reached only through them.
    const who = await identity(request, env);
    if (!who) return Response.json({ error: 'no_identity' }, { status: 401, headers: noStore });
    if (request.method === 'GET') {
      if (url.pathname === '/api/accounts/connect') return connect(url, env);
      if (url.pathname === '/api/auth/callback') return callback(request, env, url, who);
    }
    const res = await mailboxApi(request, env, url, who);
    return res ?? Response.json({ error: 'not_found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const noStore = { 'cache-control': 'no-store' };

interface Release {
  tag: string;
  published_at: string;
}

/**
 * GET /api/releases?limit=&before=: What's new in the status bar. The build writes
 * releases.json from the PRs merged to main (scripts/changelog.mjs); this pages through it.
 */
async function releases(request: Request, env: Env, url: URL): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL('/releases.json', url), { headers: request.headers }));
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) return Response.json({ error: 'not_found' }, { status: 404 });
  const all = ((await res.json()) as { releases: Release[] }).releases;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
  const before = url.searchParams.get('before');
  const from = before ? all.findIndex((r) => r.published_at < before) : 0;
  return Response.json({ releases: from < 0 ? [] : all.slice(from, from + limit) }, { headers: noStore });
}

/** The API a mailbox serves: who this is, accounts, archive pages, schedules and usage. Null: not one of these. */
async function mailboxApi(request: Request, env: Env, url: URL, { email, mailbox }: Identity): Promise<Response | null> {
  if (url.pathname === '/api/me' && request.method === 'GET') return Response.json(await mailbox.me(email), { headers: noStore });
  const test = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/test$/);
  if (test && request.method === 'POST') {
    if (!(await testAccount(env, mailbox, test[1]))) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json((await mailbox.me(email)).accounts.find((a) => a.id === test[1]), { headers: noStore });
  }
  const account = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})$/);
  if (account && request.method === 'DELETE') {
    // Remove = disconnect here and revoke at Google. Archived mail stays; deleting it is a separate step.
    const token = await mailbox.disconnectAccount(account[1]);
    if (!token) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ ok: true, revoked: await revoke(token) }, { headers: noStore });
  }
  const sync = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/sync$/);
  if (sync && request.method === 'GET') {
    const info = await mailbox.syncInfo(sync[1]);
    return info ? Response.json(info, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404 });
  }
  if (sync && request.method === 'POST') {
    // Sync now: start a run unless one is going; answers with where the sync stands.
    const r = await mailbox.syncAccount(sync[1], true);
    if ('error' in r) return Response.json({ error: r.error }, { status: r.error === 'not_found' ? 404 : 409, headers: noStore });
    return Response.json({ started: r.status === 'started', sync: await mailbox.syncInfo(sync[1]) }, { headers: noStore });
  }
  const archive = url.pathname.match(/^\/api\/archive\/([a-z]+)$/);
  if (archive && request.method === 'GET' && ARCHIVE_VIEWS.includes(archive[1] as ArchiveView)) {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    return Response.json(await mailbox.archive(archive[1] as ArchiveView, q), { headers: noStore });
  }
  if (url.pathname === '/api/usage' && request.method === 'GET')
    return Response.json(await mailbox.usage(), { headers: noStore });
  if (url.pathname === '/api/schedules' && request.method === 'GET')
    return Response.json(await mailbox.schedules(), { headers: noStore });
  const schedule = url.pathname.match(/^\/api\/schedules\/([a-z-]{1,40})$/);
  if (schedule && request.method === 'PUT') {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: 'too_large' }, { status: 413 });
    let change: unknown;
    try {
      change = JSON.parse(text);
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const saved = await mailbox.saveSchedule(schedule[1], change);
    return saved.ok
      ? Response.json(saved.schedule, { headers: noStore })
      : Response.json({ error: 'invalid', detail: saved.error }, { status: 400 });
  }
  return null;
}

