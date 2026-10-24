import { mailboxName } from '@mailcellar/schema';
import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { accountMailbox, userIdFor } from '../src/auth';
import { seedSample } from './fixtures/sample';

export const ORIGIN = 'https://mailcellar.icaruslab.dev';
const TEAM = 'https://test.cloudflareaccess.com';
const KID = `test-${crypto.randomUUID()}`;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A stand-in for Cloudflare Access's signing key; the Worker fetches its public half from the certs URL. */
const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const jwk = { ...((await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey), kid: KID, alg: 'RS256' };

/** A token as Access would sign it for this app; claims override the defaults. */
export async function accessToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const head = part({ alg: 'RS256', kid: KID, ...header });
  const body = part({ aud: [env.ACCESS_AUD], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Answer the Worker's fetch of Access's certs, and hand anything else to `rest`. */
export function mockFetch(rest: (url: string, init?: RequestInit) => Promise<Response> | Response = (url) => {
  throw new Error(`unexpected fetch ${url}`);
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    return rest(url, init);
  });
}

/** A person signed in through Access and, if asked, a connected Gmail account holding the sample mail (test fixture only). */
export async function signIn(email: string, opts: { account?: boolean; sample?: boolean } = {}) {
  const user = await userIdFor(email);
  const mailbox = env.MAILBOX.getByName(mailboxName(user));
  // A made-up account ID of the real shape; its refresh token is never sent anywhere real.
  const accountId = `a${user.slice(1, 23).padEnd(22, 'x')}`;
  if (opts.account || opts.sample)
    await mailbox.connectAccount({ id: accountId, email: `gmail-${email}`, refreshToken: 'test-refresh', scopes: ['https://www.googleapis.com/auth/gmail.modify'] });
  if (opts.sample) await seedSample(accountMailbox(env, user, accountId));
  const token = await accessToken({ email });
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-access-jwt-assertion', token);
    if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN);
    return exports.default.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init, headers });
  };
  return { user, email, mailbox, token, api, accountId, archive: `/api/accounts/${accountId}/archive` };
}
