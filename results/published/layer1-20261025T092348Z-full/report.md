# Layer 1 report: in-memory orderbook latency

Question answered: given a prepared command and an existing orderbook, how long does the in-memory operation take?

Includes matching, book mutation and result construction. Excludes Redis, JSON, network, auth, DB and workload generation.

## Environment

| | |
|---|---|
| Date | 2026-10-25T09:23:48.877Z |
| Host | ip-172-31-10-47 |
| CPU | Intel(R) Xeon(R) Platinum 8488C (4 threads) |
| Memory | 7.6 GB |
| Kernel | linux 7.0.0-1014-aws |
| CPU governor | n/a |
| Turbo disabled | n/a |
| Pinned CPU | none |
| Rust | rustc 1.99.1 (58cf8f9c3 2026-10-13), release (opt-level=3, lto=fat, codegen-units=1) |
| Bun | 1.4.4 |
| Rust engine | `a230af22d3` |
| TS engine | `5e66844a82` |
| Harness | `d6dc2cd80c` |
| Profile | full |
| Timer overhead (median) | rust 22 ns, ts 31 ns |

## Latency per operation

### Book depth: 1,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 200,000 | 1.64 µs | 1.99 µs | 2.91 µs | 13.01 µs | 27.44 µs | 583.4k |
| limit_rest | ts | 200,000 | 74.32 µs | 87.61 µs | 158.97 µs | 428.17 µs | 1.06 ms | 12.7k |
| limit_cross_1 | rust | 200,000 | 1.93 µs | 3.27 µs | 5.08 µs | 14.53 µs | 32.03 µs | 476.7k |
| limit_cross_1 | ts | 200,000 | 66.00 µs | 76.67 µs | 99.82 µs | 162.24 µs | 228.17 µs | 14.7k |
| limit_sweep | rust | 200,000 | 6.99 µs | 8.96 µs | 12.96 µs | 21.58 µs | 139.32 µs | 144.2k |
| limit_sweep | ts | 200,000 | 62.59 µs | 72.99 µs | 96.87 µs | 164.52 µs | 220.69 µs | 15.5k |
| market_sweep | rust | 200,000 | 5.67 µs | 7.99 µs | 11.07 µs | 20.46 µs | 39.71 µs | 171.1k |
| market_sweep | ts | 200,000 | 63.47 µs | 74.03 µs | 98.75 µs | 156.90 µs | 222.73 µs | 15.2k |
| cancel | rust | 200,000 | 269.19 µs | 289.97 µs | 313.29 µs | 325.54 µs | 456.50 µs | 3.7k |
| cancel | ts | 200,000 | 17.88 µs | 20.50 µs | 36.39 µs | 70.71 µs | 151.32 µs | 53.6k |

### Book depth: 10,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 200,000 | 11.30 µs | 12.47 µs | 19.00 µs | 23.31 µs | 152.15 µs | 87.4k |
| limit_rest | ts | 164,000 * | 993.97 µs | 1.07 ms | 1.77 ms | 2.07 ms | 2.56 ms | 977 |
| limit_cross_1 | rust | 200,000 | 9.86 µs | 19.00 µs | 23.66 µs | 32.01 µs | 152.48 µs | 95.6k |
| limit_cross_1 | ts | 171,000 * | 951.86 µs | 1.03 ms | 1.70 ms | 2.00 ms | 2.52 ms | 1.0k |
| limit_sweep | rust | 200,000 | 29.80 µs | 50.13 µs | 62.15 µs | 72.25 µs | 196.69 µs | 33.5k |
| limit_sweep | ts | 188,000 * | 874.67 µs | 994.33 µs | 1.70 ms | 2.06 ms | 2.87 ms | 1.1k |
| market_sweep | rust | 200,000 | 26.11 µs | 42.26 µs | 51.88 µs | 59.25 µs | 177.66 µs | 38.3k |
| market_sweep | ts | 182,000 * | 903.10 µs | 997.17 µs | 1.70 ms | 2.04 ms | 2.84 ms | 1.1k |
| cancel | rust | 50,000 * | 3.02 ms | 3.08 ms | 3.14 ms | 4.54 ms | 5.38 ms | 331 |
| cancel | ts | 200,000 | 436.33 µs | 457.48 µs | 478.51 µs | 647.59 µs | 1.55 ms | 2.3k |

