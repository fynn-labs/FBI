#!/usr/bin/env bash
set -euo pipefail

# Run as a normal user on the target server (not sudo).
# git pull uses your SSH agent; privileged steps are run with sudo internally.

for cmd in rsync node npm git; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done

APP_DIR=/opt/fbi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Pull latest source (as current user, so SSH agent works) ──────────────────
echo "Pulling latest code in $SOURCE_DIR..."
git -C "$SOURCE_DIR" pull

# ── Deploy source ──────────────────────────────────────────────────────────────
sudo systemctl stop fbi.service 2>/dev/null || true

sudo rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  "$SOURCE_DIR/" "$APP_DIR/"

# ── Build ──────────────────────────────────────────────────────────────────────
export VITE_VERSION
VITE_VERSION="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"

sudo npm --prefix "$APP_DIR" ci
sudo npm --prefix "$APP_DIR" run build

sudo chown -R fbi:fbi "$APP_DIR"

# ── Restart ────────────────────────────────────────────────────────────────────
sudo systemctl start fbi.service

echo "FBI updated to $(git -C "$SOURCE_DIR" rev-parse --short HEAD) and running."
