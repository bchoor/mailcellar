import { ARCHIVE_VIEWS, type ArchiveView, type Health } from '@mailcellar/schema';
import { callback, login, logout, revoke, session, testAccount } from './auth';
import type { Env } from './env';
import type { MailboxDO } from './mailbox';

export { MailboxDO } from './mailbox';

// Static assets serve the app; only /api/* reaches this handler (run_worker_first).
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const body: Health = { ok: true, service: 'mailcellar', version: env.APP_VERSION };
      return Response.json(body);
    }
    if (request.method === 'GET') {
      if (url.pathname === '/api/auth/login') return login(request, env, url);
      if (url.pathname === '/api/auth/callback') return callback(request, env, url);
      if (url.pathname === '/api/auth/logout') return logout(request, env);
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // A change must come from this app's own pages; SameSite=Lax already keeps the
    // session cookie off other sites' requests, and this refuses them outright.
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin)
      return Response.json({ error: 'bad_origin' }, { status: 403 });
    // Everything else is the signed-in user's own mailbox, reached only through their session.
    const current = await session(request, env);
    if (!current) return Response.json({ error: 'signed_out' }, { status: 401, headers: noStore });
    const res = await mailboxApi(request, env, url, current.mailbox);
    return res ?? Response.json({ error: 'not_found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const noStore = { 'cache-control': 'no-store' };

/** The API a mailbox serves: who is signed in, accounts, archive pages, schedules and usage. Null: not one of these. */
async function mailboxApi(request: Request, env: Env, url: URL, mailbox: DurableObjectStub<MailboxDO>): Promise<Response | null> {
  if (url.pathname === '/api/me' && request.method === 'GET') return Response.json(await mailbox.me(), { headers: noStore });
  const test = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/test$/);
  if (test && request.method === 'POST') {
    if (!(await testAccount(env, mailbox, test[1]))) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json((await mailbox.me()).accounts.find((a) => a.id === test[1]), { headers: noStore });
  }
  const account = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})$/);
  if (account && request.method === 'DELETE') {
    // Remove = disconnect here and revoke at Google. Archived mail stays; deleting it is a separate step.
    const token = await mailbox.disconnectAccount(account[1]);
    if (!token) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ ok: true, revoked: await revoke(token) }, { headers: noStore });
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