### Book depth: 100,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 200,000 | 110.88 µs | 122.56 µs | 138.80 µs | 216.70 µs | 357.31 µs | 9.0k |
| limit_rest | ts | 5,000 * | 12.01 ms | 13.34 ms | 18.96 ms | 23.38 ms | 25.89 ms | 81 |
| limit_cross_1 | rust | 200,000 | 181.86 µs | 197.54 µs | 220.61 µs | 302.60 µs | 371.64 µs | 5.4k |
| limit_cross_1 | ts | 5,000 * | 11.74 ms | 13.07 ms | 18.54 ms | 23.70 ms | 33.64 ms | 83 |
| limit_sweep | rust | 200,000 | 325.13 µs | 508.18 µs | 582.78 µs | 689.66 µs | 810.08 µs | 3.2k |
| limit_sweep | ts | 5,000 * | 11.67 ms | 12.91 ms | 17.89 ms | 21.52 ms | 28.43 ms | 84 |
| market_sweep | rust | 200,000 | 265.29 µs | 414.71 µs | 475.92 µs | 597.05 µs | 685.36 µs | 3.8k |
| market_sweep | ts | 5,000 * | 11.69 ms | 12.93 ms | 17.76 ms | 20.32 ms | 24.44 ms | 84 |
| cancel | rust | 3,000 * | 86.86 ms | 89.67 ms | 91.65 ms | 93.85 ms | 94.20 ms | 12 |
| cancel | ts | 37,000 * | 3.69 ms | 4.01 ms | 5.60 ms | 6.56 ms | 10.41 ms | 265 |

`*` the per-cell time budget was hit; fewer samples than the profile target were collected.

## TS / Rust ratio (higher means Rust is faster)

| Scenario | Book | p50 | p90 | p99 |
|---|--:|--:|--:|--:|
| limit_rest | 1,000 | 45.2x | 44.1x | 54.6x |
| limit_cross_1 | 1,000 | 34.2x | 23.5x | 19.6x |
| limit_sweep | 1,000 | 8.9x | 8.1x | 7.5x |
| market_sweep | 1,000 | 11.2x | 9.3x | 8.9x |
| cancel | 1,000 | 0.1x | 0.1x | 0.1x |
| limit_rest | 10,000 | 88.0x | 85.6x | 93.1x |
| limit_cross_1 | 10,000 | 96.6x | 54.1x | 72.1x |
| limit_sweep | 10,000 | 29.4x | 19.8x | 27.4x |
| market_sweep | 10,000 | 34.6x | 23.6x | 32.8x |
| cancel | 10,000 | 0.1x | 0.1x | 0.2x |
| limit_rest | 100,000 | 108.4x | 108.9x | 136.6x |
| limit_cross_1 | 100,000 | 64.6x | 66.2x | 84.0x |
| limit_sweep | 100,000 | 35.9x | 25.4x | 30.7x |
| market_sweep | 100,000 | 44.1x | 31.2x | 37.3x |
| cancel | 100,000 | 0.0x | 0.0x | 0.1x |

## Parity check

Both engines must do the same work on the same workload. Status counts, fill counts and total filled quantity must match exactly (hard gate). Notional is `sum(fill.price * fill.filled_quantity)` and checks fill-level quantity semantics from ENGINE_CONTRACT.md §3 (warning).

| Scenario | Book | Status/fills/qty | Fill notional |
|---|--:|:-:|:-:|
| limit_rest | 1,000 | match | match |
| limit_cross_1 | 1,000 | match | differs |
| limit_sweep | 1,000 | match | differs |
| market_sweep | 1,000 | match | differs |
| cancel | 1,000 | match | match |
| limit_rest | 10,000 | match | match |
| limit_cross_1 | 10,000 | match | differs |
| limit_sweep | 10,000 | match | differs |
| market_sweep | 10,000 | match | differs |
| cancel | 10,000 | match | match |
| limit_rest | 100,000 | match | match |
| limit_cross_1 | 100,000 | match | differs |
| limit_sweep | 100,000 | match | differs |
| market_sweep | 100,000 | match | differs |
| cancel | 100,000 | match | match |

## Methodology notes

- Each round builds a fresh seeded book (untimed), prepares all commands (untimed), then times each command individually with a monotonic nanosecond clock. Rust: `Instant`. TS: `Bun.nanoseconds()`.
- Percentiles use nearest-rank over every timed sample. Warm-up rounds are discarded. TS runs `Bun.gc(true)` between seeding and timing; Rust has no GC.
- Workload and scenario definitions: `docs/METHODOLOGY.md`. Both harnesses implement the same deterministic formulas with no randomness.
- Rust result construction mirrors `main.rs` (status, filled, remaining, fills) without serialisation. The TS `createOrder` also builds `settlement` and `risk` side-effect payloads internally (excluded from the contract, but not separable without modifying the engine), so TS numbers include that cost.
- TS `Fill` ids and order ids use `crypto.randomUUID`; Rust uses `Uuid::new_v4`. Both are part of the engine path and are included.
