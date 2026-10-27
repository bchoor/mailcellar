import { AsyncLocalStorage } from 'node:async_hooks';
import type { Env } from './env';

/**
 * One data point per piece of work (an API request, a Durable Object call or alarm, a Workflow
 * step) in the Analytics Engine dataset bound as TELEMETRY. Each point says what ran, how long it
 * took and what it used: SQLite rows read and written, raw file (R2) operations by billing class,
 * and outgoing requests (Gmail's apart). Query it with Analytics Engine's SQL API, e.g.
 *
 *   SELECT blob2 AS name, count() * any(_sample_interval) AS calls, quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms,
 *          sum(double2 * _sample_interval) AS rows_read FROM mailcellar_telemetry
 *   WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY name ORDER BY rows_read DESC
 *
 * Columns: index1 = kind; blob1 kind (http, do, workflow), blob2 name, blob3 outcome (a status
 * code, ok or error), blob4 the build; double1 wall ms, double2 rows read, double3 rows written,
 * double4 raw file Class A ops, double5 Class B ops, double6 subrequests, double7 Gmail calls,
 * double8 Gmail calls refused (429/403). Wall time includes waiting on I/O; CPU time is in Workers Logs.
 */
interface Meter {
  cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[];
  r2a: number;
  r2b: number;
  fetches: number;
  gmail: number;
  gmailRefused: number;
}

const als = new AsyncLocalStorage<Meter>();

// R2 operations by billing class (Class A: writes and lists; Class B: reads).
const R2_CLASS_A = new Set(['put', 'list', 'createMultipartUpload', 'resumeMultipartUpload']);
const R2_CLASS_B = new Set(['get', 'head']);

/** Runs `work` under its own meter and writes its data point when it ends, however it ends. */
export function measured<T>(env: Env, kind: string, name: string, work: () => T, outcome?: (r: Awaited<T>) => string): T {
  if (als.getStore()) return work();
  const m: Meter = { cursors: [], r2a: 0, r2b: 0, fetches: 0, gmail: 0, gmailRefused: 0 };
  const t0 = Date.now();
  const done = (result: string) => record(env, m, kind, name, result, Date.now() - t0);
  let r: T;
  try {
    r = als.run(m, work);
  } catch (e) {
    done('error');
    throw e;
  }
  // A method that answers at once is measured at once, and stays synchronous for its callers.
  if (!(r instanceof Promise)) {
    done(outcome ? outcome(r as Awaited<T>) : 'ok');
    return r;
  }
  return r.then(
    (v) => {
      done(outcome ? outcome(v as Awaited<T>) : 'ok');
      return v;
    },
    (e) => {
      done('error');
      throw e;
    },
  ) as T;
}

function record(env: Env, m: Meter, kind: string, name: string, result: string, ms: number): void {
  let read = 0;
  let written = 0;
  try {
    for (const c of m.cursors) {
      read += c.rowsRead;
      written += c.rowsWritten;
    }
    env.TELEMETRY?.writeDataPoint({
      indexes: [kind],
      blobs: [kind, name, result, env.APP_VERSION.slice(0, 7)],
      doubles: [ms, read, written, m.r2a, m.r2b, m.fetches, m.gmail, m.gmailRefused],
    });
  } catch {
    // Telemetry never breaks the work it measures.
  }
}

/** An API path with its ids taken out, so one route is one name: /api/accounts/:id/messages/:id. */
export function routeName(method: string, path: string): string {
  const parts = path.split('/').map((p) => (/^[0-9a-f]{12,}$|^\d+$|@|^[A-Za-z0-9_-]{20,}$/i.test(decodeURIComponent(p)) ? ':id' : p));
  return `${method} ${parts.join('/')}`;
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

/** The env with its raw files bucket counted, operation by operation, toward the current meter. */
export function meteredEnv(env: Env): Env {
  const bucket = env.ARCHIVE;
  const archive = new Proxy(bucket, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const m = als.getStore();
        if (m && typeof prop === 'string') {
          if (R2_CLASS_A.has(prop)) m.r2a++;
          else if (R2_CLASS_B.has(prop)) m.r2b++;
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { ...env, ARCHIVE: archive };
}

/** Counts every outgoing request toward the current meter, and Gmail's calls and refusals apart. Call once per isolate. */
let fetchCounted = false;
export function countFetches(): void {
  if (fetchCounted) return;
  fetchCounted = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = als.getStore();
    if (!m) return original(input, init);
    m.fetches++;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const gmail = url.includes('googleapis.com/');
    if (gmail) m.gmail++;
    const res = await original(input, init);
    if (gmail && (res.status === 429 || res.status === 403)) m.gmailRefused++;
    return res;
  }) as typeof fetch;
}
