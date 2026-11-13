// Usage:
//   bun scripts/report-layer2.ts <run-dir> [<run-dir> ...]   report for the given runs
//   bun scripts/report-layer2.ts --latest <profile>          newest rust + ts run of that profile
// Writes report.md next to a single run, or results/layer2-compare-<profile>-<ts>/report.md for comparisons.
// Exit code 2 when two compared runs did different work (parity gate).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let dirs = process.argv.slice(2);
let outDir: string | undefined;
if (dirs[0] === '--latest') {
  const profile = dirs[1] ?? 'full';
  const all = readdirSync('results').filter((d) => d.startsWith('layer2-2') && d.endsWith(`-${profile}`)).sort();
  dirs = ['rust', 'ts']
    .map((e) => all.filter((d) => d.includes(`-${e}-`)).pop())
    .filter((d): d is string => !!d)
    .map((d) => join('results', d));
  if (dirs.length === 0) throw new Error(`no layer2 runs found for profile ${profile}`);
  outDir = join('results', `layer2-compare-${profile}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`);
}
if (dirs.length === 0) throw new Error('usage: report-layer2.ts <run-dir>...');
if (!outDir) outDir = dirs.length === 1 ? dirs[0]! : join('results', `layer2-compare-${Date.now()}`);

const runs = dirs.map((d) => ({
  dir: d,
  r: JSON.parse(readFileSync(join(d, 'layer2.json'), 'utf8')),
  env: existsSync(join(d, 'env.json')) ? JSON.parse(readFileSync(join(d, 'env.json'), 'utf8')) : null,
}));

const ms = (ns: number | undefined) => (ns === undefined || Number.isNaN(ns) ? 'n/a' : ns < 0 ? '~0 (noise)' : ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : `${(ns / 1e3).toFixed(0)} µs`);
const sub = (a?: number, b?: number) => (a === undefined || b === undefined ? undefined : a - b);
const int = (n: number) => n.toLocaleString('en-US');
const PS = ['p50', 'p95', 'p99'] as const;
const L: string[] = [];
const csv = ['engine,section,book_size,scenario_or_rate,achieved_rate,lost,p50_ns,p90_ns,p99_ns,p999_ns,max_ns,extra'];
let parityFailed = false;

const find = (engine: string) => runs.find((x) => x.r.engine === engine);
const rust = find('rust'), ts = find('ts');
const cellOf = (run: typeof rust, scenario: string, n: number) => run?.r.cells?.find((c: any) => c.scenario === scenario && c.book_size_per_side === n);

const scenarios: string[] = runs[0]!.r.scenarios ?? [];
const bookSizes: number[] = [...new Set<number>(runs.flatMap((x) => (x.r.cells ?? []).map((c: any) => c.book_size_per_side)))].sort((a, b) => a - b);

L.push('# Layer 2 report: engine service latency (queue, engine, result channel)', '');
L.push('Question answered: how long does an order take to travel through the Redis queue, the engine and the result channel, for the same scenarios as Layer 1?', '');
L.push('Every number below is measured on one clock (the load generator), from the intended send time to the moment the matching result is read from `response-queue-{backend_id}`.', '');

L.push('## Runs', '');
L.push('| Engine | Profile | Status | Engine host | Load generator | Redis | Engine commit |', '|---|---|---|---|---|---|---|');
for (const { r, env } of runs) {
  L.push(`| ${r.engine} | ${r.profile} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.host_desc.engine ?? 'n/a'} | ${r.host_desc.loadgen ?? env?.cpu_model ?? 'n/a'} | ${r.host_desc.redis ?? 'n/a'} | \`${env?.engines?.[r.engine]?.commit?.slice(0, 10) ?? 'n/a'}\`${env?.engines?.[r.engine]?.dirty ? ' (dirty)' : ''} |`);
}
L.push('');

L.push('## How latency is separated', '');
L.push('| Component | How it is obtained |', '|---|---|');
L.push('| Transport floor | Echo: `LPUSH` then `BRPOP` on a private key through the same Redis database, same connections, no engine. |');
L.push('| Engine service time (est.) | Closed-loop end-to-end (one request in flight) minus transport floor, per percentile. Includes the engine host\'s own Redis hops, parse, match and serialise. |');
L.push('| Queue wait (est.) | Open-loop end-to-end at a rate minus the closed-loop end-to-end of the same book, per percentile. Cross-checked by sampled `LLEN incoming-request`. |');
L.push('| Sender-side delay | `send lag` (intended time to LPUSH issued), `LPUSH ack` (issued to acknowledged by Redis) and `post-enqueue` (acknowledged to response read) are reported separately so load-generator delay is not mistaken for engine delay. |', '');
L.push('Percentile subtraction is an approximation. The raw end-to-end percentiles are the primary result.', '');

