// Layer 2: engine service benchmark, black box over Redis.
// Path measured: LPUSH incoming-request -> engine (BRPOP, parse, match, publish) -> response-queue-{backend} receive.
// Protocol: engines/centralized-exchange/ENGINE_CONTRACT.md §4. Workload: docs/LAYER2.md.
//
// Part A (cells): the Layer 1 scenarios (limit_rest, limit_cross_1, limit_sweep, market_sweep, cancel) at each book size,
//                 one request in flight, over Redis. Book state is restored after every round (untimed).
// Part B (load):  open loop at fixed arrival rates on a seeded book of each size.
import { createClient } from 'redis';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const engine = arg('--engine');
if (engine !== 'rust' && engine !== 'ts') throw new Error('--engine rust|ts is required');
const profileName = arg('--profile') ?? 'full';
const ratesOverride = arg('--rates')?.split(',').map(Number);
const scenariosOnly = arg('--scenarios')?.split(',');
const outDir = arg('--out');
const conf = JSON.parse(readFileSync(arg('--config') ?? '../config/layer2.json', 'utf8'));
const P = conf.profiles[profileName];
if (!P) throw new Error(`unknown profile ${profileName}`);
if (ratesOverride) P.load.rates = ratesOverride;
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL is not set');

const MID = BigInt(conf.mid_price);
const L = BigInt(conf.levels);
const U = BigInt(conf.qty_unit);
const symbolFor = (n: number) => `${conf.symbol_prefix}_${n}`;
const SCENARIOS: string[] = (conf.scenarios as string[]).filter((s) => !scenariosOnly || scenariosOnly.includes(s));
const INCOMING = 'incoming-request';
const SETTLEMENT = 'settlement-queue';
const RISK = 'matching-to-risk-pub-queue';

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const BACKEND_ID = `bench-${runId}`;
const RESPONSE_QUEUE = `response-queue-${BACKEND_ID}`;
const ECHO_QUEUE = `bench-echo-${runId}`;

const now = () => Bun.nanoseconds();
const log = (...a: unknown[]) => console.error(`[l2:${engine}]`, ...a);
const sleep = (ms: number) => Bun.sleep(ms);

// ---- Persistent connections: one per role, created once and reused for the whole run ----
const mk = (role: string) => {
  const c = createClient({ url: REDIS_URL });
  c.on('error', (e: any) => log(`redis ${role} error:`, e?.message ?? e));
  return c;
};
const tx = mk('sender');
const rx = mk('receiver');
const ctl = mk('control');
await Promise.all([tx.connect(), rx.connect(), ctl.connect()]);

// ---- Statistics ----
function pct(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}
function summarize(values: number[]) {
  const s = Float64Array.from(values).sort();
  if (s.length === 0) return { count: 0 };
  let sum = 0;
  for (const v of s) sum += v;
  return { count: s.length, min: s[0], mean: sum / s.length, p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99), p999: pct(s, 99.9), max: s[s.length - 1] };
}

// ---- Request / response bookkeeping ----
type Kind = 'rest' | 'cross' | 'seed' | 'depth' | 'op' | 'restore';
// intended: scheduled send time. sent: just before LPUSH was issued. enq: LPUSH acknowledged by Redis. recv: response read.
type Rec = { kind: Kind; intended: number; sent: number; enq?: number; recv?: number; resp?: any; anomaly?: string };
const pending = new Map<string, Rec>();
const waiters = new Map<string, () => void>();
let stopRx = false;

function onItems(items: string[], t: number) {
  for (const raw of items) {
    let resp: any;
    try { resp = JSON.parse(raw); } catch { continue; }
    const rec = pending.get(resp.request_id);
    if (!rec) continue;
    rec.recv = t;
    rec.resp = resp;
    pending.delete(resp.request_id);
    waiters.get(resp.request_id)?.();
  }
}

const rxLoop = (async () => {
  while (!stopRx) {
    try {
      const items = await rx.rPopCount(RESPONSE_QUEUE, 256);
      const t = now();
      if (items && items.length) { onItems(items, t); continue; }
      const r = await rx.brPop(RESPONSE_QUEUE, 1);
      const t2 = now();
      if (r) onItems([r.element], t2);
    } catch (e: any) {
      log('receiver error', e?.message ?? e);
      await sleep(100);
    }
  }
})();

