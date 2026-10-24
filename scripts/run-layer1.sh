#!/usr/bin/env bash
# Usage: scripts/run-layer1.sh [profile] [engines]
#   profile: smoke | default | full   (default: default)
#   engines: both | rust | ts         (default: both)
# Env: BENCH_CPU=<core>  pin each engine process to one core with taskset.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-default}"
ENGINES="${2:-both}"
RUN_DIR="results/layer1-$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}"
mkdir -p "$RUN_DIR"

PIN=()
if [[ -n "${BENCH_CPU:-}" ]]; then PIN=(taskset -c "$BENCH_CPU"); fi

bun scripts/collect-env.ts > "$RUN_DIR/env.json"

# Engines run one after the other, never concurrently.
if [[ "$ENGINES" == "both" || "$ENGINES" == "rust" ]]; then
  (cd layer1-orderbook/rust && cargo build --release --quiet)
  (cd layer1-orderbook/rust && "${PIN[@]}" ./target/release/layer1-rust \
      --config ../../config/layer1.json --profile "$PROFILE" --out "../../$RUN_DIR/rust.json")
fi
if [[ "$ENGINES" == "both" || "$ENGINES" == "ts" ]]; then
  (cd layer1-orderbook/ts && "${PIN[@]}" bun bench.ts \
      --config ../../config/layer1.json --profile "$PROFILE" --out "../../$RUN_DIR/ts.json")
fi

ln -sfn "$(basename "$RUN_DIR")" results/latest
bun scripts/report.ts "$RUN_DIR" || echo "report generated with parity failure (exit $?)" >&2
echo "Report: $RUN_DIR/report.md"
