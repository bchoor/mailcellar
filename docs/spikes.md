# Spikes

De-risking tests from the build plan. Each one answers a question the design rests on,
so we find the wall before we build into it. Phase 1 covers S4, S5, S6 and S9; phase 2
(the backfill) covers S1, S2, S3, S7 and S8.

## S9: CI on OpenShip — done (2026-10-24)

Type-check, build, test and `wrangler deploy --dry-run` run green on the self-hosted
arm64 runner. CI and Release are registered against `main`; deploys moved to Cloudflare Workers Builds.

## S4: search-index writes per message — done (2026-10-24)

A Free Durable Object allows **100,000 rows written a day**, as a hard failure, so rows
per message decides how long a first backfill takes. `apps/worker/test/spikes/s4-index-writes.test.ts`
loads 1,000 synthetic messages (Zipf-distributed vocabulary of 20,000 words, 300-800 words
a message) into a real DO in workerd, in batches of 100, one call per batch so each batch
commits like a sync step would.

| Index design | Rows / msg | Bytes / msg | 200k-mail backfill | 200k-mail index |
| --- | --- | --- | --- | --- |
| Full body FTS, rollups per message | 10.41 | 6,304 | 20.8 days | 1.26 GB |
| Full body FTS, rollups per batch | 7.98 | 6,304 | 16.0 days | 1.26 GB |
| Subject + from + snippet FTS | 7.98 | 930 | 16.0 days | 186 MB |
| Same, contentless FTS | 7.98 | 635 | 16.0 days | 127 MB |
| Same, `messages WITHOUT ROWID` | 6.98 | 635 | 14.0 days | 127 MB |
| Same, every table `WITHOUT ROWID` (shipped in PR 3) | **5.56** | **590** | **11.1 days** | **118 MB** |

Where the rows go, per message, in the shipped design: `messages` 2 (row and `ts` index), `fts` 1,
`senders` 1, `domains` 0.86, `months` 0.67, `labels` 0.03.

**Decisions**

- Index **subject, from and a 200-character snippet, contentless**, not the body. The body
  is in R2 and, from phase 2, in Basin, so full-text over bodies belongs in Basin SQL, not
  in the DO. This is the difference between 127 MB and 1.26 GB an mailbox.
- **Roll up once a batch**, not once a message: it saves 2.4 rows a message, a third of the
  write budget, because a batch of 100 collapses to far fewer distinct months and labels.
- **Every table `WITHOUT ROWID`**: the primary key is the table, so an insert or upsert writes
  one row instead of a row plus its key index. That saves 2.4 rows a message across `messages`
  and the rollups.

**What this means.** A 200,000-mail backfill writes about 1.1M rows, so it needs **about
11 days on Free** at 100k rows a day, or about a day on Paid. Phase 2's tracking UI has to make that pace visible and resumable rather than hide it.

**Caveat.** Rows are counted with `rowsWritten`, the same meter Cloudflare bills on, measured
in local workerd. FTS5 keeps its index in shadow tables (`fts_data`, `fts_idx`, `fts_docsize`)
that the meter reports as one row per insert; if production counts those pages separately the
real figure could be up to ~2 rows a message higher. Re-measure against a deployed DO once
one exists.

## S5: real DO storage cap on Free — answered by S4 (2026-10-24)

The open question was whether a 200k-mail index fits an object, given that Cloudflare's
limits table says 5 GB an account while the FAQ says 1 GB an object. S4 measures the chosen
design at **590 bytes a message, so 118 MB for 200,000 mails** — inside the smaller of the
two figures with 8x to spare. No sharding needed.

Still worth confirming against a deployed object, since the number only matters if the 1 GB
figure is per object: folded into the first deploy rather than run as its own spike.

## S6: Gmail sign-in lasts 8+ days — waiting on a Google OAuth client

`gmail.readonly` is a restricted scope, and an app left in Testing mode gets refresh tokens
that expire after 7 days, which would break every backfill. The test is to hold a refresh
token for 8 days and use it. It needs a Google Cloud OAuth client, which only Bikram can
create, and 8 calendar days, so it gates PR 4 rather than this PR.

## Phase 2 spikes: the backfill on Workers Free (2026-10-24)

Run against a throwaway Worker, `mailcellar-spike`, on the real account (Workers Free), with
its own bucket and synthetic test mail only. The Worker is `scripts/spikes/backfill-worker.js`;
it was deployed and driven through the Cloudflare API, and CPU was read from Workers
Observability. Each test ran 4 steps; numbers are CPU per message.

### S3: CPU per message

Work per message: read the Gmail-shaped JSON, decode `raw`, read the headers, SHA-256, gzip,
write to R2.

| Message size | Full work | Without gzip |
| --- | --- | --- |
| 5 KB (10 a step) | 1.1 ms | |
| 50 KB (10 a step) | 2.5 ms | |
| 500 KB | 19 ms | 4.3 ms |
| 5 MB | 180 ms | 26 ms |

- Gzip is about 80% of the CPU.
- The documented 10 ms per step was **not enforced**. One invocation used 1.9 s of CPU and
  finished `ok`. Cloudflare allows short bursts; we don't build on it.
- Locally (Node): MIME parsing with postal-mime costs about half of gzip. A Parquet row
  (hyparquet-writer) costs 0.1 to 0.8 ms.

**Decisions**

- Gzip messages up to 256 KB. Store larger ones as they are; most of their bytes are
  attachments that are already compressed.
- Don't parse MIME during the backfill. The index comes from Gmail's response (labels, size,
  date, snippet) plus From and Subject read from the raw headers, which costs about 0.02 ms.
  Bodies are parsed when a message is opened.

### S7: invocations, Gmail calls and chaining

- **A Workflow instance runs all its steps in one invocation.** Sleeps of 2 s and 65 s
  between steps did not start a new one.
- So the Free cap of **50 external requests applies to the whole instance**, not to each
  step. Measured: 30 fetches in step 1, then 20 in step 2, then `Too many subrequests`.
  The 1,000 Cloudflare-service calls (R2, DO) are counted the same way.
- An instance can start the next one. Chained 3 times, at 2 ms CPU each, and each new
  instance gets a fresh budget.

**Decisions**

- **One instance = one batch**: a token refresh, one `messages.list` page and Gmail batch
  requests (up to 50 messages each). Then it starts the next instance.
- **500 messages an instance**: 12 Gmail calls and about 510 R2 and DO calls, well inside both caps.
- The daily pace is set by DO writes: 100,000 rows a day for the **whole Cloudflare account**,
  shared with every other app on it. At 5.56 rows a message that is about 18,000 messages a
  day, or 36 instances. The Workflow stops for the day near the cap and resumes after 00:00 UTC.

### S1, S2, S8: Basin (R2 Data Catalog)

- S1, writing Parquet in a Worker: cheap (see S3), so not a blocker.
- S2, committing to the catalog: **blocked**. Catalog writes need a Cloudflare API token with
  Data Catalog Write and R2 write. The Cloudflare connection used here can't create API tokens.
- S8, query cost: R2 SQL bills $2.50 per TB scanned. A full scan of a 200k-mail archive
  (about 1 GB of Parquet) costs well under a cent.

**Proposal (Bikram to decide)**: the backfill doesn't need Basin. Raw mail in R2 is the record, and the DO
holds the index. Basin can be filled from R2 later, when full-text search over bodies is
built, so its token is asked for then.
