#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# Required env vars (set by orchestrator):
#   RUN_ID, REPO_URL, DEFAULT_BRANCH, BRANCH_NAME,
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL
# Optional: any project secret, injected as env var.
# Required mounts:
#   /ssh-agent              (host ssh-agent socket, RW)
#   /home/agent/.claude     (host ~/.claude, RO)
#   /run/fbi                (tmpfs with instructions.txt + prompt.txt)
#
# Contract: at end, write /tmp/result.json with exit_code, push_exit, head_sha.

set -uo pipefail

export SSH_AUTH_SOCK=/ssh-agent

cd /workspace

git clone "$REPO_URL" . || { echo "clone failed"; exit 10; }
git checkout -b "$BRANCH_NAME" "origin/$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Compose the final prompt: project instructions + run prompt.
: > /tmp/prompt.txt
if [ -s /run/fbi/instructions.txt ]; then
    cat /run/fbi/instructions.txt >> /tmp/prompt.txt
    printf '\n\n---\n\n' >> /tmp/prompt.txt
fi
cat /run/fbi/prompt.txt >> /tmp/prompt.txt

# Run the agent. TTY-attached; Claude may emit its OAuth login flow if needed.
claude --dangerously-skip-permissions -p "$(cat /tmp/prompt.txt)"
CLAUDE_EXIT=$?

# Capture anything Claude didn't commit, then push.
git add -A
git commit -m "wip: claude run $RUN_ID" 2>/dev/null || true

PUSH_EXIT=0
git push -u origin "$BRANCH_NAME" || PUSH_EXIT=$?

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" > /tmp/result.json

exit $CLAUDE_EXIT
