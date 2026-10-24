# Spikes

De-risking tests from the build plan. Each one answers a question the design rests on,
so we find the wall before we build into it. Phase 1 covers S4, S5, S6 and S9.

## S9: CI on OpenShip — done (2026-10-24)

Type-check, build, test and `wrangler deploy --dry-run` run green on the self-hosted
arm64 runner. CI, Release and Deploy are registered against `main`.

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
