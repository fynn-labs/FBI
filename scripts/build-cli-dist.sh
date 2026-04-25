#!/usr/bin/env bash
set -euo pipefail
# Builds fbi-tunnel CLI binaries for the platforms supported by the current
# host and places them in dist/cli/ with the naming convention expected by
# the server: fbi-tunnel-{os}-{arch}  (e.g. fbi-tunnel-darwin-arm64).
#
# On macOS: builds darwin-arm64 + darwin-amd64 (both native, no cross-linker
#   needed because Apple's toolchain handles both sides of the fat binary split).
# On Linux x86_64: builds linux-amd64 (native) + linux-arm64 via the GNU
#   aarch64 cross-linker.  Install it with:
#     sudo apt-get install -y gcc-aarch64-linux-gnu
# Output directory can be overridden via DIST_CLI_OUT.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="${DIST_CLI_OUT:-$REPO_ROOT/dist/cli}"
mkdir -p "$OUT"

cd "$REPO_ROOT"

WORKSPACE_TARGET=$(cargo metadata --no-deps --format-version 1 | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['target_directory'])")

build() {
  local triple="$1" name="$2"
  echo "→ $triple  →  dist/cli/fbi-tunnel-$name"
  rustup target add "$triple" 2>/dev/null || true
  cargo build --release --target "$triple" -p fbi-tunnel
  cp "$WORKSPACE_TARGET/$triple/release/fbi-tunnel" "$OUT/fbi-tunnel-$name"
}

HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)

case "$HOST_OS/$HOST_ARCH" in
  Darwin/*)
    build aarch64-apple-darwin darwin-arm64
    build x86_64-apple-darwin  darwin-amd64
    ;;
  Linux/x86_64)
    build x86_64-unknown-linux-gnu linux-amd64
    if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
      export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
      build aarch64-unknown-linux-gnu linux-arm64
    else
      echo "Skipping linux-arm64: install gcc-aarch64-linux-gnu for cross-compilation"
    fi
    ;;
  Linux/aarch64)
    build aarch64-unknown-linux-gnu linux-arm64
    if command -v x86_64-linux-gnu-gcc >/dev/null 2>&1; then
      export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
      build x86_64-unknown-linux-gnu linux-amd64
    else
      echo "Skipping linux-amd64: install gcc on an x86_64 host for cross-compilation"
    fi
    ;;
  *)
    echo "Unsupported host: $HOST_OS/$HOST_ARCH" >&2
    exit 1
    ;;
esac

echo ""
echo "Built:"
ls -lh "$OUT/"
