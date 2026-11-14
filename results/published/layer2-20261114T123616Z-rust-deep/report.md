# Layer 2 report: engine service latency (queue, engine, result channel)

Question answered: how long does an order take to travel through the Redis queue, the engine and the result channel, for the same scenarios as Layer 1?

Every number below is measured on one clock (the load generator), from the intended send time to the moment the matching result is read from `response-queue-{backend_id}`.

## Runs

| Engine | Profile | Status | Engine host | Load generator | Redis | Engine commit |
|---|---|---|---|---|---|---|
| rust | deep | ok | n/a | Intel(R) Xeon(R) Platinum 8488C | n/a | `e7ff6b57a2` |

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
| limit_rest | rust | 5,000 | 1.12 ms | 1.44 ms | 1.67 ms | 2.05 ms | 2.48 ms | 907 | 580 µs | 536 µs |
| limit_cross_1 | rust | 5,000 | 1.03 ms | 1.37 ms | 1.62 ms | 1.89 ms | 2.36 ms | 976 | 580 µs | 450 µs |
| limit_sweep | rust | 5,000 | 830 µs | 1.20 ms | 1.75 ms | 2.21 ms | 2.55 ms | 1181 | 580 µs | 250 µs |
| market_sweep | rust | 5,000 | 841 µs | 1.20 ms | 1.58 ms | 2.08 ms | 2.50 ms | 1172 | 580 µs | 261 µs |
| cancel | rust | 5,000 | 1.09 ms | 1.44 ms | 1.67 ms | 1.87 ms | 2.53 ms | 919 | 580 µs | 515 µs |

### Book depth: 10,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 5,000 | 1.09 ms | 1.43 ms | 1.63 ms | 1.85 ms | 2.36 ms | 921 | 580 µs | 515 µs |
| limit_cross_1 | rust | 5,000 | 1.32 ms | 1.57 ms | 1.80 ms | 2.03 ms | 2.55 ms | 775 | 580 µs | 740 µs |
| limit_sweep | rust | 5,000 | 953 µs | 2.23 ms | 3.46 ms | 3.95 ms | 4.16 ms | 861 | 580 µs | 374 µs |
| market_sweep | rust | 5,000 | 1.07 ms | 2.07 ms | 2.78 ms | 3.34 ms | 3.82 ms | 829 | 580 µs | 486 µs |
| cancel | rust | 5,000 | 933 µs | 1.29 ms | 1.56 ms | 1.91 ms | 4.05 ms | 1074 | 580 µs | 353 µs |

### Book depth: 100,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 5,000 | 1.61 ms | 1.88 ms | 2.13 ms | 2.73 ms | 3.19 ms | 627 | 580 µs | 1.03 ms |
| limit_cross_1 | rust | 5,000 | 2.31 ms | 2.72 ms | 2.92 ms | 6.26 ms | 10.55 ms | 438 | 580 µs | 1.73 ms |
| limit_sweep | rust | 5,000 | 6.91 ms | 13.29 ms | 14.85 ms | 15.55 ms | 17.02 ms | 131 | 580 µs | 6.33 ms |
| market_sweep | rust | 5,000 | 6.21 ms | 9.81 ms | 10.64 ms | 11.09 ms | 11.74 ms | 160 | 580 µs | 5.63 ms |
| cancel | rust | 5,000 | 1.04 ms | 1.39 ms | 1.63 ms | 2.12 ms | 2.78 ms | 964 | 580 µs | 461 µs |

## Parity check

Single-engine report: run both engines and use `make layer2-report` for the parity comparison.

## Latency under load (open loop, fixed arrival rate)

A pair stream on a seeded book: a taker crosses the best level (1 fill), then a maker re-adds the consumed quantity. Latency is measured from each request's scheduled send time, so a stalled sender or engine is not hidden (no coordinated omission).

### Book depth: 1,000 resting orders per side

