#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# Claude owns branching: supervisor does NOT pre-create a branch. It runs the
# agent on the default branch checkout, captures HEAD afterwards, creates a
# fallback branch if Claude never branched, and pushes whatever branch HEAD
# points to.
#
# Required env vars (set by orchestrator):
#   RUN_ID, REPO_URL, DEFAULT_BRANCH,
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
# Optional:
#   FBI_MARKETPLACES        newline-separated plugin marketplace sources
#   FBI_PLUGINS             newline-separated plugin specs (name@marketplace)
#   FBI_RESUME_SESSION_ID   when set, uses claude --resume instead of fresh start
#   Any project secret, injected as env var.
# Required mounts:
#   /ssh-agent              (host ssh-agent socket, RW)
#   /home/agent/.claude.json (host ~/.claude.json, RW — OAuth)
#   /fbi                    (injected via putArchive: preamble/instructions/global/prompt)
#
# Contract: at end, write /tmp/result.json with exit_code, push_exit, head_sha, branch.

set -euo pipefail

export SSH_AUTH_SOCK=/ssh-agent

# Install plugin marketplaces and plugins. Failures are non-fatal so a bad
# entry doesn't block the run — the agent just won't have that plugin.
if [ -n "${FBI_MARKETPLACES:-}" ]; then
    while IFS= read -r mkt; do
        [ -z "$mkt" ] && continue
        echo "[fbi] adding marketplace: $mkt"
        claude plugin marketplace add "$mkt" || echo "[fbi] warn: marketplace add failed: $mkt"
    done <<< "$FBI_MARKETPLACES"
fi
if [ -n "${FBI_PLUGINS:-}" ]; then
    while IFS= read -r plug; do
        [ -z "$plug" ] && continue
        echo "[fbi] installing plugin: $plug"
        claude plugin install "$plug" || echo "[fbi] warn: plugin install failed: $plug"
    done <<< "$FBI_PLUGINS"
fi

cd /workspace

git clone --recurse-submodules "$REPO_URL" . || { echo "clone failed"; exit 10; }
git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Compose the final prompt: preamble + global + project instructions + run prompt.
: > /tmp/prompt.txt
for section in preamble.txt global.txt instructions.txt; do
    if [ -s "/fbi/$section" ]; then
        cat "/fbi/$section" >> /tmp/prompt.txt
        printf '\n\n---\n\n' >> /tmp/prompt.txt
    fi
done
[ -f /fbi/prompt.txt ] || { echo "prompt.txt not found in /fbi"; exit 12; }
cat /fbi/prompt.txt >> /tmp/prompt.txt

# Run the agent. Two modes:
#   fresh: read composed prompt from /tmp/prompt.txt and stdin-pipe into claude.
#   resume: use $FBI_RESUME_SESSION_ID to continue an existing session.
set +e
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    echo "[fbi] resuming claude session $FBI_RESUME_SESSION_ID"
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
    CLAUDE_EXIT=$?
else
    claude --dangerously-skip-permissions < /tmp/prompt.txt
    CLAUDE_EXIT=$?
fi
set -e

# Capture uncommitted work.
git add -A
git commit -m "wip: claude run $RUN_ID" 2>/dev/null || true

# Detect current branch. If Claude never branched, create the fallback so we
# never push to the default branch.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
    CURRENT_BRANCH="claude/run-$RUN_ID"
    git checkout -b "$CURRENT_BRANCH"
    echo "[fbi] claude didn't branch; pushing to fallback $CURRENT_BRANCH"
fi

PUSH_EXIT=0
git push -u origin "$CURRENT_BRANCH" || PUSH_EXIT=$?

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$CURRENT_BRANCH" > /tmp/result.json

exit $CLAUDE_EXIT
