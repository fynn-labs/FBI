#!/usr/bin/env bash
set -euo pipefail
# Builds fbi-tunnel for the current host platform and places it in
# desktop/binaries/ with the Tauri sidecar naming convention
# (fbi-tunnel-{target-triple}).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/desktop/binaries"
mkdir -p "$OUT"

TARGET=$(rustc -vV | awk '/^host:/ { print $2 }')
echo "Building fbi-tunnel for $TARGET..."
cargo build --release --manifest-path "$REPO_ROOT/cli/fbi-tunnel/Cargo.toml"
cp "$REPO_ROOT/target/release/fbi-tunnel" "$OUT/fbi-tunnel-$TARGET"
echo "Wrote $OUT/fbi-tunnel-$TARGET"
