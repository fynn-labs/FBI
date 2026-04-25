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
VITE_VERSION="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"

sudo npm --prefix "$APP_DIR" ci
sudo VITE_VERSION="$VITE_VERSION" npm --prefix "$APP_DIR" run build

sudo chown -R fbi:fbi "$APP_DIR"

# ── Download CLI dist binaries ─────────────────────────────────────────────────
# Pre-built for all platforms by CI; downloading avoids needing Rust on the
# server and gets the darwin binaries that can't be built on Linux.
echo "Downloading CLI binaries..."
REPO="fynn-labs/FBI"
RELEASE_TAG=$(curl -sf "https://api.github.com/repos/$REPO/releases/latest" | \
  grep -m1 '"tag_name"' | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [ -n "$RELEASE_TAG" ]; then
  CLI_DIR="$APP_DIR/dist/cli"
  sudo mkdir -p "$CLI_DIR"
  BASE_URL="https://github.com/$REPO/releases/download/$RELEASE_TAG"
  for name in darwin-arm64 darwin-amd64 linux-amd64 linux-arm64; do
    echo "  fbi-tunnel-$name ($RELEASE_TAG)"
    sudo curl -fsSL "$BASE_URL/fbi-tunnel-$name" -o "$CLI_DIR/fbi-tunnel-$name"
    sudo chmod +x "$CLI_DIR/fbi-tunnel-$name"
  done
  sudo chown -R fbi:fbi "$CLI_DIR"
else
  echo "Warning: could not determine latest release tag; CLI binaries not updated"
fi

# ── Restart ────────────────────────────────────────────────────────────────────
sudo systemctl start fbi.service

echo "FBI updated to $(git -C "$SOURCE_DIR" rev-parse --short HEAD) and running."
