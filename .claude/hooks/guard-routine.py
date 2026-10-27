#!/usr/bin/env python3
"""Keeps the pre-approved Cloudflare and GitHub calls in .claude/settings.json scoped.

settings.json lets routine calls run without a prompt. This hook sends a call back
to a prompt (permissionDecision "ask") when it reaches past MailCellar's own
resources: API tokens, account members, shared Access policies, deletes, other
Workers, other Access apps, or merges outside this repo.
"""
import json
import os
import re
import sys

OWN_REPO = "bchoor/mailcellar"
OWN_WORKERS = {"mailcellar"}
# The MailCellar Access app id(s), comma separated, from the cloud environment.
# Never committed: the repo is public.
OWN_ACCESS_APPS = {
    a.strip().lower()
    for a in os.environ.get("MAILCELLAR_ACCESS_APP_IDS", "").split(",")
    if a.strip()
}


def ask(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def check_cloudflare(code):
    c = code.lower()
    if re.search(r"/tokens\b|/members\b|/roles\b", c):
        ask("Touches API tokens or account members.")
    # App-specific rules live under access/apps/<id>/policies; this path is the
    # account's shared, reusable policies, which other apps depend on.
    if "access/policies" in c or "allow-bchoor-auth" in c:
        ask("Touches a shared Access policy.")
    if re.search(r"method\s*:\s*['\"`]delete|\.delete\(|-x\s*delete", c):
        ask("Deletes a Cloudflare resource.")
    for name in re.findall(r"workers/scripts/([a-z0-9_-]+)", c):
        if name not in OWN_WORKERS:
            ask(f"Touches Worker '{name}', not MailCellar's.")
    for app in re.findall(r"access/apps/([0-9a-f-]{8,})", c):
        if app not in OWN_ACCESS_APPS:
            ask("Touches an Access app that is not MailCellar's.")


def main():
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    args = data.get("tool_input", {}) or {}

    if tool == "mcp__Cloudflare__execute":
        check_cloudflare(" ".join(str(v) for v in args.values()))
    elif tool in ("mcp__github__merge_pull_request", "mcp__github__enable_pr_auto_merge"):
        repo = f"{args.get('owner', '')}/{args.get('repo', '')}".lower()
        if repo != OWN_REPO:
            ask(f"Merges in {repo}; only {OWN_REPO} merges are pre-approved.")
    elif tool == "Bash":
        cmd = args.get("command", "")
        if re.search(r"\bgh\s+pr\s+merge\b", cmd):
            cwd = data.get("cwd", "")
            if re.search(r"(-R|--repo)\b", cmd) and OWN_REPO not in cmd:
                ask("Merges outside this repo.")
            if "/lumen" in cwd:
                ask("Merges in the Lumen kit, which needs the owner's OK.")


if __name__ == "__main__":
    main()
