# MailCellar

MailCellar keeps every Gmail message you have, searchable and private, on Cloudflare's free tier. Delete mail from Gmail; it stays in your cellar.

It is a Cloudflare-native take on [msgvault](https://github.com/wesm/msgvault): the same model (a system of record, a blob store, a fast index) rebuilt from Cloudflare services.

| msgvault | MailCellar |
| --- | --- |
| SQLite system of record | Basin Catalog (Iceberg tables), per user |
| Attachments folder, raw MIME | R2, per user |
| DuckDB/Parquet cache, FTS5 | Mailbox Durable Object (SQLite, FTS5) |
| sqlite-vec embeddings | Vectorize, per user |
| TUI and web UI | Web app on [Lumen UI](https://github.com/columenlabs/lumen-ui) |

Principles: each user's mail lives only in that user's stores and is read only through their session; shared metrics are content-free events in Workers Analytics Engine.

## Status

`apps/web` is a clickable prototype on sample data: archive views (Overview, Messages, Senders, Domains, Labels, Time), Backfill progress, Cloudflare usage against the free tier, and Settings (Accounts, Schedules). Nothing talks to Gmail yet.

## Develop

```bash
bun install
bun run dev              # the web app at http://localhost:5173
bun run build            # static build into apps/web/dist
bun run deploy           # build and deploy to the mailcellar Worker
```

`bun run --filter=@mailcellar/web build:single` writes the whole app into one `index.html`.

## Plan

1. Spike: icebird upsert to Basin from a Free-tier Worker, CPU per step measured
2. Repo scaffold: Workers, wrangler config, CI, Lumen app shell
3. Gmail sign-in and account connect; tokens held in the mailbox DO
4. Mailbox DO: schema, FTS5 search, rollups, read API
5. Sync Workflow: first and incremental pull, R2 writes, resumable steps
6. Schedule: DO alarm, Settings ▸ Schedules, Sync now
7. App pages on real data
8. Message view: raw MIME from R2, safe rendering, attachments
9. Backfill page and status bar from the DO's sync state
10. Usage page: Cloudflare GraphQL Analytics feed, limits, alerts
11. Basin commit path (icebird, or the PyIceberg fallback)
12. Embeddings: Workers AI and Vectorize for a chosen subset
13. Analytics Engine events, error handling, retries
