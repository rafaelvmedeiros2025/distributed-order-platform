import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOrder, requestHash, retryDelay, simulatePayment, DomainError } from '../src/domain.js';
test('request fingerprints ignore item order and normalize default payment mode', () => {
  const a = { customerId: 'c1', items: [{ sku: 'b', quantity: 2 }, { sku: 'a', quantity: 1 }] };
  const b = { ...a, items: [...a.items].reverse(), paymentMode: 'success' as const };
  assert.equal(requestHash(a), requestHash(b));
  assert.notEqual(requestHash(a), requestHash({ ...a, customerId: 'c2' }));
});
test('duplicate SKUs are rejected rather than reserving stock twice', () => {
  assert.throws(() => canonicalOrder({ customerId: 'c', items: [{ sku: 'a', quantity: 1 }, { sku: 'a', quantity: 2 }] }), DomainError);
});
test('backoff grows exponentially, adds jitter, and caps base delay', () => {
  assert.equal(retryDelay(1, () => 0), 1000);
  assert.equal(retryDelay(3, () => 0.5), 4250);
  assert.equal(retryDelay(20, () => 0), 60000);
});
test('payment simulation recovers temporary failures and uses a stable reference', () => {
  assert.throws(() => simulatePayment('temporary', 1, 'o1'));
  assert.throws(() => simulatePayment('temporary', 2, 'o1'));
  assert.equal(simulatePayment('temporary', 3, 'o1'), simulatePayment('success', 1, 'o1'));
  assert.throws(() => simulatePayment('declined', 1, 'o1'), DomainError);
});
