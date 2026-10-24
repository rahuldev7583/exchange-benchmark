// Usage: bun scripts/report.ts results/<run-dir>
// Reads rust.json, ts.json, env.json and writes report.md, summary.csv in the run dir.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: bun scripts/report.ts <run-dir>');

const load = (f: string) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null);
const env = load('env.json');
const data: Record<string, any> = { rust: load('rust.json'), ts: load('ts.json') };

const fmt = (ns: number): string =>
  ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${Math.round(ns)} ns`;
const fmtOps = (x: number): string => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : x.toFixed(0));

const cells = (engine: string): any[] => data[engine]?.results ?? [];
const find = (engine: string, s: string, n: number) =>
  cells(engine).find((c) => c.scenario === s && c.book_size_per_side === n);

const scenarios = [...new Set([...cells('rust'), ...cells('ts')].map((c) => c.scenario))];
const books = [...new Set([...cells('rust'), ...cells('ts')].map((c) => c.book_size_per_side))].sort((a, b) => a - b);

const lines: string[] = [];
const csv = ['engine,scenario,book_size_per_side,samples,min_ns,mean_ns,p50_ns,p90_ns,p99_ns,p999_ns,max_ns,ops_per_sec'];

lines.push('# Layer 1 report: in-memory orderbook latency', '');
lines.push('Question answered: given a prepared command and an existing orderbook, how long does the in-memory operation take?', '');
lines.push('Includes matching, book mutation and result construction. Excludes Redis, JSON, network, auth, DB and workload generation.', '');

if (env) {
  lines.push('## Environment', '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Date | ${env.timestamp} |`);
  lines.push(`| Host | ${env.host} |`);
  lines.push(`| CPU | ${env.cpu_model} (${env.cpu_threads} threads) |`);
  lines.push(`| Memory | ${env.memory_gb} GB |`);
  lines.push(`| Kernel | ${env.kernel} |`);
  lines.push(`| CPU governor | ${env.cpu_governor} |`);
  lines.push(`| Turbo disabled | ${env.turbo_disabled} |`);
  lines.push(`| Pinned CPU | ${env.pinned_cpu} |`);
  lines.push(`| Rust | ${env.rustc}, ${env.cargo_profile} |`);
  lines.push(`| Bun | ${env.bun} |`);
  lines.push(`| Rust engine | \`${env.engines.rust.commit.slice(0, 10)}\`${env.engines.rust.dirty ? ' (dirty)' : ''} |`);
  lines.push(`| TS engine | \`${env.engines.ts.commit.slice(0, 10)}\`${env.engines.ts.dirty ? ' (dirty)' : ''} |`);
  lines.push(`| Harness | \`${String(env.harness_commit).slice(0, 10)}\` |`);
  lines.push(`| Profile | ${data.rust?.profile ?? data.ts?.profile} |`);
  lines.push(`| Timer overhead (median) | rust ${data.rust ? data.rust.timer_overhead_ns + ' ns' : 'n/a'}, ts ${data.ts ? data.ts.timer_overhead_ns + ' ns' : 'n/a'} |`, '');
}

lines.push('## Latency per operation', '');
for (const n of books) {
  lines.push(`### Book depth: ${n.toLocaleString()} resting orders per side`, '');
  lines.push('| Scenario | Engine | Samples | p50 | p90 | p99 | p99.9 | max | ops/s (1/mean) |');
  lines.push('|---|---|--:|--:|--:|--:|--:|--:|--:|');
  for (const s of scenarios) {
    for (const e of ['rust', 'ts']) {
      const c = find(e, s, n);
      if (!c) continue;
      const l = c.latency_ns;
      const note = c.truncated_by_budget ? ' *' : '';
      lines.push(`| ${s} | ${e} | ${c.samples.toLocaleString()}${note} | ${fmt(l.p50)} | ${fmt(l.p90)} | ${fmt(l.p99)} | ${fmt(l.p999)} | ${fmt(l.max)} | ${fmtOps(c.throughput_ops_per_sec)} |`);
      csv.push([e, s, n, c.samples, l.min, l.mean.toFixed(1), l.p50, l.p90, l.p99, l.p999, l.max, c.throughput_ops_per_sec.toFixed(1)].join(','));
    }
  }
  lines.push('');
}
if (cells('rust').concat(cells('ts')).some((c) => c.truncated_by_budget)) {
  lines.push('`*` the per-cell time budget was hit; fewer samples than the profile target were collected.', '');
}

if (data.rust && data.ts) {
  lines.push('## TS / Rust ratio (higher means Rust is faster)', '');
  lines.push('| Scenario | Book | p50 | p90 | p99 |', '|---|--:|--:|--:|--:|');
  for (const n of books) for (const s of scenarios) {
    const r = find('rust', s, n), t = find('ts', s, n);
    if (!r || !t) continue;
    const x = (k: string) => `${(t.latency_ns[k] / r.latency_ns[k]).toFixed(1)}x`;
    lines.push(`| ${s} | ${n.toLocaleString()} | ${x('p50')} | ${x('p90')} | ${x('p99')} |`);
  }
  lines.push('');
}

lines.push('## Parity check', '');
let hardFail = false;
if (data.rust && data.ts) {
  lines.push('Both engines must do the same work on the same workload. Status counts, fill counts and total filled quantity must match exactly (hard gate). Notional is `sum(fill.price * fill.filled_quantity)` and checks fill-level quantity semantics from ENGINE_CONTRACT.md §3 (warning).', '');
  lines.push('| Scenario | Book | Status/fills/qty | Fill notional |', '|---|--:|:-:|:-:|');
  for (const n of books) for (const s of scenarios) {
    const r = find('rust', s, n), t = find('ts', s, n);
    if (!r || !t) continue;
    const core = (c: any) => JSON.stringify([c.parity.statuses, c.parity.fills, c.parity.filled_quantity]);
    const coreOk = core(r) === core(t);
    const notionalOk = r.parity.notional === t.parity.notional;
    if (!coreOk) hardFail = true;
    lines.push(`| ${s} | ${n.toLocaleString()} | ${coreOk ? 'match' : '**MISMATCH**'} | ${notionalOk ? 'match' : 'differs'} |`);
  }
  lines.push('');
  if (hardFail) lines.push('> **Parity FAILED.** The latency numbers above compare different work and must not be published.', '');
} else {
  lines.push('Only one engine present in this run; parity not checked.', '');
}

lines.push('## Methodology notes', '');
lines.push(
  '- Each round builds a fresh seeded book (untimed), prepares all commands (untimed), then times each command individually with a monotonic nanosecond clock. Rust: `Instant`. TS: `Bun.nanoseconds()`.',
  '- Percentiles use nearest-rank over every timed sample. Warm-up rounds are discarded. TS runs `Bun.gc(true)` between seeding and timing; Rust has no GC.',
  '- Workload and scenario definitions: `docs/METHODOLOGY.md`. Both harnesses implement the same deterministic formulas with no randomness.',
  '- Rust result construction mirrors `main.rs` (status, filled, remaining, fills) without serialisation. The TS `createOrder` also builds `settlement` and `risk` side-effect payloads internally (excluded from the contract, but not separable without modifying the engine), so TS numbers include that cost.',
  '- TS `Fill` ids and order ids use `crypto.randomUUID`; Rust uses `Uuid::new_v4`. Both are part of the engine path and are included.',
  '',
);

writeFileSync(join(dir, 'report.md'), lines.join('\n'));
writeFileSync(join(dir, 'summary.csv'), csv.join('\n') + '\n');
console.log(`wrote ${join(dir, 'report.md')} and summary.csv`);
if (hardFail) process.exit(2);
