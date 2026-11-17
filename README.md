# exchange-benchmark

Benchmark of two matching engines on identical workloads:

| Engine | Source (git submodule) |
|---|---|
| Rust | `engines/matching-engine-rust` ([rahuldev7583/matching-engine-rust](https://github.com/rahuldev7583/matching-engine-rust)) |
| TypeScript (Bun) | `engines/centralized-exchange/apps/matching-engine` ([rahuldev7583/centralized-exchange](https://github.com/rahuldev7583/centralized-exchange)) |

## Layers

| Layer | Measures | Status |
|---|---|---|
| **1. Orderbook** | In-memory operation on a prepared book (no Redis, JSON or network). [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | done |
| **2. Engine service** | Same scenarios through the Redis queue, engine and result channel. [docs/LAYER2.md](docs/LAYER2.md) | done |
| 3. Full exchange | Client to result through the backend | planned |

Scenarios: `limit_rest`, `limit_cross_1`, `limit_sweep`, `market_sweep`, `cancel`, at 1k, 10k and 100k resting orders per side.

## Setup

Requires git, Rust (stable, edition 2024), [Bun](https://bun.sh) >= 1.3. Linux recommended.

```bash
git clone --recurse-submodules <this-repo-url>
cd exchange-benchmark
make setup
```

## Layer 1

```bash
make layer1-smoke   # ~10 s sanity check
make layer1-full    # 1k, 10k, 100k books (published numbers)
make layer1-rust    # Rust only
make layer1-ts      # TS only
BENCH_CPU=2 make layer1-full   # pin to a core
```

Output: `results/layer1-<timestamp>-<profile>/` (`report.md`, `summary.csv`, raw JSON, `env.json`). Config: [config/layer1.json](config/layer1.json).

## Layer 2

Runs on one EC2 instance (same region) with Redis in Docker. Run **one engine at a time** and restart it before each run (books must be empty).

```bash
cp .env.example .env && $EDITOR .env     # set REDIS_URL (redis://localhost:6379)
docker run -d --name redis -p 6379:6379 redis:7

make engine-setup-rust                   # or engine-setup-ts
(cd layer2-service && bun install)

make engine-rust                         # terminal 1 (fresh process)
make layer2-full ENGINE=rust             # terminal 2; use layer2-smoke for a quick check
# stop engine, then
make engine-ts
make layer2-full ENGINE=ts

make layer2-report                       # side-by-side comparison with parity gate
make layer2-clean                        # optional: clear leftover settlement/risk queues
```

Profiles: `smoke`, `full` (1k and 10k books), `deep` (adds 100k, slow through the TS engine). Output: `results/layer2-<ts>-<engine>-<profile>/` and `results/layer2-compare-<profile>-<ts>/`. Config: [config/layer2.json](config/layer2.json).

## Conclusions

Latest published results in [results/published/](results/published/). Host: Intel Xeon Platinum 8488C, 4 threads.

### Layer 1: orderbook (`layer1-20261025T105646Z-full`)

- Rust is much faster in memory for everything except `cancel`: p50 about 1.6 µs vs 72 µs (1k book, `limit_rest`), 11 µs vs 973 µs (10k), 111 µs vs 11.9 ms (100k).
- Gap grows with depth: 8 to 44x at 1k, 28 to 95x at 10k, 35 to 107x at 100k (p50).
- TS wins `cancel` (p50 18 µs vs 274 µs at 1k, 383 µs vs 3.1 ms at 10k). Rust cancel scales with book depth, hitting 87 ms at 100k.
- Parity: status, fills and quantity match everywhere. Fill notional differs for the crossing scenarios (known asymmetry, see methodology).

### Layer 2: engine service (`layer2-compare-deep-20261114T130110Z`)

- Redis round trips dominate at small depth. At 1k, both engines sit at about 0.8 to 1.1 ms p50 (transport floor about 0.56 ms) and the ratio is 0.84 to 1.09x.
- Rust pulls ahead as the book grows: about 2x at 10k and 7 to 15x at 100k for `limit_rest`, `limit_cross_1` and `cancel` (1.0 to 1.6 ms vs 16 to 17 ms p50).
- Under open-loop load, both handle 1,600 req/s on a 1k book. At 10k, TS collapses at 800 req/s (achieved 607/s, queue backlog) while Rust holds 800/s and degrades at 1,600/s. At 100k, Rust degrades at 400/s and fails at 800/s; TS fails at 100/s.
- Caveat: the run's parity gate **failed** on `market_sweep` at 100k (TS did 3x the requests and settlement/risk messages, hit its time budget), so 100k `market_sweep` and `limit_sweep` figures are not comparable. All other cells match.

## Repo structure

```
engines/                 pinned submodules (not edited here)
config/                  layer1.json, layer2.json
layer1-orderbook/        Rust and Bun harnesses
layer2-service/          load generator (bun, node-redis)
scripts/                 setup, run, reports, engine start
docs/                    METHODOLOGY, LAYER2, HARDWARE_AND_DEPLOYMENT
results/                 run output; published/ is committed
```

## Notes

- `make update-engines` bumps submodules. Any engine change invalidates previous numbers.
- Compare engines only within the same run setup, and only if the parity check passes (otherwise the script exits with code 2).
- Read "Known asymmetries" in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) before publishing.
