#!/usr/bin/env bash
# Local dev bootstrap: installs deps, generates a secrets key,
# installs the Playwright browser (used by the Playwright MCP for UI testing),
# then execs `npm run dev`.
#
# Idempotent — re-running skips steps whose outputs already exist.
# Run from anywhere; the script resolves the repo root from its own location.

set -euo pipefail

for cmd in node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d node_modules ]; then
  echo "▸ npm install"
  npm install
fi

: "${SECRETS_KEY_FILE:=/tmp/fbi.key}"
if [ ! -f "$SECRETS_KEY_FILE" ]; then
  echo "▸ generating secrets key at $SECRETS_KEY_FILE"
  head -c 32 /dev/urandom > "$SECRETS_KEY_FILE"
  chmod 600 "$SECRETS_KEY_FILE"
fi

if ! ls -d "$HOME/.cache/ms-playwright"/chromium-* >/dev/null 2>&1; then
  echo "▸ installing Playwright chrome-for-testing (first-run only, ~170MB)"
  npx --yes @playwright/mcp install-browser chrome-for-testing
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Dev}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-dev@example.com}"
export DB_PATH="${DB_PATH:-/tmp/fbi.db}"
export RUNS_DIR="${RUNS_DIR:-/tmp/fbi-runs}"
export DRAFT_UPLOADS_DIR="${DRAFT_UPLOADS_DIR:-/tmp/fbi-draft-uploads}"
export SECRETS_KEY_FILE

echo "▸ npm run dev  (server :3000, vite :5173)"
exec npm run dev
