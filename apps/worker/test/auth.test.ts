import { GMAIL_SCOPES, type Me } from '@mailcellar/schema';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, signIn } from './helpers';

const CLIENT = 'test-client.apps.googleusercontent.com';
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const idToken = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'RS256' })}.${b64url({ iss: 'https://accounts.google.com', aud: CLIENT, exp: Date.now() / 1000 + 600, email_verified: true, ...claims })}.sig`;

/** Google's token and revoke endpoints, as the test wants them to answer. */
function google(token: Record<string, unknown>) {
  const calls: { url: string; body: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json(token);
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}
afterEach(() => vi.restoreAllMocks());

const get = (path: string, cookie = '') =>
  exports.default.fetch(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const setCookies = (res: Response) => res.headers.getSetCookie();
const value = (res: Response, name: string) =>
  setCookies(res).find((c) => c.startsWith(`${name}=`))!.split(';')[0];

/** Start a sign-in and return Google's URL and the flow cookie. */
async function start(path = '/api/auth/login', cookie = '') {
  const res = await get(path, cookie);
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get('location')!);
  return { to, flow: value(res, 'mc_oauth') };
}

describe('sign-in', () => {
  it('sends the person to Google with state, PKCE and offline access', async () => {
    const { to, flow } = await start();
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = to.searchParams;
    expect(p.get('client_id')).toBe(CLIENT);
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
    expect(p.get('scope')).toContain(GMAIL_SCOPES.modify);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toMatch(/^[\w-]{40,}$/);
    expect(flow).toMatch(/^mc_oauth=/);
  });

  it('signs in, connects the account, and serves only that user', async () => {
    const { to, flow } = await start();
    const calls = google({
      refresh_token: 'rt-ada',
      scope: `openid email ${GMAIL_SCOPES.modify}`,
      id_token: idToken({ sub: '1001', email: 'ada@example.com', name: 'Ada Lovelace' }),
    });
    const res = await get(`/api/auth/callback?code=c1&state=${to.searchParams.get('state')}`, flow);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const session = value(res, 'mc_session');
    expect(setCookies(res).find((c) => c.startsWith('mc_session='))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(calls[0].body).toContain('code_verifier=');

    const me = (await (await get('/api/me', session)).json()) as Me;
    expect(me.user).toEqual({ email: 'ada@example.com', name: 'Ada Lovelace' });
    expect(me.accounts).toEqual([expect.objectContaining({ email: 'ada@example.com', read: true, modify: true })]);
    expect(me.accounts[0].test).toMatchObject({ ok: true, detail: 'Read ✓ · Modify ✓' });
    expect(JSON.stringify(me)).not.toContain('rt-ada');
    // A new user's archive is their own, and empty: no sample mail.
    expect(await (await get('/api/archive/messages', session)).json()).toEqual([]);
  });

  it('refuses a callback whose state does not match', async () => {
    const { flow } = await start();
    google({});
    const res = await get('/api/auth/callback?code=c1&state=forged', flow);
    expect(res.headers.get('location')).toBe('/?auth_error=state');
    expect(setCookies(res).some((c) => c.startsWith('mc_session='))).toBe(false);
  });

  it('refuses a grant without Gmail, or an ID token for another app', async () => {
    for (const [token, error] of [
      [{ refresh_token: 'x', scope: 'openid email', id_token: idToken({ sub: '1', email: 'a@example.com' }) }, 'gmail_scope'],
      [{ refresh_token: 'x', scope: GMAIL_SCOPES.modify, id_token: idToken({ sub: '1', email: 'a@example.com', aud: 'other' }) }, 'google'],
    ] as const) {
      const { to, flow } = await start();
      google(token);
      const res = await get(`/api/auth/callback?code=c&state=${to.searchParams.get('state')}`, flow);
      expect(res.headers.get('location')).toBe(`/?auth_error=${error}`);
      vi.restoreAllMocks();
    }
  });

  it('asks again with consent when Google sends no refresh token for a new account', async () => {
    const { to, flow } = await start();
    google({ scope: GMAIL_SCOPES.modify, id_token: idToken({ sub: '2002', email: 'new@example.com' }) });
    const res = await get(`/api/auth/callback?code=c&state=${to.searchParams.get('state')}`, flow);
    expect(res.headers.get('location')).toMatch(/^\/api\/auth\/login\?consent=1&hint=new%40example.com$/);
    const again = await start(res.headers.get('location')!);
    expect(again.to.searchParams.get('prompt')).toBe('select_account consent');
  });

  it('answers 401 without a session, and signs out', async () => {
    expect((await get('/api/me')).status).toBe(401);
    expect((await get('/api/archive/months', 'mc_session=u_x.bogus')).status).toBe(401);
    const { cookie } = await signIn('leaver');
    expect((await get('/api/me', cookie)).status).toBe(200);
    const out = await get('/api/auth/logout', cookie);
    expect(out.headers.get('location')).toBe('/');
    expect((await get('/api/me', cookie)).status).toBe(401);
  });
});

describe('accounts', () => {
  it('adds a second account to the signed-in user, then removes it and revokes its token', async () => {
    const { cookie, api } = await signIn('owner');
    const { to, flow } = await start('/api/auth/login?add=1', cookie);
    expect(to.searchParams.get('prompt')).toBe('select_account consent');
    google({
      refresh_token: 'rt-work',
      scope: GMAIL_SCOPES.readonly,
      id_token: idToken({ sub: '3003', email: 'work@example.org' }),
    });
    const res = await get(`/api/auth/callback?code=c&state=${to.searchParams.get('state')}`, `${cookie}; ${flow}`);
    expect(res.headers.get('location')).toBe('/?settings=accounts');
    vi.restoreAllMocks();

    const me = (await (await api('/api/me')).json()) as Me;
    const work = me.accounts.find((a) => a.email === 'work@example.org')!;
    expect([work.read, work.modify, work.test.ok]).toEqual([true, false, false]);
    expect(work.test.error).toMatch(/modify/i);

    // The connection test asks Google which scopes the token carries now.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?access_token=at-work'))
        return Response.json({ scope: `${GMAIL_SCOPES.modify} openid` });
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-work' });
      throw new Error(`unexpected fetch ${url}`);
    });
    const tested = (await (await api(`/api/accounts/${work.id}/test`, { method: 'POST' })).json()) as Me['accounts'][number];
    expect(tested.test).toMatchObject({ ok: true, detail: 'Read ✓ · Modify ✓', error: null });
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const revoked = (await (await api(`/api/accounts/${work.id}/test`, { method: 'POST' })).json()) as Me['accounts'][number];
    expect(revoked.test.ok).toBe(false);
    expect(revoked.test.error).toMatch(/no longer accepts/);
    vi.restoreAllMocks();

    const calls = google({});
    const del = await api(`/api/accounts/${work.id}`, { method: 'DELETE' });
    expect(await del.json()).toEqual({ ok: true, revoked: true });
    expect(calls).toEqual([{ url: 'https://oauth2.googleapis.com/revoke', body: 'token=rt-work' }]);
    expect(((await (await api('/api/me')).json()) as Me).accounts).toEqual([]);
    expect((await api(`/api/accounts/${work.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('will not add an account without a session', async () => {
    const res = await get('/api/auth/login?add=1');
    expect(res.headers.get('location')).toBe('/?auth_error=signed_out');
  });

  it('refuses a change from another site', async () => {
    const { cookie } = await signIn('csrf');
    const res = await exports.default.fetch(`${ORIGIN}/api/accounts/a0000000000000000000000`, {
      method: 'DELETE',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('keeps refresh tokens out of every API answer', async () => {
    const { mailbox } = await signIn('tokens');
    await mailbox.connectAccount({ id: 'aAAAAAAAAAAAAAAAAAAAAAA', email: 't@example.com', refreshToken: 'rt-secret', scopes: [] });
    expect(JSON.stringify(await mailbox.me())).not.toContain('rt-secret');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('test-secret');
  });
});
