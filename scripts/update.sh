#!/usr/bin/env bash
set -euo pipefail

# Run as root on the target server.
# Pulls the latest code from git, rebuilds, and restarts the service.

for cmd in rsync node npm git; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done

APP_DIR=/opt/fbi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Pull latest source ─────────────────────────────────────────────────────────
echo "Pulling latest code in $SOURCE_DIR..."
git -C "$SOURCE_DIR" pull

# ── Deploy source ──────────────────────────────────────────────────────────────
systemctl stop fbi.service 2>/dev/null || true

rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  "$SOURCE_DIR/" "$APP_DIR/"

# ── Build ──────────────────────────────────────────────────────────────────────
export VITE_VERSION
VITE_VERSION="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"

npm --prefix "$APP_DIR" ci
npm --prefix "$APP_DIR" run build

chown -R fbi:fbi "$APP_DIR"

# ── Restart ────────────────────────────────────────────────────────────────────
systemctl start fbi.service

echo "FBI updated to $(git -C "$SOURCE_DIR" rev-parse --short HEAD) and running."
