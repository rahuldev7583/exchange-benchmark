# Layer 2: engine service benchmark

**Question:** how long does an order take to travel through the Redis queue, the engine and the result channel?

The engines are black boxes. Nothing in `engines/` is modified or instrumented. The load generator speaks the engine's own Redis protocol (ENGINE_CONTRACT §4).

## Topology

```
 loadgen EC2                       Upstash (one database)                     engine EC2
 ┌──────────────┐  LPUSH incoming-request  ┌─────────┐  BRPOP (3 queues)  ┌────────────────┐
 │ layer2 bench │ ───────────────────────► │  Redis  │ ◄───────────────── │ rust OR ts     │
 │ (bun)        │ ◄─────────────────────── │         │ ───────────────►   │ engine         │
 └──────────────┘  RPOP/BRPOP              └─────────┘  LPUSH response-   └────────────────┘
                   response-queue-{id}                   queue-{backend}
```

Run **one engine at a time**. Both consume `incoming-request`; running both would split the traffic. Use the same Upstash database, the same region and the same instance types for every run.

## Fairness rules

| Rule | How it is enforced |
|---|---|
| Same database | One `REDIS_URL` in `.env` on both hosts |
| Persistent connections | Harness opens 3 connections once (sender, receiver, control) and reuses them. Engines keep their own long-lived connections. |
| Identical commands | Both engines receive the byte-identical `create-order` JSON on `incoming-request`. The harness only uses `LPUSH`, `RPOP count`, `BRPOP`, `LLEN`, `PING`. |
| Identical workload | Deterministic, no randomness, same order of requests (below) |
| Identical start state | Preflight aborts unless the queue is empty and the engine's book is empty. Restart the engine before every run. |
| Logging off | `VERBOSE_LOGGING=false` set by `start-engine.sh` (ENGINE_CONTRACT §6) |
| No response collisions | Unique `BACKEND_ID` per run, so `response-queue-bench-<run>` is private |
| One clock | Send and receive are timestamped on the load generator, so there is no cross-host clock skew |

## Workload

Symbol `BTC_USDC` (fixture), `MID=65000`, `U=1e15` base units.

1. **Seed (untimed):** `seed_orders_per_side` resting asks at `MID+2..MID+L+1` and bids at `MID-2..MID-L-1`, qty `U*(5+i%5)`. Sent through the engine, closed loop.
2. **Steady state** is a stream of pairs on a dedicated working level that holds no seed orders:
   - request `2p`: maker limit order qty `U` at `MID+1` (sell) or `MID-1` (buy), alternating by pair. It **rests** (`accepted`, no fills).
   - request `2p+1`: taker limit order, opposite side, same price, qty `U`. It **crosses** exactly the maker (`fully_filled`, one fill).

   The book depth is constant for the whole run. Makers and takers use different user ids, so no self-trade prevention is triggered. Requests are sent in order on one connection and the engines pop FIFO from one queue, so a taker always meets its maker.
3. Responses are validated. A wrong status or fill count is an *anomaly* and fails the run.

## Phases

| Phase | Purpose |
|---|---|
| Preflight | Queue empty, engine answers `get-depth`, book empty |
| Transport floor | `LPUSH` then `BRPOP` on a private key, no engine. Closed loop, `floor_samples` samples. Also `PING` RTT. |
| Seed + warm-up | Same for both engines, discarded |
| Idle | Closed loop, exactly one request in flight, `idle_samples` samples. This is service time with no queueing. |
| Load | Open loop at fixed arrival rates (`rates`). Each request's latency is `receive time - scheduled send time`, so there is no coordinated omission. `incoming-request` length is sampled every 250 ms. Rates ascend and stop at the first saturated step (lost responses, achieved < 90% of offered, or anomaly). |

## Separating queue latency from engine processing time

Without touching the engines, the report derives:

- **Transport floor** = echo through Redis only.
- **Engine service time (est.)** = idle end-to-end − floor. Includes the engine host's own Redis hops, parse, match and serialise.
- **Queue wait (est.)** = end-to-end at rate R − idle end-to-end. Cross-checked with the sampled queue depth.

Percentile subtraction is approximate. The raw end-to-end p50/p95/p99 are the primary results.

## Things that affect the numbers (read before publishing)

- **Network distance.** Put the load generator, engine host and Upstash in the same region (ideally the same AZ). Redis round trips dominate at these scales.
- **Engines publish extra messages per order**: `settlement-queue` and `matching-to-risk-pub-queue` entries, with no consumer running. The Rust engine issues its `LPUSH` calls synchronously on the matching thread; the TypeScript engine does not await them. That difference is part of what Layer 2 measures. `make layer2-clean` removes these queues.
- **Upstash limits.** Each order costs about 4 to 8 Redis commands (harness push, engine pop, response, side-effect pushes, receive). Check your plan's commands/second and daily quota before `full` (up to 1600 req/s). Lower the `rates` in `config/layer2.json` if needed.
- **Engine startup.** Restart the engine before each run so the book starts empty.
- Layer 1 numbers are not comparable to Layer 2 numbers.
