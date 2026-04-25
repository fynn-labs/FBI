#!/usr/bin/env bash
# FBI post-build layer. Run by the orchestrator as:
#   docker build -t <final> --build-arg BASE=<prev-image> -f Dockerfile.postbuild .
# where Dockerfile.postbuild embeds this script's intent:
#   FROM $BASE
#   RUN <contents of this file>
#
# Responsibilities:
#   1. Ensure required tools are installed.
#   2. Create the non-root "agent" user with HOME=/home/agent.
#   3. Drop GitHub host keys into /home/agent/.ssh/known_hosts.
#
# The script assumes apt-based systems (debian/ubuntu). For other bases,
# the orchestrator will log a warning and skip (see image.ts).

set -euo pipefail

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  # Remove any third-party apt sources from the base image (stale keys, etc.).
  # We add back what we need explicitly (NodeSource, gh CLI) below. Preserve
  # ubuntu.sources (Noble+ deb822 format) — deleting it leaves apt with no
  # repos at all, since /etc/apt/sources.list is empty on Ubuntu 24.04+.
  find /etc/apt/sources.list.d -mindepth 1 ! -name 'ubuntu.sources' -delete 2>/dev/null || true
  apt-get update
  apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl gnupg
  # Node.js 20 LTS — required for Claude Code CLI.
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs
  rm -rf /var/lib/apt/lists/*
fi

# Install gh CLI.
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y gh
fi

# Install Claude Code CLI via npm so the binary lands in npm's global bin
# (typically /usr/bin/claude) and is accessible to all users without any
# PATH hacks. The curl installer puts a wrapper in ~/. that breaks when
# called from a different directory via a symlink.
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
fi

# Create agent user.
if ! id agent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash agent
fi

# Seed known_hosts with GitHub's published keys.
mkdir -p /home/agent/.ssh
cat > /home/agent/.ssh/known_hosts <<'HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
HOSTS
chown -R agent:agent /home/agent/.ssh
chmod 700 /home/agent/.ssh
chmod 600 /home/agent/.ssh/known_hosts

# Create workspace directory owned by agent so git clone works.
mkdir -p /workspace
chown agent:agent /workspace

# Create prompt injection directory (filled via putArchive before container start).
mkdir -p /fbi
chown agent:agent /fbi

# Pre-create ~/.claude so it's owned by agent. Docker will bind-mount
# .credentials.json into it at runtime; plugin install needs the rest
# of the directory to be writable by agent.
mkdir -p /home/agent/.claude
chown agent:agent /home/agent/.claude
