#!/usr/bin/env bun
// Loads the app the way a person does and fails on anything that would leave them stuck: the app's
// page and every file it names, who am I, backfill status, and each mailbox's Overview reads (each
// wakes that mailbox's Durable Object). Every request has a time budget, so a stall fails like an
// error does. Then a headless browser opens /app/ and must reach /api/me with no page error.
//
//   SMOKE_URL        where to check (http://localhost:8787 for the e2e, the live site after a deploy)
//   SMOKE_VERSION    optional: /api/health must report this build (waits for the deploy to land)
//   SMOKE_CLIENT_ID, SMOKE_CLIENT_SECRET   optional: a Cloudflare Access service token for a live site
//   SMOKE_BUDGET_MS  per request (default 8000)
//   SMOKE_BROWSER    "0" skips the browser step

const base = (process.env.SMOKE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const budget = Number(process.env.SMOKE_BUDGET_MS ?? 8000);
const want = process.env.SMOKE_VERSION ?? '';
const headers = process.env.SMOKE_CLIENT_ID
  ? { 'CF-Access-Client-Id': process.env.SMOKE_CLIENT_ID, 'CF-Access-Client-Secret': process.env.SMOKE_CLIENT_SECRET ?? '' }
  : {};

const failures = [];
const log = (line) => console.log(line);

/** One GET within the budget; a redirect counts as a failure (Access sent it to the login page). */
async function get(path, { ok = (r) => r.status === 200 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(base + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(budget) });
    const ms = Date.now() - started;
    const body = await res.text();
    if (!ok(res)) failures.push(`${path}: ${res.status} in ${ms} ms`);
    log(`${ok(res) ? 'ok  ' : 'FAIL'} ${res.status} ${String(ms).padStart(5)} ms ${path}`);
    return { res, body };
  } catch (e) {
    const ms = Date.now() - started;
    failures.push(`${path}: ${e?.name === 'TimeoutError' ? `no answer in ${budget} ms` : String(e)}`);
    log(`FAIL  --- ${String(ms).padStart(5)} ms ${path} (${e?.name ?? e})`);
    return { res: null, body: '' };
  }
}

const json = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

// 1. The build that should be live is (a deploy can take a minute to reach every location).
if (want) {
  const until = Date.now() + 5 * 60_000;
  for (;;) {
    const { body } = await get('/api/health');
    const version = json(body)?.version ?? '';
    if (version && (version.startsWith(want) || want.startsWith(version))) break;
    if (Date.now() > until) {
      failures.push(`/api/health: live build ${version || 'unknown'}, wanted ${want}`);
      break;
    }
    failures.length = 0;
    await new Promise((r) => setTimeout(r, 10_000));
  }
} else await get('/api/health');

// 2. The app's page and every file it names.
const app = await get('/app/', { ok: (r) => r.status === 200 && (r.headers.get('content-type') ?? '').includes('text/html') });
const files = [...app.body.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+)"/g)].map((m) => m[1]);
if (app.res && !files.length) failures.push('/app/: names no script or stylesheet');
for (const f of new Set(files)) await get(f);

// 3. What every page asks first, then each mailbox's Overview.
const me = json((await get('/api/me')).body);
await get('/api/backfill/status');
await get('/api/releases?limit=20');
for (const a of me?.accounts ?? []) {
  for (const view of ['months', 'totals', 'labels']) await get(`/api/accounts/${a.id}/archive/${view}`);
  await get(`/api/accounts/${a.id}/messages?size=50`);
}

// 4. A browser boots the app: /api/me answered and no page error. Skipped where none is installed.
if (process.env.SMOKE_BROWSER !== '0') {
  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    log('skip browser: playwright is not installed here');
  }
  if (chromium) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ extraHTTPHeaders: headers });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('response', (r) => {
        if (r.url().startsWith(base) && r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
      });
      const started = Date.now();
      const asked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me', { timeout: 20_000 });
      await page.goto(`${base}/app/`, { timeout: 20_000 });
      const res = await asked.catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      const ms = Date.now() - started;
      if (!res) failures.push('browser: the app never asked /api/me (stuck before it boots)');
      else if (res.status() !== 200) failures.push(`browser: /api/me ${res.status()}`);
      for (const e of errors) failures.push(`browser: ${e}`);
      log(`${res && !errors.length ? 'ok  ' : 'FAIL'} browser boot ${ms} ms`);
    } finally {
      await browser.close();
    }
  }
}

if (failures.length) {
  console.error(`\nSmoke failed at ${base}:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
log(`\nSmoke passed at ${base}`);
