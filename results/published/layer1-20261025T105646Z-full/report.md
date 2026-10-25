# Layer 1 report: in-memory orderbook latency

Question answered: given a prepared command and an existing orderbook, how long does the in-memory operation take?

Includes matching, book mutation and result construction. Excludes Redis, JSON, network, auth, DB and workload generation.

## Environment

| | |
|---|---|
| Date | 2026-10-25T10:56:46.273Z |
| Host | ip-172-31-10-47 |
| CPU | Intel(R) Xeon(R) Platinum 8488C (4 threads) |
| Memory | 7.6 GB |
| Kernel | linux 7.0.0-1014-aws |
| CPU governor | n/a |
| Turbo disabled | n/a |
| Pinned CPU | 2 |
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
| limit_rest | rust | 200,000 | 1.62 µs | 1.94 µs | 2.77 µs | 12.78 µs | 29.83 µs | 593.2k |
| limit_rest | ts | 200,000 | 71.78 µs | 84.88 µs | 136.98 µs | 335.01 µs | 3.16 ms | 13.1k |
| limit_cross_1 | rust | 200,000 | 1.95 µs | 3.28 µs | 5.11 µs | 14.46 µs | 30.90 µs | 473.9k |
| limit_cross_1 | ts | 200,000 | 63.21 µs | 73.75 µs | 91.39 µs | 119.48 µs | 3.14 ms | 15.2k |
| limit_sweep | rust | 200,000 | 6.97 µs | 8.95 µs | 13.13 µs | 22.10 µs | 125.61 µs | 144.5k |
| limit_sweep | ts | 200,000 | 60.69 µs | 71.46 µs | 95.56 µs | 120.13 µs | 3.15 ms | 16.0k |
| market_sweep | rust | 200,000 | 5.65 µs | 7.95 µs | 11.15 µs | 20.52 µs | 128.66 µs | 171.6k |
| market_sweep | ts | 200,000 | 61.32 µs | 71.92 µs | 93.42 µs | 123.91 µs | 3.19 ms | 15.7k |
| cancel | rust | 200,000 | 273.89 µs | 294.82 µs | 318.38 µs | 330.58 µs | 540.92 µs | 3.6k |
| cancel | ts | 200,000 | 17.66 µs | 20.30 µs | 31.76 µs | 39.84 µs | 2.86 ms | 54.6k |

### Book depth: 10,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 200,000 | 11.31 µs | 12.48 µs | 19.23 µs | 23.51 µs | 148.88 µs | 87.4k |
| limit_rest | ts | 168,000 * | 973.30 µs | 1.04 ms | 1.58 ms | 1.71 ms | 2.56 ms | 1.0k |
| limit_cross_1 | rust | 200,000 | 9.90 µs | 18.96 µs | 23.50 µs | 32.27 µs | 148.88 µs | 95.4k |
| limit_cross_1 | ts | 174,000 * | 935.13 µs | 1.00 ms | 1.57 ms | 1.71 ms | 4.06 ms | 1.0k |
| limit_sweep | rust | 200,000 | 29.83 µs | 50.20 µs | 62.15 µs | 72.07 µs | 175.71 µs | 33.4k |
| limit_sweep | ts | 194,000 * | 844.61 µs | 951.28 µs | 1.50 ms | 1.65 ms | 2.13 ms | 1.2k |
| market_sweep | rust | 200,000 | 26.11 µs | 42.30 µs | 51.96 µs | 60.06 µs | 166.86 µs | 38.3k |
| market_sweep | ts | 188,000 * | 874.39 µs | 964.03 µs | 1.50 ms | 1.62 ms | 2.35 ms | 1.1k |
| cancel | rust | 48,000 * | 3.09 ms | 3.16 ms | 3.22 ms | 4.67 ms | 5.86 ms | 322 |
| cancel | ts | 200,000 | 382.83 µs | 398.88 µs | 417.93 µs | 805.97 µs | 3.75 ms | 2.6k |

### Book depth: 100,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 200,000 | 111.00 µs | 122.99 µs | 139.06 µs | 215.45 µs | 451.62 µs | 9.0k |
| limit_rest | ts | 5,000 * | 11.89 ms | 13.34 ms | 18.86 ms | 28.19 ms | 34.13 ms | 82 |
| limit_cross_1 | rust | 200,000 | 181.52 µs | 198.00 µs | 220.88 µs | 297.67 µs | 460.29 µs | 5.4k |
| limit_cross_1 | ts | 5,000 * | 11.58 ms | 13.04 ms | 18.47 ms | 24.84 ms | 33.40 ms | 84 |
| limit_sweep | rust | 200,000 | 325.10 µs | 508.40 µs | 582.50 µs | 686.79 µs | 816.47 µs | 3.2k |
| limit_sweep | ts | 5,000 * | 11.52 ms | 13.06 ms | 18.23 ms | 29.71 ms | 41.78 ms | 84 |
| market_sweep | rust | 200,000 | 265.15 µs | 414.58 µs | 475.32 µs | 596.76 µs | 714.33 µs | 3.8k |
| market_sweep | ts | 6,000 * | 11.37 ms | 12.86 ms | 17.61 ms | 28.21 ms | 34.15 ms | 86 |
| cancel | rust | 3,000 * | 87.51 ms | 90.04 ms | 91.59 ms | 93.58 ms | 94.69 ms | 11 |
| cancel | ts | 37,000 * | 3.69 ms | 3.96 ms | 4.61 ms | 7.58 ms | 14.86 ms | 270 |

`*` the per-cell time budget was hit; fewer samples than the profile target were collected.

## TS / Rust ratio (higher means Rust is faster)

| Scenario | Book | p50 | p90 | p99 |
|---|--:|--:|--:|--:|
| limit_rest | 1,000 | 44.3x | 43.8x | 49.4x |
| limit_cross_1 | 1,000 | 32.4x | 22.5x | 17.9x |
| limit_sweep | 1,000 | 8.7x | 8.0x | 7.3x |
| market_sweep | 1,000 | 10.8x | 9.0x | 8.4x |
| cancel | 1,000 | 0.1x | 0.1x | 0.1x |
| limit_rest | 10,000 | 86.0x | 83.7x | 82.2x |
| limit_cross_1 | 10,000 | 94.5x | 53.0x | 66.7x |
| limit_sweep | 10,000 | 28.3x | 19.0x | 24.1x |
| market_sweep | 10,000 | 33.5x | 22.8x | 28.8x |
| cancel | 10,000 | 0.1x | 0.1x | 0.1x |
| limit_rest | 100,000 | 107.1x | 108.5x | 135.6x |
| limit_cross_1 | 100,000 | 63.8x | 65.8x | 83.6x |
| limit_sweep | 100,000 | 35.4x | 25.7x | 31.3x |
| market_sweep | 100,000 | 42.9x | 31.0x | 37.0x |
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
