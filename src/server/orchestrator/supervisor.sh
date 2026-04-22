#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# Required env vars (set by orchestrator):
#   RUN_ID, REPO_URL, DEFAULT_BRANCH, BRANCH_NAME,
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
# Optional:
#   FBI_MARKETPLACES  newline-separated plugin marketplace sources
#   FBI_PLUGINS       newline-separated plugin specs (name@marketplace)
#   Any project secret, injected as env var.
# Required mounts:
#   /ssh-agent              (host ssh-agent socket, RW)
#   /home/agent/.claude.json (host ~/.claude.json, RW — OAuth)
#   /fbi                    (injected via putArchive: instructions.txt + prompt.txt)
#
# Contract: at end, write /tmp/result.json with exit_code, push_exit, head_sha.

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
git checkout -b "$BRANCH_NAME" "origin/$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Compose the final prompt: global + project instructions + run prompt.
: > /tmp/prompt.txt
for section in global.txt instructions.txt; do
    if [ -s "/fbi/$section" ]; then
        cat "/fbi/$section" >> /tmp/prompt.txt
        printf '\n\n---\n\n' >> /tmp/prompt.txt
    fi
done
[ -f /fbi/prompt.txt ] || { echo "prompt.txt not found in /fbi"; exit 12; }
cat /fbi/prompt.txt >> /tmp/prompt.txt

# Run the agent. Stdin is the prompt file; stdout/stderr go to the TTY so
# Claude streams output live instead of buffering until exit (-p mode buffers).
set +e
claude --dangerously-skip-permissions < /tmp/prompt.txt
CLAUDE_EXIT=$?
set -e

# Capture anything Claude didn't commit, then push.
git add -A
git commit -m "wip: claude run $RUN_ID" 2>/dev/null || true

PUSH_EXIT=0
git push -u origin "$BRANCH_NAME" || PUSH_EXIT=$?

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" > /tmp/result.json

exit $CLAUDE_EXIT
