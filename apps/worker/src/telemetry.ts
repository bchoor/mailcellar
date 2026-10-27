import { AsyncLocalStorage } from 'node:async_hooks';
import {
  flushCalls,
  foldRoute,
  meterEvent,
  meterFetch,
  meterRequest,
  meteredBindings,
  requestCalls,
  serverTiming,
  setEventSink,
  setRequestSink,
  withRequest,
} from '@columenlabs/lumen-ops';
import { meterClientBatch, setClientSink } from '@columenlabs/lumen-ops/client';
import type { Env } from './env';

/**
 * Telemetry from Lumen's ops meters (@columenlabs/lumen-ops), in the Analytics Engine dataset bound
 * as METRICS (mailcellar_requests, the same columns as every Lumen app's):
 *
 *   requests   one point per request: route template, status, outcome, ms, and the time it spent
 *              waiting on bindings and other services (blob2 `api` or `site`)
 *   calls      every Durable Object RPC, R2, Workers AI, Workflow, asset and tunnel call and every
 *              outbound fetch, timed: one `call` event per call code a piece of work made (code
 *              `ARCHIVE.put`, `fetch.gmail.googleapis.com`, ...), and the split sent back as `Server-Timing`
 *   work       one `do` event per Durable Object method or alarm (code `Class.method`) and one
 *              `workflow` event per Workflow step (code the step): ms, and counts SQLite rows read,
 *              rows written, calls made; plus `gmail.refused` (counts 429s, 403s) when Gmail said no
 *   browser    screens opened, failed requests and Web Vitals from the app's pages (`POST /api/t`,
 *              blob2 `view`, `fetch_fail`, `vital`, `error`), and each crash as a `client_error` event
 *              with its detail in Workers Logs (`POST /api/client-error`)
 *
 * R2 billing classes read off the call codes: Class A is ARCHIVE.put, list and the multipart
 * calls; Class B is ARCHIVE.get and head. Always weight by `_sample_interval`, e.g. the heaviest
 * Durable Object methods of the last day:
 *
 *   SELECT blob3 AS method, sum(_sample_interval) AS calls, sum(double3 * _sample_interval) AS rows_read
 *   FROM mailcellar_requests WHERE blob2 = 'do' AND timestamp > NOW() - INTERVAL '1' DAY
 *   GROUP BY method ORDER BY rows_read DESC
 *
 * A point holds route templates, codes and numbers: never a raw path, a query, an email or a body.
 * With no dataset bound nothing is written and Server-Timing still works.
 */
interface Meter {
  cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[];
  refused429: number;
  refused403: number;
}

const als = new AsyncLocalStorage<Meter>();
const APP = 'mailcellar';
const newMeter = (): Meter => ({ cursors: [], refused429: 0, refused403: 0 });
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

/** What each binding counts as in Server-Timing; Durable Object namespaces are `do` without saying. */
const KINDS: Record<string, string> = { ARCHIVE: 'r2', AI: 'ai', ASSETS: 'assets', SYNC: 'workflow', FREESEND: 'vpc' };

let wired = false;

/** Points the meters at the dataset and patches fetch, once per isolate (the Worker's and each object's). */
function wire(env: Env): void {
  if (wired) return;
  wired = true;
  const version = env.APP_VERSION?.slice(0, 7);
  setRequestSink(env.METRICS);
  setEventSink(env.METRICS, { app: APP, env: 'production', version });
  setClientSink(env.METRICS);
  // Lumen's meter first (each call timed by its host), then Gmail's refusals counted.
  meterFetch();
  const timed = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = als.getStore();
    if (!m) return timed(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const gmail = url.includes('googleapis.com/');
    const res = await timed(input, init);
    if (gmail && res.status === 429) m.refused429++;
    if (gmail && res.status === 403) m.refused403++;
    return res;
  }) as typeof fetch;
}

/** The scope a piece of work outside a request (an object's method, a Workflow step) charges its calls to. */
const workScope = (env: Env) => ({ app: APP, requestId: newId(), env: 'production', version: env.APP_VERSION?.slice(0, 7) });

/**
 * Runs `work` (a Durable Object method or a Workflow step) under its own meter, and writes its
 * event and its calls when it ends, however it ends.
 */
export function measured<T>(env: Env, kind: 'do' | 'workflow', name: string, work: () => T): T {
  if (als.getStore()) return work();
  const m = newMeter();
  const t0 = performance.now();
  return withRequest(workScope(env), name, () => {
    const done = (ok: boolean) => recordWork(m, kind, name, ok, performance.now() - t0);
    let r: T;
    try {
      r = als.run(m, work);
    } catch (e) {
      done(false);
      throw e;
    }
    // A method that answers at once is measured at once, and stays synchronous for its callers.
    if (!(r instanceof Promise)) {
      done(true);
      return r;
    }
    return r.then(
      (v) => {
        done(true);
        return v;
      },
      (e) => {
        done(false);
        throw e;
      },
    ) as T;
  });
}

function rowsOf(m: Meter): [number, number] {
  let read = 0;
  let written = 0;
  for (const c of m.cursors) {
    read += c.rowsRead;
    written += c.rowsWritten;
  }
  return [read, written];
}

/** Called inside the work's scope: its calls, its event and Gmail's refusals. */
function recordWork(m: Meter, kind: string, name: string, ok: boolean, ms: number): void {
  try {
    const [read, written] = rowsOf(m);
    const calls = requestCalls().reduce((n, [, c]) => n + c.n, 0);
    flushCalls();
    meterEvent({ event: kind, code: name, ok, ms, counts: [read, written, calls] });
    refusals(m, name);
  } catch {
    // Telemetry never breaks the work it measures.
  }
}

