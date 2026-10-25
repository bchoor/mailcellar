# MailCellar

[msgvault](https://github.com/wesm/msgvault) for Cloudflare: Gmail and mbox.

MailCellar copies every Gmail message you have into your own Cloudflare account, and makes it searchable. Delete mail from Gmail; it stays in your cellar. It also imports mbox files, such as a Google Takeout export.

## Credit

MailCellar is a Cloudflare port of the design of [msgvault](https://github.com/wesm/msgvault) by Wes McKinney (MIT): a system of record, raw messages as files, and a fast index. msgvault runs on your computer. MailCellar runs on Workers, Durable Objects and R2. msgvault's speed is our bar: 200,000 messages in about 2 hours.

| msgvault | MailCellar |
| --- | --- |
| SQLite system of record | Basin: an Apache Iceberg table per user in R2 Data Catalog |
| Raw MIME on disk | Raw files: original emails as R2 objects, packed per batch |
| DuckDB/Parquet cache, FTS5 | One Durable Object per mailbox: SQLite with FTS5 |
| TUI and web UI | Web app on [Lumen UI](https://www.npmjs.com/package/@columenlabs/lumen-ui) |

## Architecture

One Worker serves the app and the API. Cloudflare Access signs people in. Each Gmail account or mbox archive is a mailbox with its own Durable Object.

- **Raw files (R2 objects).** Every email as Gmail sent it, attachments included. Copies write them in packs; each message is a byte range in a pack.
- **Basin (system of record).** One row per message (headers, labels, size, where its bytes are) in an Iceberg table, stored in the same bucket. Any index can be rebuilt from it.
- **Index (Durable Object SQLite).** Every page, search, sort and group in the app runs here. The index is built from Basin once per month of mail.
- **Copy (Workflow).** Lists a month in Gmail, fetches raw messages, writes raw files, stages Basin rows. A commit run adds the staged rows to Basin. The copy path reads and writes no Durable Object rows.
- **Schedules (Durable Object alarms).** New mail syncs every 6 hours by default. Alarms don't use cron triggers, and Free allows only 5 per account.

### Where Basin is read and written

The app never queries Basin to show a page. The Worker reads Basin's Parquet files from the bucket directly; it does not use R2 SQL.

| Path | Basin | When |
| --- | --- | --- |
| Copy commit (backfill and new-mail sync) | Write | Each commit run adds the staged rows |
| mbox import | Write | Same as copy |
| Basin check | Write | One test row, under its own user; no mail |
| Index build | Read | Once per month of mail: that month's rows into the mailbox's Durable Object |
| First message open in a month | Read | Builds that month's locations file (where each email is in the raw files); later opens read the file |
| Re-copy of a month copied before | Read | That month's IDs, so mail already saved is skipped |

Each user's mail lives only in that user's stores: their own prefix in the bucket, their own Basin table, their own Durable Objects.

## Costs

Real figures from one Gmail account copied from Nov 2004 to Oct 2026 (October 2026):

- **Time:** about 2.5 hours on Workers Paid. Copy runs about 1,000 messages a minute per month, two months at a time.
- **R2 writes:** about 9,800 Class A operations, about $0.04 past the free tier.
- **Durable Object writes:** about 5 rows per indexed message. That backfill wrote 546,000 rows.

What that means for your bill:

- **First backfill:** Workers Free allows 100,000 Durable Object rows written a day, so about 20,000 messages are indexed a day. A large mailbox takes days on Free. Workers Paid ($5 a month) lifts that limit; one month covers the first backfill.
- **After that:** Workers Free is enough. The same 100,000 rows a day cover about 20,000 new messages a day.
- **Storage:** R2 includes 10 GB a month. Past that, R2 bills $0.015 per GB-month. Raw files and Basin both count.

The Usage page shows the account's Cloudflare usage against its plan, and backfills pause before a hard limit.

## Set up

[docs/setup.md](docs/setup.md): Cloudflare Access, the Google OAuth client, the R2 bucket and Basin, Worker variables and secrets, and Workers Builds.

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