const envelope = (request_id: string, payload: unknown, command: string) =>
  JSON.stringify({ BACKEND_ID, request_id, payload, command });
const orderPayload = (symbol: string, type: 'limit' | 'market', side: 'buy' | 'sell', qty: bigint, price: bigint, user_id: number) =>
  ({ type, quantity: qty.toString(), ...(type === 'limit' ? { price: price.toString() } : {}), symbol, user_id, side });

function sendOne(id: string, body: string, kind: Kind, intended = now()): Rec {
  const rec: Rec = { kind, intended, sent: now() };
  pending.set(id, rec);
  tx.lPush(INCOMING, body).then(() => { rec.enq = now(); }, (e: any) => log('send error', e?.message ?? e));
  return rec;
}
function awaitRec(id: string, rec: Rec, timeoutMs: number): Promise<boolean> {
  if (rec.recv !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(id); resolve(false); }, timeoutMs);
    waiters.set(id, () => { clearTimeout(timer); waiters.delete(id); resolve(true); });
  });
}

const big = (v: unknown): bigint => { try { return BigInt(String(v)); } catch { return -1n; } };
const nFills = (r: any) => (Array.isArray(r?.fills) ? r.fills.length : -1);

// Unique taker/maker user ids so self-trade handling never triggers (Rust prevents, TS skips).
let uidSeq = 1_000_000;
const nextUid = () => uidSeq++;

// ---- Untimed bulk send (seed, restore): windowed, every response awaited ----
async function sendAll(reqs: { id: string; body: string }[], label: string, window = 200): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let i = 0; i < reqs.length; i += window) {
    const batch = reqs.slice(i, i + window).map((r) => ({ r, rec: sendOne(r.id, r.body, 'restore') }));
    for (const { r, rec } of batch) {
      if (!(await awaitRec(r.id, rec, 30000))) throw new Error(`${label} request ${r.id} timed out (engine stalled?)`);
      out.push(rec);
    }
  }
  return out;
}

// ---- Preflight ----
async function probeDepth(symbol: string, attempt: number, probes: string[]) {
  const id = `${runId}-depth-${symbol}-${attempt}`;
  const body = envelope(id, symbol, 'get-depth');
  probes.push(body);
  const rec = sendOne(id, body, 'depth');
  if (!(await awaitRec(id, rec, 2000))) { pending.delete(id); return null; }
  return rec.resp;
}
async function preflight(symbols: string[]) {
  let depth = await ctl.lLen(INCOMING);
  for (let i = 0; i < 60 && depth > 0; i++) {
    if (i === 0) log(`${INCOMING} holds ${depth} items; waiting up to 30s for it to drain...`);
    await sleep(500);
    depth = await ctl.lLen(INCOMING);
  }
  if (depth > 0) throw new Error(`${INCOMING} still holds ${depth} items. Another run or engine is active. Stop it and drain the queue.`);
  log('waiting for engine readiness (get-depth)...');
  const deadline = now() + 30e9;
  const probes: string[] = [];
  let ready = false;
  for (let attempt = 0; now() < deadline && !ready; attempt++) ready = (await probeDepth(symbols[0]!, attempt, probes)) !== null;
  if (!ready) {
    for (const body of probes) await ctl.lRem(INCOMING, 0, body).catch(() => {});
    throw new Error('engine did not answer get-depth within 30s. Is it running against the same REDIS_URL?');
  }
  for (const symbol of symbols) {
    const r = await probeDepth(symbol, 99, probes);
    const bids = r?.bids?.length ?? -1, asks = r?.asks?.length ?? -1;
    if (bids !== 0 || asks !== 0) throw new Error(`Orderbook ${symbol} is not empty (bids=${bids}, asks=${asks}). Restart the engine so every run starts from the same empty books.`);
  }
  log(`engine ready, ${symbols.length} books empty`);
}

