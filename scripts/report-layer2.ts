// Usage:
//   bun scripts/report-layer2.ts <run-dir> [<run-dir> ...]   report for the given runs
//   bun scripts/report-layer2.ts --latest <profile>          newest rust + ts run of that profile
// Writes report.md next to a single run, or results/layer2-compare-<profile>-<ts>/report.md for comparisons.
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
const PS = ['p50', 'p95', 'p99'] as const;
const L: string[] = [];
const csv = ['engine,section,offered_rate,achieved_rate,lost,p50_ns,p95_ns,p99_ns,max_ns,queue_wait_p50_ns,queue_wait_p95_ns,queue_wait_p99_ns,max_queue_depth'];

L.push('# Layer 2 report: engine service latency (queue, engine, result channel)', '');
L.push('Question answered: how long does an order take to travel through the Redis queue, the engine and the result channel?', '');
L.push('Every number below is measured on one clock (the load generator), from the intended send time to the moment the matching result is read from `response-queue-{backend_id}`.', '');

L.push('## Runs', '');
L.push('| Engine | Profile | Status | Engine host | Load generator | Redis | Engine commit |', '|---|---|---|---|---|---|---|');
for (const { r, env } of runs) {
  L.push(`| ${r.engine} | ${r.profile} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.host_desc.engine ?? 'n/a'} | ${r.host_desc.loadgen ?? env?.cpu_model ?? 'n/a'} | ${r.host_desc.redis ?? 'n/a'} | \`${env?.engines?.[r.engine]?.commit?.slice(0, 10) ?? 'n/a'}\` |`);
}
L.push('');

L.push('## How latency is separated', '');
L.push('| Component | How it is obtained |', '|---|---|');
L.push('| Transport floor | Echo: `LPUSH` then `BRPOP` on a private key through the same Redis database, same connections, same payload size, no engine. Includes load generator to Redis and back. |');
L.push('| Engine service time (est.) | Idle end-to-end (one request in flight) minus transport floor, per percentile. Includes the engine host\'s own Redis hops (BRPOP wake-up, publish) plus parse, match and serialise. |');
L.push('| Queue wait (est.) | End-to-end at a given rate minus idle end-to-end, per percentile. Cross-checked by sampled `LLEN incoming-request`. |', '');
L.push('Percentile subtraction is an approximation (percentiles of a difference are not the difference of percentiles). Treat these as component estimates; the raw end-to-end percentiles are the primary result.', '');

