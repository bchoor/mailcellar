// Remote images in opened mail, and the person's list of senders whose images show without asking.
// Every remote image the app shows comes through imageFetch: the Worker asks the sender's server,
// so the sender sees Cloudflare, never the reader's address or browser. Nothing here touches a
// Durable Object; the edge cache and the browser's cache answer repeats.
import { type ImageSenderKind, imageSenderValue } from '@mailcellar/schema';

const FETCH_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_URL = 2048;
/** A week: mail images rarely change, and a repeat costs nothing at the edge or in the browser. */
const KEEP_S = 7 * 24 * 3600;
const BLANK = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

const imageHeaders = (type: string, keep: number) => ({
  'content-type': type,
  'cache-control': `private, max-age=${keep}`,
  'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});
const blank = (keep = 3600) => new Response(BLANK, { headers: imageHeaders('image/gif', keep) });

/** The image's address, or null when it isn't one the fetcher may ask: http(s), a public host name. */
function target(raw: string | null, self: URL): URL | null {
  if (!raw || raw.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  // Host names only: no IP literals, no local names, never this app.
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || host.endsWith('.local') || host.endsWith('.internal') || host === self.hostname) return null;
  u.hash = '';
  return u;
}

/** Up to MAX_BYTES of the body; null when it runs past. */
async function capped(body: ReadableStream<Uint8Array>): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** GET /api/img?u=: one remote image of an open message, fetched by the Worker. Anything but an image comes back blank. */
export async function imageFetch(url: URL): Promise<Response> {
  const u = target(url.searchParams.get('u'), url);
  if (!u) return blank(KEEP_S);
  const key = new Request(`${url.origin}/api/img?u=${encodeURIComponent(u.href)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: imageHeaders(hit.headers.get('content-type') ?? 'image/gif', KEEP_S) });
  let res: Response;
  try {
    res = await fetch(u.href, {
      headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; MailCellar image fetcher)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch {
    return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !res.body || !type.startsWith('image/')) {
    await res.body?.cancel();
    return blank();
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await capped(res.body);
  } catch {
    return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  if (!bytes) return blank(KEEP_S);
  const out = new Response(bytes, { headers: imageHeaders(type, KEEP_S) });
  // The edge copy is shared by URL only; a sender's image is the same for every reader.
  const shared = new Response(bytes, { headers: { ...imageHeaders(type, KEEP_S), 'cache-control': `public, max-age=${KEEP_S}` } });
  await cache.put(key, shared).catch(() => {});
  return out;
}

/** The rule a PUT or DELETE /api/image-senders/:kind/:value names, cleaned; null when it isn't one. */
export function imageSenderOf(kind: string, value: string): { kind: ImageSenderKind; value: string } | null {
  if (kind !== 'domain' && kind !== 'address') return null;
  let v: string;
  try {
    v = decodeURIComponent(value);
  } catch {
    return null;
  }
  const clean = imageSenderValue(kind, v);
  return clean ? { kind, value: clean } : null;
}
