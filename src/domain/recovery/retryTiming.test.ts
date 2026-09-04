import { describe, expect, it } from 'vitest';
import type { FailedPayment } from '../payments/types';
import type { RecoveryRecommendation } from './types';
import { computeRecoveryRecommendation } from './recoveryDecisionEngine';
import { computeSmartRetryTiming } from './retryTiming';

const FAILED_AT = '2025-06-01T12:00:00.000Z';

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_retry_timing' as FailedPayment['paymentId'],
    customerId: 'cust_retry_timing' as FailedPayment['customerId'],
    customerName: 'Retry Timing Test',
    amount: 50000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 3,
    lastAttemptAt: '2025-06-01T11:59:30.000Z',
    failedAt: FAILED_AT,
    ...overrides,
  };
}

function makeRecommendation(
  overrides: Partial<RecoveryRecommendation> = {},
): RecoveryRecommendation {
  return {
    diagnosis: 'Transient timeout.',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: 0.85,
    reasoning: 'Retry is appropriate.',
    maxAttempts: 3,
    ...overrides,
  };
}

function timestampDiffMinutes(start: string, end: string): number {
  return (new Date(end).getTime() - new Date(start).getTime()) / 60_000;
}

describe('computeSmartRetryTiming', () => {
  it('UPI timeout gets a short retry delay', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'UPI_TIMEOUT' }),
      recommendation: makeRecommendation(),
    });
    expect(timing?.delayMinutes).toBe(30);
    expect(timing?.reason).toBe('UPI timeout is likely temporary; retry after 30 minutes.');
  });

  it('network-style bank failure gets a moderate retry delay', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'BANK_SERVER_ERROR', paymentMethod: 'NETBANKING' }),
      recommendation: makeRecommendation({ retryAfterMinutes: 60 }),
    });
    expect(timing?.delayMinutes).toBe(180);
    expect(timing?.reason).toBe('Bank server error is likely temporary; retry after 3 hours.');
  });

  it('insufficient funds gets a longer delay', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }),
      recommendation: makeRecommendation({ retryAfterMinutes: 360 }),
    });
    expect(timing?.delayMinutes).toBe(720);
  });

  it('temporary bank decline gets a moderate delay', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'BANK_SERVER_ERROR' }),
      recommendation: makeRecommendation({ retryAfterMinutes: 60 }),
    });
    expect(timing?.delayMinutes).toBeGreaterThanOrEqual(120);
    expect(timing?.delayMinutes).toBeLessThanOrEqual(360);
  });

  it('expired card does not get retry timing', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' }),
      recommendation: makeRecommendation({
        recommendedAction: 'UPDATE_PAYMENT_METHOD',
        retryAfterMinutes: null,
      }),
    });
    expect(timing).toBeNull();
  });

  it('payment-method update recommendation has no retry timing', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' }),
      recommendation: makeRecommendation({
        recommendedAction: 'UPDATE_PAYMENT_METHOD',
        retryAfterMinutes: null,
      }),
    });
    expect(timing).toBeNull();
  });

  it('high attempt count increases retry delay and lowers timing confidence', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ attemptCount: 2 }),
      recommendation: makeRecommendation(),
    });
    expect(timing?.delayMinutes).toBe(150);
    expect(timing?.confidence).toBe('LOW');
    expect(timing?.reason).toBe(
      'Multiple attempts have already failed; delaying the next retry reduces repeated failure risk.',
    );
  });

  it('customer history is used when enough data exists', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment(),
      recommendation: makeRecommendation(),
      previousSuccessfulPaymentTimestamps: [
        '2025-05-01T18:05:00.000Z',
        '2025-05-02T19:10:00.000Z',
        '2025-05-03T18:42:00.000Z',
        '2025-05-04T20:03:00.000Z',
      ],
    });
    expect(timing?.source).toBe('CUSTOMER_HISTORY');
    expect(timing?.confidence).toBe('HIGH');
    expect(timing?.recommendedRetryAt).toBe('2025-06-01T19:00:00.000Z');
  });

  it('fallback is used when history is unavailable and no failure rule exists', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'AUTHENTICATION_FAILED' }),
      recommendation: makeRecommendation({ retryAfterMinutes: 90 }),
    });
    expect(timing?.source).toBe('FALLBACK');
    expect(timing?.delayMinutes).toBe(90);
    expect(timing?.confidence).toBe('LOW');
  });

  it('recommended timestamp is correctly calculated', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment(),
      recommendation: makeRecommendation(),
    });
    expect(timing?.recommendedRetryAt).toBe('2025-06-01T12:30:00.000Z');
  });

  it('timestamp format is valid ISO 8601', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment(),
      recommendation: makeRecommendation(),
    });
    expect(timing?.recommendedRetryAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Number.isNaN(new Date(timing?.recommendedRetryAt ?? '').getTime())).toBe(false);
  });

  it('delayMinutes matches timestamp difference', () => {
    const payment = makePayment({ failedAt: FAILED_AT });
    const timing = computeSmartRetryTiming({
      payment,
      recommendation: makeRecommendation(),
    });
    expect(timing).not.toBeNull();
    expect(timestampDiffMinutes(payment.failedAt, timing!.recommendedRetryAt)).toBe(
      timing!.delayMinutes,
    );
  });

  it('assigns correct timing confidence for strong failure-reason rules', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }),
      recommendation: makeRecommendation({ retryAfterMinutes: 360 }),
    });
    expect(timing?.confidence).toBe('MEDIUM');
  });

  it('uses deterministic reason strings', () => {
    const timing = computeSmartRetryTiming({
      payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }),
      recommendation: makeRecommendation({ retryAfterMinutes: 360 }),
    });
    expect(timing?.reason).toBe(
      'Insufficient balance needs a funding window; retry after 12 hours.',
    );
  });

  it('does not mutate input payment data', () => {
    const payment = makePayment();
    const before = JSON.stringify(payment);
    computeSmartRetryTiming({ payment, recommendation: makeRecommendation() });
    expect(JSON.stringify(payment)).toBe(before);
  });

  it('same input always produces the same output', () => {
    const input = {
      payment: makePayment({ previousSuccessfulPayments: 9 }),
      recommendation: makeRecommendation(),
    };
    expect(computeSmartRetryTiming(input)).toEqual(computeSmartRetryTiming(input));
  });

  it('existing recommendation behavior remains unchanged', () => {
    const payment = makePayment({
      failureReason: 'UPI_TIMEOUT',
      attemptCount: 1,
      previousSuccessfulPayments: 5,
    });
    const before = computeRecoveryRecommendation(payment);
    computeSmartRetryTiming({ payment, recommendation: before });
    const after = computeRecoveryRecommendation(payment);
    expect(after).toEqual(before);
    expect(after.retryAfterMinutes).toBe(30);
  });
});
