import { GMAIL_SCOPES, type Me } from '@mailcellar/schema';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { accessToken, mockFetch, ORIGIN, signIn } from './helpers';

const CLIENT = 'test-client.apps.googleusercontent.com';
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const idToken = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'RS256' })}.${b64url({ iss: 'https://accounts.google.com', aud: CLIENT, exp: Date.now() / 1000 + 600, email_verified: true, ...claims })}.sig`;

/** Google's token and revoke endpoints, as the test wants them to answer. */
function google(token: Record<string, unknown>) {
  const calls: { url: string; body: string }[] = [];
  mockFetch((url, init) => {
    calls.push({ url, body: String(init?.body ?? '') });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json(token);
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

const flowCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('mc_oauth='))!;

/** Start connecting a Gmail account; returns Google's URL and the flow cookie to send back. */
async function start(api: Awaited<ReturnType<typeof signIn>>['api']) {
  const res = await api('/api/accounts/connect');
  expect(res.status).toBe(302);
  return { to: new URL(res.headers.get('location')!), set: flowCookie(res), flow: flowCookie(res).split(';')[0] };
}

/** Come back from Google with a code for the flow just started. */
const finish = (api: Awaited<ReturnType<typeof signIn>>['api'], flow: string, query: string) =>
  api(`/api/auth/callback?${query}`, { headers: { cookie: flow } });

describe('identity (Cloudflare Access)', () => {
  it('serves each Access user their own mailbox, with no login of its own', async () => {
    const { api, email } = await signIn('ada@example.com');
    const me = (await (await api('/api/me')).json()) as Me;
    expect(me).toEqual({ user: { email }, accounts: [] });
  });

  it('answers 401 without a valid Access token', async () => {
    const call = (token?: string) =>
      exports.default.fetch(`${ORIGIN}/api/me`, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });
    expect((await call()).status).toBe(401);
    expect((await call('not.a.jwt')).status).toBe(401);
    expect((await call(await accessToken({ email: 'x@example.com', aud: ['other-app'] }))).status).toBe(401);
    expect((await call(await accessToken({ email: 'x@example.com', iss: 'https://evil.cloudflareaccess.com' }))).status).toBe(401);
    expect((await call(await accessToken({ email: 'x@example.com', exp: Math.floor(Date.now() / 1000) - 5 }))).status).toBe(401);
    expect((await call(await accessToken({ email: 'x@example.com' }, { kid: 'unknown' }))).status).toBe(401);
    const good = await accessToken({ email: 'x@example.com' });
    const [h, b] = good.split('.');
    expect((await call(`${h}.${b}.${good.split('.')[2].slice(0, -4)}AAAA`)).status).toBe(401);
    expect((await call(good)).status).toBe(200);
  });

  it('keeps the health check open', async () => {
    expect((await exports.default.fetch(`${ORIGIN}/api/health`)).status).toBe(200);
  });
});

describe('connecting Gmail accounts', () => {
  it('sends the person to Google with state, PKCE, offline access and consent', async () => {
    const { api } = await signIn('starter@example.com');
    const { to, set } = await start(api);
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = to.searchParams;
    expect(p.get('client_id')).toBe(CLIENT);
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
    expect(p.get('scope')).toBe(`openid email ${GMAIL_SCOPES.modify}`);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('select_account consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toMatch(/^[\w-]{40,}$/);
    // The cookie must reach the callback's path.
    expect(set).toMatch(/Path=\/api\/auth; .*HttpOnly; Secure; SameSite=Lax/);
  });

  it('adds any number of accounts, tests each, and removes one with its token revoked', async () => {
    const { api } = await signIn('owner@example.com');
    for (const [sub, email, scope, rt] of [
      ['1001', 'home@gmail.com', `openid email ${GMAIL_SCOPES.modify}`, 'rt-home'],
      ['3003', 'work@example.org', GMAIL_SCOPES.readonly, 'rt-work'],
    ]) {
      const { to, flow } = await start(api);
      const calls = google({ refresh_token: rt, scope, id_token: idToken({ sub, email }) });
      const res = await finish(api, flow, `code=c&state=${to.searchParams.get('state')}`);
      expect(res.headers.get('location')).toBe('/?settings=accounts');
      expect(calls[0].body).toContain('code_verifier=');
      vi.restoreAllMocks();
    }

    const me = (await (await api('/api/me')).json()) as Me;
    expect(me.accounts.map((a) => a.email)).toEqual(['home@gmail.com', 'work@example.org']);
    expect(me.accounts[0].test).toMatchObject({ ok: true, error: null });
    const work = me.accounts[1];
    // Read only is fine: the account passes, and the app warns that Gmail cleanup is unavailable.
    expect([work.read, work.modify, work.test.ok]).toEqual([true, false, true]);
    expect(work.test.error).toBeNull();
    expect(JSON.stringify(me)).not.toMatch(/rt-home|rt-work/);

    // The connection test asks Google which scopes the token carries now.
    mockFetch((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?access_token=at-work'))
        return Response.json({ scope: `${GMAIL_SCOPES.modify} openid` });
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'at-work' });
      throw new Error(`unexpected fetch ${url}`);
    });
    const tested = (await (await api(`/api/accounts/${work.id}/test`, { method: 'POST' })).json()) as Me['accounts'][number];
    expect(tested).toMatchObject({ modify: true, test: { ok: true, error: null } });
    vi.restoreAllMocks();

    mockFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const revoked = (await (await api(`/api/accounts/${work.id}/test`, { method: 'POST' })).json()) as Me['accounts'][number];
    expect(revoked.test.ok).toBe(false);
    expect(revoked.test.error).toMatch(/no longer accepts/);
    vi.restoreAllMocks();

    const calls = google({});
    const del = await api(`/api/accounts/${work.id}`, { method: 'DELETE' });
    expect(await del.json()).toEqual({ ok: true, revoked: true });
    expect(calls).toEqual([{ url: 'https://oauth2.googleapis.com/revoke', body: 'token=rt-work' }]);
    expect(((await (await api('/api/me')).json()) as Me).accounts.map((a) => a.email)).toEqual(['home@gmail.com']);
    expect((await api(`/api/accounts/${work.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('puts an account in the mailbox of whoever is signed in, not anyone else', async () => {
    const a = await signIn('alice@example.com');
    const b = await signIn('bob@example.com');
    const { to, flow } = await start(a.api);
    google({ refresh_token: 'rt', scope: GMAIL_SCOPES.modify, id_token: idToken({ sub: '77', email: 'shared@gmail.com' }) });
    await finish(a.api, flow, `code=c&state=${to.searchParams.get('state')}`);
    expect(((await (await a.api('/api/me')).json()) as Me).accounts).toHaveLength(1);
    expect(((await (await b.api('/api/me')).json()) as Me).accounts).toHaveLength(0);
  });

  it('refuses a callback whose state does not match, or with no flow cookie', async () => {
    const { api } = await signIn('forger@example.com');
    const { flow } = await start(api);
    google({});
    expect((await finish(api, flow, 'code=c1&state=forged')).headers.get('location')).toBe('/?settings=accounts&auth_error=state');
    expect((await api('/api/auth/callback?code=c1&state=x')).headers.get('location')).toBe('/?settings=accounts&auth_error=state');
  });

  it('refuses a grant without Gmail, an ID token for another app, or no refresh token', async () => {
    const { api } = await signIn('picky@example.com');
    for (const [token, error] of [
      [{ refresh_token: 'x', scope: 'openid email', id_token: idToken({ sub: '1', email: 'a@example.com' }) }, 'gmail_scope'],
      [{ refresh_token: 'x', scope: GMAIL_SCOPES.modify, id_token: idToken({ sub: '1', email: 'a@example.com', aud: 'other' }) }, 'google'],
      [{ scope: GMAIL_SCOPES.modify, id_token: idToken({ sub: '2', email: 'b@example.com' }) }, 'no_refresh'],
    ] as const) {
      const { to, flow } = await start(api);
      google(token);
      const res = await finish(api, flow, `code=c&state=${to.searchParams.get('state')}`);
      expect(res.headers.get('location')).toBe(`/?settings=accounts&auth_error=${error}`);
      vi.restoreAllMocks();
    }
    expect(((await (await api('/api/me')).json()) as Me).accounts).toEqual([]);
  });

  it('reports a cancel at Google', async () => {
    const { api } = await signIn('canceller@example.com');
    const { to, flow } = await start(api);
    const res = await finish(api, flow, `error=access_denied&state=${to.searchParams.get('state')}`);
    expect(res.headers.get('location')).toBe('/?settings=accounts&auth_error=denied');
  });

  it('will not start a connection without an Access identity', async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/accounts/connect`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('refuses a change from another site', async () => {
    const { token } = await signIn('csrf@example.com');
    const res = await exports.default.fetch(`${ORIGIN}/api/accounts/a0000000000000000000000`, {
      method: 'DELETE',
      headers: { 'cf-access-jwt-assertion': token, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('keeps refresh tokens out of every API answer', async () => {
    const { mailbox, email } = await signIn('tokens@example.com');
    await mailbox.connectAccount({ id: 'aAAAAAAAAAAAAAAAAAAAAAA', email: 't@example.com', refreshToken: 'rt-secret', scopes: [] });
    expect(JSON.stringify(await mailbox.me(email))).not.toContain('rt-secret');
    expect(env.GOOGLE_CLIENT_SECRET).toBe('test-secret');
  });
});
