# FBI

A personal web tool that runs `claude --dangerously-skip-permissions` inside ephemeral Docker containers, with an interactive in-browser terminal and per-run branch push.

**Status:** v1 — runtime slice only. See [design spec](docs/superpowers/specs/2026-04-21-fbi-agent-runtime-design.md).

## Prerequisites on the server

1. Docker Engine installed and running.
2. Tailscale (or other network boundary) set up — the app has no login.
3. Node 20+.
4. A unix user `fbi` in the `docker` group.
5. SSH keys loaded into the `fbi` user's ssh-agent, persisted across reboots.
6. `claude /login` performed once as `fbi`.

### Persistent ssh-agent recipe

One-time setup for a persistent user ssh-agent for the `fbi` user:

```bash
# As root:
loginctl enable-linger fbi

# As fbi:
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ssh-agent.service <<'EOF'
[Unit]
Description=User ssh-agent
[Service]
Type=simple
Environment=SSH_AUTH_SOCK=%t/ssh-agent.sock
ExecStart=/usr/bin/ssh-agent -D -a $SSH_AUTH_SOCK
[Install]
WantedBy=default.target
EOF
systemctl --user enable --now ssh-agent
# Then add your keys:
SSH_AUTH_SOCK=$XDG_RUNTIME_DIR/ssh-agent.sock ssh-add ~/.ssh/id_ed25519
```

In `/etc/default/fbi`, set:
```
HOST_SSH_AUTH_SOCK=/run/user/$(id -u fbi)/ssh-agent.sock
```

## Install

```bash
git clone <repo> /tmp/fbi-src
cd /tmp/fbi-src
sudo bash scripts/install.sh
sudo vim /etc/default/fbi    # set GIT_AUTHOR_NAME / EMAIL
sudo systemctl restart fbi
```

Open the service URL over Tailscale (port 3000 by default).

## Local development

```bash
npm install
head -c 32 /dev/urandom > /tmp/fbi.key
GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL=dev@example.com \
  DB_PATH=/tmp/fbi.db RUNS_DIR=/tmp/fbi-runs \
  SECRETS_KEY_FILE=/tmp/fbi.key \
  npm run dev
```

Server at http://localhost:3000, Vite dev server at http://localhost:5173.

## Testing

```bash
npm test               # all unit tests
npm run typecheck
```

Integration tests for the orchestrator require Docker; they auto-skip if Docker is unreachable.

## Architecture

See [design spec](docs/superpowers/specs/2026-04-21-fbi-agent-runtime-design.md).
