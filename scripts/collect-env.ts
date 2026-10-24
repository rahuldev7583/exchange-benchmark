// Writes environment metadata (hardware, toolchains, engine commits) as JSON to stdout.
import { readFileSync } from 'node:fs';
import { cpus, totalmem, release, platform } from 'node:os';

const sh = (cmd: string): string => {
  const r = Bun.spawnSync(['sh', '-c', cmd]);
  return r.stdout.toString().trim();
};
const read = (path: string): string => {
  try { return readFileSync(path, 'utf8').trim(); } catch { return 'n/a'; }
};

const c = cpus();
console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  host: sh('hostname'),
  cpu_model: c[0]?.model ?? 'unknown',
  cpu_threads: c.length,
  memory_gb: +(totalmem() / 2 ** 30).toFixed(1),
  kernel: `${platform()} ${release()}`,
  cpu_governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
  turbo_disabled: read('/sys/devices/system/cpu/intel_pstate/no_turbo'),
  pinned_cpu: process.env.BENCH_CPU ?? 'none',
  rustc: sh('rustc --version'),
  cargo_profile: 'release (opt-level=3, lto=fat, codegen-units=1)',
  bun: Bun.version,
  engines: {
    rust: { repo: 'rahuldev7583/matching-engine-rust', commit: sh('git -C engines/matching-engine-rust rev-parse HEAD'), dirty: sh('git -C engines/matching-engine-rust status --porcelain') !== '' },
    ts: { repo: 'rahuldev7583/centralized-exchange', commit: sh('git -C engines/centralized-exchange rev-parse HEAD'), dirty: sh('git -C engines/centralized-exchange status --porcelain') !== '' },
  },
  harness_commit: sh('git rev-parse --verify -q HEAD || echo uncommitted'),
}, null, 2));
