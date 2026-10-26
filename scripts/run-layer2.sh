#!/usr/bin/env bash
# Usage: scripts/run-layer2.sh rust|ts [smoke|full]
# Run on the LOAD GENERATOR host while exactly one engine runs on the engine host
# (against the same REDIS_URL). Optional: L2_RATES=5,10 overrides the rate steps. Writes results/layer2-<ts>-<engine>-<profile>/.
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE="${1:?usage: run-layer2.sh rust|ts [smoke|full]}"
PROFILE="${2:-full}"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${REDIS_URL:?REDIS_URL is not set (put it in .env, see .env.example)}"

RUN_DIR="results/layer2-$(date -u +%Y%m%dT%H%M%SZ)-${ENGINE}-${PROFILE}"
mkdir -p "$RUN_DIR"
bun scripts/collect-env.ts > "$RUN_DIR/env.json"

(cd layer2-service && bun install --silent)
STATUS=0
(cd layer2-service && bun bench.ts --engine "$ENGINE" --profile "$PROFILE" \
    --config ../config/layer2.json --out "../$RUN_DIR" ${L2_RATES:+--rates "$L2_RATES"}) || STATUS=$?

bun scripts/report-layer2.ts "$RUN_DIR" || true
echo "Run dir: $RUN_DIR (bench exit code $STATUS)"
exit "$STATUS"
