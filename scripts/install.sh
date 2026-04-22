#!/usr/bin/env bash
set -euo pipefail

# FBI install script. Run as root on the target server AFTER:
#   - Node 20+ installed
#   - Docker running
#   - User 'fbi' created and added to 'docker' group
#   - ssh-agent for 'fbi' configured to start on boot with keys loaded
#   - 'claude /login' performed once as 'fbi'

for cmd in rsync node npm; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found in PATH"; exit 1; }
done
id fbi >/dev/null 2>&1 || { echo "ERROR: user 'fbi' does not exist"; exit 1; }

APP_DIR=/opt/fbi
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

install -d -o fbi -g fbi /var/lib/agent-manager /var/lib/agent-manager/runs /etc/agent-manager

if [ ! -f /etc/agent-manager/secrets.key ]; then
  head -c 32 /dev/urandom > /etc/agent-manager/secrets.key
  chown fbi:fbi /etc/agent-manager/secrets.key
  chmod 600 /etc/agent-manager/secrets.key
fi

systemctl stop fbi.service 2>/dev/null || true
rsync -a --delete --exclude node_modules --exclude .git "$SOURCE_DIR/" "$APP_DIR/"
chown -R fbi:fbi "$APP_DIR"

su - fbi -c "cd '$APP_DIR' && npm ci && npm run build"

cat > /etc/default/fbi <<'ENV'
PORT=3000
DB_PATH=/var/lib/agent-manager/db.sqlite
RUNS_DIR=/var/lib/agent-manager/runs
SECRETS_KEY_FILE=/etc/agent-manager/secrets.key
# Set these to real values:
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
# Defaulted but can override:
# HOST_SSH_AUTH_SOCK=/run/user/1000/ssh-agent.sock
# HOST_CLAUDE_DIR=/home/fbi/.claude
WEB_DIR=/opt/fbi/dist/web
ENV
chmod 640 /etc/default/fbi

install -m 644 "$APP_DIR/systemd/fbi.service" /etc/systemd/system/fbi.service
systemctl daemon-reload
systemctl enable --now fbi.service

echo "FBI installed. Edit /etc/default/fbi and restart: systemctl restart fbi"
