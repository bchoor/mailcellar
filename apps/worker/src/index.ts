import { ARCHIVE_VIEWS, type ArchiveView, type Health, type UsageDay } from '@mailcellar/schema';
import { accountMailbox, callback, connect, identity, revoke, testAccount, type Identity } from './auth';
import { filters, subscriptions, withGmail } from './gmail';
import type { Env } from './env';

export { MailboxDO } from './mailbox';

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

/** The API a person's mailboxes serve: who this is, accounts, each account's pages, schedules and usage. Null: not one of these. */
async function mailboxApi(request: Request, env: Env, url: URL, who: Identity): Promise<Response | null> {
  const { email, mailbox } = who;
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
  // One Gmail account's pages: its archive (its own mailbox DO) and its Gmail settings (read live).
  const scoped = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/(archive\/[a-z]+|filters|subscriptions)$/);
  if (scoped && request.method === 'GET') {
    const [, id, page] = scoped;
    const refreshToken = await mailbox.accountToken(id);
    if (!refreshToken) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    if (page === 'filters' || page === 'subscriptions') {
      const body = await withGmail<object>(env, refreshToken, page === 'filters' ? filters : subscriptions);
      return Response.json(body, { status: 'error' in body ? 502 : 200, headers: noStore });
    }
    const view = page.slice('archive/'.length) as ArchiveView;
    if (!ARCHIVE_VIEWS.includes(view)) return null;
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    return Response.json(await accountMailbox(env, who.user, id).archive(view, q), { headers: noStore });
  }
  if (url.pathname === '/api/usage' && request.method === 'GET') {
    // Every mailbox meters itself: the user's, and one per Gmail account. The page shows their sum.
    const ids = (await mailbox.me(email)).accounts.map((a) => a.id);
    const all = await Promise.all([mailbox.usage(), ...ids.map((id) => accountMailbox(env, who.user, id).usage())]);
    const sum = new Map<string, UsageDay>();
    for (const d of all.flat()) {
      const k = `${d.day}:${d.metric}`;
      const prev = sum.get(k);
      sum.set(k, prev ? { ...prev, value: prev.value + d.value } : { ...d });
    }
    return Response.json([...sum.values()].sort((a, b) => a.day.localeCompare(b.day) || a.metric.localeCompare(b.metric)), { headers: noStore });
  }
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

