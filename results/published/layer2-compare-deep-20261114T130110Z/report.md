# Layer 2 report: engine service latency (queue, engine, result channel)

Question answered: how long does an order take to travel through the Redis queue, the engine and the result channel, for the same scenarios as Layer 1?

Every number below is measured on one clock (the load generator), from the intended send time to the moment the matching result is read from `response-queue-{backend_id}`.

## Runs

| Engine | Profile | Status | Engine host | Load generator | Redis | Engine commit |
|---|---|---|---|---|---|---|
| rust | deep | ok | n/a | Intel(R) Xeon(R) Platinum 8488C | n/a | `e7ff6b57a2` |
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
| limit_rest | rust | 5,000 | 1.12 ms | 1.44 ms | 1.67 ms | 2.05 ms | 2.48 ms | 907 | 580 µs | 536 µs |
| limit_rest | ts | 5,000 | 942 µs | 1.25 ms | 1.50 ms | 1.96 ms | 3.80 ms | 1062 | 559 µs | 383 µs |
| limit_cross_1 | rust | 5,000 | 1.03 ms | 1.37 ms | 1.62 ms | 1.89 ms | 2.36 ms | 976 | 580 µs | 450 µs |
| limit_cross_1 | ts | 5,000 | 927 µs | 1.22 ms | 1.49 ms | 2.03 ms | 2.40 ms | 1077 | 559 µs | 368 µs |
| limit_sweep | rust | 5,000 | 830 µs | 1.20 ms | 1.75 ms | 2.21 ms | 2.55 ms | 1181 | 580 µs | 250 µs |
| limit_sweep | ts | 5,000 | 904 µs | 1.18 ms | 1.71 ms | 2.29 ms | 2.67 ms | 1103 | 559 µs | 346 µs |
| market_sweep | rust | 5,000 | 841 µs | 1.20 ms | 1.58 ms | 2.08 ms | 2.50 ms | 1172 | 580 µs | 261 µs |
| market_sweep | ts | 5,000 | 904 µs | 1.21 ms | 1.75 ms | 2.36 ms | 3.42 ms | 1092 | 559 µs | 346 µs |
| cancel | rust | 5,000 | 1.09 ms | 1.44 ms | 1.67 ms | 1.87 ms | 2.53 ms | 919 | 580 µs | 515 µs |
| cancel | ts | 5,000 | 1.02 ms | 1.27 ms | 1.47 ms | 1.97 ms | 4.88 ms | 985 | 559 µs | 463 µs |

### Book depth: 10,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 5,000 | 1.09 ms | 1.43 ms | 1.63 ms | 1.85 ms | 2.36 ms | 921 | 580 µs | 515 µs |
| limit_rest | ts | 5,000 | 2.15 ms | 2.39 ms | 3.07 ms | 3.90 ms | 5.68 ms | 466 | 559 µs | 1.60 ms |
| limit_cross_1 | rust | 5,000 | 1.32 ms | 1.57 ms | 1.80 ms | 2.03 ms | 2.55 ms | 775 | 580 µs | 740 µs |
| limit_cross_1 | ts | 5,000 | 2.20 ms | 2.43 ms | 2.69 ms | 3.97 ms | 4.65 ms | 457 | 559 µs | 1.64 ms |
| limit_sweep | rust | 5,000 | 953 µs | 2.23 ms | 3.46 ms | 3.95 ms | 4.16 ms | 861 | 580 µs | 374 µs |
| limit_sweep | ts | 5,000 | 2.16 ms | 2.57 ms | 3.12 ms | 4.37 ms | 4.78 ms | 453 | 559 µs | 1.61 ms |
| market_sweep | rust | 5,000 | 1.07 ms | 2.07 ms | 2.78 ms | 3.34 ms | 3.82 ms | 829 | 580 µs | 486 µs |
| market_sweep | ts | 5,000 | 2.10 ms | 2.46 ms | 3.03 ms | 4.65 ms | 4.86 ms | 470 | 559 µs | 1.54 ms |
| cancel | rust | 5,000 | 933 µs | 1.29 ms | 1.56 ms | 1.91 ms | 4.05 ms | 1074 | 580 µs | 353 µs |
| cancel | ts | 5,000 | 1.75 ms | 2.00 ms | 2.39 ms | 3.69 ms | 6.95 ms | 575 | 559 µs | 1.19 ms |

