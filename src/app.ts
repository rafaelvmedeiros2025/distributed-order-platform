import Fastify, { type FastifyError } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Redis } from 'ioredis';
import type { Pool } from './db.js';
import { DomainError, type OrderInput } from './domain.js';
import { createOrder, getOrder } from './orders.js';
export async function buildApp(pool: Pool, redis?: Redis, logger = false) {
  const app = Fastify({ logger: logger ? { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] } : false, bodyLimit: 16_384 });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', ...(redis ? { redis } : {}) });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const failure = error as FastifyError;
    if (failure.validation) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request' });
    if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500)
      return reply.code(failure.statusCode).send({ code: 'REQUEST_ERROR', message: failure.message });
    request.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });
  app.get('/health/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    try { await pool.query('SELECT 1'); if (redis) await redis.ping(); return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.get('/products', async () => (await pool.query('SELECT * FROM products ORDER BY sku')).rows);
  app.post<{ Body: OrderInput; Headers: { 'idempotency-key': string } }>('/orders', {
    schema: {
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 128 } } },
      body: { type: 'object', additionalProperties: false, required: ['customerId','items'], properties: {
        customerId: { type: 'string', minLength: 1, maxLength: 128 },
        paymentMode: { type: 'string', enum: ['success','temporary','declined'] },
        items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['sku','quantity'], properties: {
          sku: { type: 'string', minLength: 1, maxLength: 64 }, quantity: { type: 'integer', minimum: 1, maximum: 1000 }
        } } }
      } }
    }
  }, async (request, reply) => {
    const result = await createOrder(pool, request.headers['idempotency-key'], request.body);
    return reply.code(result.replayed ? 200 : 201).header('location', `/orders/${result.id}`).send(await getOrder(pool, result.id));
  });
  app.get<{ Params: { id: string } }>('/orders/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } } } }
  }, async request => getOrder(pool, request.params.id));
  return app;
}
