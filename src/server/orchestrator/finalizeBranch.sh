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

# Take one final WIP snapshot so unsaved work is preserved even if the
# periodic daemon missed the last edit.
if [ -x /usr/local/bin/fbi-wip-snapshot.sh ]; then
    /usr/local/bin/fbi-wip-snapshot.sh > /tmp/last-snapshot.log 2>&1 || :
fi

# Refresh the remote default branch so already-merged detection works.
git fetch --quiet origin "$DEFAULT_BRANCH" 2>/dev/null || true

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"

# Read WIP sha (if any) from the log.
WIP_SHA=""
if [ -f /tmp/last-snapshot.log ]; then
    # last-snapshot.log is a single JSON line: {"ok":true,"sha":"..."}
    WIP_SHA=$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' /tmp/last-snapshot.log | tail -n 1)
fi

# Push exit is sourced from the last post-commit hook's log so we don't
# re-push from here — the hook has been keeping origin up to date.
PUSH_EXIT=0
if [ -f /tmp/last-push.log ]; then
    if grep -qE '^!|rejected|error:' /tmp/last-push.log 2>/dev/null; then
        PUSH_EXIT=1
    fi
fi

printf '{"exit_code":%d,"push_exit":%d,"head_sha":"%s","branch":"%s","wip_sha":"%s"}\n' \
    "$CLAUDE_EXIT" "$PUSH_EXIT" "$HEAD_SHA" "$CURRENT_BRANCH" "$WIP_SHA" > "$RESULT_PATH"
