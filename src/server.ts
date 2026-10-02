import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createPool } from './db.js';
const pool = createPool();
if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', error => console.error('Redis connection error:', error.message));
const app = await buildApp(pool, redis, true);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await Promise.all([pool.end(), redis.quit()]);
}
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
try { await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' }); }
catch (error) { app.log.error(error); await shutdown(); process.exitCode = 1; }
