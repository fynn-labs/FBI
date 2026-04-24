#!/bin/sh
# FBI WIP snapshot. Captures the current working tree into a commit object
# and force-pushes it to fbi-wip/wip. Does not touch HEAD, the real index,
# or the working tree.
#
# Env vars:
#   FBI_WORKSPACE   workspace dir (default: /workspace). For testability.
#   FBI_RUN_ID      run id (logged only).
#
# Output contract: one JSON line on stdout:
#   {"ok":true,"sha":"...","noop":false}
#   {"ok":true,"sha":"<last>","noop":true}
#   {"ok":false,"reason":"no-workspace"|"push"|"other","message":"..."}
# Exit 0 always (non-zero reserved for unreachable preconditions).

set -u

WS="${FBI_WORKSPACE:-/workspace}"
cd "$WS" 2>/dev/null || { printf '%s\n' '{"ok":false,"reason":"no-workspace"}'; exit 0; }

# Nothing to snapshot?
if [ -z "$(git status --porcelain)" ]; then
  last=$(git rev-parse --verify -q refs/remotes/fbi-wip/wip 2>/dev/null || echo '')
  printf '{"ok":true,"sha":"%s","noop":true}\n' "$last"
  exit 0
fi

parent=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ -z "$parent" ]; then
  printf '%s\n' '{"ok":false,"reason":"no-head"}'
  exit 0
fi

# Build the snapshot tree in a temporary index so the real index is untouched.
GIT_DIR_ABS=$(git rev-parse --absolute-git-dir)
tmp_index=$(mktemp)
# Seed the temp index from the real one if present so write-tree captures both
# staged and unstaged + untracked in one tree.
if [ -f "$GIT_DIR_ABS/index" ]; then
  cp "$GIT_DIR_ABS/index" "$tmp_index"
else
  rm -f "$tmp_index"
fi

if ! out=$(GIT_INDEX_FILE="$tmp_index" git add -A 2>&1); then
  rm -f "$tmp_index"
  esc=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"ok":false,"reason":"index","message":"%s"}\n' "$esc"
  exit 0
fi

tree=$(GIT_INDEX_FILE="$tmp_index" git write-tree 2>/dev/null || echo '')
rm -f "$tmp_index"
if [ -z "$tree" ]; then
  printf '%s\n' '{"ok":false,"reason":"write-tree"}'
  exit 0
fi

msg="fbi wip snapshot run=${FBI_RUN_ID:-?} ts=$(date -u +%s)"
commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" -p "$parent" 2>/dev/null || echo '')
if [ -z "$commit" ]; then
  printf '%s\n' '{"ok":false,"reason":"commit-tree"}'
  exit 0
fi

# Force-push: sole writer under FBI's branch policy. Last writer wins if two
# snapshot invocations race; acceptable because both represent the same run.
if ! out=$(git push --force --quiet fbi-wip "$commit:refs/heads/wip" 2>&1); then
  esc=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"ok":false,"reason":"push","message":"%s"}\n' "$esc"
  exit 0
fi

# Update the local remote-tracking ref for ergonomics.
git update-ref refs/remotes/fbi-wip/wip "$commit" 2>/dev/null || :

printf '{"ok":true,"sha":"%s","noop":false}\n' "$commit"
exit 0
