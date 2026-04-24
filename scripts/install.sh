#!/usr/bin/env bash
set -euo pipefail

# Run as root on the target server.
#
# Prerequisites (must be done before running this script):
#   - Node 20+ and npm installed
#   - Docker Engine running; user 'fbi' in the 'docker' group
#   - 'claude /login' run once as the fbi user
#   - ssh-agent configured to start for the fbi user on boot (see README)

for cmd in rsync node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done
id fbi >/dev/null 2>&1 || { echo "ERROR: user 'fbi' does not exist"; exit 1; }

APP_DIR=/opt/fbi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Runtime directories ────────────────────────────────────────────────────────
install -d -m 750 -o fbi -g fbi \
  /var/lib/agent-manager \
  /var/lib/agent-manager/runs \
  /etc/agent-manager

if [ ! -f /etc/agent-manager/secrets.key ]; then
  head -c 32 /dev/urandom > /etc/agent-manager/secrets.key
  chown fbi:fbi /etc/agent-manager/secrets.key
  chmod 600 /etc/agent-manager/secrets.key
fi

# ── Deploy source ──────────────────────────────────────────────────────────────
systemctl stop fbi.service 2>/dev/null || true

rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  "$SOURCE_DIR/" "$APP_DIR/"

# ── Build ──────────────────────────────────────────────────────────────────────
# Capture SHA from source (APP_DIR has no .git after rsync --exclude .git).
export VITE_VERSION
VITE_VERSION="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo dev)"

npm --prefix "$APP_DIR" ci
npm --prefix "$APP_DIR" run build

chown -R fbi:fbi "$APP_DIR"

# ── Environment file ───────────────────────────────────────────────────────────
# Only written on first install; re-installs preserve operator customisations.
if [ ! -f /etc/default/fbi ]; then
  cat > /etc/default/fbi <<'ENV'
PORT=3000
DB_PATH=/var/lib/agent-manager/db.sqlite
RUNS_DIR=/var/lib/agent-manager/runs
SECRETS_KEY_FILE=/etc/agent-manager/secrets.key
# Set these to real values:
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
# Optional overrides:
# HOST_SSH_AUTH_SOCK=/run/user/1000/ssh-agent.sock
# HOST_CLAUDE_DIR=/home/fbi/.claude
# HOST_DOCKER_SOCKET=/var/run/docker.sock   # forwarded read-write into run containers
# HOST_DOCKER_GID=995                       # override auto-detected docker group GID
WEB_DIR=/opt/fbi/dist/web
# Claude Code plugins installed in every run container.
# Comma- or newline-separated. Projects can add more in the UI.
FBI_DEFAULT_MARKETPLACES=anthropics/claude-plugins-official
FBI_DEFAULT_PLUGINS=superpowers@claude-plugins-official
ENV
  chmod 640 /etc/default/fbi
fi

# ── Systemd ────────────────────────────────────────────────────────────────────
install -m 644 "$APP_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
systemctl daemon-reload
systemctl enable --now fbi.service

echo "FBI installed and running."
echo "Edit /etc/default/fbi with real GIT_AUTHOR_NAME/EMAIL, then: systemctl restart fbi"
