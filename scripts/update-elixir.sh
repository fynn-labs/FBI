#!/usr/bin/env bash
# Pull latest, rebuild the Elixir release, and restart fbi-elixir.
# Run from anywhere on silco (or any host with the same layout) as a user
# that has sudo and SSH access for the git pull.

set -euo pipefail

SOURCE_DIR="${SOURCE_DIR:-/opt/src/fbi}"
RELEASE_DIR="${RELEASE_DIR:-/opt/fbi-elixir}"
SERVICE="${SERVICE:-fbi-elixir}"

cd "$SOURCE_DIR"

echo "==> git fetch + hard reset to origin/main in $SOURCE_DIR"
# silco is a deployment target — there shouldn't be local commits or dirty
# state on disk. If there are, they're accidental and we'd rather pick up
# what's on origin than wedge the script.
git fetch origin main
git reset --hard origin/main

REV="$(git rev-parse --short HEAD)"

echo "==> mix compile + release at $RELEASE_DIR (commit $REV)"
sudo bash -c "cd '$SOURCE_DIR/server-elixir' && \
  MIX_ENV=prod mix compile && \
  MIX_ENV=prod mix release --overwrite --path '$RELEASE_DIR'"

echo "==> chown $RELEASE_DIR -> fbi:fbi"
sudo chown -R fbi:fbi "$RELEASE_DIR"

echo "==> restart $SERVICE"
sudo systemctl restart "$SERVICE"

# Wait briefly so journal has time to print boot lines, then show the head.
sleep 2
echo "==> recent journal:"
sudo journalctl -u "$SERVICE" -n 15 --no-pager --no-hostname \
  | grep -v inotify \
  || true

echo
echo "Done. fbi-elixir at $REV."
