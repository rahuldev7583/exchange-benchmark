// Layer 1: in-memory orderbook benchmark for the TypeScript engine (apps/matching-engine/engine.ts).
// Workload definition: docs/METHODOLOGY.md (must stay identical to rust/src/main.rs).

import { readFileSync, writeFileSync } from 'node:fs';
import { MatchingEngine, type OpenOrder, type OrderInput } from '../../engines/centralized-exchange/apps/matching-engine/engine.ts';

type Cmd =
  | { kind: 'create'; request_id: string; input: OrderInput }
  | { kind: 'cancel'; request_id: string; order_id: string };

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const conf = JSON.parse(readFileSync(arg('--config') ?? '../../config/layer1.json', 'utf8'));
const profile = arg('--profile') ?? 'default';
const out = arg('--out');
const only = arg('--scenarios')?.split(',');
const p = conf.profiles[profile];
if (!p) throw new Error(`unknown profile ${profile}`);

const SYMBOL: string = conf.symbol;
const MID = BigInt(conf.mid_price);
const L = BigInt(conf.levels);
const U = BigInt(conf.qty_unit);

function seedBook(n: number): MatchingEngine {
  const engine = new MatchingEngine();
  const asks = new Map<string, OpenOrder>();
  const bids = new Map<string, OpenOrder>();
  engine.orderbook.set(SYMBOL, { asks, bids });
  for (let i = 0; i < n; i++) {
    const bi = BigInt(i);
    const d = 1n + (bi % L);
    const qty = U * (5n + (bi % 5n));
    asks.set(`a${i}`, {
      order_id: `a${i}`, side: 'sell', price: MID + d, quantity: qty,
      user_id: `maker-${i % 100}`, request_id: `req-a${i}`, type: 'limit', symbol: SYMBOL, created_at: i,
    });
    bids.set(`b${i}`, {
      order_id: `b${i}`, side: 'buy', price: MID - d, quantity: qty,
      user_id: `maker-${(i + 50) % 100}`, request_id: `req-b${i}`, type: 'limit', symbol: SYMBOL, created_at: i,
    });
  }
  return engine;
}

function buildCommands(scenario: string, n: number, ops: number): Cmd[] {
  const cmds: Cmd[] = [];
  for (let i = 0; i < ops; i++) {
    if (scenario === 'cancel') {
      const k = (Math.floor(i / 2) * 7919) % n;
      cmds.push({ kind: 'cancel', request_id: `r${i}`, order_id: i % 2 === 0 ? `a${k}` : `b${k}` });
      continue;
    }
    const buy = i % 2 === 0;
    const bi = BigInt(i);
    let type: 'limit' | 'market' = 'limit';
    let qty = U;
    let price = 0n;
    switch (scenario) {
      case 'limit_rest': price = buy ? MID - 1n - (bi % L) : MID + 1n + (bi % L); break;
      case 'limit_cross_1': price = buy ? MID + 1n : MID - 1n; break;
      case 'limit_sweep': qty = 30n * U; price = buy ? MID + L : MID - L; break;
      case 'market_sweep': type = 'market'; qty = 20n * U; break;
      default: throw new Error(`unknown scenario ${scenario}`);
    }
    cmds.push({
      kind: 'create',
      request_id: `r${i}`,
      input: { symbol: SYMBOL, type, side: buy ? 'buy' : 'sell', price, quantity: qty, user_id: `taker-${i}` },
    });
  }
  return cmds;
}

function percentile(sorted: Float64Array, pct: number): number {
  const rank = Math.ceil((pct / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

function timerOverheadNs(): number {
  const d = new Float64Array(200_000);
  for (let i = 0; i < d.length; i++) {
    const t = Bun.nanoseconds();
    d[i] = Bun.nanoseconds() - t;
  }
  d.sort();
  return d[d.length >> 1]!;
}

function runCell(scenario: string, n: number) {
  const ops = Math.max(1, Math.min(p.max_ops_per_round, Math.floor(n / 10)));
  const rounds = Math.ceil(p.target_samples / ops);
  const warmup: number = p.warmup_rounds;
  const budgetNs = p.cell_budget_seconds * 1e9;

  const samples = new Float64Array(ops * rounds);
  let count = 0;
  const statuses: Record<string, number> = {};
  let fills = 0;
  let filledQty = 0n;
  let notional = 0n;
  let done = 0;
  let truncated = false;
  const started = Bun.nanoseconds();

  for (let r = 0; r < warmup + rounds; r++) {
    const timed = r >= warmup;
    if (timed && done >= 3 && Bun.nanoseconds() - started > budgetNs) { truncated = true; break; }
    const engine = seedBook(n);
    const cmds = buildCommands(scenario, n, ops);
    const results: any[] = new Array(ops);
    Bun.gc(true);
    for (let i = 0; i < ops; i++) {
      const c = cmds[i]!;
      const t = Bun.nanoseconds();
      const res = c.kind === 'create'
        ? engine.createOrder(c.input, c.request_id)
        : engine.cancelOrder(c.order_id, c.request_id);
      const ns = Bun.nanoseconds() - t;
      if (timed) samples[count++] = ns;
      results[i] = res;
    }
    if (timed) {
      if (done === 0) {
        for (const res of results) {
          const resp = res.response as { status: string; filled_quantity: bigint };
          statuses[resp.status] = (statuses[resp.status] ?? 0) + 1;
          filledQty += resp.filled_quantity;
          for (const f of res.fills) {
            fills++;
            notional += f.price * f.filled_quantity;
          }
        }
      }
      done++;
    }
  }

  const s = samples.subarray(0, count);
  s.sort();
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s[i]!;
  const mean = sum / s.length;
  const sortedStatuses = Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    engine: 'ts',
    scenario,
    book_size_per_side: n,
    ops_per_round: ops,
    rounds: done,
    warmup_rounds: warmup,
    samples: s.length,
    truncated_by_budget: truncated,
    latency_ns: {
      min: s[0], mean, p50: percentile(s, 50), p90: percentile(s, 90),
      p99: percentile(s, 99), p999: percentile(s, 99.9), max: s[s.length - 1],
    },
    throughput_ops_per_sec: 1e9 / mean,
    parity: { statuses: sortedStatuses, fills, filled_quantity: filledQty.toString(), notional: notional.toString() },
  };
}

const cells = [];
for (const n of p.book_sizes as number[]) {
  for (const s of conf.scenarios as string[]) {
    if (only && !only.includes(s)) continue;
    console.error(`[ts] ${s} book=${n}/side`);
    cells.push(runCell(s, n));
  }
}

const text = JSON.stringify(
  { engine: 'ts', profile, timer_overhead_ns: timerOverheadNs(), results: cells },
  null,
  2,
);
if (out) writeFileSync(out, text);
else console.log(text);