### Book depth: 100,000 resting orders per side

| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| limit_rest | rust | 5,000 | 1.61 ms | 1.88 ms | 2.13 ms | 2.73 ms | 3.19 ms | 627 | 580 µs | 1.03 ms |
| limit_rest | ts | 5,000 | 16.77 ms | 18.42 ms | 23.27 ms | 28.13 ms | 32.52 ms | 59 | 559 µs | 16.22 ms |
| limit_cross_1 | rust | 5,000 | 2.31 ms | 2.72 ms | 2.92 ms | 6.26 ms | 10.55 ms | 438 | 580 µs | 1.73 ms |
| limit_cross_1 | ts | 5,000 | 16.83 ms | 18.79 ms | 23.64 ms | 30.58 ms | 33.14 ms | 58 | 559 µs | 16.28 ms |
| limit_sweep | rust | 5,000 | 6.91 ms | 13.29 ms | 14.85 ms | 15.55 ms | 17.02 ms | 131 | 580 µs | 6.33 ms |
| limit_sweep | ts | 600 (budget) | 16.47 ms | 18.23 ms | 19.82 ms | 23.77 ms | 23.77 ms | 60 | 559 µs | 15.91 ms |
| market_sweep | rust | 5,000 | 6.21 ms | 9.81 ms | 10.64 ms | 11.09 ms | 11.74 ms | 160 | 580 µs | 5.63 ms |
| market_sweep | ts | 600 (budget) | 16.59 ms | 18.31 ms | 19.79 ms | 28.69 ms | 28.69 ms | 60 | 559 µs | 16.03 ms |
| cancel | rust | 5,000 | 1.04 ms | 1.39 ms | 1.63 ms | 2.12 ms | 2.78 ms | 964 | 580 µs | 461 µs |
| cancel | ts | 5,000 | 15.86 ms | 19.23 ms | 23.37 ms | 25.43 ms | 28.08 ms | 62 | 559 µs | 15.30 ms |

### TS / Rust ratio (above 1 means Rust is faster end to end)

| Scenario | Book | p50 | p90 | p99 |
|---|--:|--:|--:|--:|
| limit_rest | 1,000 | 0.84x | 0.87x | 0.90x |
| limit_cross_1 | 1,000 | 0.90x | 0.89x | 0.92x |
| limit_sweep | 1,000 | 1.09x | 0.99x | 0.98x |
| market_sweep | 1,000 | 1.08x | 1.01x | 1.11x |
| cancel | 1,000 | 0.93x | 0.88x | 0.88x |
| limit_rest | 10,000 | 1.97x | 1.67x | 1.88x |
| limit_cross_1 | 10,000 | 1.67x | 1.54x | 1.49x |
| limit_sweep | 10,000 | 2.27x | 1.15x | 0.90x |
| market_sweep | 10,000 | 1.97x | 1.19x | 1.09x |
| cancel | 10,000 | 1.87x | 1.55x | 1.53x |
| limit_rest | 100,000 | 10.45x | 9.79x | 10.91x |
| limit_cross_1 | 100,000 | 7.29x | 6.91x | 8.09x |
| limit_sweep | 100,000 | 2.38x | 1.37x | 1.33x |
| market_sweep | 100,000 | 2.67x | 1.87x | 1.86x |
| cancel | 100,000 | 15.24x | 13.87x | 14.34x |

Over Redis the in-memory difference from Layer 1 is mostly hidden behind network round trips. Ratios close to 1 mean the Redis path dominates; they are not a contradiction of Layer 1.

## Parity check

Both engines must do the same work on the same workload, including the same Redis side effects. Status counts, fill count, filled quantity and notional come from the first timed round; side-effect messages are the `settlement-queue` / `matching-to-risk-pub-queue` entries each engine wrote during that round (round trips are not compared, message counts are).

