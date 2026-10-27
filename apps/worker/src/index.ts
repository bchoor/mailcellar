import { ARCHIVE_VIEWS, MESSAGE_PAGE_SIZES, MESSAGE_GROUPS, MESSAGE_SORTS, messageFilters, type MessageGroupBy, type MessageSort, monthNow, type ArchiveView, type Health, type Suite, type UsageDay } from '@mailcellar/schema';
import { callback, connect, identity, revoke, testAccount, type Identity } from './auth';
import { filters, gmailLabels, subscriptions, withGmail } from './gmail-settings';
import type { Env } from './env';
import { attachment, openMessage } from './message';
import { admit, peopleApi } from './members';
import { mcp } from './mcp';
import { bodySnippets } from './search';
import { accountQuota } from './quota';
import { archiveApi, removeArchive } from './archive-api';
import { accountMailbox } from './sync';

export { MailboxDO } from './mailbox';
export { QuotaDO } from './quota';
export { SyncWorkflow } from './sync';

// The app's pages before it moved under /app (run_worker_first sends these here).
const OLD_APP_PATH = /^\/(m\/.*|messages|panes|gmail\/.*|senders|domains|labels|time|backfill|usage|admin\/.*|invite\/.*)$/;

/** The app under /app: its files, or its index.html for any of its pages (the router reads the address). */
async function appPage(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/app') return Response.redirect(new URL(`/app/${url.search}`, url).href, 301);
  const res = await env.ASSETS.fetch(request);
  if (res.status !== 404 || request.method !== 'GET') return res;
  return env.ASSETS.fetch(new Request(new URL('/app/', url), { headers: request.headers }));
}

// Static assets serve the public page and the app's files; /api/*, /mcp and the app's pages reach
// this handler (run_worker_first).
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      const body: Health = { ok: true, service: 'mailcellar', version: env.APP_VERSION };
      return Response.json(body);
    }
    if (url.pathname === '/api/releases' && request.method === 'GET') return releases(request, env, url);
    // The MCP server: its own Access application, its own checks (mcp.ts).
    if (url.pathname === '/mcp') return mcp(request, env, url);
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) return appPage(request, env, url);
    if (OLD_APP_PATH.test(url.pathname)) return Response.redirect(new URL(`/app${url.pathname}${url.search}`, url).href, 301);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // A change must come from this app's own pages; this refuses other sites' requests outright.
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin)
      return Response.json({ error: 'bad_origin' }, { status: 403 });
    // Cloudflare Access names the person; everything below is their own mailbox, reached only through them.
    const who = await identity(request, env);
    if (!who) return Response.json({ error: 'no_identity' }, { status: 401, headers: noStore });
    // Signed in is not the same as let in: only admins and the guest list are (members.ts).
    const pass = await admit(env, who.email);
    if (!pass) return Response.json({ error: 'not_invited', email: who.email }, { status: 403, headers: noStore });
    const people = await peopleApi(request, env, url, who.email, pass.admin);
    if (people) return people;
    if (request.method === 'GET') {
      if (url.pathname === '/api/accounts/connect') return connect(url, env);
      if (url.pathname === '/api/auth/callback') return callback(request, env, url, who);
    }
    const res = await mailboxApi(request, env, url, who, pass.admin);
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

/** The suite this deployment joins, from its Worker variables; undefined when none is set. */
function suiteOf(env: Env): Suite | undefined {
  const suite: Suite = {
    list: env.SUITE_LIST_URL || undefined,
    prefsCookie: env.SUITE_PREFS_COOKIE || undefined,
    prefsDomain: env.SUITE_PREFS_DOMAIN || undefined,
  };
  return suite.list || suite.prefsCookie ? suite : undefined;
}

