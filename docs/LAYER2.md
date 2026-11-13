# Layer 2: engine service benchmark

**Question:** how long does an order take to travel through the Redis queue, the engine and the result channel, for the same scenarios as Layer 1?

The engines are black boxes. The load generator speaks the engine's own Redis protocol (ENGINE_CONTRACT §4). The engines under `engines/` are not instrumented.

## Topology

```
 loadgen EC2                       Upstash (one database)                     engine EC2
 ┌──────────────┐  LPUSH incoming-request  ┌─────────┐  BRPOP (3 queues)  ┌────────────────┐
 │ layer2 bench │ ───────────────────────► │  Redis  │ ◄───────────────── │ rust OR ts     │
 │ (bun)        │ ◄─────────────────────── │         │ ───────────────►   │ engine         │
 └──────────────┘  RPOP/BRPOP              └─────────┘  LPUSH response-   └────────────────┘
                   response-queue-{id}                   queue-{backend},
                                                         settlement-queue,
                                                         matching-to-risk-pub-queue
```

Run **one engine at a time**. Both consume `incoming-request`; running both would split the traffic. Use the same Upstash database, the same region and the same instance types for every run.

## Equivalent engine behaviour (what makes the comparison valid)

Both engines implement the same Redis behaviour (ENGINE_CONTRACT §4):

| Aspect | Rust | TypeScript |
|---|---|---|
| Input | `BRPOP liquidation-to-matching-eng incoming-request risk-to-matching-eng 0` | same, timeout 0 |
| Publishing | Never blocks the matcher: one writer thread per connection (response, settlement, risk), each draining its channel into a pipeline | Never blocks the matcher: three clients, un-awaited `lPush` (node-redis auto-pipelines) |
| Messages per `create-order` | 1 response, plus `settlement` + `risk` per fill, plus `settlement` + `risk` if the remainder rests | identical |
| Messages per `cancel-order` | 1 response, plus `settlement` + `risk` when cancelled | identical |
| `get-order`, `get-depth` | 1 response | identical |
| `cancel-order` / `get-order` payload | bare order id string (also accepts `{symbol, order_id}`) | bare order id string |
| Unknown command / market | ignored / `rejected` response, no panic | same |

The parity table in every comparison report checks this empirically: statuses, fills, filled quantity, notional **and the number of settlement and risk messages written** must be identical per scenario, or the report exits with code 2. Message *formats* on the settlement and risk queues are excluded (TS human decimals, Rust integer base units).

## Fairness rules

| Rule | How it is enforced |
|---|---|
| Same database | One `REDIS_URL` in `.env` on both hosts |
| Persistent connections | Harness opens 3 connections once (sender, receiver, control) and reuses them. Engines keep their own long-lived connections. |
| Identical commands | Both engines receive the byte-identical JSON on `incoming-request`. The harness only uses `LPUSH`, `RPOP count`, `BRPOP`, `LLEN`, `PING`. |
| Identical workload | Deterministic, no randomness, same order of requests |
| Identical start state | Preflight aborts unless the queue is empty and every benchmark book is empty. Restart the engine before every run. |
| Logging off | `VERBOSE_LOGGING=false` set by `start-engine.sh` (ENGINE_CONTRACT §6) |
| No response collisions | Unique `BACKEND_ID` per run, so `response-queue-bench-<run>` is private |
| One clock | Send and receive are timestamped on the load generator, so there is no cross-host clock skew |
| Same markets | `start-engine.sh` builds `MARKETS_FIXTURE` from `config/layer2.json` (`bun scripts/l2-fixture.ts`): one market `L2_<n>` per book size |

## Workload

`MID=65000`, `L=100` levels, `U=1e15` base units (same as Layer 1). One market per book size, `L2_<n>`, with `n` resting orders per side.

**Seed** (through the engine, untimed, all responses checked): the Layer 1 seed. For `i in 0..n`, `d = 1 + i % L`, `qty = U * (5 + i % 5)`: ask `a{i}` at `MID + d` (user `1 + i%100`), bid `b{i}` at `MID - d` (user `1 + (i+50)%100`).

### Part A: scenarios (closed loop, one request in flight)

The five Layer 1 scenarios with the same command formulas, at each book size. Every operation is one request through Redis; latency is `response read - send`. `ops_per_round = min(max_ops_per_round, n/10)`; rounds repeat until `target_samples` or `cell_budget_seconds`.