| Scenario | Book | Status/fills/qty | Notional | Settlement msgs (rust / ts) | Risk msgs (rust / ts) | Requests (rust / ts) |
|---|--:|:-:|:-:|:-:|:-:|:-:|
| limit_rest | 1,000 | match | match | 200 / 200  | 200 / 200  | 200 / 200  |
| limit_cross_1 | 1,000 | match | match | 200 / 200  | 200 / 200  | 200 / 200  |
| limit_sweep | 1,000 | match | match | 1180 / 1180  | 1180 / 1180  | 690 / 690  |
| market_sweep | 1,000 | match | match | 920 / 920  | 920 / 920  | 560 / 560  |
| cancel | 1,000 | match | match | 200 / 200  | 200 / 200  | 200 / 200  |
| limit_rest | 10,000 | match | match | 400 / 400  | 400 / 400  | 400 / 400  |
| limit_cross_1 | 10,000 | match | match | 400 / 400  | 400 / 400  | 400 / 400  |
| limit_sweep | 10,000 | match | match | 3712 / 3712  | 3712 / 3712  | 2056 / 2056  |
| market_sweep | 10,000 | match | match | 3212 / 3212  | 3212 / 3212  | 1806 / 1806  |
| cancel | 10,000 | match | match | 400 / 400  | 400 / 400  | 400 / 400  |
| limit_rest | 100,000 | match | match | 400 / 400  | 400 / 400  | 400 / 400  |
| limit_cross_1 | 100,000 | match | match | 400 / 400  | 400 / 400  | 400 / 400  |
| limit_sweep | 100,000 | match | match | 5600 / 5600  | 5600 / 5600  | 3000 / 3000  |
| market_sweep | 100,000 | **MISMATCH** | match | 1600 / 4800 **MISMATCH** | 1600 / 4800 **MISMATCH** | 1000 / 2600 **MISMATCH** |
| cancel | 100,000 | match | match | 400 / 400  | 400 / 400  | 400 / 400  |

**Parity FAILED: the engines did different work. Do not compare these runs.**

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

