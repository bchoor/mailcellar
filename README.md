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

Login is Cloudflare Access. Settings ▸ Accounts connects Gmail accounts through Google. The archive pages, Backfill, Cloudflare usage and Schedules are built; they stay empty until the backfill (phase 2) copies mail.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | The app (Vite, React, Lumen UI), served as static assets |
| `apps/worker` | The Worker: `/api/*` and the per-user mailbox Durable Object |
| `packages/schema` | Shared IDs, key layout and API types |
| `wrangler.jsonc` | One Worker, `mailcellar.icaruslab.dev`, bindings `MAILBOX`, `ARCHIVE` (R2), `ASSETS` |

## Develop

```bash
bun install
bun run dev              # the web app at http://localhost:5173
bun run check            # type-check, build, Worker tests (Vitest in workerd)
```

`bun run --filter=@mailcellar/web build:single` writes the whole app into one `index.html`.

Cloudflare Workers Builds deploys every push to `main`. CI and releases run on OpenShip's self-hosted runner: `.github/workflows/` and [docs/releases.md](docs/releases.md).

## Plan

Built in phases, one PR at a time ([build plan](https://claude.ai/artifact/C9VLgdgbM4gqn92YngUVCy)):

1. **UI, integrations, schemas**: scaffold and CI, phase 1 spikes, DO and Basin schemas, Google sign-in and Gmail connect, archive pages, Schedules and Usage.
2. **Backfill and tracking**: phase 2 spikes, sync Workflow, Basin commits, live schedule, Backfill page, message view, events and retries.
3. **Optional**: semantic search with Workers AI and Vectorize.