| Scenario | Command | After each round (untimed) |
|---|---|---|
| `limit_rest` | limit qty `U`, buy at `MID-1-(i%L)`, sell at `MID+1+(i%L)`. Rests. | cancel the orders just placed |
| `limit_cross_1` | limit qty `U`, buy at `MID+1`, sell at `MID-1`. One fill. | re-add each consumed maker (same price and quantity) |
| `limit_sweep` | limit qty `30U`, buy at `MID+L`, sell at `MID-L`. About 5 fills. | re-add each consumed maker |
| `market_sweep` | market qty `20U`. About 3 to 4 fills. | re-add each consumed maker |
| `cancel` | cancel `a{k}` (even `i`) or `b{k}` (odd `i`), `k = ((i/2) * 7919) % n` | re-add the cancelled seed orders |

Layer 1 reseeds a fresh book per round; over Redis that is impractical, so the book is restored by compensating requests instead. The book depth and per-level shape stay the same, the FIFO position of replaced orders changes. `cancel` runs first for every book size because it addresses the original seed order ids.

Takers use unique user ids, so self-trade handling never triggers.

### Part B: load (open loop)

On the seeded book of each size, a pair stream: request `2p` is a taker (limit, qty `U`, buy at `MID+1` on even pairs, sell at `MID-1` on odd pairs) that crosses the best level and fully fills with one fill; request `2p+1` is a maker (same side as the consumed order, same price, qty `U`) that rests and restores the quantity. Requests go out on one connection in order and the engine pops FIFO, so the book depth is constant.

Responses are validated: a wrong status or fill count is an *anomaly* and fails the run.

## Phases

| Phase | Purpose |
|---|---|
| Preflight | Queue empty, engine answers `get-depth`, every `L2_<n>` book empty |
| Transport floor | `LPUSH` then `BRPOP` on a private key, no engine. Also `PING` RTT. |
| Part A cells | Seed (once per book size), then each scenario as above, with warm-up rounds discarded |
| Part B idle | Closed loop on the pair stream, `idle_samples` samples. Baseline for queue wait. |
| Part B load | Open loop at fixed arrival rates. Latency is `receive time - scheduled send time` (no coordinated omission). `incoming-request` length is sampled every 250 ms. Rates ascend and stop at the first saturated step (lost responses, achieved < 90% of offered, or anomaly). |

## Separating queue latency from engine processing time and sender delay

- **Transport floor** = echo through Redis only.
- **Engine service time (est.)** = closed-loop end-to-end - floor.
- **Queue wait (est.)** = open-loop end-to-end at rate R - closed-loop end-to-end.
- **Sender-side timing** (open loop), reported separately: `send lag` = intended time to `LPUSH` issued (load generator behind schedule); `LPUSH ack` = issued to acknowledged by Redis; `post-enqueue` = acknowledged to response read; `max burst` = most requests issued in one scheduler tick (above 1 means the generator caught up in a burst).

Percentile subtraction is approximate. The raw end-to-end percentiles are the primary results.

## Things that affect the numbers (read before publishing)

- **Network distance.** Put the load generator, engine host and Upstash in the same region (ideally the same AZ). Redis round trips dominate at these scales, so over Redis the Layer 1 gap shrinks. That is expected, not a contradiction.
- **Seeding cost.** Seeding goes through the engine. The TS engine sorts the whole opposite book on every `createOrder`, so seeding `n` per side costs roughly `O(n^2 log n)`: fine at 1k and 10k, impractical at 100k (`deep` profile, use only with patience).
- **Upstash limits.** Each order costs about 4 to 8 Redis commands, restore requests add more. Check your plan's commands/second and daily quota before `full` (up to 1600 req/s). Lower the `rates` in `config/layer2.json` if needed.
- **Side-effect queues.** Both engines write `settlement-queue` and `matching-to-risk-pub-queue` with no consumer. `make layer2-clean` removes them. Their lengths are used for the parity check, so the check works with leftovers from earlier runs.
- **Engine startup.** Restart the engine before each run so every book starts empty.
- **Engine CPU** is not visible from the load generator. If you need it, sample the engine host (`pidstat -p <pid> 1`).
- **Order bias.** Repeat the pair of runs in alternating engine order (rust, ts, ts, rust) and compare.
- Layer 1 numbers are not comparable to Layer 2 numbers.