// ---- Part A ----
L.push('## Scenarios over Redis (closed loop, one request in flight)', '');
L.push('Same scenarios, book seeding and command formulas as Layer 1 (`docs/METHODOLOGY.md`), but every operation travels `LPUSH incoming-request` → engine → `response-queue`. The book is restored after every round (untimed) so its depth stays constant.', '');
for (const n of bookSizes) {
  L.push(`### Book depth: ${int(n)} resting orders per side`, '');
  L.push('| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) | Floor p50 | Engine est. p50 |', '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const s of scenarios) {
    for (const run of [rust, ts]) {
      const c = cellOf(run, s, n);
      if (!c) continue;
      const l = c.latency_ns;
      const f = run!.r.floor?.echo_ns?.p50;
      L.push(`| ${s} | ${run!.r.engine} | ${int(c.samples)}${c.truncated_by_budget ? ' (budget)' : ''} | ${ms(l.p50)} | ${ms(l.p90)} | ${ms(l.p99)} | ${ms(l.p999)} | ${ms(l.max)} | ${c.ops_per_sec_closed_loop.toFixed(0)} | ${ms(f)} | ${ms(sub(l.p50, f))} |`);
      csv.push([run!.r.engine, 'cell', n, s, '', '', l.p50, l.p90, l.p99, l.p999, l.max, ''].join(','));
    }
  }
  L.push('');
}
if (rust && ts) {
  L.push('### TS / Rust ratio (above 1 means Rust is faster end to end)', '');
  L.push('| Scenario | Book | p50 | p90 | p99 |', '|---|--:|--:|--:|--:|');
  for (const n of bookSizes) for (const s of scenarios) {
    const a = cellOf(rust, s, n)?.latency_ns, b = cellOf(ts, s, n)?.latency_ns;
    if (!a || !b) continue;
    L.push(`| ${s} | ${int(n)} | ${(b.p50 / a.p50).toFixed(2)}x | ${(b.p90 / a.p90).toFixed(2)}x | ${(b.p99 / a.p99).toFixed(2)}x |`);
  }
  L.push('', 'Over Redis the in-memory difference from Layer 1 is mostly hidden behind network round trips. Ratios close to 1 mean the Redis path dominates; they are not a contradiction of Layer 1.', '');
}

// ---- Parity ----
L.push('## Parity check', '');
if (rust && ts) {
  L.push('Both engines must do the same work on the same workload, including the same Redis side effects. Status counts, fill count, filled quantity and notional come from the first timed round; side-effect messages are the `settlement-queue` / `matching-to-risk-pub-queue` entries each engine wrote during that round (round trips are not compared, message counts are).', '');
  L.push('| Scenario | Book | Status/fills/qty | Notional | Settlement msgs (rust / ts) | Risk msgs (rust / ts) | Requests (rust / ts) |', '|---|--:|:-:|:-:|:-:|:-:|:-:|');
  for (const n of bookSizes) for (const s of scenarios) {
    const a = cellOf(rust, s, n), b = cellOf(ts, s, n);
    if (!a || !b) continue;
    const same = JSON.stringify([a.parity.statuses, a.parity.fills, a.parity.filled_quantity]) === JSON.stringify([b.parity.statuses, b.parity.fills, b.parity.filled_quantity]);
    const notional = a.parity.notional === b.parity.notional;
    const sa = a.first_round_side_effects, sb = b.first_round_side_effects;
    const settle = sa?.settlement_msgs === sb?.settlement_msgs, risk = sa?.risk_msgs === sb?.risk_msgs, reqs = sa?.requests === sb?.requests;
    if (!same || !notional || !settle || !risk || !reqs) parityFailed = true;
    L.push(`| ${s} | ${int(n)} | ${same ? 'match' : '**MISMATCH**'} | ${notional ? 'match' : '**MISMATCH**'} | ${sa?.settlement_msgs} / ${sb?.settlement_msgs} ${settle ? '' : '**MISMATCH**'} | ${sa?.risk_msgs} / ${sb?.risk_msgs} ${risk ? '' : '**MISMATCH**'} | ${sa?.requests} / ${sb?.requests} ${reqs ? '' : '**MISMATCH**'} |`);
  }
  L.push('', parityFailed ? '**Parity FAILED: the engines did different work. Do not compare these runs.**' : 'Parity passed: identical statuses, fills, quantities, notional and side-effect message counts.', '');
} else {
  L.push('Single-engine report: run both engines and use `make layer2-report` for the parity comparison.', '');
}

