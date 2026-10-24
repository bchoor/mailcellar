// Who is using the app, and the Gmail accounts they connect. Cloudflare Access signs the
// person in and tells the Worker their email; there is no login screen of our own. Gmail
// accounts are separate: Settings ▸ Accounts connects any number of them through Google.
// The connect flow follows msgvault's: a random state and a PKCE verifier per attempt,
// offline access for a refresh token, the granted scopes checked before anything is saved,
// and the token revoked at Google when an account is removed.
import { asUserId, CONNECT_SCOPES, GMAIL_SCOPES, mailboxName, type AuthError, type UserId } from '@mailcellar/schema';
import type { Env } from './env';
import type { MailboxDO } from './mailbox';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const FLOW_COOKIE = 'mc_oauth';
const FLOW_PATH = '/api/auth';
const FLOW_MINUTES = 10;

/** What a connect attempt remembers between leaving for Google and coming back. */
interface Flow {
  state: string;
  verifier: string;
}

/** The person behind a request, as Cloudflare Access names them, and their mailbox. */
export interface Identity {
  user: UserId;
  email: string;
  mailbox: DurableObjectStub<MailboxDO>;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromB64url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const json = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes));

/** Opaque, stable IDs: the user's from their Access email, an account's from Google's subject ID. */
export const userIdFor = async (email: string) => asUserId(`u${b64url(await sha256(`access:${email.toLowerCase()}`)).slice(0, 22)}`);
export const accountIdFor = async (sub: string) => `a${b64url(await sha256(`account:${sub}`)).slice(0, 22)}`;

/** Access signing keys by key ID, refreshed hourly or when a token names a key not seen yet. */
let accessKeys: { at: number; keys: Map<string, CryptoKey> } | null = null;
export const resetAccessKeys = () => (accessKeys = null);

async function accessKey(env: Env, kid: string): Promise<CryptoKey | null> {
  if (!accessKeys || Date.now() - accessKeys.at > 3_600_000 || !accessKeys.keys.has(kid)) {
    const res = await fetch(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const map = new Map<string, CryptoKey>();
    for (const jwk of keys)
      map.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    accessKeys = { at: Date.now(), keys: map };
  }
  return accessKeys.keys.get(kid) ?? null;
}

/** The email in a valid Cloudflare Access token for this app, or null. */
async function verifyAccess(token: string, env: Env): Promise<string | null> {
  try {
    const [head, body, sig] = token.split('.');
    const header = json<{ alg?: string; kid?: string }>(fromB64url(head));
    if (header.alg !== 'RS256' || !header.kid) return null;
    const key = await accessKey(env, header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(sig), new TextEncoder().encode(`${head}.${body}`));
    if (!ok) return null;
    const claims = json<{ aud?: string | string[]; iss?: string; exp?: number; email?: string }>(fromB64url(body));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD) || claims.iss !== env.ACCESS_TEAM_DOMAIN) return null;
    if ((claims.exp ?? 0) * 1000 < Date.now() || !claims.email) return null;
    return claims.email;
  } catch {
    return null;
  }
}

/**
 * Who is making this request. In production that is the email in Cloudflare Access's signed
 * token; Access sits in front of the whole site, and the Worker checks the token itself.
 * `wrangler dev` has no Access, so there DEV_USER_EMAIL stands in (set only in .dev.vars).
 */
export async function identity(request: Request, env: Env): Promise<Identity | null> {
  let email: string | null = null;
  if (env.ACCESS_AUD) {
    const token = request.headers.get('cf-access-jwt-assertion');
    email = token ? await verifyAccess(token, env) : null;
  } else if (env.DEV_USER_EMAIL) email = env.DEV_USER_EMAIL;
  if (!email) return null;
  const user = await userIdFor(email);
  return { user, email, mailbox: env.MAILBOX.getByName(mailboxName(user)) };
}

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (value: string, maxAge: number) =>
  `${FLOW_COOKIE}=${value}; Path=${FLOW_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const redirect = (to: string, setCookie?: string) => {
  const headers = new Headers({ location: to, 'cache-control': 'no-store' });
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(null, { status: 302, headers });
};
const back = (error?: AuthError) => redirect(`/?settings=accounts${error ? `&auth_error=${error}` : ''}`, cookie('', 0));

/** GET /api/accounts/connect: off to Google to pick a Gmail account and allow access to it. */
export async function connect(url: URL, env: Env): Promise<Response> {
  const flow: Flow = { state: random(), verifier: random() };
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/callback`,
    response_type: 'code',
    scope: CONNECT_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    // Consent every time, so Google always issues a refresh token, even for an account seen before.
    prompt: 'select_account consent',
    state: flow.state,
    code_challenge: b64url(await sha256(flow.verifier)),
    code_challenge_method: 'S256',
  });
  return redirect(`${AUTH_URL}?${params}`, cookie(b64url(new TextEncoder().encode(JSON.stringify(flow))), FLOW_MINUTES * 60));
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}
interface IdClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
}

