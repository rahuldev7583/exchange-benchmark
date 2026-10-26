// Layer 2: engine service benchmark, black box over Redis.
// Path measured: LPUSH incoming-request -> engine (BRPOP, parse, match, publish) -> response-queue-{backend} receive.
// Protocol: engines/centralized-exchange/ENGINE_CONTRACT.md §4. Workload: docs/LAYER2.md.
import { createClient } from 'redis';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const engine = arg('--engine');
if (engine !== 'rust' && engine !== 'ts') throw new Error('--engine rust|ts is required');
const profileName = arg('--profile') ?? 'full';
const ratesOverride = arg('--rates')?.split(',').map(Number);
const outDir = arg('--out');
const conf = JSON.parse(readFileSync(arg('--config') ?? '../config/layer2.json', 'utf8'));
const P = conf.profiles[profileName];
if (!P) throw new Error(`unknown profile ${profileName}`);
if (ratesOverride) P.rates = ratesOverride;
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error('REDIS_URL is not set');

const SYMBOL: string = conf.symbol;
const MID: number = conf.mid_price;
const L: number = conf.levels;
const U: number = conf.qty_unit;
const INCOMING = 'incoming-request';

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
  return { count: s.length, min: s[0], mean: sum / s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] };
}

// ---- Receiver: single loop draining the shared response queue ----
type Rec = { kind: 'rest' | 'cross' | 'seed' | 'depth'; qty: number; intended: number; sent: number; recv?: number; resp?: any; anomaly?: string };
const pending = new Map<string, Rec>();
let stopRx = false;
let responseCount = 0;

function onItems(items: string[], t: number) {
  for (const raw of items) {
    responseCount++;
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
const waiters = new Map<string, () => void>();

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

// ---- Request construction (identical for both engines) ----
const envelope = (request_id: string, payload: unknown, command = 'create-order') =>
  JSON.stringify({ BACKEND_ID, request_id, payload, command });
const orderPayload = (side: 'buy' | 'sell', qty: number, price: number, user_id: number) =>
  ({ type: 'limit', quantity: String(qty), price: String(price), symbol: SYMBOL, user_id, side });

// Request k of the steady-state stream. Pairs: even k = maker rests at the working level, odd k = taker crosses exactly it.
function workloadRequest(k: number, id: string): { body: string; kind: 'rest' | 'cross'; qty: number } {
  const pair = k >> 1;
  const sellMaker = pair % 2 === 0;
  if ((k & 1) === 0) {
    const price = sellMaker ? MID + 1 : MID - 1;
    return { body: envelope(id, orderPayload(sellMaker ? 'sell' : 'buy', U, price, 10_000 + (pair % 100))), kind: 'rest', qty: U };
  }
  const price = sellMaker ? MID + 1 : MID - 1;
  return { body: envelope(id, orderPayload(sellMaker ? 'buy' : 'sell', U, price, 1_000_000 + pair)), kind: 'cross', qty: U };
}

function validate(rec: Rec) {
  const r = rec.resp;
  if (!r) return;
  const filled = (() => { try { return BigInt(String(r.filled_quantity)); } catch { return -1n; } })();
  const nFills = Array.isArray(r.fills) ? r.fills.length : -1;
  if (rec.kind === 'rest' || rec.kind === 'seed') {
    if (r.status !== 'accepted' || filled !== 0n || nFills !== 0) rec.anomaly = `expected accepted/0 fills, got ${r.status}/${nFills}`;
  } else if (rec.kind === 'cross') {
    if (r.status !== 'fully_filled' || filled !== BigInt(rec.qty) || nFills !== 1) rec.anomaly = `expected fully_filled/1 fill, got ${r.status}/${nFills}`;
  }
}

function sendOne(id: string, body: string, kind: Rec['kind'], qty: number, intended = now()): Rec {
  const rec: Rec = { kind, qty, intended, sent: now() };
  pending.set(id, rec);
  tx.lPush(INCOMING, body).catch((e: any) => log('send error', e?.message ?? e));
  return rec;
}
function awaitRec(id: string, rec: Rec, timeoutMs: number): Promise<boolean> {
  if (rec.recv !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(id); resolve(false); }, timeoutMs);
    waiters.set(id, () => { clearTimeout(timer); waiters.delete(id); resolve(true); });
  });
}