// ---- Part B ----
L.push('## Latency under load (open loop, fixed arrival rate)', '');
L.push('A pair stream on a seeded book: a taker crosses the best level (1 fill), then a maker re-adds the consumed quantity. Latency is measured from each request\'s scheduled send time, so a stalled sender or engine is not hidden (no coordinated omission).', '');
const loadSizes: number[] = [...new Set<number>(runs.flatMap((x) => (x.r.load ?? []).map((e: any) => e.book_size_per_side)))].sort((a, b) => a - b);
for (const n of loadSizes) {
  L.push(`### Book depth: ${int(n)} resting orders per side`, '');
  for (const run of [rust, ts]) {
    const e = run?.r.load?.find((x: any) => x.book_size_per_side === n);
    if (!e) continue;
    const idleAll = e.idle.e2e_ns.all;
    L.push(`**${run!.r.engine}** (closed-loop baseline p50 ${ms(idleAll.p50)}, p99 ${ms(idleAll.p99)})`, '');
    L.push('| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 | LPUSH ack p50 | LPUSH ack p99 | Post-enqueue p50 | p99 | Max burst |', '|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const l of e.steps) {
      const s = l.e2e_ns.all;
      const qw = PS.map((p) => sub(s[p], idleAll[p]));
      L.push(`| ${l.offered_rate} | ${l.achieved_rate.toFixed(0)} | ${l.lost} | ${PS.map((p) => ms(s[p])).join(' | ')} | ${ms(s.max)} | ${qw.map(ms).join(' | ')} | ${l.queue_depth.max} | ${ms(l.send_lag_ns.p99)} | ${ms(l.lpush_ack_ns.p50)} | ${ms(l.lpush_ack_ns.p99)} | ${ms(l.post_enqueue_ns.p50)} | ${ms(l.post_enqueue_ns.p99)} | ${l.send_burst.max ?? 'n/a'} |`);
      csv.push([run!.r.engine, 'load', n, l.offered_rate, l.achieved_rate.toFixed(1), l.lost, s.p50, s.p90, s.p99, s.p999, s.max, `maxqueue=${l.queue_depth.max}`].join(','));
    }
    if (e.stopped_early_at_rate) L.push('', `Stopped after ${e.stopped_early_at_rate} req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.`);
    L.push('');
  }
  if (rust && ts) {
    const a = rust.r.load?.find((x: any) => x.book_size_per_side === n), b = ts.r.load?.find((x: any) => x.book_size_per_side === n);
    const rates = (a?.steps ?? []).map((l: any) => l.offered_rate).filter((x: number) => b?.steps.some((m: any) => m.offered_rate === x));
    if (rates.length) {
      L.push('Side by side (end-to-end, all requests)', '');
      L.push('| Offered/s | rust p50 | rust p95 | rust p99 | ts p50 | ts p95 | ts p99 | rust achieved/s | ts achieved/s |', '|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
      for (const rate of rates) {
        const x = a.steps.find((l: any) => l.offered_rate === rate), y = b.steps.find((l: any) => l.offered_rate === rate);
        L.push(`| ${rate} | ${PS.map((p) => ms(x.e2e_ns.all[p])).join(' | ')} | ${PS.map((p) => ms(y.e2e_ns.all[p])).join(' | ')} | ${x.achieved_rate.toFixed(0)} | ${y.achieved_rate.toFixed(0)} |`);
      }
      L.push('');
    }
  }
}

L.push('## Validity checks', '');
L.push('| Engine | Anomalies (scenarios) | Anomalies (load idle) | Anomalies (load) | Leftover settlement-queue | Leftover risk queue |', '|---|--:|--:|--:|--:|--:|');
for (const { r } of runs) {
  const ac = (r.cells ?? []).reduce((s: number, c: any) => s + c.anomalies, 0);
  const ai = (r.load ?? []).reduce((s: number, e: any) => s + e.idle.anomalies, 0);
  const al = (r.load ?? []).reduce((s: number, e: any) => s + e.steps.reduce((t: number, l: any) => t + l.anomalies, 0), 0);
  L.push(`| ${r.engine} | ${ac} | ${ai} | ${al} | ${r.leftover_side_effect_queues?.['settlement-queue'] ?? 'n/a'} | ${r.leftover_side_effect_queues?.['matching-to-risk-pub-queue'] ?? 'n/a'} |`);
}
L.push('', 'An anomaly is a response whose status differs from what the identical workload must produce (see `docs/LAYER2.md`). Any anomaly invalidates the comparison.', '');
L.push('## Notes', '');
L.push(
  '- Both engines consume the same Redis database, same keys and byte-identical requests. Each run uses a unique `BACKEND_ID`, so response queues never collide.',
  '- The engine must be restarted before every run: the preflight aborts unless `incoming-request` is empty and every benchmark book is empty.',
  '- Both engines publish response, settlement and risk messages without blocking the matching path (Rust: writer threads with pipelining; TS: un-awaited `lPush`). Message counts per request are checked in the parity table.',
  '- Settlement/risk payload formats are excluded from the contract (TS human decimals, Rust integer base units).',
  '- Engine CPU is not captured from the load generator; record it on the engine host if needed (`pidstat -p <pid> 1`).',
  '- For order-bias control repeat the pair of runs in alternating engine order (rust, ts, ts, rust).',
  '- Workload definition: `docs/LAYER2.md`.',
  '',
);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.md'), L.join('\n'));
writeFileSync(join(outDir, 'summary.csv'), csv.join('\n') + '\n');
console.log(`wrote ${join(outDir, 'report.md')}`);
if (parityFailed) process.exit(2);