// ---- Transport floor (echo through Redis only, no engine) ----
async function measureFloor() {
  const pings: number[] = [];
  for (let i = 0; i < 50; i++) { const t = now(); await ctl.ping(); pings.push(now() - t); }
  const sample = envelope(`${runId}-echo-000000`, orderPayload(symbolFor(P.book_sizes[0]), 'limit', 'buy', U, MID, 1), 'create-order');
  const echoRx = mk('echo-consumer');
  await echoRx.connect();
  const settleMs = Math.ceil(((pings.sort((a, b) => a - b)[25] ?? 1e6) / 1e6) * 1.5) + 2;
  const lat: number[] = [];
  const total = P.floor_samples + 20;
  for (let i = 0; i < total; i++) {
    const popped = echoRx.brPop(ECHO_QUEUE, 5);
    await sleep(settleMs);
    const t = now();
    tx.lPush(ECHO_QUEUE, sample).catch((e: any) => log('echo send error', e?.message ?? e));
    const got = await popped;
    const dt = now() - t;
    if (!got) throw new Error('echo consumer timed out');
    if (i >= 20) lat.push(dt);
  }
  await ctl.del(ECHO_QUEUE);
  await echoRx.quit();
  return { ping_rtt_ns: summarize(pings), echo_ns: summarize(lat) };
}

// ---- Seeding: same book as Layer 1, sent through the engine ----
// ask a{i}: MID + d, user 1 + i%100; bid b{i}: MID - d, user 1 + (i+50)%100; d = 1 + i%L, qty = U*(5 + i%5)
type SeedIds = { a: string[]; b: string[] };
const seeded = new Map<number, SeedIds>();
const seedSpec = (side: 'a' | 'b', i: number) => {
  const bi = BigInt(i);
  const d = 1n + (bi % L);
  return {
    side: side === 'a' ? ('sell' as const) : ('buy' as const),
    price: side === 'a' ? MID + d : MID - d,
    qty: U * (5n + (bi % 5n)),
    user: side === 'a' ? 1 + (i % 100) : 1 + ((i + 50) % 100),
  };
};
const seedReq = (n: number, side: 'a' | 'b', i: number, id: string) => {
  const s = seedSpec(side, i);
  return { id, body: envelope(id, orderPayload(symbolFor(n), 'limit', s.side, s.qty, s.price, s.user), 'create-order') };
};

async function ensureSeeded(n: number): Promise<SeedIds> {
  const have = seeded.get(n);
  if (have) return have;
  log(`seeding ${symbolFor(n)}: ${n} asks + ${n} bids through the engine`);
  const reqs: { id: string; body: string }[] = [];
  for (let i = 0; i < n; i++) {
    reqs.push(seedReq(n, 'a', i, `${runId}-seed-${n}-a${i}`));
    reqs.push(seedReq(n, 'b', i, `${runId}-seed-${n}-b${i}`));
  }
  const recs = await sendAll(reqs, `seed ${n}`);
  const ids: SeedIds = { a: new Array(n), b: new Array(n) };
  recs.forEach((rec, j) => {
    const r = rec.resp;
    if (r.status !== 'accepted' || nFills(r) !== 0) throw new Error(`seed anomaly (${reqs[j]!.id}): expected accepted/0 fills, got ${r.status}/${nFills(r)} ${r.message ?? ''}`);
    (j % 2 === 0 ? ids.a : ids.b)[j >> 1] = r.order_id;
  });
  seeded.set(n, ids);
  log(`seeded ${symbolFor(n)}`);
  return ids;
}

// ---- Part A: Layer 1 scenarios over Redis ----
type Op =
  | { kind: 'create'; payload: any; side: 'buy' | 'sell' }
  | { kind: 'cancel'; order_id: string; ref: { side: 'a' | 'b'; k: number } };

function buildOps(scenario: string, n: number, ops: number, seed: SeedIds): Op[] {
  const sym = symbolFor(n);
  const out: Op[] = [];
  for (let i = 0; i < ops; i++) {
    if (scenario === 'cancel') {
      const k = (Math.floor(i / 2) * 7919) % n;
      const side = i % 2 === 0 ? 'a' : 'b';
      out.push({ kind: 'cancel', order_id: (side === 'a' ? seed.a : seed.b)[k]!, ref: { side, k } });
      continue;
    }
    const buy = i % 2 === 0;
    const bi = BigInt(i);
    const user = nextUid();
    const side = buy ? 'buy' : 'sell';
    switch (scenario) {
      case 'limit_rest':
        out.push({ kind: 'create', side, payload: orderPayload(sym, 'limit', side, U, buy ? MID - 1n - (bi % L) : MID + 1n + (bi % L), user) }); break;
      case 'limit_cross_1':
        out.push({ kind: 'create', side, payload: orderPayload(sym, 'limit', side, U, buy ? MID + 1n : MID - 1n, user) }); break;
      case 'limit_sweep':
        out.push({ kind: 'create', side, payload: orderPayload(sym, 'limit', side, 30n * U, buy ? MID + L : MID - L, user) }); break;
      case 'market_sweep':
        out.push({ kind: 'create', side, payload: orderPayload(sym, 'market', side, 20n * U, 0n, user) }); break;
      default: throw new Error(`unknown scenario ${scenario}`);
    }
  }
  return out;
}

