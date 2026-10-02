# ADR 002: Database-owned idempotency and stock reservations

Status: Accepted

## Context

Client retries and concurrent checkouts can cause duplicate orders or overselling. An in-process lock cannot protect multiple API instances.

## Decision

Use PostgreSQL transaction-scoped advisory locks for idempotency keys, a canonical request fingerprint for conflict detection, and sorted row locks for inventory reservation. Store money as integer cents and price line items from the catalog. Release reserved stock on a terminal payment failure in the same transaction as the failure state.

## Consequences

Correctness depends on durable database constraints and locks rather than process memory. Hot SKUs serialize reservations. Keys are global in this demo and have no expiry; authenticated customer scoping and an explicit retention policy are required before deployment. Replays return the latest resource representation.
