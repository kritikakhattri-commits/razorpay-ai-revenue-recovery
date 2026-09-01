import { describe, it, expect } from 'vitest';
import type { FailedPayment, FailureReason } from '../payments/types';
import type { RecoveryAction } from './types';
import { computeRecoveryRecommendation } from './recoveryDecisionEngine';

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_test001' as FailedPayment['paymentId'],
    customerId: 'cust_test001' as FailedPayment['customerId'],
    customerName: 'Test Customer',
    amount: 50000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 0,
    lastAttemptAt: '2024-01-15T10:30:00.000Z',
    failedAt: '2024-01-15T10:30:05.000Z',
    ...overrides,
  };
}

describe('computeRecoveryRecommendation', () => {
  describe('action routing — every failure reason maps to the correct action', () => {
    const cases: [FailureReason, RecoveryAction][] = [
      ['UPI_TIMEOUT', 'RETRY_LATER'],
      ['BANK_SERVER_ERROR', 'RETRY_LATER'],
      ['INSUFFICIENT_BALANCE', 'RETRY_LATER'],
      ['EXPIRED_CARD', 'UPDATE_PAYMENT_METHOD'],
      ['AUTHENTICATION_FAILED', 'SEND_PAYMENT_LINK'],
      ['CUSTOMER_ABANDONED', 'SEND_PAYMENT_LINK'],
    ];

    it.each(cases)('%s → %s', (failureReason, expectedAction) => {
      const rec = computeRecoveryRecommendation(makePayment({ failureReason }));
      expect(rec.recommendedAction).toBe(expectedAction);
    });
  });

  describe('retry delays — expected retryAfterMinutes per failure reason', () => {
    it('UPI_TIMEOUT → 30 minutes', () => {
      const rec = computeRecoveryRecommendation(makePayment({ failureReason: 'UPI_TIMEOUT' }));
      expect(rec.retryAfterMinutes).toBe(30);
    });

    it('BANK_SERVER_ERROR → 60 minutes', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ failureReason: 'BANK_SERVER_ERROR' }),
      );
      expect(rec.retryAfterMinutes).toBe(60);
    });

    it('INSUFFICIENT_BALANCE → 360 minutes', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }),
      );
      expect(rec.retryAfterMinutes).toBe(360);
    });

    it('EXPIRED_CARD → null (no retry delay, method update required)', () => {
      const rec = computeRecoveryRecommendation(makePayment({ failureReason: 'EXPIRED_CARD' }));
      expect(rec.retryAfterMinutes).toBeNull();
    });

    it('AUTHENTICATION_FAILED → null (payment link sent, no timed retry)', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ failureReason: 'AUTHENTICATION_FAILED' }),
      );
      expect(rec.retryAfterMinutes).toBeNull();
    });

    it('CUSTOMER_ABANDONED → null (payment link sent, no timed retry)', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED' }),
      );
      expect(rec.retryAfterMinutes).toBeNull();
    });
  });

  describe('expired card safety invariant', () => {
    it('never recommends RETRY_LATER for EXPIRED_CARD', () => {
      const rec = computeRecoveryRecommendation(makePayment({ failureReason: 'EXPIRED_CARD' }));
      expect(rec.recommendedAction).not.toBe('RETRY_LATER');
    });

    it('always has null retryAfterMinutes for EXPIRED_CARD', () => {
      const withHistory = makePayment({
        failureReason: 'EXPIRED_CARD',
        previousSuccessfulPayments: 20,
        attemptCount: 1,
      });
      expect(computeRecoveryRecommendation(withHistory).retryAfterMinutes).toBeNull();
    });
  });

  describe('confidence — increases with strong payment history', () => {
    it('UPI_TIMEOUT: more prior successes → higher confidence', () => {
      const low = computeRecoveryRecommendation(
        makePayment({ failureReason: 'UPI_TIMEOUT', previousSuccessfulPayments: 0 }),
      );
      const high = computeRecoveryRecommendation(
        makePayment({ failureReason: 'UPI_TIMEOUT', previousSuccessfulPayments: 7 }),
      );
      expect(high.confidence).toBeGreaterThan(low.confidence);
    });

    it('BANK_SERVER_ERROR: more prior successes → higher confidence', () => {
      const low = computeRecoveryRecommendation(
        makePayment({ failureReason: 'BANK_SERVER_ERROR', previousSuccessfulPayments: 0 }),
      );
      const high = computeRecoveryRecommendation(
        makePayment({ failureReason: 'BANK_SERVER_ERROR', previousSuccessfulPayments: 5 }),
      );
      expect(high.confidence).toBeGreaterThan(low.confidence);
    });

    it('INSUFFICIENT_BALANCE: more prior successes → higher confidence', () => {
      const low = computeRecoveryRecommendation(
        makePayment({ failureReason: 'INSUFFICIENT_BALANCE', previousSuccessfulPayments: 0 }),
      );
      const high = computeRecoveryRecommendation(
        makePayment({ failureReason: 'INSUFFICIENT_BALANCE', previousSuccessfulPayments: 6 }),
      );
      expect(high.confidence).toBeGreaterThan(low.confidence);
    });

    it('CUSTOMER_ABANDONED: more prior successes → higher confidence', () => {
      const low = computeRecoveryRecommendation(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED', previousSuccessfulPayments: 0 }),
      );
      const high = computeRecoveryRecommendation(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED', previousSuccessfulPayments: 4 }),
      );
      expect(high.confidence).toBeGreaterThan(low.confidence);
    });
  });

  describe('confidence — decreases with repeated failed attempts', () => {
    it('UPI_TIMEOUT: more attempts → lower confidence', () => {
      const few = computeRecoveryRecommendation(
        makePayment({ failureReason: 'UPI_TIMEOUT', attemptCount: 1 }),
      );
      const many = computeRecoveryRecommendation(
        makePayment({ failureReason: 'UPI_TIMEOUT', attemptCount: 4 }),
      );
      expect(many.confidence).toBeLessThan(few.confidence);
    });

    it('BANK_SERVER_ERROR: more attempts → lower confidence', () => {
      const few = computeRecoveryRecommendation(
        makePayment({ failureReason: 'BANK_SERVER_ERROR', attemptCount: 1 }),
      );
      const many = computeRecoveryRecommendation(
        makePayment({ failureReason: 'BANK_SERVER_ERROR', attemptCount: 3 }),
      );
      expect(many.confidence).toBeLessThan(few.confidence);
    });

    it('CUSTOMER_ABANDONED: more attempts → lower confidence', () => {
      const few = computeRecoveryRecommendation(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED', attemptCount: 1 }),
      );
      const many = computeRecoveryRecommendation(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED', attemptCount: 3 }),
      );
      expect(many.confidence).toBeLessThan(few.confidence);
    });
  });

  describe('confidence bounds', () => {
    it('never exceeds 1.0 — EXPIRED_CARD with many prior successes', () => {
      // baseConfidence(0.88) + historyBoost(min(10*0.02,0.15)=0.15) = 1.03 without clamp
      const rec = computeRecoveryRecommendation(
        makePayment({ failureReason: 'EXPIRED_CARD', previousSuccessfulPayments: 10, attemptCount: 1 }),
      );
      expect(rec.confidence).toBeLessThanOrEqual(1);
    });

    it('never drops below 0.0 — CUSTOMER_ABANDONED with many failed attempts', () => {
      // baseConfidence(0.55) - (5-1)*0.15 = 0.55 - 0.60 = -0.05 without clamp
      const rec = computeRecoveryRecommendation(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED', attemptCount: 5, previousSuccessfulPayments: 0 }),
      );
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
    });

    it.each([
      'UPI_TIMEOUT',
      'BANK_SERVER_ERROR',
      'INSUFFICIENT_BALANCE',
      'EXPIRED_CARD',
      'AUTHENTICATION_FAILED',
      'CUSTOMER_ABANDONED',
    ] as FailureReason[])('%s confidence is in [0, 1]', (failureReason) => {
      const rec = computeRecoveryRecommendation(makePayment({ failureReason }));
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('determinism — same input always produces same recommendation', () => {
    it.each([
      'UPI_TIMEOUT',
      'BANK_SERVER_ERROR',
      'INSUFFICIENT_BALANCE',
      'EXPIRED_CARD',
      'AUTHENTICATION_FAILED',
      'CUSTOMER_ABANDONED',
    ] as FailureReason[])('%s produces identical result on repeated calls', (failureReason) => {
      const payment = makePayment({ failureReason, previousSuccessfulPayments: 3, attemptCount: 2 });
      expect(computeRecoveryRecommendation(payment)).toEqual(computeRecoveryRecommendation(payment));
    });
  });

  describe('output shape', () => {
    it('includes all required fields', () => {
      const rec = computeRecoveryRecommendation(makePayment());
      expect(rec).toHaveProperty('diagnosis');
      expect(rec).toHaveProperty('recommendedAction');
      expect(rec).toHaveProperty('retryAfterMinutes');
      expect(rec).toHaveProperty('confidence');
      expect(rec).toHaveProperty('reasoning');
      expect(rec).toHaveProperty('maxAttempts');
    });

    it('diagnosis is a non-empty string', () => {
      const rec = computeRecoveryRecommendation(makePayment());
      expect(typeof rec.diagnosis).toBe('string');
      expect(rec.diagnosis.length).toBeGreaterThan(0);
    });

    it('reasoning is a non-empty string', () => {
      const rec = computeRecoveryRecommendation(makePayment());
      expect(typeof rec.reasoning).toBe('string');
      expect(rec.reasoning.length).toBeGreaterThan(0);
    });

    it('maxAttempts is a positive integer', () => {
      const rec = computeRecoveryRecommendation(makePayment());
      expect(Number.isInteger(rec.maxAttempts)).toBe(true);
      expect(rec.maxAttempts).toBeGreaterThan(0);
    });
  });

  describe('reasoning content', () => {
    it('mentions prior successful payment count when > 0', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ previousSuccessfulPayments: 7, failureReason: 'UPI_TIMEOUT' }),
      );
      expect(rec.reasoning).toContain('7');
    });

    it('mentions failed attempts when attemptCount > 1', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ attemptCount: 3, failureReason: 'UPI_TIMEOUT' }),
      );
      expect(rec.reasoning).toContain('3');
    });

    it('notes no prior history when previousSuccessfulPayments is 0', () => {
      const rec = computeRecoveryRecommendation(
        makePayment({ previousSuccessfulPayments: 0 }),
      );
      expect(rec.reasoning).toMatch(/no prior/i);
    });
  });
});
