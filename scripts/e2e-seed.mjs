#!/usr/bin/env bun
// e2e only: gives the local Worker a mailbox shaped like a real one, through the app's own mbox
// import (archive-api.ts): E2E_MESSAGES messages over three years, some with labels, then waits
// for the import to finish. Never run against a live site.
const base = (process.env.SMOKE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base + '/')) throw new Error(`e2e-seed runs against a local Worker only, not ${base}`);
const count = Number(process.env.E2E_MESSAGES ?? 3000);
const headers = { origin: base, 'content-type': 'application/json' };

const me = await (await fetch(`${base}/api/me`)).json();
if (me.accounts?.some((a) => a.kind === 'archive')) {
  console.log('seed: mailbox already there');
  process.exit(0);
}

const senders = ['news@example.com', 'billing@example.org', 'friend@example.net', 'team@example.com', 'alerts@example.io'];
const labels = ['Inbox', 'Inbox,Receipts', 'Archived', 'Important,Travel', 'Inbox,Category Updates'];
const start = Date.UTC(2023, 9, 1);
const span = Date.UTC(2026, 9, 1) - start;
let mbox = '';
for (let i = 0; i < count; i++) {
  const at = new Date(start + Math.floor((span * i) / count));
  const from = senders[i % senders.length];
  // The separator's date is asctime's: "Sun Oct  1 00:00:00 2023" (the time before the year).
  const [day, date, month, year, time] = at.toUTCString().replace(',', '').split(' ');
  mbox +=
    `From ${from} ${day} ${month} ${date} ${time} ${year}\r\n` +
    `X-Gmail-Labels: ${labels[i % labels.length]}\r\n` +
    `Message-ID: <e2e-${i}@example.com>\r\n` +
    `From: Sender ${i % 7} <${from}>\r\n` +
    `To: e2e@example.com\r\n` +
    `Subject: Message ${i} about item ${i % 97}\r\n` +
    `Date: ${at.toUTCString()}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    `Body of message ${i}. Order ${1000 + i}, total $${(i % 300) + 0.99}.\r\n\r\n`;
}
const file = new TextEncoder().encode(mbox);

const add = await fetch(`${base}/api/archives`, { method: 'POST', headers, body: JSON.stringify({ name: 'e2e', file: 'e2e.mbox', bytes: file.length }) });
if (!add.ok) throw new Error(`add archive: ${add.status} ${await add.text()}`);
const { id, parts } = await add.json();
if (parts !== 1) throw new Error(`seed file should be one part, got ${parts}`);
const put = await fetch(`${base}/api/archives/${id}/parts/1`, { method: 'PUT', headers: { origin: base, 'content-length': String(file.length) }, body: file });
if (!put.ok) throw new Error(`upload: ${put.status} ${await put.text()}`);
const done = await fetch(`${base}/api/archives/${id}/complete`, { method: 'POST', headers, body: '{}' });
if (!done.ok) throw new Error(`complete: ${done.status} ${await done.text()}`);

const until = Date.now() + 5 * 60_000;
for (;;) {
  const a = (await (await fetch(`${base}/api/me`)).json()).accounts.find((x) => x.id === id);
  const status = a?.archive?.status;
  if (status === 'done') break;
  if (status === 'failed') throw new Error(`import failed: ${a.archive.error}`);
  if (Date.now() > until) throw new Error(`import still ${status} after 5 minutes`);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`seed: imported ${count} messages into ${id}`);
