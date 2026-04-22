#!/usr/bin/env bash
# Decides whether to push / which branch to push at the end of an FBI run.
#
# Sourced AND exec'd: when run as a script, it performs the work in the
# current working directory (expected to be the repo working tree). It is
# split out of supervisor.sh so it can be tested against git fixtures.
#
# Required env:
#   DEFAULT_BRANCH   name of the project's default branch (e.g. "main")
#   RUN_ID           numeric run id, used for the fallback branch name
#   CLAUDE_EXIT      exit code of the claude process (for the result JSON)
#   RESULT_PATH      path to write the result JSON to (e.g. /tmp/result.json)
#
# Writes JSON: {"exit_code":N,"push_exit":N,"head_sha":"...","branch":"..."}
# Never fails the script on push error — push_exit records it.

set -euo pipefail

: "${DEFAULT_BRANCH:?DEFAULT_BRANCH required}"
: "${RUN_ID:?RUN_ID required}"
: "${CLAUDE_EXIT:?CLAUDE_EXIT required}"
: "${RESULT_PATH:?RESULT_PATH required}"

# Capture uncommitted work on whatever branch we're on. If there's nothing
# staged, the commit is skipped (|| true swallows the "nothing to commit" exit).
git add -A
git commit -m "wip: claude run $RUN_ID" 2>/dev/null || true

# Refresh our view of the default branch so the "already merged" check below
# reflects anything merged during the run. Best-effort: offline ⇒ cached ref.
git fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"

# Does HEAD contain new commits vs origin/$DEFAULT_BRANCH? If HEAD is an
# ancestor of (or equal to) the default branch tip, Claude's work is either
# already merged or they produced no commits — either way, nothing to push.
HAS_NEW_WORK=1
if git merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    HAS_NEW_WORK=0
fi

PUSH_EXIT=0
RESULT_BRANCH=""

if [ "$HAS_NEW_WORK" = "1" ]; then
    # Keep work off the default branch: if Claude never branched, create the
    # fallback so the push lands on claude/run-$RUN_ID instead of main.
    if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
        CURRENT_BRANCH="claude/run-$RUN_ID"
        git checkout -b "$CURRENT_BRANCH"
        echo "[fbi] claude didn't branch; pushing to fallback $CURRENT_BRANCH"
    fi
    git push -u origin "$CURRENT_BRANCH" || PUSH_EXIT=$?
    RESULT_BRANCH="$CURRENT_BRANCH"
elif [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ] \
     && git rev-parse --verify --quiet "refs/remotes/origin/$CURRENT_BRANCH" >/dev/null; then
    # No new work, but Claude is on a feature branch that exists on the remote
    # (likely already merged via PR). Preserve the name so the UI can still
    # surface the existing PR / compare view.
    RESULT_BRANCH="$CURRENT_BRANCH"
    echo "[fbi] no new commits beyond $DEFAULT_BRANCH; preserving remote branch $CURRENT_BRANCH"
else
    echo "[fbi] no new commits beyond $DEFAULT_BRANCH; nothing to push"
fi

printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$RESULT_BRANCH" > "$RESULT_PATH"