L.push('## Idle latency (closed loop, one request in flight)', '');
L.push('| Engine | Kind | p50 | p95 | p99 | Floor p50 | Floor p95 | Floor p99 | Engine service est. p50 | p95 | p99 |', '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
for (const { r } of runs) {
  if (!r.idle) continue;
  const f = r.floor?.echo_ns ?? {};
  for (const kind of ['rest', 'cross', 'all'] as const) {
    const s = r.idle.e2e_ns[kind];
    L.push(`| ${r.engine} | ${kind} | ${PS.map((p) => ms(s[p])).join(' | ')} | ${PS.map((p) => ms(f[p])).join(' | ')} | ${PS.map((p) => ms(sub(s[p], f[p]))).join(' | ')} |`);
    csv.push([r.engine, `idle_${kind}`, '', '', '', s.p50, s.p95, s.p99, s.max, '', '', '', ''].join(','));
  }
}
L.push('', '`rest` = limit order that rests on the book (no fill). `cross` = limit order that fully fills against one resting order.', '');
for (const { r } of runs) {
  if (r.floor) L.push(`- ${r.engine}: Redis PING RTT p50 ${ms(r.floor.ping_rtt_ns.p50)}, p99 ${ms(r.floor.ping_rtt_ns.p99)}`);
}
L.push('');

L.push('## Latency under load (open loop, fixed arrival rate)', '');
L.push('Latency is measured from each request\'s scheduled send time, so a stalled sender or engine is not hidden (no coordinated omission).', '');
for (const { r } of runs) {
  if (!r.load?.length) continue;
  const idleAll = r.idle?.e2e_ns.all ?? {};
  L.push(`### ${r.engine}`, '');
  L.push('| Offered/s | Achieved/s | Lost | p50 | p95 | p99 | max | Queue wait p50 | p95 | p99 | Max queue depth | Send lag p99 |', '|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const l of r.load) {
    const s = l.e2e_ns.all;
    const qw = PS.map((p) => sub(s[p], idleAll[p]));
    L.push(`| ${l.offered_rate} | ${l.achieved_rate.toFixed(0)} | ${l.lost} | ${PS.map((p) => ms(s[p])).join(' | ')} | ${ms(s.max)} | ${qw.map(ms).join(' | ')} | ${l.queue_depth.max} | ${ms(l.send_lag_ns.p99)} |`);
    csv.push([r.engine, 'load', l.offered_rate, l.achieved_rate.toFixed(1), l.lost, s.p50, s.p95, s.p99, s.max, ...qw, l.queue_depth.max].join(','));
  }
  if (r.stopped_early_at_rate) L.push('', `Stopped after ${r.stopped_early_at_rate} req/s: lost responses, achieved rate below 90% of offered, or anomalies. Higher rates were not run.`);
  L.push('');
}

if (runs.length === 2) {
  const [a, b] = runs;
  const rates = a!.r.load.map((l: any) => l.offered_rate).filter((x: number) => b!.r.load.some((m: any) => m.offered_rate === x));
  if (rates.length) {
    L.push('## Side by side (end-to-end, all requests)', '');
    L.push(`| Offered/s | ${a!.r.engine} p50 | ${a!.r.engine} p95 | ${a!.r.engine} p99 | ${b!.r.engine} p50 | ${b!.r.engine} p95 | ${b!.r.engine} p99 | ${a!.r.engine} achieved/s | ${b!.r.engine} achieved/s |`, '|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const rate of rates) {
      const x = a!.r.load.find((l: any) => l.offered_rate === rate), y = b!.r.load.find((l: any) => l.offered_rate === rate);
      L.push(`| ${rate} | ${PS.map((p) => ms(x.e2e_ns.all[p])).join(' | ')} | ${PS.map((p) => ms(y.e2e_ns.all[p])).join(' | ')} | ${x.achieved_rate.toFixed(0)} | ${y.achieved_rate.toFixed(0)} |`);
    }
    L.push('');
  }
}

L.push('## Validity checks', '');
L.push('| Engine | Anomalies (idle) | Anomalies (load) | Leftover settlement-queue | Leftover risk queue |', '|---|--:|--:|--:|--:|');
for (const { r } of runs) {
  const al = (r.load ?? []).reduce((s: number, l: any) => s + l.anomalies, 0);
  L.push(`| ${r.engine} | ${r.idle?.anomalies ?? 'n/a'} | ${al} | ${r.leftover_side_effect_queues?.['settlement-queue'] ?? 'n/a'} | ${r.leftover_side_effect_queues?.['matching-to-risk-pub-queue'] ?? 'n/a'} |`);
}
L.push('', 'An anomaly is a response whose status or fill count differs from what the identical workload must produce (rest => `accepted` with no fills, cross => `fully_filled` with one fill). Any anomaly invalidates the comparison.', '');
L.push('## Notes', '');
L.push(
  '- Both engines consume the same Redis database, same keys and byte-identical requests. Each run uses a unique `BACKEND_ID`, so response queues never collide.',
  '- The engine must be restarted before every run: the preflight aborts unless `incoming-request` is empty and the book is empty.',
  '- The engines also write to `settlement-queue` and `matching-to-risk-pub-queue` (no consumer is running). Those writes are part of the engine path but excluded from the parity contract.',
  '- Rate steps stop at the first saturated step to protect the shared Redis database.',
  '- Workload definition: `docs/LAYER2.md`.',
  '',
);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.md'), L.join('\n'));
writeFileSync(join(outDir, 'summary.csv'), csv.join('\n') + '\n');
console.log(`wrote ${join(outDir, 'report.md')}`);