// ---- Preflight ----
async function preflight() {
  // A queue that is draining (e.g. leftovers from an aborted run while the engine catches up) is fine; one that never empties is not.
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
  for (let attempt = 0; now() < deadline; attempt++) {
    const id = `${runId}-depth-${attempt}`;
    const body = envelope(id, SYMBOL, 'get-depth');
    probes.push(body);
    const rec = sendOne(id, body, 'depth', 0);
    if (await awaitRec(id, rec, 2000)) {
      const bids = rec.resp?.bids?.length ?? -1, asks = rec.resp?.asks?.length ?? -1;
      if (bids !== 0 || asks !== 0) {
        throw new Error(`Orderbook is not empty (bids=${bids}, asks=${asks}). Restart the engine so every run starts from the same empty book.`);
      }
      log('engine ready, book empty');
      return;
    }
    pending.delete(id);
  }
  // Remove our unanswered probes so they do not poison the next run.
  for (const body of probes) await ctl.lRem(INCOMING, 0, body).catch(() => {});
  throw new Error('engine did not answer get-depth within 30s. Is it running against the same REDIS_URL?');
}

// ---- Phase: transport floor (echo through Redis only, no engine) ----
async function measureFloor() {
  const pings: number[] = [];
  for (let i = 0; i < 50; i++) { const t = now(); await ctl.ping(); pings.push(now() - t); }
  const sample = workloadRequest(0, `${runId}-echo-000000`).body;
  // Dedicated connection so the echo consumer is not queued behind the response receiver's blocking BRPOP.
  const echoRx = mk('echo-consumer');
  await echoRx.connect();
  const settleMs = Math.ceil(((pings.sort((a, b) => a - b)[25] ?? 1e6) / 1e6) * 1.5) + 2;
  const lat: number[] = [];
  const total = P.floor_samples + 20;
  for (let i = 0; i < total; i++) {
    // Consumer is already blocked when the producer pushes, like the engine waiting on incoming-request.
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

// ---- Phase: seed the book through the engine (identical for both) ----
async function seedBook() {
  const n: number = P.seed_orders_per_side;
  const reqs: { id: string; body: string; qty: number }[] = [];
  for (let i = 0; i < n; i++) {
    const qty = U * (5 + (i % 5));
    const d = 2 + (i % L);
    reqs.push({ id: `${runId}-seed-a${i}`, body: envelope(`${runId}-seed-a${i}`, orderPayload('sell', qty, MID + d, 1 + (i % 100))), qty });
    reqs.push({ id: `${runId}-seed-b${i}`, body: envelope(`${runId}-seed-b${i}`, orderPayload('buy', qty, MID - d, 1 + ((i + 50) % 100))), qty });
  }
  const WINDOW = 50;
  for (let i = 0; i < reqs.length; i += WINDOW) {
    const batch = reqs.slice(i, i + WINDOW).map((r) => ({ r, rec: sendOne(r.id, r.body, 'seed', r.qty) }));
    for (const { r, rec } of batch) {
      if (!(await awaitRec(r.id, rec, 15000))) throw new Error(`seed request ${r.id} timed out`);
      validate(rec);
      if (rec.anomaly) throw new Error(`seed anomaly ${r.id}: ${rec.anomaly}`);
    }
  }
  log(`seeded ${reqs.length} resting orders`);
}

// ---- Phase: closed loop, one request in flight (service time without queueing) ----
let k = 0;
async function closedLoop(count: number, record: boolean, label: string) {
  const n = count + (count % 2);
  const recs: { rest: number[]; cross: number[]; anomalies: string[] } = { rest: [], cross: [], anomalies: [] };
  for (let i = 0; i < n; i++, k++) {
    const id = `${runId}-${label}-${i}`;
    const w = workloadRequest(k, id);
    const rec = sendOne(id, w.body, w.kind, w.qty);
    if (!(await awaitRec(id, rec, 15000))) throw new Error(`${label} request ${id} timed out (engine stalled?)`);
    validate(rec);
    if (!record) continue;
    if (rec.anomaly) recs.anomalies.push(rec.anomaly);
    (w.kind === 'rest' ? recs.rest : recs.cross).push(rec.recv! - rec.intended);
  }
  return recs;
}

// ---- Phase: open loop at a fixed rate; latency from the intended send time ----
async function openLoop(rate: number) {
  const total = Math.floor((rate * P.duration_seconds) / 2) * 2;
  const stamp = `${runId}-r${rate}`;
  const items = Array.from({ length: total }, (_, i) => ({ id: `${stamp}-${i}`, ...workloadRequest(k + i, `${stamp}-${i}`) }));
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
  while (sent < total) {
    const t = now();
    const due = t < start ? 0 : Math.min(total, Math.floor((t - start) / gapNs) + 1);
    while (sent < due) {
      const it = items[sent]!;
      recs[sent] = sendOne(it.id, it.body, it.kind, it.qty, start + sent * gapNs);
      sent++;
    }
    await sleep(1);
  }
  const sendEnd = now();

  const drainDeadline = now() + P.drain_timeout_seconds * 1e9;
  while (now() < drainDeadline && recs.some((r) => r.recv === undefined)) await sleep(20);
  sampling = false;
  await sampler;

  const got = recs.filter((r) => r.recv !== undefined);
  const lost = total - got.length;
  for (const r of recs) if (r.recv === undefined) { for (const [id, v] of pending) if (v === r) pending.delete(id); }
  const anomalies: string[] = [];
  for (const r of got) { validate(r); if (r.anomaly) anomalies.push(r.anomaly); }
  const lastRecv = got.reduce((m, r) => Math.max(m, r.recv!), start);
  return {
    offered_rate: rate,
    requests: total,
    received: got.length,
    lost,
    achieved_rate: got.length / ((lastRecv - start) / 1e9),
    send_lag_ns: summarize(recs.map((r) => r.sent - r.intended)),
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
const result: any = {
  layer: 2, engine, profile: profileName, run_id: runId, backend_id: BACKEND_ID,
  started_at: new Date().toISOString(),
  host_desc: { engine: process.env.ENGINE_HOST_DESC ?? null, loadgen: process.env.LOADGEN_HOST_DESC ?? null, redis: process.env.REDIS_DESC ?? null },
  config: P, status: 'running',
};
let exitCode = 0;
try {
  await preflight();
  log('phase: transport floor (echo, no engine)');
  result.floor = await measureFloor();
  log('phase: seed');
  await seedBook();
  log('phase: warmup');
  await closedLoop(P.warmup_requests, false, 'warm');
  log('phase: idle (closed loop, 1 in flight)');
  const idle = await closedLoop(P.idle_samples, true, 'idle');
  result.idle = {
    e2e_ns: { all: summarize([...idle.rest, ...idle.cross]), rest: summarize(idle.rest), cross: summarize(idle.cross) },
    anomalies: idle.anomalies.length,
  };
  result.load = [];
  for (const rate of P.rates as number[]) {
    for (let i = 0; i < 100 && (await ctl.lLen(INCOMING)) > 0; i++) await sleep(200);
    await sleep(1000);
    log(`phase: open loop ${rate} req/s for ${P.duration_seconds}s`);
    const r = await openLoop(rate);
    result.load.push(r);
    const saturated = r.lost > 0 || r.achieved_rate < 0.9 * rate || r.anomalies > 0;
    log(`  received ${r.received}/${r.requests}, achieved ${r.achieved_rate.toFixed(0)}/s, p50 ${((r.e2e_ns.all as any).p50 / 1e6).toFixed(2)} ms, p99 ${((r.e2e_ns.all as any).p99 / 1e6).toFixed(2)} ms, max queue ${r.queue_depth.max}`);
    if (r.anomalies > 0) exitCode = 2;
    if (saturated) { result.stopped_early_at_rate = rate; log('  saturated or anomalous; not running higher rates'); break; }
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
    'settlement-queue': await ctl.lLen('settlement-queue').catch(() => null),
    'matching-to-risk-pub-queue': await ctl.lLen('matching-to-risk-pub-queue').catch(() => null),
  };
  // Preflight proved we were the only producer, so anything still queued is our own unprocessed backlog
  // (a saturated step). Drop it so it cannot poison the next run.
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
