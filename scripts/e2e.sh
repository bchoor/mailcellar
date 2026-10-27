#!/usr/bin/env bash
# Pre-merge e2e: the production build (web bundle and Worker) under `wrangler dev`, checked by
# scripts/smoke.mjs against a mailbox with real-shaped mail (scripts/e2e-seed.mjs).
#
# With E2E_BASE_REF (CI sets the branch it merges into), it is an upgrade, like a deploy: that
# ref's build takes the mail in, then this build starts on the same saved Durable Objects (new
# migrations and one-time passes run on mail already there) and must answer within budget.
# Without it, this build does both visits. Bindings that only run on Cloudflare (Workers AI, the
# private tunnel) are left out of a copy of wrangler.jsonc.
set -euo pipefail
cd "$(dirname "$0")/.."
HERE=$(pwd)

PORT="${PORT:-8787}"
mkdir -p .wrangler
LOG="$HERE/.wrangler/e2e-wrangler.log"
STATE="$HERE/.wrangler/e2e-state"
rm -rf "$STATE"
: >"$LOG"

# Writes <root>/.wrangler/e2e.jsonc: wrangler.jsonc as a local Worker signed in as e2e@example.com.
config() {
  mkdir -p "$1/.wrangler"
  (cd "$1" && bun -e '
    const config = Bun.JSONC.parse(await Bun.file("wrangler.jsonc").text());
    delete config.ai;
    delete config.vpc_services;
    delete config.$schema;
    // No Access locally: the Worker acts as DEV_USER_EMAIL (auth.ts).
    config.vars = { ...config.vars, ACCESS_AUD: "", DEV_USER_EMAIL: "e2e@example.com", APP_VERSION: "e2e" };
    // Paths are read from where the config sits.
    config.main = "../" + config.main;
    config.assets.directory = "../" + config.assets.directory.replace(/^\.\//, "");
    await Bun.write(".wrangler/e2e.jsonc", JSON.stringify(config, null, 2));
  ')
}

# Starts the Worker built in <root> on the saved state.
start() {
  echo "--- start $1" >>"$LOG"
  (cd "$1" && exec bunx wrangler dev --config .wrangler/e2e.jsonc --port "$PORT" --persist-to "$STATE") >>"$LOG" 2>&1 &
  WRANGLER=$!
  for _ in $(seq 1 90); do
    curl -sf "http://localhost:$PORT/api/health" >/dev/null && return 0
    if ! kill -0 "$WRANGLER" 2>/dev/null; then tail -80 "$LOG"; echo "wrangler dev exited"; exit 1; fi
    sleep 1
  done
  tail -80 "$LOG"; echo "wrangler dev never answered"; exit 1
}
stop() {
  [ -n "$WRANGLER" ] || return 0
  kill "$WRANGLER" 2>/dev/null || true
  wait "$WRANGLER" 2>/dev/null || true
  WRANGLER=
  # Let the port go before the next start.
  for _ in $(seq 1 20); do curl -s "http://localhost:$PORT/" >/dev/null || return 0; sleep 0.5; done
}
WRANGLER=
BASE_DIR=
cleanup() {
  stop
  if [ -n "$BASE_DIR" ]; then git worktree remove --force "$BASE_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT
smoke() { SMOKE_URL="http://localhost:$PORT" bun "$HERE/scripts/smoke.mjs" || { echo "--- wrangler dev log ---"; tail -80 "$LOG"; exit 1; }; }

[ -f apps/web/dist/app/index.html ] || bun run build
config "$HERE"

FIRST="$HERE"
if [ -n "${E2E_BASE_REF:-}" ]; then
  BASE_DIR="$HERE/.wrangler/base"
  git worktree remove --force "$BASE_DIR" 2>/dev/null || rm -rf "$BASE_DIR"
  git worktree prune
  git worktree add --detach "$BASE_DIR" "$E2E_BASE_REF" >/dev/null
  (cd "$BASE_DIR" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)
  config "$BASE_DIR"
  FIRST="$BASE_DIR"
fi

start "$FIRST"
SMOKE_URL="http://localhost:$PORT" bun scripts/e2e-seed.mjs || { tail -80 "$LOG"; exit 1; }
echo "--- first visit (${E2E_BASE_REF:-this build})"
smoke
stop

start "$HERE"
echo "--- returning visit: this build on the saved mailboxes"
smoke

# A Worker or Durable Object that threw while serving shows here even when the answers looked fine.
if grep -E "✘ \[ERROR\]|Uncaught" "$LOG"; then echo "errors in the Worker log"; exit 1; fi
echo "e2e passed"
