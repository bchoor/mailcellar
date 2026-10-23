#!/usr/bin/env bash
# Cut MailCellar releases (docs/releases.md) through the GitHub REST API.
# Adapted from EdgeDesk's scripts/release.sh, without its desk tags and in-app changelog.
#   scripts/release.sh          one patch release at main once RELEASE_EVERY (10)
#                               first-parent merges landed since the latest v0.* tag,
#                               or on the first merge 7 days after it; FORCE=1 cuts
#                               it now whatever the count
#   scripts/release.sh minor    tag main as the next minor; its notes are the
#                               hand-written docs/releases/v0.X.0.md (required)
#   scripts/release.sh notes    set the latest minor release's notes from its file again
#   DRY_RUN=1 scripts/release.sh  print the releases it would cut, create nothing
# .github/workflows/release.yml runs it on each merge to main. Needs gh with REST
# access to the repo, and jq. A patch's notes are key takeaways Claude writes from the
# batch's PRs (ANTHROPIC_API_KEY), then the list of those PRs; without a key they are
# GitHub's generated PR list.
set -euo pipefail
BUMP=${1:-patch}
DRY_RUN=${DRY_RUN:-0}
FORCE=${FORCE:-0}
RELEASE_EVERY=${RELEASE_EVERY:-10}
MODEL=claude-sonnet-5-5
REPO=${GITHUB_REPOSITORY:-bchoor/mailcellar}
git fetch -q origin main --tags
LATEST=$(git tag --list 'v0.*' --sort=-v:refname | head -1)
if [ -z "$LATEST" ]; then
  echo "no v0.* tag yet: tag the first commit v0.0.0 (docs/releases.md)" >&2
  exit 1
fi
IFS=. read -r _ MINOR PATCH <<< "${LATEST#v}"

release() { # tag sha previous-tag [notes-file]
  if [ "$DRY_RUN" = 1 ]; then
    echo "would cut $1 (notes from ${4:-$3}) $(git log -1 --format='%h %s' "$2")"
    return
  fi
  if [ -n "${4:-}" ]; then
    notes=$(cat "$4")
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    notes=$(takeaways "$1" "$2" "$3") || { echo "Claude wrote no notes" >&2; exit 1; }
  else
    notes=$(gh api -X POST "repos/$REPO/releases/generate-notes" \
      -f tag_name="$1" -f target_commitish="$2" -f previous_tag_name="$3" --jq .body)
  fi
  gh api -X POST "repos/$REPO/releases" \
    -f tag_name="$1" -f target_commitish="$2" -f name="$1" -f body="$notes" --silent
  echo "$1 $(git log -1 --format='%h %s' "$2")"
}

takeaways() { # tag sha previous-tag: Key takeaways and changes by area, from the PRs
  prs=$(git log --first-parent --format=%s "$3..$2" | grep -oE '\(#[0-9]+\)$' | tr -dc '0-9\n')
  pulls=$(for n in $prs; do
    gh api "repos/$REPO/pulls/$n" --jq '{number, title, body, login: .user.login}' \
      || { echo "could not read PR #$n" >&2; return 1; }
  done) || return 1
  input=$(jq -r '"## #\(.number) \(.title)\n\((.body // "") | .[0:1500])\n"' <<< "$pulls")
  list=$(jq -r '"- #\(.number) \(.title) (@\(.login))"' <<< "$pulls")
  prompt="Write the GitHub release notes for MailCellar $1, which covers the merged pull requests below. \
MailCellar keeps every Gmail message a person has, searchable and private, on Cloudflare's free tier. \
Start with '## Key takeaways': 3 to 5 bullets, each opening with one or more type tags from [Feature] [Improvement] [Fix] [Performance] [Security] \
(e.g. '- [Feature] **Headline**: sentence'), then a bold one-line headline, then one plain sentence on what a user can now do. \
Write each bullet for a new user who has never seen the change: the sentence must say where it lives, \
as they would find it, with the page or menu path (e.g. 'In Settings ▸ Accounts, ...', 'On the Senders page, ...'), \
and name the thing changed in full; a change with no screen says what it affects. \
Then one '## <area>' section per area touched (App, Gmail, Search, Sync, Storage, Infra), \
a few short bullets each in plain words, merging related PRs. No PR numbers, no file paths. \
Output only the markdown."
  body=$(jq -n --arg model "$MODEL" --arg text "$prompt"$'\n\n'"$input" \
    '{model: $model, max_tokens: 16000, messages: [{role: "user", content: $text}]}')
  # Only a whole reply is published: anything but end_turn (max_tokens, refusal, an error)
  # is asked again, at most 3 times, then fails the release.
  for attempt in 1 2 3; do
    reply=$(curl -sS https://api.anthropic.com/v1/messages \
      -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' \
      -H 'content-type: application/json' -d "$body")
    text=$(jq -r 'if .stop_reason == "end_turn"
      then [.content[]? | select(.type == "text") | .text] | join("") else "" end' <<< "$reply")
    [ -n "$text" ] && break
    # show why, without the key
    jq -c '{type, error, stop_reason, model, blocks: [.content[]?.type]}' <<< "$reply" >&2
    sleep $((attempt * 5))
  done
  [ -n "$text" ] || return 1
  printf '%s' "$text"
  printf '\n\n## Pull requests (%s)\n%s\n\nFull changelog: https://github.com/%s/compare/%s...%s\n' \
    "$(echo "$prs" | wc -w | tr -d ' ')" "$list" "$REPO" "$3" "$1"
}

if [ "$BUMP" = minor ]; then
  TAG="v0.$((MINOR + 1)).0"
  FILE="docs/releases/$TAG.md"
  git show "origin/main:$FILE" > /dev/null 2>&1 \
    || { echo "$FILE is not on main: write the key takeaways first (docs/releases.md)" >&2; exit 1; }
  git show "origin/main:$FILE" > "${RUNNER_TEMP:-/tmp}/notes.md"
  release "$TAG" "$(git rev-parse origin/main)" "$LATEST" "${RUNNER_TEMP:-/tmp}/notes.md"
  exit
fi
if [ "$BUMP" = notes ]; then
  TAG="v0.$MINOR.0"
  git show "origin/main:docs/releases/$TAG.md" > "${RUNNER_TEMP:-/tmp}/notes.md" 2> /dev/null \
    || { echo "docs/releases/$TAG.md is not on main" >&2; exit 1; }
  if [ "$DRY_RUN" = 1 ]; then echo "would set $TAG notes from docs/releases/$TAG.md"; exit; fi
  id=$(gh api "repos/$REPO/releases/tags/$TAG" --jq .id)
  gh api -X PATCH "repos/$REPO/releases/$id" -F body=@"${RUNNER_TEMP:-/tmp}/notes.md" --silent
  echo "$TAG notes set from docs/releases/$TAG.md"
  exit
fi
COUNT=$(git rev-list --first-parent --count "$LATEST..origin/main")
if [ "$COUNT" = 0 ]; then echo "nothing merged since $LATEST"; exit; fi
AGE_DAYS=$(( ($(date +%s) - $(git log -1 --format=%ct "$LATEST")) / 86400 ))
if [ "$FORCE" != 1 ] && [ "$COUNT" -lt "$RELEASE_EVERY" ] && [ "$AGE_DAYS" -lt 7 ]; then
  echo "$COUNT of $RELEASE_EVERY merges, $AGE_DAYS of 7 days since $LATEST: no release yet"
  exit
fi
release "v0.$MINOR.$((PATCH + 1))" "$(git rev-parse origin/main)" "$LATEST"
