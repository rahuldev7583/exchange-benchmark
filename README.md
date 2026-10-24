# exchange-benchmark

Benchmark of two matching engines on identical workloads:

| Engine | Source (git submodule) |
|---|---|
| Rust | `engines/matching-engine-rust` ([rahuldev7583/matching-engine-rust](https://github.com/rahuldev7583/matching-engine-rust)) |
| TypeScript (Bun) | `engines/centralized-exchange/apps/matching-engine` ([rahuldev7583/centralized-exchange](https://github.com/rahuldev7583/centralized-exchange)) |

## Layers

| Layer | Question | Status |
|---|---|---|
| **1. Orderbook** | Given a prepared command and an existing orderbook, how long does the in-memory operation take? | implemented |
| 2. Engine service | How long does an order take through the queue, engine and result channel? | planned |
| 3. Full exchange | How long until a client receives the matching result through the backend? | planned |

Layer 1 includes matching, book mutation and result construction. It excludes Redis, JSON parsing, networking, authentication, database work and workload generation. It reports p50, p90, p99, p99.9, max and throughput per scenario and book depth. Details: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Prerequisites

- git, Rust (stable, edition 2024 support), [Bun](https://bun.sh) >= 1.3
- Linux recommended (`taskset` for CPU pinning)

## Setup

```bash
git clone --recurse-submodules <this-repo-url>
cd exchange-benchmark
make setup          # inits submodules, builds the Rust harness (release)
```

## Run

```bash
make layer1-smoke   # about 10 s, 1k book, sanity check and parity
make layer1         # default profile: 1k and 10k books, about 10 to 15 min
make layer1-full    # 1k, 10k, 100k books, for published numbers
make layer1-rust    # Rust only
make layer1-ts      # TS only

BENCH_CPU=2 make layer1-full     # pin each engine process to core 2
```

Each run writes `results/layer1-<timestamp>-<profile>/` with:

| File | Content |
|---|---|
| `report.md` | Environment, latency tables, TS/Rust ratios, parity check |
| `summary.csv` | One row per engine, scenario and book size |
| `rust.json`, `ts.json` | Raw per-cell results |
| `env.json` | CPU, kernel, toolchains, engine commits |

`results/latest` links to the last run. Regenerate a report with `make report`. Copy runs you want to keep into `results/published/` (the rest of `results/` is git-ignored).

## Scenarios

`limit_rest`, `limit_cross_1`, `limit_sweep`, `market_sweep`, `cancel`, each at 1k, 10k and 100k resting orders per side. Edit [config/layer1.json](config/layer1.json) to change profiles, sample counts or book sizes. Both harnesses read the same file.

## Repo structure

```
exchange-benchmark/
├── engines/                         # pinned submodules (never edited here)
│   ├── centralized-exchange/        # turborepo; apps/matching-engine/engine.ts is benchmarked
│   └── matching-engine-rust/
├── config/layer1.json               # shared workload parameters and profiles
├── layer1-orderbook/
│   ├── rust/                        # Cargo harness, path-depends on the Rust engine
│   └── ts/bench.ts                  # Bun harness, imports engine.ts directly
├── scripts/                         # setup, run, env collection, report
├── docs/
│   ├── METHODOLOGY.md               # exact workload definition, parity gate, caveats
│   └── HARDWARE_AND_DEPLOYMENT.md   # instance specs, tuning, run discipline, layers 2 and 3
└── results/                         # run output; published/ is committed
```

## Updating an engine

```bash
make update-engines                  # or: git -C engines/<name> checkout <sha>
git add engines && git commit -m "bump engines"
```

Any engine change invalidates previous numbers. Run again.

## Reading results correctly

- The parity check must pass. Otherwise the two engines did different work (the script exits with code 2).
- Compare engines only within the same run, on the same machine.
- Read the "Known asymmetries" section of the methodology doc before publishing.
- Numbers from the shared dev VM are for sanity checks only. See the hardware doc for the publication setup.