**ts** (closed-loop baseline p50 1.12 ms, p99 1.57 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 2.19 ms | 2.52 ms | 2.74 ms | 4.20 ms | 1.06 ms | 1.09 ms | 1.16 ms | 0 | 1.05 ms | 663 µs | 994 µs | 821 µs | 1.31 ms | 1 |
| 100 | 100 | 0 | 2.02 ms | 2.43 ms | 2.51 ms | 3.42 ms | 895 µs | 1000 µs | 938 µs | 0 | 1.06 ms | 573 µs | 871 µs | 883 µs | 1.17 ms | 1 |
| 200 | 200 | 0 | 1.88 ms | 2.30 ms | 2.40 ms | 5.90 ms | 758 µs | 869 µs | 826 µs | 0 | 1.04 ms | 485 µs | 791 µs | 830 µs | 1.21 ms | 1 |
| 400 | 400 | 0 | 1.67 ms | 2.25 ms | 2.40 ms | 7.19 ms | 546 µs | 819 µs | 826 µs | 0 | 1.05 ms | 302 µs | 654 µs | 845 µs | 1.17 ms | 2 |
| 800 | 800 | 0 | 1.44 ms | 2.13 ms | 2.32 ms | 6.75 ms | 313 µs | 703 µs | 742 µs | 0 | 1.05 ms | 276 µs | 655 µs | 640 µs | 1.14 ms | 5 |
| 1600 | 1600 | 0 | 1.93 ms | 3.66 ms | 5.08 ms | 8.86 ms | 807 µs | 2.23 ms | 3.50 ms | 6 | 1.05 ms | 182 µs | 592 µs | 1.18 ms | 4.33 ms | 13 |

Side by side (end-to-end, all requests)

| Offered/s | rust p50 | rust p95 | rust p99 | ts p50 | ts p95 | ts p99 | rust achieved/s | ts achieved/s |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 2.00 ms | 2.50 ms | 2.61 ms | 2.19 ms | 2.52 ms | 2.74 ms | 50 | 50 |
| 100 | 1.75 ms | 2.38 ms | 2.52 ms | 2.02 ms | 2.43 ms | 2.51 ms | 100 | 100 |
| 200 | 1.83 ms | 2.22 ms | 2.46 ms | 1.88 ms | 2.30 ms | 2.40 ms | 200 | 200 |
| 400 | 1.54 ms | 2.11 ms | 2.31 ms | 1.67 ms | 2.25 ms | 2.40 ms | 400 | 400 |
| 800 | 1.37 ms | 2.05 ms | 2.23 ms | 1.44 ms | 2.13 ms | 2.32 ms | 800 | 800 |
| 1600 | 1.59 ms | 2.28 ms | 2.66 ms | 1.93 ms | 3.66 ms | 5.08 ms | 1600 | 1600 |

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

**ts** (closed-loop baseline p50 2.24 ms, p99 3.00 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 3.47 ms | 4.06 ms | 4.47 ms | 9.72 ms | 1.23 ms | 1.58 ms | 1.46 ms | 0 | 1.06 ms | 581 µs | 837 µs | 2.38 ms | 3.22 ms | 1 |
| 100 | 100 | 0 | 2.97 ms | 3.81 ms | 4.07 ms | 6.05 ms | 731 µs | 1.32 ms | 1.07 ms | 0 | 1.07 ms | 570 µs | 851 µs | 2.00 ms | 2.91 ms | 1 |
| 200 | 200 | 0 | 2.92 ms | 3.40 ms | 3.75 ms | 7.97 ms | 678 µs | 921 µs | 746 µs | 0 | 1.05 ms | 363 µs | 678 µs | 1.92 ms | 2.64 ms | 1 |
| 400 | 400 | 0 | 2.60 ms | 3.23 ms | 3.71 ms | 9.35 ms | 364 µs | 751 µs | 706 µs | 0 | 1.05 ms | 298 µs | 688 µs | 1.77 ms | 2.77 ms | 2 |
| 800 | 607 | 0 | 4376.24 ms | 9170.83 ms | 9479.54 ms | 9560.99 ms | 4374.00 ms | 9168.35 ms | 9476.54 ms | 5702 | 1.05 ms | 271 µs | 637 µs | 4375.50 ms | 9479.01 ms | 4 |

Stopped after 800 req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.

Side by side (end-to-end, all requests)

| Offered/s | rust p50 | rust p95 | rust p99 | ts p50 | ts p95 | ts p99 | rust achieved/s | ts achieved/s |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 2.32 ms | 3.05 ms | 3.16 ms | 3.47 ms | 4.06 ms | 4.47 ms | 50 | 50 |
| 100 | 2.24 ms | 2.90 ms | 3.05 ms | 2.97 ms | 3.81 ms | 4.07 ms | 100 | 100 |
| 200 | 1.95 ms | 2.65 ms | 2.76 ms | 2.92 ms | 3.40 ms | 3.75 ms | 200 | 200 |
| 400 | 1.87 ms | 2.44 ms | 2.59 ms | 2.60 ms | 3.23 ms | 3.71 ms | 400 | 400 |
| 800 | 1.66 ms | 2.37 ms | 2.55 ms | 4376.24 ms | 9170.83 ms | 9479.54 ms | 800 | 607 |

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

**ts** (closed-loop baseline p50 16.67 ms, p99 23.78 ms)

| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 50 | 0 | 17.78 ms | 20.35 ms | 24.92 ms | 41.28 ms | 1.12 ms | 417 µs | 1.14 ms | 1 | 1.05 ms | 560 µs | 832 µs | 16.66 ms | 23.94 ms | 1 |
| 100 | 60 | 2 | 9986.55 ms | 19075.97 ms | 19875.75 ms | 20049.16 ms | 9969.88 ms | 19056.04 ms | 19851.98 ms | 1195 | 1.05 ms | 547 µs | 865 µs | 9985.36 ms | 19874.55 ms | 1 |

Stopped after 100 req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.

Side by side (end-to-end, all requests)

| Offered/s | rust p50 | rust p95 | rust p99 | ts p50 | ts p95 | ts p99 | rust achieved/s | ts achieved/s |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 50 | 4.08 ms | 4.93 ms | 5.19 ms | 17.78 ms | 20.35 ms | 24.92 ms | 50 | 50 |
| 100 | 3.43 ms | 4.36 ms | 4.60 ms | 9986.55 ms | 19075.97 ms | 19875.75 ms | 100 | 60 |

## Validity checks

| Engine | Anomalies (scenarios) | Anomalies (load idle) | Anomalies (load) | Leftover settlement-queue | Leftover risk queue |
|---|--:|--:|--:|--:|--:|
| rust | 0 | 0 | 0 | 1228110 | 1228110 |
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
