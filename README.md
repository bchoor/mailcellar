# MailCellar

[msgvault](https://github.com/wesm/msgvault) for Cloudflare: Gmail and mbox.

MailCellar copies every Gmail message you have into your own Cloudflare account, and makes it searchable. Delete mail from Gmail; it stays in your cellar. It also imports mbox files, such as a Google Takeout export.

## Credit

MailCellar is a Cloudflare port of the design of [msgvault](https://github.com/wesm/msgvault) by Wes McKinney (MIT): a system of record, raw messages as files, and a fast index. msgvault runs on your computer. MailCellar runs on Workers, Durable Objects and R2. msgvault's speed is our bar: 200,000 messages in about 2 hours.

| msgvault | MailCellar |
| --- | --- |
| SQLite system of record | One Durable Object per mailbox: SQLite with FTS5 |
| Raw MIME on disk | Raw files: original emails as R2 objects, packed |
| TUI and web UI | Web app on [Lumen UI](https://www.npmjs.com/package/@columenlabs/lumen-ui) |

## Architecture

One Worker serves the app and the API. Cloudflare Access signs people in. Each Gmail account or mbox archive is a mailbox with its own Durable Object.

- **Raw files (R2 objects).** Every email as Gmail sent it, attachments included. Messages under 128 KB are packed 25 to a file, up to 2 MB 8 to a file, and larger ones get a file each.
- **Mailbox (Durable Object SQLite).** The record. One row per message: headers, labels, size, and where its bytes are (file, offset, length). Every page, search, sort and group in the app runs here.
- **Copy (Workflow).** Lists a month in Gmail, fetches raw messages, writes raw files, and writes each message's row into its mailbox.
- **Open a message.** One Durable Object read for its location, then one ranged read of its raw file.
- **Schedules (Durable Object alarms).** New mail syncs every 6 hours by default. Alarms don't use cron triggers, and Free allows only 5 per account.

Each user's mail lives only in that user's stores: their own prefix in the bucket and their own Durable Objects.

## Costs

Real figures from one Gmail account copied from Nov 2004 to Oct 2026 (October 2026). They were measured on an earlier version that also wrote a second copy of each row to R2; the current version writes less.

- **Time:** about 2.5 hours on Workers Paid. Copy runs about 1,000 messages a minute per month, two months at a time.
- **R2 writes:** about 9,800 Class A operations, about $0.04 past the free tier.
- **Durable Object writes:** about 5 rows per message. That backfill wrote 546,000 rows.

What that means for your bill:

- **First backfill:** Workers Free allows 100,000 Durable Object rows written a day, so about 20,000 messages are copied a day. A large mailbox takes days on Free. Workers Paid ($5 a month) lifts that limit; one month covers the first backfill.
- **After that:** Workers Free is enough. The same 100,000 rows a day cover about 20,000 new messages a day.
- **Storage:** R2 includes 10 GB a month. Past that, R2 bills $0.015 per GB-month.

The Usage page shows the account's Cloudflare usage against its plan, and backfills pause before a hard limit.

## Set up

[docs/setup.md](docs/setup.md): Cloudflare Access, the Google OAuth client, the R2 bucket, Worker variables and secrets, and Workers Builds.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | The app (Vite, React, Lumen UI), served as static assets |
| `apps/worker` | The Worker: `/api/*`, the mailbox Durable Objects, the sync Workflow |
| `packages/schema` | Shared IDs, key layout, API types, plan limits |
| `wrangler.jsonc` | One Worker, bindings `MAILBOX`, `QUOTA`, `SYNC`, `ARCHIVE` (R2), `ASSETS` |

## Develop

```bash
bun install
cp .dev.vars.example .dev.vars   # then fill it in
bun run dev                      # the web app at http://localhost:5173
bunx wrangler dev                # Worker and app at http://localhost:8787
bun run check                    # type-check and build
```

## License

[MIT](LICENSE).
