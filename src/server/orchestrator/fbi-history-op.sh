#!/bin/sh
# FBI history operation runner. Invoked inside a container (live run container
# via `docker exec`, or a transient --rm container) to perform one git
# operation on behalf of the server.
#
# Env vars (required):
#   FBI_OP            one of: merge | sync | squash-local
#   FBI_BRANCH        feature branch name (e.g. feat/x)
#   FBI_DEFAULT       default branch (e.g. main)
# Op-specific:
#   FBI_STRATEGY      for op=merge: merge | rebase | squash
#   FBI_SUBJECT       for op=squash-local or op=merge/strategy=squash
#   FBI_RUN_ID        run id, for commit messages
#
# Output contract: one JSON line on stdout:
#   {"ok":true,"sha":"...","message":""}
#   {"ok":false,"reason":"conflict|gh-error","message":"..."}
# Exit code is always 0 on structured failure; non-zero only on unreachable
# pre-conditions (no /workspace, no git).
#
# Design: the op runs in a *separate worktree* (mktemp dir) so it never
# disturbs the agent's working tree in /workspace. Works equally for live
# and transient containers. POSIX sh only — no bashisms, so alpine-based
# images work.

set -u

: "${FBI_OP:?FBI_OP required}"
: "${FBI_BRANCH:?FBI_BRANCH required}"
: "${FBI_DEFAULT:?FBI_DEFAULT required}"

cd /workspace || { printf '%s\n' '{"ok":false,"reason":"gh-error","message":"no /workspace"}'; exit 2; }

emit_fail() {
  reason=$1
  msg=$(printf '%s' "$2" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '%s\n' "{\"ok\":false,\"reason\":\"${reason}\",\"message\":\"${msg}\"}"
}
emit_ok() {
  sha=$1
  printf '%s\n' "{\"ok\":true,\"sha\":\"${sha}\",\"message\":\"\"}"
}

WORK=$(mktemp -d)
cleanup() {
  git -C /workspace worktree remove --force "$WORK" 2>/dev/null || rm -rf "$WORK"
}
trap cleanup EXIT

# Fetch all branches so origin/$FBI_BRANCH and origin/$FBI_DEFAULT are both
# up-to-date. Important for live containers: post-commit pushed the branch
# but the orchestrator's container doesn't have the remote-tracking ref
# updated until we fetch.
if ! out=$(git -C /workspace fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*' 2>&1); then
  emit_fail gh-error "fetch failed: $out"
  exit 0
fi

# Check out default in the isolated worktree (detached — we don't need a
# local branch name here, pushes use explicit refspec below).
if ! out=$(git -C /workspace worktree add --detach "$WORK" "origin/$FBI_DEFAULT" 2>&1); then
  emit_fail gh-error "worktree add failed: $out"
  exit 0
fi

cd "$WORK"

run_merge() {
  strategy="${FBI_STRATEGY:-merge}"
  case "$strategy" in
    merge)
      if ! out=$(git merge --no-ff "origin/$FBI_BRANCH" 2>&1); then
        git merge --abort 2>/dev/null
        emit_fail conflict "merge conflict: $out"
        exit 0
      fi
      if ! out=$(git push origin "HEAD:refs/heads/$FBI_DEFAULT" 2>&1); then
        emit_fail gh-error "push failed: $out"
        exit 0
      fi
      ;;
    rebase)
      if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
        emit_fail gh-error "checkout branch failed"
        exit 0
      fi
      if ! out=$(git rebase "origin/$FBI_DEFAULT" 2>&1); then
        git rebase --abort 2>/dev/null
        emit_fail conflict "rebase conflict: $out"
        exit 0
      fi
      if ! out=$(git push --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
        emit_fail gh-error "force-push branch failed: $out"
        exit 0
      fi
      rebased_sha=$(git rev-parse HEAD)
      if ! git checkout --detach "origin/$FBI_DEFAULT" 2>/dev/null; then
        emit_fail gh-error "checkout default (post-rebase) failed"
        exit 0
      fi
      if ! out=$(git merge --ff-only "$rebased_sha" 2>&1); then
        emit_fail gh-error "ff-merge failed: $out"
        exit 0
      fi
      if ! out=$(git push origin "HEAD:refs/heads/$FBI_DEFAULT" 2>&1); then
        emit_fail gh-error "push failed: $out"
        exit 0
      fi
      ;;
    squash)
      subject="${FBI_SUBJECT:-Merge branch $FBI_BRANCH (FBI run ${FBI_RUN_ID:-?})}"
      if ! out=$(git merge --squash "origin/$FBI_BRANCH" 2>&1); then
        git merge --abort 2>/dev/null
        emit_fail conflict "squash conflict: $out"
        exit 0
      fi
      if ! out=$(git -c user.name="${GIT_AUTHOR_NAME:-FBI}" -c user.email="${GIT_AUTHOR_EMAIL:-fbi@example.com}" commit -m "$subject" 2>&1); then
        emit_fail gh-error "commit failed: $out"
        exit 0
      fi
      if ! out=$(git push origin "HEAD:refs/heads/$FBI_DEFAULT" 2>&1); then
        emit_fail gh-error "push failed: $out"
        exit 0
      fi
      ;;
    *)
      emit_fail gh-error "unknown strategy $strategy"
      exit 0
      ;;
  esac
  sha=$(git rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

run_sync() {
  if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
    emit_fail gh-error "checkout branch failed"
    exit 0
  fi
  if ! out=$(git rebase "origin/$FBI_DEFAULT" 2>&1); then
    git rebase --abort 2>/dev/null
    emit_fail conflict "rebase conflict: $out"
    exit 0
  fi
  if ! out=$(git push --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
    emit_fail gh-error "force-push failed: $out"
    exit 0
  fi
  sha=$(git rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

run_squash_local() {
  : "${FBI_SUBJECT:?FBI_SUBJECT required for squash-local}"
  if ! git checkout --detach "origin/$FBI_BRANCH" 2>/dev/null; then
    emit_fail gh-error "checkout branch failed"
    exit 0
  fi
  base=$(git merge-base HEAD "origin/$FBI_DEFAULT" 2>/dev/null) || {
    emit_fail gh-error "merge-base failed"
    exit 0
  }
  if ! out=$(git reset --soft "$base" 2>&1); then
    emit_fail gh-error "reset failed: $out"
    exit 0
  fi
  if ! out=$(git -c user.name="${GIT_AUTHOR_NAME:-FBI}" -c user.email="${GIT_AUTHOR_EMAIL:-fbi@example.com}" commit -m "$FBI_SUBJECT" 2>&1); then
    emit_fail gh-error "commit failed: $out"
    exit 0
  fi
  if ! out=$(git push --force-with-lease origin "HEAD:refs/heads/$FBI_BRANCH" 2>&1); then
    emit_fail gh-error "force-push failed: $out"
    exit 0
  fi
  sha=$(git rev-parse HEAD 2>/dev/null || echo '')
  emit_ok "$sha"
}

case "$FBI_OP" in
  merge) run_merge ;;
  sync) run_sync ;;
  squash-local) run_squash_local ;;
  *)
    emit_fail gh-error "unknown op $FBI_OP"
    exit 0
    ;;
esac
