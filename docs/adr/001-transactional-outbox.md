# ADR 001: PostgreSQL transactional outbox

Status: Accepted

## Context

An order and its payment work must survive together. Writing the order to PostgreSQL and then publishing to a separate broker creates a failure window between the two writes.

## Decision

Insert an outbox event in the order transaction. A separate worker reads committed events with row locking and SKIP LOCKED. Retain completed/dead events for inspection. Do not use Redis as the durable work queue.

## Consequences

The project runs without a cloud account and avoids distributed transactions. Polling adds database traffic. A future broker adapter must mark events delivered only after broker acknowledgement and tolerate duplicate delivery. Retention/cleanup is not implemented yet.
