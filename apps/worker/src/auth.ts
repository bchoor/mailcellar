// Google sign-in and the session cookie. The flow follows msgvault's: a random state and a
// PKCE verifier per attempt, offline access for a refresh token, the granted scopes checked
// before anything is saved, and the token revoked at Google when an account is removed.
import {
  asUserId,
  GMAIL_SCOPES,
  mailboxName,
  SESSION_COOKIE,
  SESSION_DAYS,
  SIGN_IN_SCOPES,
  type AuthError,
  type UserId,
} from '@mailcellar/schema';
import type { Env } from './env';
import type { MailboxDO } from './mailbox';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const FLOW_COOKIE = 'mc_oauth';
const FLOW_MINUTES = 10;

/** What a sign-in attempt remembers between leaving for Google and coming back. */
interface Flow {
  state: string;
  verifier: string;
  /** login: sign in (and connect that account). add: connect another account to the signed-in user. */
  mode: 'login' | 'add';
  /** Google was asked for consent, so a missing refresh token is final. */
  consent: boolean;
}

/** A signed-in request: whose it is, and that user's mailbox. */
export interface Session {
  user: UserId;
  hash: string;
  mailbox: DurableObjectStub<MailboxDO>;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Opaque, stable IDs from Google's subject ID: never the email, which can change. */
export const userIdFor = async (sub: string) => asUserId(`u${b64url(await sha256(`google:${sub}`)).slice(0, 22)}`);
export const accountIdFor = async (sub: string) => `a${b64url(await sha256(`account:${sub}`)).slice(0, 22)}`;

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (name: string, value: string, maxAge: number, path = '/') =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const redirect = (to: string, ...setCookies: string[]) => {
  const headers = new Headers({ location: to, 'cache-control': 'no-store' });
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
};
const fail = (code: AuthError) => redirect(`/?auth_error=${code}`, cookie(FLOW_COOKIE, '', 0, '/api/auth'));

/** The signed-in user for this request, or null. Costs one read in the user's mailbox. */
export async function session(request: Request, env: Env): Promise<Session | null> {
  const raw = cookies(request).get(SESSION_COOKIE);
  const dot = raw?.indexOf('.') ?? -1;
  if (!raw || dot < 1) return null;
  let user: UserId;
  try {
    user = asUserId(raw.slice(0, dot));
  } catch {
    return null;
  }
  const hash = hex(await sha256(raw.slice(dot + 1)));
  const mailbox = env.MAILBOX.getByName(mailboxName(user));
  return (await mailbox.hasSession(hash)) ? { user, hash, mailbox } : null;
}

/** GET /api/auth/login[?add=1]: off to Google's consent screen. */
export async function login(request: Request, env: Env, url: URL): Promise<Response> {
  const mode: Flow['mode'] = url.searchParams.get('add') ? 'add' : 'login';
  if (mode === 'add' && !(await session(request, env))) return fail('signed_out');
  const consent = mode === 'add' || url.searchParams.has('consent');
  const flow: Flow = { state: random(), verifier: random(), mode, consent };
  const challenge = b64url(await sha256(flow.verifier));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/callback`,
    response_type: 'code',
    scope: SIGN_IN_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    // Adding an account always asks for consent so Google issues a refresh token. Signing in
    // only picks the account; the callback comes back here with consent if no token is held.
    prompt: consent ? 'select_account consent' : 'select_account',
    state: flow.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const hint = url.searchParams.get('hint');
  if (hint && hint.length < 320) params.set('login_hint', hint);
  return redirect(`${AUTH_URL}?${params}`, cookie(FLOW_COOKIE, b64url(new TextEncoder().encode(JSON.stringify(flow))), FLOW_MINUTES * 60, '/api/auth'));
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
  name?: string;
  exp?: number;
}

/** GET /api/auth/callback: Google sends the person back here with a code. */
export async function callback(request: Request, env: Env, url: URL): Promise<Response> {
  let flow: Flow;
  try {
    const raw = cookies(request).get(FLOW_COOKIE) ?? '';
    flow = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return fail('state');
  }
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code || !flow.state || url.searchParams.get('state') !== flow.state) return fail('state');

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
  if (!res.ok) return fail('google');
  const token = (await res.json()) as TokenResponse;
  // The ID token came straight from Google's token endpoint over TLS, so its claims are
  // trusted without checking the signature (OpenID Connect Core 3.1.3.7); iss, aud and exp still are.
  const claims = idClaims(token.id_token);
  if (
    !claims?.sub || !claims.email || claims.email_verified === false ||
    claims.aud !== env.GOOGLE_CLIENT_ID ||
    !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss ?? '') ||
    (claims.exp ?? 0) * 1000 < Date.now()
  )
    return fail('google');
  const scopes = (token.scope ?? '').split(' ');
  if (!scopes.includes(GMAIL_SCOPES.modify) && !scopes.includes(GMAIL_SCOPES.readonly)) return fail('gmail_scope');

  const account = { id: await accountIdFor(claims.sub), email: claims.email, refreshToken: token.refresh_token ?? null, scopes };
  const clear = cookie(FLOW_COOKIE, '', 0, '/api/auth');
  if (flow.mode === 'add') {
    const current = await session(request, env);
    if (!current) return fail('signed_out');
    const saved = await current.mailbox.connectAccount(account);
    if (!saved.ok) return fail('no_refresh');
    return redirect('/?settings=accounts', clear);
  }

  const user = await userIdFor(claims.sub);
  const mailbox = env.MAILBOX.getByName(mailboxName(user));
  const saved = await mailbox.connectAccount(account, { email: claims.email, name: claims.name ?? null });
  // First sign-in without a refresh token (Google skips it once consent is on file): ask again, with consent.
  if (!saved.ok)
    return !flow.consent
      ? redirect(`/api/auth/login?consent=1&hint=${encodeURIComponent(claims.email)}`, clear)
      : fail('no_refresh');
  const secret = random();
  await mailbox.startSession(hex(await sha256(secret)));
  return redirect('/', clear, cookie(SESSION_COOKIE, `${user}.${secret}`, SESSION_DAYS * 86_400));
}

function idClaims(jwt: string | undefined): IdClaims | null {
  try {
    const body = jwt!.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** GET /api/auth/logout: end this session and go back to the sign-in page. */
export async function logout(request: Request, env: Env): Promise<Response> {
  const current = await session(request, env);
  if (current) await current.mailbox.endSession(current.hash);
  return redirect('/', cookie(SESSION_COOKIE, '', 0));
}

/**
 * Test a connected account: trade its refresh token for an access token and ask Google
 * which scopes that token carries. Records the outcome on the account.
 */
export async function testAccount(env: Env, mailbox: DurableObjectStub<MailboxDO>, id: string): Promise<boolean> {
  const refreshToken = await mailbox.accountToken(id);
  if (!refreshToken) return false;
  let result: { scopes: string[] } | { error: string };
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
    const token = (await res.json()) as { access_token?: string; error?: string };
    if (!token.access_token) {
      result = { error: token.error === 'invalid_grant' ? 'Google no longer accepts this sign-in (revoked or expired). Remove the account and add it again.' : `Google refused the token (${res.status}).` };
    } else {
      const info = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token.access_token)}`);
      const body = (await info.json()) as { scope?: string };
      result = info.ok ? { scopes: (body.scope ?? '').split(' ') } : { error: `Google couldn't describe the token (${info.status}).` };
    }
  } catch {
    result = { error: 'Couldn’t reach Google. Try again.' };
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