/** The API a person's mailboxes serve: who this is, accounts, each account's pages, schedules and usage. Null: not one of these. */
async function mailboxApi(request: Request, env: Env, url: URL, who: Identity, admin: boolean): Promise<Response | null> {
  const { email, mailbox } = who;
  if (url.pathname === '/api/me' && request.method === 'GET') return Response.json({ ...(await mailbox.me(email)), admin, suite: suiteOf(env) }, { headers: noStore });
  const test = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/test$/);
  if (test && request.method === 'POST') {
    if (!(await testAccount(env, mailbox, test[1]))) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json((await mailbox.me(email)).accounts.find((a) => a.id === test[1]), { headers: noStore });
  }
  const archives = await archiveApi(request, env, url, who.user, mailbox);
  if (archives) return archives;
  const account = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})$/);
  if (account && request.method === 'DELETE' && (await mailbox.accountKind(account[1])) === 'archive') {
    // An archive has no Google access to revoke.
    if (!(await removeArchive(env, who.user, mailbox, account[1]))) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ ok: true, revoked: false }, { headers: noStore });
  }
  if (account && request.method === 'DELETE') {
    // Remove = disconnect here and revoke at Google. Archived mail stays; deleting it is a separate step.
    const token = await mailbox.disconnectAccount(account[1]);
    if (!token) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ ok: true, revoked: await revoke(token) }, { headers: noStore });
  }
  if (url.pathname === '/api/backfill/paused' && request.method === 'PUT') {
    // Pause or resume all backfill: {"paused": true}.
    let body: { paused?: unknown };
    try {
      body = JSON.parse((await request.text()).slice(0, 1024));
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    if (typeof body.paused !== 'boolean') return Response.json({ error: 'bad_paused' }, { status: 400 });
    // Resuming is refused while spend is past the cap's stop line.
    if (!(await mailbox.setBackfillPaused(body.paused))) return Response.json({ error: 'over_budget' }, { status: 409, headers: noStore });
    return Response.json(await mailbox.syncAll(), { headers: noStore });
  }
  // The one read the Backfill page and status bar poll: every mailbox, from its status row.
  if (url.pathname === '/api/backfill/status' && request.method === 'GET') return Response.json(await mailbox.backfillStatus(), { headers: noStore });
  if (url.pathname === '/api/sync' && request.method === 'GET') return Response.json(await mailbox.syncAll(), { headers: noStore });
  const sync = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/sync$/);
  if (sync && request.method === 'GET') {
    const info = await mailbox.syncInfo(sync[1]);
    return info ? Response.json(info, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404 });
  }
  if (sync && request.method === 'POST') {
    // Sync now: start a run unless one is going; answers with where the sync stands.
    const r = await mailbox.syncAccount(sync[1], true, 'you');
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
  const unqueue = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/backfill\/cancel$/);
  if (unqueue && request.method === 'POST') {
    // Take months out of the queue: {"months": ["2024-01", ...]}, or {} for all of them.
    const text = await request.text();
    if (text.length > 16_384) return Response.json({ error: 'too_large' }, { status: 413 });
    let body: { months?: unknown };
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const months = body.months;
    if (months !== undefined && (!Array.isArray(months) || months.length > 1000 || !months.every((m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m))))
      return Response.json({ error: 'bad_months' }, { status: 400 });
    const r = await mailbox.unqueue(unqueue[1], (months as string[] | undefined) ?? null);
    return r ? Response.json({ ...r, jobs: await mailbox.jobs(unqueue[1]) }, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404 });
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
  // One message, opened from the Messages page: read from its raw file, not from Gmail.
  const opened = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/messages\/([0-9a-f]{1,16})(?:\/attachments\/(\d{1,4}))?$/);
  if (opened && request.method === 'GET') {
    const month = url.searchParams.get('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return Response.json({ error: 'bad_month' }, { status: 400, headers: noStore });
    const [, id, mid, n] = opened;
    if (n !== undefined) return (await attachment(env, who.user, id, mid, month, Number(n), url.searchParams.get('view') === '1')) ?? Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    const detail = await openMessage(env, who.user, id, mid, month);
    // A message never changes once copied: the app keeps it for the day.
    return detail ? Response.json(detail, { headers: { 'cache-control': 'private, max-age=86400' } }) : Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  // How many messages each Period group holds (spans as from..to, comma separated).
  const periods = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/messages\/periods$/);
  if (periods && request.method === 'GET') {
    if (!(await mailbox.hasMailbox(periods[1]))) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    const spans = (url.searchParams.get('spans') ?? '').split(',').map((v) => v.split('..').map(Number) as [number, number]);
    if (!spans.length || spans.length > 40 || spans.some((x) => x.length !== 2 || !x.every(Number.isFinite))) return Response.json({ error: 'bad_spans' }, { status: 400, headers: noStore });
    const n = await accountMailbox(env, who.user, periods[1]).periodCounts(spans);
    return Response.json({ n }, { headers: noStore });
  }
  // One page of an account's Messages groups (Group by), from the rollups.
  const grouped = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/messages\/groups$/);
  if (grouped && request.method === 'GET') {
    if (!(await mailbox.hasMailbox(grouped[1]))) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    const by = url.searchParams.get('by') ?? '';
    const filters = messageFilters(url.searchParams.get('f'));
    if (!filters || !(MESSAGE_GROUPS as readonly string[]).includes(by)) return Response.json({ error: 'bad_group' }, { status: 400, headers: noStore });
    const body = await accountMailbox(env, who.user, grouped[1]).messageGroups(by as MessageGroupBy, filters.length > 0, url.searchParams.get('after'));
    return Response.json(body, { headers: noStore });
  }
  // One page of an account's messages under the Messages page's filters.
  const paged = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/messages$/);
  if (paged && request.method === 'GET') {
    if (!(await mailbox.hasMailbox(paged[1]))) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    const filters = messageFilters(url.searchParams.get('f'));
    if (!filters) return Response.json({ error: 'bad_filter' }, { status: 400, headers: noStore });
    const size = Number(url.searchParams.get('size'));
    const page = await accountMailbox(env, who.user, paged[1]).messagePage(
      filters,
      url.searchParams.get('cursor'),
      (MESSAGE_PAGE_SIZES as readonly number[]).includes(size) ? size : 50,
      url.searchParams.get('asc') === '1',
      (MESSAGE_SORTS as readonly string[]).includes(url.searchParams.get('sort') ?? '') ? (url.searchParams.get('sort') as MessageSort) : 'date',
    );
    return Response.json(page, { headers: noStore });
  }
  // Search results' body snippets: the line of each body where the words are, read from its raw file.
  const snips = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/snippets$/);
  if (snips && request.method === 'GET') {
    if (!(await mailbox.hasMailbox(snips[1]))) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => /^[0-9a-f]{1,16}$/.test(id));
    return Response.json(await bodySnippets(env, who.user, snips[1], ids, url.searchParams.get('q') ?? ''), { headers: noStore });
  }
  // One Gmail account's pages: its archive (its own mailbox DO) and its Gmail settings (read live).
  const scoped = url.pathname.match(/^\/api\/accounts\/(a[A-Za-z0-9_-]{22})\/(archive\/[a-z]+|filters|subscriptions|labels)$/);
  if (scoped && request.method === 'GET') {
    const [, id, page] = scoped;
    const kind = await mailbox.accountKind(id);
    if (!kind) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    // An archive has no Gmail: its labels are the ones its file named, and it has no Gmail settings.
    if (kind === 'archive' && page === 'labels') return Response.json(await accountMailbox(env, who.user, id).labelMap(), { headers: noStore });
    if (kind === 'archive' && (page === 'filters' || page === 'subscriptions')) return Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
    const refreshToken = kind === 'gmail' ? await mailbox.accountToken(id) : null;
    if (page === 'labels' && refreshToken) {
      const body = await withGmail(env, refreshToken, gmailLabels);
      // The index named its labels once, at the first sync; catch up on any renamed or made since.
      if (!('error' in body)) await accountMailbox(env, who.user, id).nameLabels(body);
      return Response.json(body, { status: 'error' in body ? 502 : 200, headers: noStore });
    }
    if ((page === 'filters' || page === 'subscriptions') && refreshToken) {
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
  if (url.pathname === '/api/quota' && request.method === 'GET')
    return Response.json(await accountQuota(env).overview(), { headers: noStore });
  if (url.pathname === '/api/quota/refresh' && request.method === 'POST')
    return Response.json(await accountQuota(env).readNow(), { headers: noStore });
  if (url.pathname === '/api/admin/test-limit' && (request.method === 'PUT' || request.method === 'DELETE')) {
    // The end-to-end test switch, for 30 minutes: {"doWrites": 500, "resetMin": 3, "spendStop": 0.2}. Admins only.
    if (!admin) return Response.json({ error: 'forbidden' }, { status: 403, headers: noStore });
    if (request.method === 'DELETE') return Response.json({ test: await accountQuota(env).setTestLimit(null) }, { headers: noStore });
    let body: { doWrites?: unknown; resetMin?: unknown; spendStop?: unknown };
    try {
      body = JSON.parse((await request.text()).slice(0, 1024));
    } catch {
      return Response.json({ error: 'bad_json' }, { status: 400 });
    }
    const num = (v: unknown, max: number) => (v === undefined ? undefined : typeof v === 'number' && v >= 0 && v <= max ? v : NaN);
    const o = { doWrites: num(body.doWrites, 50_000), resetMin: num(body.resetMin, 30), spendStop: num(body.spendStop, 1) };
    if (Object.values(o).some((v) => Number.isNaN(v))) return Response.json({ error: 'bad_limit' }, { status: 400 });
    return Response.json({ test: await accountQuota(env).setTestLimit(o) }, { headers: noStore });
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

