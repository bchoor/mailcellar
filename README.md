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

Real figures from one Gmail account copied from Nov 2004 to Oct 2026 (October 2026), about 122,000 messages.

- **Time:** about 2.5 hours on Workers Paid. Copy runs about 1,000 messages a minute per month, two months at a time.
- **R2 writes:** about 9,800 Class A operations, about $0.04 past the free tier.

### Durable Object writes per message

Workers Free allows 100,000 Durable Object rows written a day, so writes per message set how fast a backfill can go. Measured on that mailbox:

| Part | Rows written per message |
| --- | --- |
| Message row, envelope search (subject, sender, snippet, labels), rollups, sort indexes | ~4.5 |
| Body search index | ~2.0 |
| Conversation (thread) index, used by the MCP server | 1 |
| **Total** | **~7.5** |

What that means for your bill:

- **First backfill:** at ~7.5 rows a message, Workers Free copies about 13,000 messages a day; a 100,000-message mailbox takes about 8 days. Workers Paid ($5 a month) includes 50 million rows a month, so one month covers the first backfill of almost any mailbox, and it runs in hours.
- **After that:** Workers Free is enough. New mail at ~7.5 rows a message stays far under 100,000 a day.
- **Turning on a newer index for mail already copied** writes only that index: about 2 rows a message for body search, 1 for the thread index. Both wait for the day's room under the limit.
- **Storage:** R2 includes 10 GB a month; past that it bills $0.015 per GB-month. The mailbox databases take about 3.3 KB a message, two thirds of it the body search index (400 MB for 122,000 messages). Workers Free includes 5 GB.

The Usage page shows the account's Cloudflare usage against its plan, and backfills pause before a hard limit.

## MCP server

`https://mail.example.com/mcp` lets Claude (or any MCP client) search and read your archive. It is read only: no tool sends, changes or deletes mail. Tools: `list_mailboxes`, `search_messages` (words in the subject, sender, labels or body), `get_message` (body as text, paged), `list_thread`, `get_stats`, `aggregate` (top senders, domains, labels, months), `get_attachment`. Sign-in is Cloudflare Access with Managed OAuth; see [docs/setup.md](docs/setup.md#9-mcp-server). In claude.ai: Settings ▸ Connectors ▸ Add custom connector, with that URL.

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
