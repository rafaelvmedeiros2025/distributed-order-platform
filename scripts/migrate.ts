import { readFile } from 'node:fs/promises';
import { createPool, transaction } from '../src/db.js';
const pool = createPool();
try {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const name = '001_initial.sql';
    if (!(await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) {
      await client.query(await readFile(`migrations/${name}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
  console.log('Migrations applied');
} finally { await pool.end(); }
