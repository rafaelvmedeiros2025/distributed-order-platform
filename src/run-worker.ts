import { setTimeout } from 'node:timers/promises';
import { createPool } from './db.js';
import { processNext } from './worker.js';
const pool = createPool();
const pollMs = Number(process.env.WORKER_POLL_MS ?? 500);
if (!Number.isFinite(pollMs) || pollMs < 10) throw new Error('WORKER_POLL_MS must be at least 10');
let stopping = false;
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { stopping = true; });
try {
  while (!stopping) {
    try {
      const processed = await processNext(pool);
      if (processed) console.log(JSON.stringify({ level: 'info', event: 'outbox.processed', time: new Date().toISOString() }));
      if (!processed) await setTimeout(pollMs);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'worker.error', message: error instanceof Error ? error.message : 'Unknown error' }));
      await setTimeout(pollMs);
    }
  }
} finally { await pool.end(); }
