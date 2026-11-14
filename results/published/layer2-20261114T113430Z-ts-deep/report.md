# Layer 2 report: engine service latency (queue, engine, result channel)

Question answered: how long does an order take to travel through the Redis queue, the engine and the result channel, for the same scenarios as Layer 1?

Every number below is measured on one clock (the load generator), from the intended send time to the moment the matching result is read from `response-queue-{backend_id}`.

## Runs

| Engine | Profile | Status | Engine host | Load generator | Redis | Engine commit |
|---|---|---|---|---|---|---|
| ts | deep | ok | n/a | Intel(R) Xeon(R) Platinum 8488C | n/a | `f89de5a3e9` |

## How latency is separated

| Component | How it is obtained |
|---|---|
| Transport floor | Echo: `LPUSH` then `BRPOP` on a private key through the same Redis database, same connections, no engine. |
| Engine service time (est.) | Closed-loop end-to-end (one request in flight) minus transport floor, per percentile. Includes the engine host's own Redis hops, parse, match and serialise. |
| Queue wait (est.) | Open-loop end-to-end at a rate minus the closed-loop end-to-end of the same book, per percentile. Cross-checked by sampled `LLEN incoming-request`. |
| Sender-side delay | `send lag` (intended time to LPUSH issued), `LPUSH ack` (issued to acknowledged by Redis) and `post-enqueue` (acknowledged to response read) are reported separately so load-generator delay is not mistaken for engine delay. |

Percentile subtraction is an approximation. The raw end-to-end percentiles are the primary result.

## Scenarios over Redis (closed loop, one request in flight)

Same scenarios, book seeding and command formulas as Layer 1 (`docs/METHODOLOGY.md`), but every operation travels `LPUSH incoming-request` → engine → `response-queue`. The book is restored after every round (untimed) so its depth stays constant.

### Book depth: 1,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | ts | 5,000 | 942 µs | 1.25 ms | 1.50 ms | 1.96 ms | 3.80 ms | 1062 | 559 µs | 383 µs |
| limit_cross_1 | ts | 5,000 | 927 µs | 1.22 ms | 1.49 ms | 2.03 ms | 2.40 ms | 1077 | 559 µs | 368 µs |
| limit_sweep | ts | 5,000 | 904 µs | 1.18 ms | 1.71 ms | 2.29 ms | 2.67 ms | 1103 | 559 µs | 346 µs |
| market_sweep | ts | 5,000 | 904 µs | 1.21 ms | 1.75 ms | 2.36 ms | 3.42 ms | 1092 | 559 µs | 346 µs |
| cancel | ts | 5,000 | 1.02 ms | 1.27 ms | 1.47 ms | 1.97 ms | 4.88 ms | 985 | 559 µs | 463 µs |

### Book depth: 10,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | ts | 5,000 | 2.15 ms | 2.39 ms | 3.07 ms | 3.90 ms | 5.68 ms | 466 | 559 µs | 1.60 ms |
| limit_cross_1 | ts | 5,000 | 2.20 ms | 2.43 ms | 2.69 ms | 3.97 ms | 4.65 ms | 457 | 559 µs | 1.64 ms |
| limit_sweep | ts | 5,000 | 2.16 ms | 2.57 ms | 3.12 ms | 4.37 ms | 4.78 ms | 453 | 559 µs | 1.61 ms |
| market_sweep | ts | 5,000 | 2.10 ms | 2.46 ms | 3.03 ms | 4.65 ms | 4.86 ms | 470 | 559 µs | 1.54 ms |
| cancel | ts | 5,000 | 1.75 ms | 2.00 ms | 2.39 ms | 3.69 ms | 6.95 ms | 575 | 559 µs | 1.19 ms |

### Book depth: 100,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | ts | 5,000 | 16.77 ms | 18.42 ms | 23.27 ms | 28.13 ms | 32.52 ms | 59 | 559 µs | 16.22 ms |
| limit_cross_1 | ts | 5,000 | 16.83 ms | 18.79 ms | 23.64 ms | 30.58 ms | 33.14 ms | 58 | 559 µs | 16.28 ms |
| limit_sweep | ts | 600 (budget) | 16.47 ms | 18.23 ms | 19.82 ms | 23.77 ms | 23.77 ms | 60 | 559 µs | 15.91 ms |
| market_sweep | ts | 600 (budget) | 16.59 ms | 18.31 ms | 19.79 ms | 28.69 ms | 28.69 ms | 60 | 559 µs | 16.03 ms |
| cancel | ts | 5,000 | 15.86 ms | 19.23 ms | 23.37 ms | 25.43 ms | 28.08 ms | 62 | 559 µs | 15.30 ms |

## Parity check

Single-engine report: run both engines and use `make layer2-report` for the parity comparison.

## Latency under load (open loop, fixed arrival rate)

A pair stream on a seeded book: a taker crosses the best level (1 fill), then a maker re-adds the consumed quantity. Latency is measured from each request's scheduled send time, so a stalled sender or engine is not hidden (no coordinated omission).

### Book depth: 1,000 resting orders per side

