import { asUserId, mailboxName } from '@mailcellar/schema';
import { env, exports } from 'cloudflare:workers';
import { seedSample } from './fixtures/sample';

export const ORIGIN = 'https://mailcellar.icaruslab.dev';

const hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** A signed-in user, without going through Google: a session and, if asked, the sample mailbox. */
export async function signIn(name: string, opts: { sample?: boolean } = {}) {
  const user = asUserId(name);
  const mailbox = env.MAILBOX.getByName(mailboxName(user));
  const secret = `secret-${name}-${crypto.randomUUID()}`;
  await mailbox.startSession(await hex(secret));
  if (opts.sample) await seedSample(mailbox);
  const cookie = `mc_session=${user}.${secret}`;
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN);
    return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
  };
  return { user, mailbox, cookie, api };
}
