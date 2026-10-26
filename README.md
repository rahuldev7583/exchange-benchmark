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
| **2. Engine service** | How long does an order take through the queue, engine and result channel? | implemented ([docs/LAYER2.md](docs/LAYER2.md)) |
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

## Layer 2: engine service (Redis, two hosts)

Two EC2 hosts and one shared Upstash database. Run **one engine at a time**, then repeat for the other.

| Host | Runs |
|---|---|
| Engine EC2 | exactly one engine (`rust` or `ts`) |
| Load-generator EC2 | this benchmark |

**1. Both hosts:** clone, then create `.env` (git-ignored) with the same `REDIS_URL`.

```bash
git clone --recurse-submodules <this-repo-url> && cd exchange-benchmark
cp .env.example .env && $EDITOR .env        # set REDIS_URL (rediss://...)
```

**2. Engine host, one-time setup** (needs Rust for `rust`, Bun for `ts`):

```bash
make engine-setup-rust      # cargo build --release
make engine-setup-ts        # bun install + prisma generate (no database is used)
```

**3. Load-generator host, one-time setup:**

```bash
(cd layer2-service && bun install)
```

**4. Smoke test (about 1 minute per engine).** Start the engine on the engine host, then run the smoke test on the load-generator host:

```bash
# engine host
make engine-rust            # leave running (tmux/screen)
# loadgen host
make layer2-smoke ENGINE=rust
# engine host: Ctrl-C, then
make engine-ts
# loadgen host
make layer2-smoke ENGINE=ts
```

**5. Full run.** Restart the engine first (the book must be empty), then:

```bash
# engine host
make engine-rust            # fresh process
# loadgen host
make layer2-full ENGINE=rust

# engine host: Ctrl-C, start fresh
make engine-ts
# loadgen host
make layer2-full ENGINE=ts

# loadgen host: side-by-side comparison of the latest rust and ts full runs
make layer2-report
make layer2-clean           # optional: delete unconsumed settlement/risk queues in Redis
```

Output: `results/layer2-<ts>-<engine>-<profile>/` (`layer2.json`, `report.md`, `env.json`) and `results/layer2-compare-full-<ts>/report.md` with p50, p95 and p99 end-to-end, idle (service) time, transport floor and queue wait per arrival rate. A run fails (non-zero exit) if the engine answers with an unexpected status or the book is not empty at start.

Optional: `ENGINE_CPU=2 make engine-rust` pins the engine; `ENGINE_HOST_DESC`, `LOADGEN_HOST_DESC` and `REDIS_DESC` in `.env` are recorded in the report. Edit [config/layer2.json](config/layer2.json) to change rates or durations. Check your Upstash plan limits first (see [docs/LAYER2.md](docs/LAYER2.md)).

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
├── layer2-service/                  # layer 2 load generator (bun, node-redis)
├── scripts/                         # setup, run, env collection, reports, engine start
├── docs/
│   ├── METHODOLOGY.md               # layer 1 workload definition, parity gate, caveats
│   ├── LAYER2.md                    # layer 2 topology, workload, latency separation
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