/** GET /api/auth/callback: Google sends the person back here; the account joins their mailbox. */
export async function callback(request: Request, env: Env, url: URL, who: Identity): Promise<Response> {
  let flow: Flow;
  try {
    flow = json(fromB64url(cookies(request).get(FLOW_COOKIE) ?? ''));
  } catch {
    return back('state');
  }
  if (url.searchParams.get('error')) return back('denied');
  const code = url.searchParams.get('code');
  if (!code || !flow.state || url.searchParams.get('state') !== flow.state) return back('state');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/api/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: flow.verifier,
    }),
  });
  if (!res.ok) return back('google');
  const token = (await res.json()) as TokenResponse;
  // The ID token came straight from Google's token endpoint over TLS, so its claims are
  // trusted without checking the signature (OpenID Connect Core 3.1.3.7); iss, aud and exp still are.
  let claims: IdClaims | null = null;
  try {
    claims = json(fromB64url(token.id_token!.split('.')[1]));
  } catch {}
  if (
    !claims?.sub || !claims.email || claims.email_verified === false ||
    claims.aud !== env.GOOGLE_CLIENT_ID ||
    !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '') ||
    (claims.exp ?? 0) * 1000 < Date.now()
  )
    return back('google');
  const scopes = (token.scope ?? '').split(' ');
  if (!scopes.includes(GMAIL_SCOPES.modify) && !scopes.includes(GMAIL_SCOPES.readonly)) return back('gmail_scope');

  const saved = await who.mailbox.connectAccount({
    id: await accountIdFor(claims.sub),
    email: claims.email,
    refreshToken: token.refresh_token ?? null,
    scopes,
  });
  return back(saved.ok ? undefined : 'no_refresh');
}

/** Trade a refresh token for an access token, or say in words why Google refused. */
export async function accessTokenFor(env: Env, refreshToken: string): Promise<{ token: string } | { error: string; revoked: boolean }> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (body.access_token) return { token: body.access_token };
    return body.error === 'invalid_grant'
      ? { error: 'Google no longer accepts this connection (revoked or expired). Remove the account and add it again.', revoked: true }
      : { error: `Google rejected the connection (HTTP ${res.status}). Try again; if it keeps failing, remove the account and add it again.`, revoked: false };
  } catch {
    return { error: 'Couldn’t reach Google. Try again.', revoked: false };
  }
}

/**
 * Test a connected account: trade its refresh token for an access token and ask Google
 * which scopes that token carries. Records the outcome on the account.
 */
export async function testAccount(env: Env, mailbox: DurableObjectStub<MailboxDO>, id: string): Promise<boolean> {
  const refreshToken = await mailbox.accountToken(id);
  if (!refreshToken) return false;
  let result: { scopes: string[] } | { error: string };
  const access = await accessTokenFor(env, refreshToken);
  if ('error' in access) result = { error: access.error };
  else {
    try {
      const info = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(access.token)}`);
      const body = (await info.json()) as { scope?: string };
      result = info.ok ? { scopes: (body.scope ?? '').split(' ') } : { error: `Google couldn’t confirm this account’s access (HTTP ${info.status}). Try again.` };
    } catch {
      result = { error: 'Couldn’t reach Google. Try again.' };
    }
  }
  await mailbox.recordTest(id, result);
  return true;
}

/** Revoke a refresh token at Google. Best effort: the account is disconnected here either way. */
export async function revoke(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    // 400 invalid_token: already revoked or expired, which is the outcome wanted.
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}
