import { createHash } from 'node:crypto';
export type PaymentMode = 'success' | 'temporary' | 'declined';
export interface OrderInput {
  customerId: string;
  items: { sku: string; quantity: number }[];
  paymentMode?: PaymentMode;
}
export class DomainError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function canonicalOrder(input: OrderInput) {
  const items = [...input.items].sort((a, b) => a.sku.localeCompare(b.sku));
  if (new Set(items.map(i => i.sku)).size !== items.length)
    throw new DomainError(400, 'DUPLICATE_SKU', 'Each SKU must appear only once');
  return { customerId: input.customerId, items, paymentMode: input.paymentMode ?? 'success' };
}
export function requestHash(input: OrderInput) {
  return createHash('sha256').update(JSON.stringify(canonicalOrder(input))).digest('hex');
}
export function retryDelay(attempt: number, random = Math.random) {
  return Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(random() * 500);
}
export function simulatePayment(mode: PaymentMode, attempt: number, orderId: string) {
  if (mode === 'declined') throw new DomainError(422, 'PAYMENT_DECLINED', 'Simulated payment declined');
  if (mode === 'temporary' && attempt <= 2) throw new Error('Simulated provider unavailable');
  return `simulated-${orderId}`;
}