const EXPECT: Record<string, string> = {
  limit_rest: 'accepted', limit_cross_1: 'fully_filled', limit_sweep: 'fully_filled', market_sweep: 'fully_filled', cancel: 'cancelled',
};

// Put the book back to its seeded shape after a timed round (untimed).
async function restore(scenario: string, n: number, ops: Op[], recs: Rec[], seed: SeedIds, tag: string) {
  const sym = symbolFor(n);
  const reqs: { id: string; body: string }[] = [];
  const after: ((r: Rec) => void)[] = [];
  const add = (command: string, payload: unknown, then?: (r: Rec) => void) => {
    const id = `${runId}-${tag}-rs${reqs.length}`;
    reqs.push({ id, body: envelope(id, payload, command) });
    after.push(then ?? (() => {}));
  };
  if (scenario === 'limit_rest') {
    for (const r of recs) add('cancel-order', r.resp.order_id);
  } else if (scenario === 'cancel') {
    ops.forEach((op) => {
      if (op.kind !== 'cancel') return;
      const s = seedSpec(op.ref.side, op.ref.k);
      add('create-order', orderPayload(sym, 'limit', s.side, s.qty, s.price, s.user), (r) => {
        (op.ref.side === 'a' ? seed.a : seed.b)[op.ref.k] = r.resp.order_id;
      });
    });
  } else {
    // Re-add each consumed maker order (same price, same quantity, opposite side of the taker).
    ops.forEach((op, i) => {
      if (op.kind !== 'create') return;
      const makerSide = op.side === 'buy' ? 'sell' : 'buy';
      for (const f of recs[i]!.resp.fills as any[]) {
        add('create-order', orderPayload(sym, 'limit', makerSide, big(f.filled_quantity), big(f.price), 1 + (reqs.length % 100)));
      }
    });
  }
  const out = await sendAll(reqs, `restore ${tag}`);
  out.forEach((r, j) => {
    const expect = scenario === 'limit_rest' ? 'cancelled' : 'accepted';
    if (r.resp.status !== expect) throw new Error(`restore anomaly (${scenario}): expected ${expect}, got ${r.resp.status} ${r.resp.message ?? ''}`);
    after[j]!(r);
  });
  return reqs.length;
}

async function sideCounts() {
  // Side-effect messages are published asynchronously by both engines; wait until the counters stop moving.
  let prev = '';
  for (let i = 0; i < 20; i++) {
    const cur = `${await ctl.lLen(SETTLEMENT)}/${await ctl.lLen(RISK)}`;
    if (cur === prev) break;
    prev = cur;
    await sleep(150);
  }
  const [s, r] = prev.split('/').map(Number);
  return { settlement: s!, risk: r! };
}

