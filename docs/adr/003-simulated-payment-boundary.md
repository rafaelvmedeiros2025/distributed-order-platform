# ADR 003: Deterministic simulated payment provider

Status: Accepted for the reference implementation

## Context

The project needs reproducible success, temporary failure, and permanent failure scenarios without requiring payment credentials or moving real money.

## Decision

Use an immediate, deterministic provider simulation. It fails the first two attempts in temporary mode and uses the order ID to generate a stable receipt reference. The worker processes this simulation inside the event transaction.

## Consequences

Tests can reproduce resilience scenarios without a network dependency. This does not solve real-world payment ambiguity. A real adapter needs request timeouts, provider-side idempotency, reconciliation, and a claim/lease design that avoids holding database locks across slow external calls. Terminal failure compensation must wait until payment status is known.
