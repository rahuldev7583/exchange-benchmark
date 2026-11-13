// Prints the MARKETS_FIXTURE JSON the engines need for layer 2: one market per book size
// of every profile (L2_<n>). Used by start-engine.sh so both engines load identical markets.
import { readFileSync } from 'node:fs';

const conf = JSON.parse(readFileSync(process.argv[2] ?? 'config/layer2.json', 'utf8'));
const sizes = new Set<number>();
for (const p of Object.values<any>(conf.profiles)) {
  for (const n of p.book_sizes) sizes.add(n);
  for (const n of p.load.book_sizes) sizes.add(n);
}
const markets = [...sizes].sort((a, b) => a - b).map((n) => ({ symbol: `${conf.symbol_prefix}_${n}` }));
console.log(JSON.stringify({ markets }));