async function runCell(n: number, scenario: string) {
  const seed = await ensureSeeded(n);
  const opsPerRound = Math.max(1, Math.min(P.max_ops_per_round, Math.floor(n / 10)));
  const rounds = Math.ceil(P.target_samples / opsPerRound);
  const budgetNs = (P.cell_budget_seconds as number) * 1e9;
  const started = now();

  const samples: number[] = [];
  const enqueue: number[] = [];
  const statuses: Record<string, number> = {};
  let fills = 0, filledQty = 0n, notional = 0n;
  const anomalies: string[] = [];
  let done = 0, truncated = false;
  let side: any = null;

  for (let r = 0; r < P.warmup_rounds + rounds; r++) {
    const timed = r >= P.warmup_rounds;
    if (timed && done >= 3 && now() - started > budgetNs) { truncated = true; break; }
    const firstTimed = timed && done === 0;
    const before = firstTimed ? await sideCounts() : null;
    const ops = buildOps(scenario, n, opsPerRound, seed);
    const recs: Rec[] = [];
    let requests = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      const id = `${runId}-${symbolFor(n)}-${scenario}-${r}-${i}`;
      const body = op.kind === 'create' ? envelope(id, op.payload, 'create-order') : envelope(id, op.order_id, 'cancel-order');
      const t0 = now();
      const rec = sendOne(id, body, 'op', t0);
      if (!(await awaitRec(id, rec, 30000))) throw new Error(`${scenario} request ${id} timed out (engine stalled?)`);
      requests++;
      recs.push(rec);
      const resp = rec.resp;
      if (resp.status !== EXPECT[scenario]) {
        anomalies.push(`${scenario}: expected ${EXPECT[scenario]}, got ${resp.status} (${resp.message ?? ''})`);
      }
      if (timed) {
        samples.push(rec.recv! - t0);
        if (rec.enq !== undefined) enqueue.push(rec.enq - rec.sent);
      }
    }

    if (firstTimed) {
      for (const rec of recs) {
        const resp = rec.resp;
        statuses[resp.status] = (statuses[resp.status] ?? 0) + 1;
        filledQty += big(resp.filled_quantity);
        for (const f of resp.fills as any[]) { fills++; notional += big(f.price) * big(f.filled_quantity); }
      }
    }

    requests += await restore(scenario, n, ops, recs, seed, `${scenario}-${r}`);
    if (firstTimed) {
      const after = await sideCounts();
      side = { requests, settlement_msgs: after.settlement - before!.settlement, risk_msgs: after.risk - before!.risk };
    }
    if (timed) done++;
  }

  const sorted = Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => (a < b ? -1 : 1)));
  const lat = summarize(samples) as any;
  return {
    scenario,
    book_size_per_side: n,
    ops_per_round: opsPerRound,
    rounds: done,
    warmup_rounds: P.warmup_rounds,
    samples: samples.length,
    truncated_by_budget: truncated,
    latency_ns: lat,
    lpush_ack_ns: summarize(enqueue),
    ops_per_sec_closed_loop: 1e9 / lat.mean,
    parity: { statuses: sorted, fills, filled_quantity: filledQty.toString(), notional: notional.toString() },
    first_round_side_effects: side,
    anomalies: anomalies.length,
    anomaly_examples: anomalies.slice(0, 3),
  };
}

// ---- Part B: load. Pair stream on a seeded book: a taker crosses the best level, a maker re-adds the same quantity ----
function pairRequest(n: number, k: number, id: string): { body: string; kind: 'rest' | 'cross' } {
  const sym = symbolFor(n);
  const pair = k >> 1;
  const buyPair = pair % 2 === 0;
  if ((k & 1) === 0) {
    const p = buyPair ? orderPayload(sym, 'limit', 'buy', U, MID + 1n, 1_000_000 + pair) : orderPayload(sym, 'limit', 'sell', U, MID - 1n, 1_000_000 + pair);
    return { body: envelope(id, p, 'create-order'), kind: 'cross' };
  }
  const p = buyPair ? orderPayload(sym, 'limit', 'sell', U, MID + 1n, 10_000 + (pair % 100)) : orderPayload(sym, 'limit', 'buy', U, MID - 1n, 10_000 + (pair % 100));
  return { body: envelope(id, p, 'create-order'), kind: 'rest' };
}

function validatePair(rec: Rec) {
  const r = rec.resp;
  if (!r) return;
  const filled = big(r.filled_quantity);
  if (rec.kind === 'rest') {
    if (r.status !== 'accepted' || filled !== 0n || nFills(r) !== 0) rec.anomaly = `expected accepted/0 fills, got ${r.status}/${nFills(r)}`;
  } else if (rec.kind === 'cross') {
    if (r.status !== 'fully_filled' || filled !== U || nFills(r) !== 1) rec.anomaly = `expected fully_filled/1 fill, got ${r.status}/${nFills(r)}`;
  }
}