**rust** (closed-loop baseline p50 1.20 ms, p99 1.67 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 2.00 ms | 2.50 ms | 2.61 ms | 3.17 ms | 802 µs | 940 µs | 947 µs | 0 | 1.06 ms | 574 µs | 772 µs | 882 µs | 1.25 ms | 1 |
| 100 | 100 | 0 | 1.75 ms | 2.38 ms | 2.52 ms | 4.70 ms | 545 µs | 815 µs | 857 µs | 0 | 1.06 ms | 601 µs | 793 µs | 676 µs | 1.10 ms | 1 |
| 200 | 200 | 0 | 1.83 ms | 2.22 ms | 2.46 ms | 3.94 ms | 624 µs | 657 µs | 796 µs | 0 | 1.05 ms | 472 µs | 717 µs | 745 µs | 1.20 ms | 1 |
| 400 | 400 | 0 | 1.54 ms | 2.11 ms | 2.31 ms | 5.75 ms | 341 µs | 552 µs | 644 µs | 0 | 1.05 ms | 317 µs | 601 µs | 709 µs | 1.12 ms | 2 |
| 800 | 800 | 0 | 1.37 ms | 2.05 ms | 2.23 ms | 9.09 ms | 173 µs | 486 µs | 561 µs | 0 | 1.05 ms | 267 µs | 593 µs | 607 µs | 1.08 ms | 7 |
| 1600 | 1600 | 0 | 1.59 ms | 2.28 ms | 2.66 ms | 10.50 ms | 390 µs | 722 µs | 999 µs | 2 | 1.05 ms | 247 µs | 605 µs | 736 µs | 2.02 ms | 15 |

### Book depth: 10,000 resting orders per side

**rust** (closed-loop baseline p50 1.34 ms, p99 1.77 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 2.32 ms | 3.05 ms | 3.16 ms | 4.35 ms | 975 µs | 1.41 ms | 1.39 ms | 0 | 1.08 ms | 649 µs | 943 µs | 1.23 ms | 1.67 ms | 1 |
| 100 | 100 | 0 | 2.24 ms | 2.90 ms | 3.05 ms | 3.84 ms | 900 µs | 1.27 ms | 1.28 ms | 0 | 1.07 ms | 518 µs | 746 µs | 1.20 ms | 1.58 ms | 1 |
| 200 | 200 | 0 | 1.95 ms | 2.65 ms | 2.76 ms | 7.15 ms | 603 µs | 1.01 ms | 993 µs | 0 | 1.06 ms | 500 µs | 775 µs | 965 µs | 1.43 ms | 1 |
| 400 | 400 | 0 | 1.87 ms | 2.44 ms | 2.59 ms | 6.88 ms | 524 µs | 808 µs | 826 µs | 0 | 1.05 ms | 302 µs | 609 µs | 1.05 ms | 1.46 ms | 2 |
| 800 | 800 | 0 | 1.66 ms | 2.37 ms | 2.55 ms | 7.44 ms | 319 µs | 738 µs | 777 µs | 1 | 1.05 ms | 259 µs | 578 µs | 891 µs | 1.44 ms | 5 |
| 1600 | 1600 | 0 | 3.73 ms | 25.46 ms | 32.31 ms | 38.60 ms | 2.38 ms | 23.83 ms | 30.54 ms | 49 | 1.05 ms | 201 µs | 556 µs | 2.98 ms | 31.59 ms | 6 |

### Book depth: 100,000 resting orders per side

**rust** (closed-loop baseline p50 2.39 ms, p99 3.03 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 4.08 ms | 4.93 ms | 5.19 ms | 12.01 ms | 1.69 ms | 2.07 ms | 2.16 ms | 0 | 1.06 ms | 596 µs | 843 µs | 2.92 ms | 3.78 ms | 1 |
| 100 | 100 | 0 | 3.43 ms | 4.36 ms | 4.60 ms | 5.46 ms | 1.05 ms | 1.50 ms | 1.57 ms | 0 | 1.06 ms | 520 µs | 766 µs | 2.41 ms | 3.36 ms | 1 |
| 200 | 200 | 0 | 3.47 ms | 4.42 ms | 4.68 ms | 8.44 ms | 1.08 ms | 1.56 ms | 1.65 ms | 0 | 1.06 ms | 443 µs | 718 µs | 2.49 ms | 3.44 ms | 1 |
| 400 | 399 | 0 | 10.43 ms | 74.60 ms | 79.97 ms | 85.22 ms | 8.04 ms | 71.74 ms | 76.93 ms | 32 | 1.05 ms | 394 µs | 652 µs | 9.46 ms | 79.31 ms | 2 |
| 800 | 398 | 4000 | 12462.91 ms | 23951.53 ms | 24989.25 ms | 25247.67 ms | 12460.52 ms | 23948.66 ms | 24986.22 ms | 11948 | 1.05 ms | 311 µs | 623 µs | 12461.97 ms | 24988.05 ms | 5 |

Stopped after 800 req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.

## Validity checks

| Engine | Anomalies (scenarios) | Anomalies (load idle) | Anomalies (load) | Leftover settlement-queue | Leftover risk queue |
|---|--:|--:|--:|--:|--:|
| rust | 0 | 0 | 0 | 1228110 | 1228110 |

An anomaly is a response whose status differs from what the identical workload must produce (see `docs/LAYER2.md`). Any anomaly invalidates the comparison.

## Notes

- Both engines consume the same Redis database, same keys and byte-identical requests. Each run uses a unique `BACKEND_ID`, so response queues never collide.
- The engine must be restarted before every run: the preflight aborts unless `incoming-request` is empty and every benchmark book is empty.
- Both engines publish response, settlement and risk messages without blocking the matching path (Rust: writer threads with pipelining; TS: un-awaited `lPush`). Message counts per request are checked in the parity table.
- Settlement/risk payload formats are excluded from the contract (TS human decimals, Rust integer base units).
- Engine CPU is not captured from the load generator; record it on the engine host if needed (`pidstat -p <pid> 1`).
- For order-bias control repeat the pair of runs in alternating engine order (rust, ts, ts, rust).
- Workload definition: `docs/LAYER2.md`.
