#!/usr/bin/env bash
# FBI run container entrypoint. Mounted at /usr/local/bin/supervisor.sh.
#
# Claude owns branching: supervisor does NOT pre-create a branch. It runs the
# agent on the default branch checkout, then hands off to finalizeBranch.sh
# which decides whether to push (skips empty / already-merged runs), creates
# a fallback branch if Claude stayed on the default branch AND produced new
# commits, and writes /tmp/result.json.
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

# Check out the user's branch for context if they specified one.
if [ -n "${FBI_CHECKOUT_BRANCH:-}" ]; then
    git checkout "$FBI_CHECKOUT_BRANCH" \
      || { echo "[fbi] warn: branch $FBI_CHECKOUT_BRANCH not found on remote; using $DEFAULT_BRANCH"; \
           git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }; }
else
    git checkout "$DEFAULT_BRANCH" || { echo "checkout failed"; exit 11; }
fi

# Pre-create the agent-owned branch. Sole writer: this container. Fast-forward
# pushes are guaranteed — no divergence on this ref.
AGENT_BRANCH="claude/run-$RUN_ID"
if ! git rev-parse --verify --quiet "origin/$AGENT_BRANCH" >/dev/null; then
    git checkout -b "$AGENT_BRANCH" \
      || { echo "[fbi] fatal: could not create branch $AGENT_BRANCH"; exit 13; }
    # Push immediately so the UI has a target and GitHub knows about the branch.
    git push -u origin "$AGENT_BRANCH" || echo "[fbi] warn: initial push of $AGENT_BRANCH failed"
else
    # Branch already exists remotely (this is a resume). Land on it.
    git checkout -B "$AGENT_BRANCH" "origin/$AGENT_BRANCH" \
      || { echo "[fbi] fatal: could not switch to $AGENT_BRANCH"; exit 13; }
fi

# Register the WIP remote so the snapshot daemon can push to it.
git remote add fbi-wip /fbi-wip.git 2>/dev/null \
  || git remote set-url fbi-wip /fbi-wip.git \
  || { echo "[fbi] fatal: could not register fbi-wip remote"; exit 14; }

# If this is a resume, restore the WIP snapshot. The script no-ops when
# there's nothing to restore (fresh run) and exits non-zero with a
# structured /tmp/result.json when the restore can't apply cleanly.
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
  FBI_WORKSPACE=/workspace \
  FBI_AGENT_BRANCH="$AGENT_BRANCH" \
  FBI_RESULT_PATH=/tmp/result.json \
  FBI_RUN_ID="$RUN_ID" \
  /usr/local/bin/fbi-resume-restore.sh
  RESTORE_EXIT=$?
  if [ "$RESTORE_EXIT" != "0" ]; then
    echo "[fbi] resume restore failed (exit $RESTORE_EXIT); see /tmp/result.json"
    exit "$RESTORE_EXIT"
  fi
fi

# Snapshot daemon. Captures working-tree state every 30s and pushes to
# fbi-wip/wip. Non-fatal on failure. Killed by the trap below at exit.
(
  while true; do
    sleep 30
    out=$(/usr/local/bin/fbi-wip-snapshot.sh 2>&1)
    printf '%s\n' "$out" > /tmp/last-snapshot.log
    # Mirror to /fbi-state so GitStateWatcher-equivalent server code can read it.
    mkdir -p /fbi-state
    printf '%s\n' "$out" > /fbi-state/snapshot-status 2>/dev/null || :
  done
) </dev/null >/dev/null 2>&1 &
FBI_SNAPSHOT_PID=$!
trap 'kill "$FBI_SNAPSHOT_PID" 2>/dev/null || :' EXIT

git config user.name  "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"

# Ensure env vars that the post-commit hook needs are exported so the hook
# subshell (a new process spawned by git) inherits them.
export RUN_ID
export DEFAULT_BRANCH
export FBI_BASE_BRANCH="${FBI_BASE_BRANCH:-}"

# Silent post-commit push hook: so the GitHub tab's commits/PR/CI views and
# the Merge-to-main button have up-to-date remote state mid-run. Runs in the
# background so a slow or offline push never blocks the commit itself.
mkdir -p .git/hooks
cat > .git/hooks/post-commit <<'HOOK'
#!/bin/sh
# Primary push: agent-owned branch (sole writer — always fast-forward).
( git push --recurse-submodules=on-demand origin HEAD > /tmp/last-push.log 2>&1 || true ) &

# Mirror push: to the user's feature branch, best-effort.
if [ -n "${FBI_BASE_BRANCH:-}" ] \
   && [ "$FBI_BASE_BRANCH" != "$DEFAULT_BRANCH" ] \
   && [ "$FBI_BASE_BRANCH" != "claude/run-${RUN_ID}" ]; then
  (
    if git push --recurse-submodules=on-demand origin "HEAD:refs/heads/$FBI_BASE_BRANCH" > /tmp/last-mirror.log 2>&1; then
      mkdir -p /fbi-state
      echo ok > /fbi-state/mirror-status
    else
      mkdir -p /fbi-state
      echo diverged > /fbi-state/mirror-status
    fi
  ) &
fi
HOOK
chmod +x .git/hooks/post-commit

# Run the agent. Two modes:
#   fresh: compose /tmp/prompt.txt from /fbi/*.txt and stdin-pipe into claude.
#   resume: use $FBI_RESUME_SESSION_ID to continue an existing session. The
#           resume path reuses the saved Claude session and does not need a
#           fresh prompt, so /fbi/prompt.txt is intentionally not required.
set +e
if [ -n "${FBI_RESUME_SESSION_ID:-}" ]; then
    echo "[fbi] resuming claude session $FBI_RESUME_SESSION_ID"
    # claude --resume presents '>' immediately and waits for user input. Signal
    # 'waiting' state so the host watcher leaves 'starting' before any hook fires.
    # The Stop hook touches the same file, so this is just an early signal.
    touch /fbi-state/waiting
    claude --resume "$FBI_RESUME_SESSION_ID" --dangerously-skip-permissions
    CLAUDE_EXIT=$?
else
    : > /tmp/prompt.txt
    for section in preamble.txt global.txt instructions.txt; do
        if [ -s "/fbi/$section" ]; then
            cat "/fbi/$section" >> /tmp/prompt.txt
            printf '\n\n---\n\n' >> /tmp/prompt.txt
        fi
    done
    [ -f /fbi/prompt.txt ] || { echo "prompt.txt not found in /fbi"; exit 12; }
    cat /fbi/prompt.txt >> /tmp/prompt.txt
    # Fresh launch: a prompt is being submitted via stdin pipe. Signal 'running'
    # so the host watcher leaves 'starting'. Claude Code does not fire
    # UserPromptSubmit for stdin-piped input, so we have to signal it ourselves.
    touch /fbi-state/prompted
    claude --dangerously-skip-permissions < /tmp/prompt.txt
    CLAUDE_EXIT=$?
fi
set -e

# Finalize the run's branch state: decide whether to push, create a fallback
# branch if Claude stayed on the default branch, and write /tmp/result.json.
# Kept in a separate script so it can be tested in isolation — see
# finalizeBranch.test.ts.
CLAUDE_EXIT="$CLAUDE_EXIT" RESULT_PATH=/tmp/result.json \
    /usr/local/bin/fbi-finalize-branch.sh

exit $CLAUDE_EXIT