let k = 0;
async function closedLoopPairs(n: number, count: number, record: boolean, label: string) {
  const total = count + (count % 2);
  const out = { rest: [] as number[], cross: [] as number[], anomalies: [] as string[] };
  for (let i = 0; i < total; i++, k++) {
    const id = `${runId}-${label}-${i}`;
    const w = pairRequest(n, k, id);
    const rec = sendOne(id, w.body, w.kind);
    if (!(await awaitRec(id, rec, 30000))) throw new Error(`${label} request ${id} timed out (engine stalled?)`);
    validatePair(rec);
    if (!record) continue;
    if (rec.anomaly) out.anomalies.push(rec.anomaly);
    out[w.kind].push(rec.recv! - rec.intended);
  }
  return out;
}

async function openLoop(n: number, rate: number) {
  const LP = P.load;
  const total = Math.floor((rate * LP.duration_seconds) / 2) * 2;
  const stamp = `${runId}-${symbolFor(n)}-r${rate}`;
  const items = Array.from({ length: total }, (_, i) => ({ id: `${stamp}-${i}`, ...pairRequest(n, k + i, `${stamp}-${i}`) }));
  k += total;
  const recs: Rec[] = new Array(total);

  const depths: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try { depths.push(await ctl.lLen(INCOMING)); } catch { /* ignore */ }
      await sleep(250);
    }
  })();

  const gapNs = 1e9 / rate;
  const start = now() + 100e6;
  let sent = 0;
  const bursts: number[] = [];
  while (sent < total) {
    const t = now();
    const due = t < start ? 0 : Math.min(total, Math.floor((t - start) / gapNs) + 1);
    if (due > sent) bursts.push(due - sent);
    while (sent < due) {
      const it = items[sent]!;
      recs[sent] = sendOne(it.id, it.body, it.kind, start + sent * gapNs);
      sent++;
    }
    await sleep(1);
  }
  const sendEnd = now();

  const drainDeadline = now() + LP.drain_timeout_seconds * 1e9;
  while (now() < drainDeadline && recs.some((r) => r.recv === undefined)) await sleep(20);
  sampling = false;
  await sampler;

  const got = recs.filter((r) => r.recv !== undefined);
  const lost = total - got.length;
  for (const r of recs) if (r.recv === undefined) { for (const [id, v] of pending) if (v === r) pending.delete(id); }
  const anomalies: string[] = [];
  for (const r of got) { validatePair(r); if (r.anomaly) anomalies.push(r.anomaly); }
  const lastRecv = got.reduce((m, r) => Math.max(m, r.recv!), start);
  const enqd = got.filter((r) => r.enq !== undefined);
  return {
    offered_rate: rate,
    requests: total,
    received: got.length,
    lost,
    achieved_rate: got.length / ((lastRecv - start) / 1e9),
    // Where the time goes before the engine can even see a request:
    send_lag_ns: summarize(recs.map((r) => r.sent - r.intended)), // intended -> LPUSH issued (load generator behind schedule)
    lpush_ack_ns: summarize(enqd.map((r) => r.enq! - r.sent)), // LPUSH issued -> acknowledged by Redis
    post_enqueue_ns: summarize(enqd.map((r) => Math.max(0, r.recv! - r.enq!))), // acknowledged -> response read (queue + engine + return path)
    send_burst: summarize(bursts), // requests issued per scheduler tick (>1 means catch-up bursts)
    send_duration_s: (sendEnd - start) / 1e9,
    e2e_ns: {
      all: summarize(got.map((r) => r.recv! - r.intended)),
      rest: summarize(got.filter((r) => r.kind === 'rest').map((r) => r.recv! - r.intended)),
      cross: summarize(got.filter((r) => r.kind === 'cross').map((r) => r.recv! - r.intended)),
    },
    queue_depth: { samples: depths.length, max: Math.max(0, ...depths), p50: pct(Float64Array.from(depths).sort(), 50), p99: pct(Float64Array.from(depths).sort(), 99) },
    anomalies: anomalies.length,
    anomaly_examples: anomalies.slice(0, 3),
  };
}

