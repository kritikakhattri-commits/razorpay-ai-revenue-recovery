import { describe, it, expect } from 'vitest';
import { loadFailedPayments } from './failedPaymentLoader';
import type { FailureReason, PaymentMethod } from '../domain/payments/types';

const ALL_PAYMENT_METHODS: PaymentMethod[] = ['UPI', 'CARD', 'NETBANKING', 'WALLET'];

const ALL_FAILURE_REASONS: FailureReason[] = [
  'INSUFFICIENT_BALANCE',
  'UPI_TIMEOUT',
  'BANK_SERVER_ERROR',
  'EXPIRED_CARD',
  'AUTHENTICATION_FAILED',
  'CUSTOMER_ABANDONED',
];

describe('loadFailedPayments', () => {
  it('loads and validates all records without throwing', () => {
    expect(() => loadFailedPayments()).not.toThrow();
  });

  it('returns exactly 40 records', () => {
    const payments = loadFailedPayments();
    expect(payments).toHaveLength(40);
  });

  it('all supported payment methods appear in the dataset', () => {
    const payments = loadFailedPayments();
    const methods = new Set(payments.map((p) => p.paymentMethod));
    for (const method of ALL_PAYMENT_METHODS) {
      expect(methods.has(method), `missing payment method: ${method}`).toBe(true);
    }
  });

  it('all supported failure reasons appear in the dataset', () => {
    const payments = loadFailedPayments();
    const reasons = new Set(payments.map((p) => p.failureReason));
    for (const reason of ALL_FAILURE_REASONS) {
      expect(reasons.has(reason), `missing failure reason: ${reason}`).toBe(true);
    }
  });
});
