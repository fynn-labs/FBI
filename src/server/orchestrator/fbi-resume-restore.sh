#!/bin/sh
# FBI resume restore. Fetches fbi-wip and overlays the snapshot tree onto
# claude/run-N's tip (which should equal origin's). Fails loudly on
# divergence.
#
# Env vars:
#   FBI_WORKSPACE       default: /workspace
#   FBI_AGENT_BRANCH    e.g. "claude/run-42"
#   FBI_RESULT_PATH     where to write failure JSON (default: /tmp/result.json)
#   FBI_RUN_ID          logged only
set -u

WS="${FBI_WORKSPACE:-/workspace}"
cd "$WS" 2>/dev/null || exit 2
AGENT="${FBI_AGENT_BRANCH:?FBI_AGENT_BRANCH required}"
RESULT_PATH="${FBI_RESULT_PATH:-/tmp/result.json}"

# Fetch WIP.
git fetch --quiet fbi-wip 2>/dev/null || {
  # No remote wip ref — nothing to restore, exit cleanly.
  exit 0
}

if ! git rev-parse --verify -q refs/remotes/fbi-wip/wip >/dev/null; then
  # wip ref absent — fresh resume, nothing to restore.
  exit 0
fi

snap=$(git rev-parse refs/remotes/fbi-wip/wip)
parent=$(git rev-parse "${snap}^" 2>/dev/null || echo '')
if [ -z "$parent" ]; then
  printf '{"stage":"restore","error":"no-parent","snapshot_sha":"%s"}\n' "$snap" > "$RESULT_PATH"
  exit 3
fi

# Verify origin/$AGENT is an ancestor of the snapshot's parent.
if ! git merge-base --is-ancestor "origin/$AGENT" "$parent" 2>/dev/null; then
  origin_tip=$(git rev-parse "origin/$AGENT" 2>/dev/null || echo '')
  printf '{"stage":"restore","error":"diverged","parent_sha":"%s","snapshot_sha":"%s","origin_tip":"%s"}\n' \
    "$parent" "$snap" "$origin_tip" > "$RESULT_PATH"
  exit 4
fi

# Reset to the snapshot's parent (fast-forwarding past any unpushed real commits).
git reset --hard "$parent" || {
  printf '{"stage":"restore","error":"reset-failed"}\n' > "$RESULT_PATH"
  exit 5
}

# Push any unpushed real commits up to parent so origin catches up.
# This no-ops if origin/$AGENT == parent.
git push --quiet origin "$AGENT" 2>/dev/null || :

# Overlay the snapshot tree into index + working tree. HEAD stays at parent.
if ! git read-tree --reset -u "$snap" 2>/dev/null; then
  printf '{"stage":"restore","error":"read-tree-failed"}\n' > "$RESULT_PATH"
  exit 6
fi

# Success — no result.json write (supervisor.sh will write the happy-path one).
exit 0
