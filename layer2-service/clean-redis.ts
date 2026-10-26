// Deletes the engine side-effect queues that no consumer drains during benchmarks, and stale bench keys.
// Does NOT touch incoming-request: if it is non-empty, something else is using this database.
import { createClient } from 'redis';
const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is not set');
const c = createClient({ url });
await c.connect();
const incoming = await c.lLen('incoming-request');
if (incoming > 0) { console.error(`incoming-request holds ${incoming} items; refusing to clean a database in use.`); process.exit(1); }
const stale: string[] = [];
for await (const batch of c.scanIterator({ MATCH: 'response-queue-bench-*', COUNT: 200 })) stale.push(...(Array.isArray(batch) ? batch : [batch]));
for await (const batch of c.scanIterator({ MATCH: 'bench-echo-*', COUNT: 200 })) stale.push(...(Array.isArray(batch) ? batch : [batch]));
const keys = ['settlement-queue', 'matching-to-risk-pub-queue', ...stale];
const removed = await c.del(keys);
console.log(`removed ${removed} keys (${keys.length} candidates)`);
await c.quit();
