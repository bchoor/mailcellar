import { ARCHIVE_VIEWS, monthNow, type ArchiveView, type Health, type UsageDay } from '@mailcellar/schema';
import { callback, connect, identity, revoke, testAccount, type Identity } from './auth';
import { filters, subscriptions, withGmail } from './gmail-settings';
import type { Env } from './env';
import { accountMailbox } from './sync';

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
  if (url.pathname === '/api/sync' && request.method === 'GET') return Response.json(await mailbox.syncAll(), { headers: noStore });
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
  const coverage = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/coverage$/);
  if (coverage && request.method === 'GET') {
    const c = await mailbox.coverage(coverage[1]);
    return c ? Response.json(c, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404 });
  }
  const backfill = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/backfill$/);
  if (backfill && request.method === 'POST') {
    // Queue a backfill: {"months": ["2024-01", ...], "label": "Last 3 months"}.
    const text = await request.text();
    if (text.length > 16_384) return Response.json({ error: 'too_large' }, { status: 413 });
    let body: { months?: unknown; label?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const now = monthNow();
    const months = body.months;
    if (!Array.isArray(months) || !months.length || months.length > 1000 || !months.every((m) => typeof m === 'string' && /^(19[7-9]\d|20\d\d)-(0[1-9]|1[0-2])$/.test(m) && m <= now))
      return Response.json({ error: 'bad_months' }, { status: 400 });
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 60) : 'Picked months';
    const r = await mailbox.backfill(backfill[1], months as string[], label);
    if ('error' in r) return Response.json({ error: r.error }, { status: r.error === 'not_found' ? 404 : 409, headers: noStore });
    return Response.json({ ...r, jobs: await mailbox.jobs(backfill[1]) }, { headers: noStore });
  }
  const jobs = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/jobs$/);
  if (jobs && request.method === 'GET') {
    const list = await mailbox.jobs(jobs[1]);
    return list ? Response.json(list, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404 });
  }
  const job = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/jobs\/(\d{1,9})\/(cancel|retry)$/);
  if (job && request.method === 'POST') {
    const r = await mailbox.jobAction(job[1], Number(job[2]), job[3] as 'cancel' | 'retry');
    return r ? Response.json(r, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404 });
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