**ts** (closed-loop baseline p50 1.12 ms, p99 1.57 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 2.19 ms | 2.52 ms | 2.74 ms | 4.20 ms | 1.06 ms | 1.09 ms | 1.16 ms | 0 | 1.05 ms | 663 µs | 994 µs | 821 µs | 1.31 ms | 1 |
| 100 | 100 | 0 | 2.02 ms | 2.43 ms | 2.51 ms | 3.42 ms | 895 µs | 1000 µs | 938 µs | 0 | 1.06 ms | 573 µs | 871 µs | 883 µs | 1.17 ms | 1 |
| 200 | 200 | 0 | 1.88 ms | 2.30 ms | 2.40 ms | 5.90 ms | 758 µs | 869 µs | 826 µs | 0 | 1.04 ms | 485 µs | 791 µs | 830 µs | 1.21 ms | 1 |
| 400 | 400 | 0 | 1.67 ms | 2.25 ms | 2.40 ms | 7.19 ms | 546 µs | 819 µs | 826 µs | 0 | 1.05 ms | 302 µs | 654 µs | 845 µs | 1.17 ms | 2 |
| 800 | 800 | 0 | 1.44 ms | 2.13 ms | 2.32 ms | 6.75 ms | 313 µs | 703 µs | 742 µs | 0 | 1.05 ms | 276 µs | 655 µs | 640 µs | 1.14 ms | 5 |
| 1600 | 1600 | 0 | 1.93 ms | 3.66 ms | 5.08 ms | 8.86 ms | 807 µs | 2.23 ms | 3.50 ms | 6 | 1.05 ms | 182 µs | 592 µs | 1.18 ms | 4.33 ms | 13 |

### Book depth: 10,000 resting orders per side

**ts** (closed-loop baseline p50 2.24 ms, p99 3.00 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 3.47 ms | 4.06 ms | 4.47 ms | 9.72 ms | 1.23 ms | 1.58 ms | 1.46 ms | 0 | 1.06 ms | 581 µs | 837 µs | 2.38 ms | 3.22 ms | 1 |
| 100 | 100 | 0 | 2.97 ms | 3.81 ms | 4.07 ms | 6.05 ms | 731 µs | 1.32 ms | 1.07 ms | 0 | 1.07 ms | 570 µs | 851 µs | 2.00 ms | 2.91 ms | 1 |
| 200 | 200 | 0 | 2.92 ms | 3.40 ms | 3.75 ms | 7.97 ms | 678 µs | 921 µs | 746 µs | 0 | 1.05 ms | 363 µs | 678 µs | 1.92 ms | 2.64 ms | 1 |
| 400 | 400 | 0 | 2.60 ms | 3.23 ms | 3.71 ms | 9.35 ms | 364 µs | 751 µs | 706 µs | 0 | 1.05 ms | 298 µs | 688 µs | 1.77 ms | 2.77 ms | 2 |
| 800 | 607 | 0 | 4376.24 ms | 9170.83 ms | 9479.54 ms | 9560.99 ms | 4374.00 ms | 9168.35 ms | 9476.54 ms | 5702 | 1.05 ms | 271 µs | 637 µs | 4375.50 ms | 9479.01 ms | 4 |

Stopped after 800 req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.

### Book depth: 100,000 resting orders per side

**ts** (closed-loop baseline p50 16.67 ms, p99 23.78 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 17.78 ms | 20.35 ms | 24.92 ms | 41.28 ms | 1.12 ms | 417 µs | 1.14 ms | 1 | 1.05 ms | 560 µs | 832 µs | 16.66 ms | 23.94 ms | 1 |
| 100 | 60 | 2 | 9986.55 ms | 19075.97 ms | 19875.75 ms | 20049.16 ms | 9969.88 ms | 19056.04 ms | 19851.98 ms | 1195 | 1.05 ms | 547 µs | 865 µs | 9985.36 ms | 19874.55 ms | 1 |

Stopped after 100 req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.

## Validity checks

| Engine | Anomalies (scenarios) | Anomalies (load idle) | Anomalies (load) | Leftover settlement-queue | Leftover risk queue |
|---|--:|--:|--:|--:|--:|
| ts | 0 | 0 | 0 | 856951 | 856951 |

An anomaly is a response whose status differs from what the identical workload must produce (see `docs/LAYER2.md`). Any anomaly invalidates the comparison.

## Notes

- Both engines consume the same Redis database, same keys and byte-identical requests. Each run uses a unique `BACKEND_ID`, so response queues never collide.
- The engine must be restarted before every run: the preflight aborts unless `incoming-request` is empty and every benchmark book is empty.
- Both engines publish response, settlement and risk messages without blocking the matching path (Rust: writer threads with pipelining; TS: un-awaited `lPush`). Message counts per request are checked in the parity table.
- Settlement/risk payload formats are excluded from the contract (TS human decimals, Rust integer base units).
- Engine CPU is not captured from the load generator; record it on the engine host if needed (`pidstat -p <pid> 1`).
- For order-bias control repeat the pair of runs in alternating engine order (rust, ts, ts, rust).
- Workload definition: `docs/LAYER2.md`.
