#!/usr/bin/env bash
# Usage: scripts/start-engine.sh rust|ts
# Runs ONE engine in the foreground against the shared Redis (REDIS_URL from .env or env).
# Run only one engine at a time; both consume the same `incoming-request` queue.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${REDIS_URL:?REDIS_URL is not set (put it in .env, see .env.example)}"

DEFAULT_FIXTURE='{"markets":[{"symbol":"BTC_USDC"}]}'
export MARKETS_FIXTURE="${MARKETS_FIXTURE:-$DEFAULT_FIXTURE}"
export VERBOSE_LOGGING=false
export LOG_LEVEL=info
export DATABASE_URL="${DATABASE_URL:-postgresql://build:build@localhost:5432/build}"
export NODE_ENV=production
PIN=()
if [[ -n "${ENGINE_CPU:-}" ]]; then PIN=(taskset -c "$ENGINE_CPU"); fi

case "${1:-}" in
  rust)
    BIN=engines/matching-engine-rust/target/release/matching-engine-rust
    [[ -x "$BIN" ]] || { echo "build first: make engine-setup-rust" >&2; exit 1; }
    exec "${PIN[@]}" "$BIN"
    ;;
  ts)
    cd engines/centralized-exchange/apps/matching-engine
    exec "${PIN[@]}" bun run index.ts
    ;;
  *) echo "usage: $0 rust|ts" >&2; exit 1 ;;
esac
