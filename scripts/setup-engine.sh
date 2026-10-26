#!/usr/bin/env bash
# Usage: scripts/setup-engine.sh rust|ts
# Builds/installs one engine on the ENGINE host (layer 2). Does not need Redis.
set -euo pipefail
cd "$(dirname "$0")/.."
git submodule update --init --recursive

case "${1:-}" in
  rust)
    (cd engines/matching-engine-rust && cargo build --release)
    ;;
  ts)
    cd engines/centralized-exchange
    bun install --frozen-lockfile
    # The engine imports `database` at startup; the Prisma client must exist.
    # The URL is never connected to (Prisma connects lazily, and fixture mode skips the DB).
    (cd packages/database && DATABASE_URL="postgresql://build:build@localhost:5432/build" bunx prisma generate)
    ;;
  *) echo "usage: $0 rust|ts" >&2; exit 1 ;;
esac
echo "engine '$1' ready. Start it with: make engine-$1"