function refusals(m: Meter, code: string): void {
  if (m.refused429 || m.refused403) meterEvent({ event: 'gmail.refused', code, ok: false, counts: [m.refused429, m.refused403] });
}

/**
 * Measures every method of a Durable Object class (RPC calls, fetch and alarm), named
 * `Class.method`, and counts the rows each one's SQLite statements read and write. A method
 * called from another of the same object's methods counts toward the outer call.
 */
export function measureObject(cls: { prototype: object; name: string }): void {
  const proto = cls.prototype as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (key === 'constructor' || !desc || typeof desc.value !== 'function') continue;
    const fn = desc.value as (...args: unknown[]) => unknown;
    proto[key] = function (this: { env: Env }, ...args: unknown[]) {
      if (als.getStore()) return fn.apply(this, args);
      return measured(this.env, 'do', `${cls.name}.${key}`, () => fn.apply(this, args));
    };
  }
}

/** Counts the rows read and written by the statements this SQLite handle runs, toward the current meter. */
export function countRows(sql: SqlStorage): void {
  const exec = sql.exec.bind(sql);
  sql.exec = ((query: string, ...bindings: unknown[]) => {
    const cursor = exec(query, ...bindings);
    als.getStore()?.cursors.push(cursor);
    return cursor;
  }) as SqlStorage['exec'];
}

/**
 * The env every part sees (the Worker, each object, the Workflow): its bindings metered by Lumen,
 * wiring the meters once.
 */
export function meteredEnv(env: Env): Env {
  wire(env);
  return meteredBindings(env, { kinds: KINDS, skip: ['METRICS'] });
}

/** A path as a template: emails, tokens and ids folded, the app's hashed files one route. */
export function routeOf(url: URL): string {
  const p = url.pathname;
  if (p.startsWith('/app/assets/')) return '/app/assets/*';
  return foldRoute(p)
    .split('/')
    .map((seg) => (seg.includes('@') || seg.includes('%40') ? ':email' : /^a[A-Za-z0-9_-]{22}$/.test(seg) || seg.length > 40 ? ':id' : seg))
    .join('/');
}

const isApi = (p: string) => p.startsWith('/api/') || p === '/mcp';

/**
 * The Worker's entry, metered: the request in scope while `handle` runs (its binding calls charged
 * to it), then `Server-Timing` on the answer, one `call` event per call code and the request
 * point. Telemetry never changes the answer or holds it up: every write is a few in-memory calls,
 * and a failure in it is swallowed.
 */
export async function meteredRequest(request: Request, env: Env, handle: (env: Env) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const metered = meteredEnv(env);
  const route = routeOf(url);
  const scope = { app: APP, requestId: newId(), env: 'production', version: env.APP_VERSION?.slice(0, 7) };
  const m = newMeter();
  const t0 = performance.now();
  return withRequest(scope, route, () =>
    als.run(m, async () => {
      const end = (res: Response | undefined) => {
        try {
          return finish(request, url, m, route, scope, res, performance.now() - t0) ?? res;
        } catch {
          return res;
        }
      };
      let res: Response;
      try {
        res = await handle(metered);
      } catch (e) {
        end(undefined);
        throw e;
      }
      return end(res) as Response;
    }),
  );
}

function finish(
  request: Request,
  url: URL,
  m: Meter,
  route: string,
  scope: { app: string; requestId: string; env: string; version?: string },
  res: Response | undefined,
  ms: number,
): Response | undefined {
  let out = res;
  if (out && out.status !== 101) {
    try {
      out.headers.set('server-timing', serverTiming(ms));
    } catch {
      // A response with fixed headers (assets, a redirect): copy it once.
      out = new Response(out.body, out);
      out.headers.set('server-timing', serverTiming(ms));
    }
  }
  flushCalls();
  refusals(m, route);
  const cf = (request as { cf?: { colo?: string; country?: string } }).cf;
  const status = out?.status ?? 500;
  meterRequest({
    surface: isApi(url.pathname) ? 'api' : 'site',
    method: request.method,
    route,
    status,
    ms,
    outcome: out ? undefined : 'exception',
    callerKind: request.headers.get('cf-access-client-id') ? 'service' : request.headers.get('cf-access-jwt-assertion') ? 'session' : 'anon',
    colo: cf?.colo,
    country: cf?.country,
    bytesIn: Number(request.headers.get('content-length')) || 0,
    bytesOut: Number(out?.headers.get('content-length')) || 0,
    scope,
  });
  return out;
}

/** `POST /api/t`: a batch of the browser's points, checked and written as they are. */
export async function clientPoints(request: Request): Promise<Response> {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {}
  meterClientBatch(body, { app: APP });
  return new Response(null, { status: 204 });
}

const CODE = /^[A-Za-z0-9_.:/$-]{1,64}$/;

/**
 * `POST /api/client-error`: a crash a page or card caught (Lumen's RouteError and LumenBoundary).
 * One `client_error` event (where it happened) and one line in Workers Logs with the message and
 * stack, so it can be found and fixed; the path's ids are folded and its query dropped.
 */
export async function clientError(request: Request): Promise<Response> {
  let b: Record<string, unknown> = {};
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {}
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  const where = CODE.test(str(b.where, 64)) ? str(b.where, 64) : 'page';
  let path = '';
  try {
    path = routeOf(new URL(str(b.path, 500), 'https://x'));
  } catch {}
  meterEvent({ event: 'client_error', code: where, ok: false, ref: path.slice(0, 96) });
  console.error(
    JSON.stringify({ event: 'client_error', app: APP, where, path, build: str(b.build, 80), outcome: str(b.outcome, 40), message: str(b.message, 500), stack: str(b.stack, 2000) }),
  );
  return new Response(null, { status: 204 });
}