// ---- Run ----
const bookSizes: number[] = P.book_sizes;
const loadSizes: number[] = P.load.book_sizes;
const result: any = {
  layer: 2, engine, profile: profileName, run_id: runId, backend_id: BACKEND_ID,
  started_at: new Date().toISOString(),
  host_desc: { engine: process.env.ENGINE_HOST_DESC ?? null, loadgen: process.env.LOADGEN_HOST_DESC ?? null, redis: process.env.REDIS_DESC ?? null },
  config: P, scenarios: SCENARIOS, status: 'running',
};
let exitCode = 0;
try {
  await preflight([...new Set([...bookSizes, ...loadSizes])].map(symbolFor));
  log('phase: transport floor (echo, no engine)');
  result.floor = await measureFloor();

  result.cells = [];
  // `cancel` targets the seeded order ids, so it must run before any scenario that consumes seed orders
  // (the crossing scenarios restore quantity with new orders, so the original ids go stale).
  const ordered = [...SCENARIOS.filter((s) => s === 'cancel'), ...SCENARIOS.filter((s) => s !== 'cancel')];
  for (const n of bookSizes) {
    for (const scenario of ordered) {
      log(`cell: ${scenario} book=${n}/side`);
      const c = await runCell(n, scenario);
      result.cells.push(c);
      const l = c.latency_ns;
      log(`  ${c.samples} samples, p50 ${(l.p50 / 1e6).toFixed(2)} ms, p99 ${(l.p99 / 1e6).toFixed(2)} ms, anomalies ${c.anomalies}`);
      if (c.anomalies > 0) exitCode = 2;
    }
  }

  result.load = [];
  for (const n of loadSizes) {
    await ensureSeeded(n);
    log(`load: book=${n}/side warmup`);
    await closedLoopPairs(n, P.load.warmup_requests, false, `warm-${n}`);
    log(`load: book=${n}/side idle (closed loop, 1 in flight)`);
    const idle = await closedLoopPairs(n, P.load.idle_samples, true, `idle-${n}`);
    const entry: any = {
      book_size_per_side: n,
      idle: { e2e_ns: { all: summarize([...idle.rest, ...idle.cross]), rest: summarize(idle.rest), cross: summarize(idle.cross) }, anomalies: idle.anomalies.length },
      steps: [],
    };
    if (idle.anomalies.length > 0) exitCode = 2;
    result.load.push(entry);
    for (const rate of P.load.rates as number[]) {
      for (let i = 0; i < 100 && (await ctl.lLen(INCOMING)) > 0; i++) await sleep(200);
      await sleep(1000);
      log(`load: book=${n}/side open loop ${rate} req/s for ${P.load.duration_seconds}s`);
      const r = await openLoop(n, rate);
      entry.steps.push(r);
      const saturated = r.lost > 0 || r.achieved_rate < 0.9 * rate || r.anomalies > 0;
      log(`  received ${r.received}/${r.requests}, achieved ${r.achieved_rate.toFixed(0)}/s, p50 ${((r.e2e_ns.all as any).p50 / 1e6).toFixed(2)} ms, p99 ${((r.e2e_ns.all as any).p99 / 1e6).toFixed(2)} ms, max queue ${r.queue_depth.max}`);
      if (r.anomalies > 0) exitCode = 2;
      if (saturated) { entry.stopped_early_at_rate = rate; log('  saturated or anomalous; not running higher rates'); break; }
    }
  }
  result.status = exitCode === 0 ? 'ok' : 'anomalies';
} catch (e: any) {
  result.status = 'failed';
  result.error = String(e?.message ?? e);
  log('FAILED:', result.error);
  exitCode = 1;
} finally {
  stopRx = true;
  result.finished_at = new Date().toISOString();
  result.leftover_side_effect_queues = {
    [SETTLEMENT]: await ctl.lLen(SETTLEMENT).catch(() => null),
    [RISK]: await ctl.lLen(RISK).catch(() => null),
  };
  const backlog = await ctl.lLen(INCOMING).catch(() => 0);
  if (backlog > 0) {
    log(`dropping ${backlog} unprocessed requests left in ${INCOMING} by this run`);
    result.dropped_backlog = backlog;
    await ctl.del(INCOMING).catch(() => {});
  }
  await ctl.del(RESPONSE_QUEUE).catch(() => {});
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'layer2.json'), JSON.stringify(result, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
  await rxLoop;
  await Promise.allSettled([tx.quit(), rx.quit(), ctl.quit()]);
}
process.exit(exitCode);
