#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
git submodule update --init --recursive
for tool in cargo bun; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
(cd layer1-orderbook/rust && cargo build --release)
echo "Setup complete. Run: make layer1"
