import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Redis } from 'ioredis';
import { createPool } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { processNext } from '../src/worker.js';
import type { OrderInput } from '../src/domain.js';
// Use a dedicated disposable test database: this suite truncates application tables.
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required (dedicated disposable database)');
const pool = createPool(process.env.TEST_DATABASE_URL);
const redis = process.env.TEST_REDIS_URL ? new Redis(process.env.TEST_REDIS_URL) : undefined;
const app = await buildApp(pool, redis);
const body = { customerId: 'customer-1', items: [{ sku: 'keyboard', quantity: 1 }] };
const post = (key: string, payload: OrderInput = body) => app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': key }, payload });
async function makeAvailable() { await pool.query("UPDATE outbox SET available_at=now() WHERE status='pending'"); }
describe('order processing against PostgreSQL', { concurrency: false }, () => {
  before(async () => { await pool.query(await readFile('migrations/001_initial.sql', 'utf8')); await app.ready(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE audit_events, payment_receipts, outbox, idempotency_keys, order_items, orders, products RESTART IDENTITY CASCADE');
    await pool.query("INSERT INTO products VALUES ('keyboard','Keyboard',9900,10), ('mouse','Mouse',4500,10)");
  });
  after(async () => { await app.close(); await pool.end(); if (redis) await redis.quit(); });
  test('creates an order with server-side pricing and an atomic outbox event', async () => {
    const response = await post('create');
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().total_cents, 9900);
    assert.equal(response.json().status, 'pending');
    assert.equal((await pool.query('SELECT stock FROM products WHERE sku=$1', ['keyboard'])).rows[0].stock, 9);
    assert.equal((await pool.query('SELECT * FROM outbox')).rowCount, 1);
    const read = await app.inject({ url: response.headers.location as string });
    assert.equal(read.json().id, response.json().id);
  });
  test('concurrent requests with the same key create exactly one order and reservation', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => post('same')));
    assert.equal(responses.filter(r => r.statusCode === 201).length, 1);
    assert.equal(responses.filter(r => r.statusCode === 200).length, 7);
    assert.equal(new Set(responses.map(r => r.json().id)).size, 1);
    assert.equal((await pool.query('SELECT * FROM orders')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM outbox')).rowCount, 1);
    assert.equal((await pool.query("SELECT stock FROM products WHERE sku='keyboard'")).rows[0].stock, 9);
  });
  test('same key with a changed payload returns 409', async () => {
    await post('conflict');
    const response = await post('conflict', { ...body, customerId: 'another' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'IDEMPOTENCY_CONFLICT');
  });
  test('concurrent orders cannot oversell the last item', async () => {
    await pool.query("UPDATE products SET stock=1 WHERE sku='keyboard'");
    const responses = await Promise.all([post('stock-a'), post('stock-b')]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
    assert.equal((await pool.query("SELECT stock FROM products WHERE sku='keyboard'")).rows[0].stock, 0);
  });
  test('a later unavailable item rolls back all reservations and writes', async () => {
    await pool.query("UPDATE products SET stock=0 WHERE sku='mouse'");
    const response = await post('rollback', { ...body, items: [...body.items, { sku: 'mouse', quantity: 1 }] });
    assert.equal(response.statusCode, 409);
    assert.equal((await pool.query("SELECT stock FROM products WHERE sku='keyboard'")).rows[0].stock, 10);
    assert.equal((await pool.query('SELECT * FROM orders')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM outbox')).rowCount, 0);
  });
  test('multiple workers process an event once and record one receipt', async () => {
    const response = await post('workers');
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => processNext(pool)));
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal((await pool.query('SELECT * FROM payment_receipts')).rowCount, 1);
    assert.equal((await app.inject({ url: `/orders/${response.json().id}` })).json().status, 'paid');
    assert.equal(await processNext(pool), false);
  });
  test('temporary failures are scheduled, then recover without duplicate payment', async () => {
    await post('retry', { ...body, paymentMode: 'temporary' });
    assert.equal(await processNext(pool), true);
    assert.equal(await processNext(pool), false);
    await makeAvailable(); await processNext(pool);
    await makeAvailable(); await processNext(pool);
    const event = (await pool.query('SELECT * FROM outbox')).rows[0];
    assert.equal(event.status, 'completed'); assert.equal(event.attempts, 3);
    assert.equal((await pool.query('SELECT * FROM payment_receipts')).rowCount, 1);
  });
  test('permanent failure is dead-lettered immediately and releases stock once', async () => {
    await post('decline', { ...body, paymentMode: 'declined' });
    await processNext(pool);
    const event = (await pool.query('SELECT * FROM outbox')).rows[0];
    assert.equal(event.status, 'dead'); assert.equal(event.attempts, 1);
    assert.equal((await pool.query('SELECT status FROM orders')).rows[0].status, 'failed');
    assert.equal((await pool.query("SELECT stock FROM products WHERE sku='keyboard'")).rows[0].stock, 10);
    assert.equal(await processNext(pool), false);
    assert.equal((await pool.query("SELECT stock FROM products WHERE sku='keyboard'")).rows[0].stock, 10);
  });
  test('retry exhaustion also compensates stock and moves the event to dead letters', async () => {
    await post('exhausted', { ...body, paymentMode: 'temporary' });
    await processNext(pool, 2); await makeAvailable(); await processNext(pool, 2);
    assert.equal((await pool.query('SELECT status FROM outbox')).rows[0].status, 'dead');
    assert.equal((await pool.query("SELECT stock FROM products WHERE sku='keyboard'")).rows[0].stock, 10);
  });
  test('database failure rolls back worker progress so the event remains recoverable', async () => {
    await post('db-failure');
    await pool.query(`CREATE OR REPLACE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected database failure'; END $$`);
    await pool.query('CREATE TRIGGER reject_receipt BEFORE INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION reject_receipt()');
    try {
      await assert.rejects(processNext(pool), /Injected database failure/);
      const event = (await pool.query('SELECT * FROM outbox')).rows[0];
      assert.equal(event.status, 'pending'); assert.equal(event.attempts, 0);
      assert.equal((await pool.query('SELECT status FROM orders')).rows[0].status, 'pending');
    } finally { await pool.query('DROP TRIGGER reject_receipt ON payment_receipts'); await pool.query('DROP FUNCTION reject_receipt()'); }
    await processNext(pool);
    assert.equal((await pool.query('SELECT status FROM orders')).rows[0].status, 'paid');
  });
  test('invalid requests are rejected before persistence', async () => {
    const missing = await app.inject({ method: 'POST', url: '/orders', payload: body });
    assert.equal(missing.statusCode, 400);
    assert.equal((await post('bad', { ...body, items: [{ sku: 'keyboard', quantity: -1 }] })).statusCode, 400);
    assert.equal((await post('duplicate', { ...body, items: [...body.items, ...body.items] })).statusCode, 400);
    assert.equal((await app.inject({ url: '/orders/not-a-uuid' })).statusCode, 400);
    assert.equal((await pool.query('SELECT * FROM orders')).rowCount, 0);
  });
  test('readiness checks dependencies and catalog endpoint exposes stock', async () => {
    assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/products' })).json().length, 2);
  });
});
