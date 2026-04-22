#!/usr/bin/env bash
set -euo pipefail

# Cross-compile fbi-tunnel for darwin/linux × amd64/arm64 inside a short-lived
# golang:1.22-alpine container, writing binaries to <repo>/dist/cli/.
# Prereqs: Docker daemon reachable. No Go toolchain needed on the host.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLI_DIR/../.." && pwd)"
OUT="$REPO_ROOT/dist/cli"

mkdir -p "$OUT"

VERSION="${VITE_VERSION:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)}"

docker run --rm \
  -v "$CLI_DIR":/src \
  -v "$OUT":/out \
  -e VERSION="$VERSION" \
  -w /src \
  golang:1.22-alpine \
  sh -c 'apk add --no-cache make >/dev/null && make dist OUT=/out VERSION=$VERSION'

chmod +x "$OUT"/fbi-tunnel-* 2>/dev/null || true

echo "fbi-tunnel binaries written to $OUT (version=$VERSION):"
ls -la "$OUT"
