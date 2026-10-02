import { transaction, type Pool } from './db.js';
import { DomainError, retryDelay, simulatePayment } from './domain.js';
export async function processNext(pool: Pool, maxAttempts = 5): Promise<boolean> {
  return transaction(pool, async client => {
    // SKIP LOCKED allows multiple worker processes without claiming the same event.
    const result = await client.query(`SELECT e.*, o.payment_mode FROM outbox e
      JOIN orders o ON o.id = e.order_id
      WHERE e.status = 'pending' AND e.available_at <= now()
      ORDER BY e.available_at, e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`);
    const event = result.rows[0];
    if (!event) return false;
    const attempt = event.attempts + 1;
    let reference: string;
    try {
      reference = simulatePayment(event.payment_mode, attempt, event.order_id);
    } catch (error) {
      const dead = error instanceof DomainError || attempt >= maxAttempts;
      await client.query(`UPDATE outbox SET attempts=$2, status=$3, last_error=$4,
        available_at=now() + ($5::double precision * interval '1 millisecond') WHERE id=$1`,
        [event.id, attempt, dead ? 'dead' : 'pending', error instanceof Error ? error.message : 'Unknown failure', retryDelay(attempt)]);
      if (dead) {
        await client.query("UPDATE orders SET status='failed' WHERE id=$1", [event.order_id]);
        const items = await client.query('SELECT sku, quantity FROM order_items WHERE order_id=$1 ORDER BY sku', [event.order_id]);
        for (const item of items.rows)
          await client.query('UPDATE products SET stock=stock+$2 WHERE sku=$1', [item.sku, item.quantity]);
        await client.query("INSERT INTO audit_events(order_id,event_type) VALUES ($1,'order.failed')", [event.order_id]);
      }
      return true;
    }
    // Only provider failures are retried; database errors roll back the transaction.
    await client.query('INSERT INTO payment_receipts(order_id,provider_reference) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING', [event.order_id, reference]);
    await client.query("UPDATE orders SET status='paid' WHERE id=$1", [event.order_id]);
    await client.query("UPDATE outbox SET status='completed', attempts=$2, last_error=NULL WHERE id=$1", [event.id, attempt]);
    await client.query("INSERT INTO audit_events(order_id,event_type) VALUES ($1,'order.paid')", [event.order_id]);
    return true;
  });
}
