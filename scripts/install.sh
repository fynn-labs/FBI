#!/usr/bin/env bash
set -euo pipefail

# Run as root on the target server.
#
# Prerequisites (must be done before running this script):
#   - Node 20+ and npm installed
#   - Docker Engine running; user 'fbi' in the 'docker' group
#   - 'claude /login' run once as the fbi user
#   - ssh-agent configured to start for the fbi user on boot (see README)
#   - inotify-tools installed (apt install inotify-tools). The Elixir
#     SafeguardWatcher uses :file_system, which on Linux shells out to
#     inotifywait; without it the watcher silently degrades to no-op
#     change notifications.

for cmd in rsync node npm mix elixir; do
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

# ── Elixir release build ───────────────────────────────────────────────────────
ELIXIR_DIR=/opt/fbi-elixir
install -d -m 750 -o fbi -g fbi "$ELIXIR_DIR"

systemctl stop fbi-elixir.service 2>/dev/null || true

(
  cd "$SOURCE_DIR/server-elixir"
  MIX_ENV=prod mix deps.get --only prod
  MIX_ENV=prod mix compile
  MIX_ENV=prod mix release --overwrite --path "$ELIXIR_DIR"
)
chown -R fbi:fbi "$ELIXIR_DIR"

# ── Quantico (mock-Claude testing binary) ───────────────────────────────────────
# Only deployed when FBI_QUANTICO_ENABLED=1 is present in /etc/default/fbi.
if grep -q '^FBI_QUANTICO_ENABLED=1' /etc/default/fbi 2>/dev/null; then
  install -d -m 755 /usr/local/lib/fbi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) Q="$SOURCE_DIR/dist/cli/quantico-linux-amd64" ;;
    aarch64) Q="$SOURCE_DIR/dist/cli/quantico-linux-arm64" ;;
    *) echo "Unsupported arch for Quantico: $ARCH"; Q="" ;;
  esac
  if [ -n "$Q" ] && [ -f "$Q" ]; then
    install -m 755 "$Q" /usr/local/lib/fbi/quantico
    echo "Quantico installed at /usr/local/lib/fbi/quantico"
  else
    echo "Quantico binary not found ($Q); run 'npm run cli:dist' first" >&2
  fi
fi

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
# Mock-Claude testing binary (development servers only):
# FBI_QUANTICO_ENABLED=1
WEB_DIR=/opt/fbi/dist/web
# Claude Code plugins installed in every run container.
# Comma- or newline-separated. Projects can add more in the UI.
FBI_DEFAULT_MARKETPLACES=anthropics/claude-plugins-official
FBI_DEFAULT_PLUGINS=superpowers@claude-plugins-official
ENV
  chmod 640 /etc/default/fbi
fi

# ── Elixir environment file ────────────────────────────────────────────────────
if [ ! -f /etc/default/fbi-elixir ]; then
  SECRET_KEY_BASE_DEFAULT="$(openssl rand -hex 32)"
  cat > /etc/default/fbi-elixir <<ENV
# Phoenix server — public on :3000, proxies unmatched routes to upstream on :3001.
PORT=3000
PHX_SERVER=true
DATABASE_PATH=/var/lib/agent-manager/db.sqlite
PROXY_TARGET=http://127.0.0.1:3001
CLAUDE_CREDENTIALS=/home/fbi/.claude/.credentials.json
SECRET_KEY_BASE=${SECRET_KEY_BASE_DEFAULT}
# Forwarded into agent containers for git auth, and used on the host to
# sparse-clone repos for .devcontainer detection.
# HOST_SSH_AUTH_SOCK=/run/user/1000/ssh-agent.sock
# Docker group GID for the agent user's supplementary group inside run
# containers. Auto-detected from /etc/group; override here if your host's
# docker group is named differently or you want to disable docker-in-docker.
# HOST_DOCKER_GID=995
ENV
  chmod 640 /etc/default/fbi-elixir
  chown root:fbi /etc/default/fbi-elixir
fi

# ── Crossover: move the existing service to loopback ──────────────────────────
if ! grep -q '^FBI_OAUTH_POLLER_DISABLED' /etc/default/fbi; then
  cat >> /etc/default/fbi <<'ENV'
# ── Crossover ────────────────────────────────────────────────────────────────
# The existing service moves to loopback so the Phoenix server (fbi-elixir)
# can own :3000. The OAuth poller runs once on the Elixir side.
HOST=127.0.0.1
PORT=3001
FBI_OAUTH_POLLER_DISABLED=1
ENV
fi

# ── Systemd ────────────────────────────────────────────────────────────────────
install -m 644 "$APP_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
install -m 644 "$SOURCE_DIR/systemd/fbi-elixir.service" /etc/systemd/system/fbi-elixir.service
systemctl daemon-reload
systemctl enable --now fbi.service fbi-elixir.service
systemctl restart fbi.service fbi-elixir.service

echo "FBI installed and running."
echo "  Node server  : loopback :3001 — edit /etc/default/fbi with real GIT_AUTHOR_NAME/EMAIL"
echo "  Elixir server: public   :3000 — secrets in /etc/default/fbi-elixir"
echo "Run 'systemctl status fbi fbi-elixir' to verify both services are active."
