import { randomUUID } from 'node:crypto';
import { transaction, type Pool } from './db.js';
import { canonicalOrder, DomainError, requestHash, type OrderInput } from './domain.js';
export async function getOrder(pool: Pool, id: string) {
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!result.rowCount) throw new DomainError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const items = await pool.query('SELECT sku, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY sku', [id]);
  return { ...result.rows[0], items: items.rows };
}
export async function createOrder(pool: Pool, key: string, input: OrderInput) {
  const normalized = canonicalOrder(input);
  const hash = requestHash(input);
  return transaction(pool, async client => {
    // A transaction-scoped lock serializes concurrent requests for the same key.
    // Hash collisions only serialize unrelated keys; the full key is checked below.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const existing = await client.query('SELECT request_hash, order_id FROM idempotency_keys WHERE key = $1', [key]);
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== hash)
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used with a different request');
      return { id: existing.rows[0].order_id as string, replayed: true };
    }
    let total = 0;
    const priced: { sku: string; quantity: number; price: number }[] = [];
    // Lock products in a consistent order to avoid deadlocks between orders.
    for (const item of normalized.items) {
      const result = await client.query('SELECT price_cents, stock FROM products WHERE sku = $1 FOR UPDATE', [item.sku]);
      const product = result.rows[0];
      if (!product) throw new DomainError(404, 'PRODUCT_NOT_FOUND', `Unknown SKU: ${item.sku}`);
      if (product.stock < item.quantity) throw new DomainError(409, 'OUT_OF_STOCK', `Insufficient stock: ${item.sku}`);
      total += product.price_cents * item.quantity;
      if (!Number.isSafeInteger(total) || total > 2147483647)
        throw new DomainError(400, 'ORDER_TOO_LARGE', 'Order total exceeds supported limit');
      priced.push({ ...item, price: product.price_cents });
      await client.query('UPDATE products SET stock = stock - $2 WHERE sku = $1', [item.sku, item.quantity]);
    }
    const id = randomUUID();
    await client.query('INSERT INTO orders(id, customer_id, total_cents, payment_mode) VALUES ($1,$2,$3,$4)', [id, normalized.customerId, total, normalized.paymentMode]);
    for (const item of priced)
      await client.query('INSERT INTO order_items VALUES ($1,$2,$3,$4)', [id, item.sku, item.quantity, item.price]);
    await client.query('INSERT INTO idempotency_keys VALUES ($1,$2,$3)', [key, hash, id]);
    await client.query("INSERT INTO outbox(id, order_id, event_type) VALUES ($1,$2,'order.created')", [randomUUID(), id]);
    await client.query("INSERT INTO audit_events(order_id, event_type) VALUES ($1,'order.created')", [id]);
    return { id, replayed: false };
  });
}
