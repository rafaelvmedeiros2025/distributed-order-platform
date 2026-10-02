# Distributed Order Platform

[![CI](https://github.com/rafaelvmedeiros2025/distributed-order-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/rafaelvmedeiros2025/distributed-order-platform/actions/workflows/ci.yml)

An executable backend engineering project exploring **idempotency, inventory concurrency, transactional outbox, and resilient asynchronous payment processing**.

Built with **Node.js 24, TypeScript, Fastify, PostgreSQL, Redis, and Docker**. The API and worker run as separate processes and can be scaled independently.

## The problem

Accepting an order is more than inserting a row. Two customers can buy the last item simultaneously, a client can retry after a network timeout, and a payment provider can fail after the order was accepted.

This project handles those cases with explicit consistency boundaries:

- Reserve inventory, create the order, store the idempotency key, and write the outbox event in **one PostgreSQL transaction**.
- Serialize requests sharing an idempotency key with a transaction-scoped advisory lock.
- Lock inventory rows in a stable order to prevent overselling and reduce deadlocks.
- Process committed events with independently running workers using `FOR UPDATE SKIP LOCKED`.
- Retry temporary payment failures with exponential backoff and jitter.
- Move permanent or exhausted failures into a dead-letter state and restore inventory atomically.
- Use Redis for rate limiting shared across API instances.

## Architecture

```mermaid
flowchart TD
    Client["API client"] --> API["Fastify API"]
    API --> Redis["Redis rate limiting"]
    API --> DB["PostgreSQL: orders, inventory, outbox"]
    Worker["Payment worker"] --> DB
    Worker --> Payment["Simulated payment provider"]
    Worker --> Outcome["Receipt or failed order"]
    Outcome --> DB
```

PostgreSQL is the durable work queue in this version. Redis is not used for event durability. There is no SQS, EventBridge, or AWS deployment implementation yet.

## Run locally

Requires Docker with Compose v2. No AWS account or payment credentials are needed.

```bash
docker compose up --build
```

Compose waits for healthy dependencies, applies migrations, seeds a demo catalog, then starts the API and worker. API: `http://localhost:3000`.

```bash
curl http://localhost:3000/products

curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-order-001' \
  -d '{"customerId":"customer-1","items":[{"sku":"keyboard","quantity":1}],"paymentMode":"temporary"}'
```

The POST returns a pending order. Use its `Location` header to poll `GET /orders/:id`. A temporary payment fails twice and then succeeds. Repeating the POST with the same key and equivalent payload returns the same order; changing the payload returns `409`.

`paymentMode` is a **demo-only failure injection field**:

| Mode | Behavior |
| --- | --- |
| `success` (default) | Payment succeeds on the first attempt |
| `temporary` | First two attempts fail; third succeeds |
| `declined` | Permanent failure, dead letter, and inventory restoration |

Stop with `docker compose down`. To remove demo data as well: `docker compose down -v` (deletes the database volume).

### Development without containerized Node

With PostgreSQL and Redis running:

```bash
npm ci
cp .env.example .env
# These scripts inherit variables from your shell; source the local example explicitly.
set -a
. ./.env
set +a
npm run migrate
npm run seed
npm run dev
# In another terminal, load the same environment and run:
npm run worker:dev
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health/live` | Process liveness |
| GET | `/health/ready` | PostgreSQL and Redis connectivity |
| GET | `/products` | Demo catalog and available stock |
| POST | `/orders` | Reserve stock and enqueue payment; requires `Idempotency-Key` |
| GET | `/orders/:id` | Read order, line items, and current state |

Money is stored as integer cents and calculated from the catalog. Clients cannot set prices. Order creation returns `201`; an idempotent replay returns `200` with the **current** order state, rather than a cached original HTTP response. Idempotency keys are global and retained indefinitely in this demo.

## Verification

```bash
npm run check
npm test
npm run build

# Dedicated disposable database; integration tests truncate application tables.
TEST_DATABASE_URL=postgres://orders:orders@localhost:5432/orders_test \
TEST_REDIS_URL=redis://localhost:6379 \
npm run test:integration
```

Create `orders_test` first if running locally. GitHub Actions provisions a separate PostgreSQL database and Redis instance automatically.

The integration suite exercises concurrent duplicate requests, payload conflicts, last-item contention, transaction rollback, parallel workers, retry recovery, permanent failure, retry exhaustion, inventory compensation, validation, and rollback after an injected database failure. CI also type-checks, builds, and builds the Docker image.

## Operational visibility

The API emits structured request/error logs with request IDs. The worker emits JSON processing/error logs. Readiness checks PostgreSQL and Redis. SIGTERM/SIGINT stop new API work and allow the current worker transaction to finish.

Inspect the durable queue and audit trail:

```sql
SELECT status, count(*) FROM outbox GROUP BY status;
SELECT id, order_id, attempts, last_error FROM outbox WHERE status = 'dead';
SELECT * FROM audit_events ORDER BY id DESC LIMIT 20;
```

Dead letters are retained for inspection. Automatic redrive is intentionally absent: failed orders have already released inventory, so a safe recovery flow must reserve stock again.

## Design decisions and boundaries

See [architecture and failure scenarios](docs/architecture.md) and the [ADRs](docs/adr/).

This is a runnable **portfolio reference implementation**, not a deployed commerce service. Payments are simulated. The worker executes that immediate simulation inside its database transaction; a real external provider requires stable provider-side idempotency, timeouts, reconciliation, and shorter database lock lifetimes.

The repository does not implement authentication, tenant isolation, real payment processing, notification delivery, tracing/metrics exporters, load testing, or infrastructure provisioning. Local credentials and exposed loopback ports are for development. Before public deployment, add identity/authorization, scope idempotency to the authenticated caller, manage secrets, and define payment reconciliation and inventory reservation expiration.

## Next extensions

- SQS/EventBridge delivery adapter preserving the transactional outbox boundary.
- External payment adapter with timeout handling and reconciliation.
- OpenTelemetry traces and queue/retry metrics.
- Authenticated customers and tenant-scoped idempotency.
- Infrastructure as code and measured throughput/failure benchmarks.

Created by [Rafael Medeiros](https://www.linkedin.com/in/rmedeiros2/).
