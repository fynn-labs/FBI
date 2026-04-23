#!/usr/bin/env bash
# FBI history operation runner. Invoked inside a container (either a live run
# container via `docker exec` or a transient --rm container) to perform one
# git operation on behalf of the server.
#
# Env vars (required):
#   FBI_OP            one of: merge | sync | squash-local
#   FBI_BRANCH        branch name the operation targets (e.g. feat/x)
#   FBI_DEFAULT       default branch (e.g. main)
# Op-specific:
#   FBI_STRATEGY      for op=merge: merge | rebase | squash
#   FBI_SUBJECT       for op=squash-local or op=merge/strategy=squash: commit msg
#   FBI_RUN_ID        run id, for commit messages
#
# Output contract: write to stdout a single JSON line:
#   {"ok":true,"sha":"...","message":""}
#   {"ok":false,"reason":"conflict|gh-error","message":"..."}
# Non-zero exit on unexpected errors.

set -uo pipefail

: "${FBI_OP:?FBI_OP required}"
: "${FBI_BRANCH:?FBI_BRANCH required}"
: "${FBI_DEFAULT:?FBI_DEFAULT required}"

cd /workspace || { echo '{"ok":false,"reason":"gh-error","message":"no /workspace"}'; exit 2; }

emit() { printf '%s\n' "$1"; }

abort_and_exit() {
  local reason="$1"; local msg="$2"
  git merge --abort >/dev/null 2>&1 || true
  git rebase --abort >/dev/null 2>&1 || true
  emit "{\"ok\":false,\"reason\":\"${reason}\",\"message\":\"${msg//\"/\\\"}\"}"
  exit 0
}

run_merge() {
  local strategy="${FBI_STRATEGY:-merge}"
  git fetch origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "fetch failed"
  case "$strategy" in
    merge)
      git checkout "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "checkout default failed"
      git pull --ff-only origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "pull --ff-only failed"
      if ! git merge --no-ff "origin/$FBI_BRANCH" 2>&1; then abort_and_exit conflict "merge conflict"; fi
      git push origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "push failed"
      ;;
    rebase)
      git checkout "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "checkout branch failed"
      if ! git rebase "origin/$FBI_DEFAULT" 2>&1; then abort_and_exit conflict "rebase conflict"; fi
      git push --force-with-lease origin "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "force-push branch failed"
      git checkout "$FBI_DEFAULT" 2>&1
      git pull --ff-only origin "$FBI_DEFAULT" 2>&1
      git merge --ff-only "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "ff-merge failed"
      git push origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "push failed"
      ;;
    squash)
      local subject="${FBI_SUBJECT:-Merge branch $FBI_BRANCH (FBI run ${FBI_RUN_ID:-?})}"
      git checkout "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "checkout default failed"
      git pull --ff-only origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "pull --ff-only failed"
      if ! git merge --squash "origin/$FBI_BRANCH" 2>&1; then abort_and_exit conflict "squash conflict"; fi
      git commit -m "$subject" 2>&1 || abort_and_exit gh-error "commit failed"
      git push origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "push failed"
      ;;
    *) abort_and_exit gh-error "unknown strategy $strategy" ;;
  esac
  local sha
  sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  emit "{\"ok\":true,\"sha\":\"$sha\",\"message\":\"\"}"
}

run_sync() {
  git fetch origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "fetch failed"
  git checkout "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "checkout branch failed"
  if ! git rebase "origin/$FBI_DEFAULT" 2>&1; then abort_and_exit conflict "rebase conflict"; fi
  git push --force-with-lease origin "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "force-push failed"
  local sha
  sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  emit "{\"ok\":true,\"sha\":\"$sha\",\"message\":\"\"}"
}

run_squash_local() {
  : "${FBI_SUBJECT:?FBI_SUBJECT required for squash-local}"
  git fetch origin "$FBI_DEFAULT" 2>&1 || abort_and_exit gh-error "fetch failed"
  git checkout "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "checkout branch failed"
  local base
  base="$(git merge-base HEAD "origin/$FBI_DEFAULT" 2>/dev/null)" || abort_and_exit gh-error "merge-base failed"
  git reset --soft "$base" 2>&1 || abort_and_exit gh-error "reset failed"
  git commit -m "$FBI_SUBJECT" 2>&1 || abort_and_exit gh-error "commit failed"
  git push --force-with-lease origin "$FBI_BRANCH" 2>&1 || abort_and_exit gh-error "force-push failed"
  local sha
  sha="$(git rev-parse HEAD 2>/dev/null || echo '')"
  emit "{\"ok\":true,\"sha\":\"$sha\",\"message\":\"\"}"
}

case "$FBI_OP" in
  merge) run_merge ;;
  sync) run_sync ;;
  squash-local) run_squash_local ;;
  *) emit "{\"ok\":false,\"reason\":\"gh-error\",\"message\":\"unknown op $FBI_OP\"}"; exit 2 ;;
esac
