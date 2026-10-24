# Layer 1 methodology

**Question:** given a prepared command and an existing orderbook, how long does the in-memory operation take?

| In scope | Out of scope |
|---|---|
| Matching, book mutation, result construction | Redis, JSON parse/serialise, network, auth, DB, workload generation |

## What is timed

| Engine | Timed call | Entry point |
|---|---|---|
| Rust | `ORDERBOOK::create_order` / `cancel_order` plus building the response (status, filled, remaining, fills) | `engines/matching-engine-rust/src/order.rs` |
| TS | `MatchingEngine.createOrder` / `cancelOrder` | `engines/centralized-exchange/apps/matching-engine/engine.ts` |

The TS engine file has no imports, so it is loaded directly by Bun without installing the turborepo.

## Loop

For each `(book_size, scenario)` cell:

1. Warm-up rounds, discarded.
2. Each round: seed a fresh book directly into the engine's data structures, prepare all commands, run GC (TS only), then time each command individually.
3. Stop when `target_samples` is reached or `cell_budget_seconds` is exceeded (minimum 3 rounds).

`ops_per_round = min(max_ops_per_round, book_size / 10)`, so a round never exhausts the book and the book depth stays approximately constant while timing.

## Deterministic workload

No randomness. `MID=65000`, `L=100` levels, `U=1e15` base units (quantities must stay below 2^53, ENGINE_CONTRACT §1). N is the book size per side.

**Seed** for `i in 0..N`, with `d = 1 + i % L` and `qty = U * (5 + i % 5)`:
- ask `a{i}`: price `MID + d`, user `maker-{i % 100}`, created_at `i`
- bid `b{i}`: price `MID - d`, user `maker-{(i + 50) % 100}`, created_at `i`

**Commands** for `i in 0..ops`; taker `taker-{i}`, id `t{i}`; even `i` buys, odd `i` sells:

| Scenario | Command |
|---|---|
| `limit_rest` | limit qty `U`; buy at `MID-1-(i%L)`, sell at `MID+1+(i%L)`. Never crosses. Rests on the book. |
| `limit_cross_1` | limit qty `U`; buy at `MID+1`, sell at `MID-1`. One fill against the best level. |
| `limit_sweep` | limit qty `30U`; buy at `MID+L`, sell at `MID-L`. Multi-fill (about 5 fills per order). |
| `market_sweep` | market qty `20U`. Multi-fill (about 3 to 4 fills per order). |
| `cancel` | cancel `a{k}` (even `i`) or `b{k}` (odd `i`), `k = ((i/2) * 7919) % N`. Distinct resting orders spread across levels. |

## Parity gate

Within the first timed round each harness records status counts, total fills, total filled quantity and notional. The report fails (exit code 2) if status counts, fill count or total filled quantity differ between engines, because the engines would then be doing different work. Notional mismatch is reported as a warning.

**Known deviation (matching-engine-rust @ a230af2):** `Fill.filled_quantity` carries the maker's full resting quantity rather than the matched quantity when the maker is larger than the taker's remainder. This is why notional differs. It violates ENGINE_CONTRACT §3 and does not affect the top-level `filled_quantity`.

## Known asymmetries (reported, not hidden)

- TS `createOrder` builds `settlement` and `risk` side-effect payloads inside the timed call. They are not separable without editing the engine.
- Rust is built with `lto=fat`, `codegen-units=1` through the harness crate. The engine's own `Cargo.toml` has no release tuning, so this is a best-case Rust build.
- Rust `cancel_order` clones the whole `orders` map on every call (`self.orders.to_owned()`), so cancel is O(book) and slower than TS at these sizes. TS `cancelOrder` scans every order, also O(book). TS `createOrder` sorts the whole counterparty book on every call, so TS latency grows with depth.
- Seeding writes directly into the books and does not go through `createOrder`, which is O(n^2) in TS.
- The clock costs about 25 to 35 ns per timer call and is not subtracted. The median overhead is printed in the report.
- Results measure a warm, single-threaded process. They say nothing about queueing, I/O or contention (layers 2 and 3).
