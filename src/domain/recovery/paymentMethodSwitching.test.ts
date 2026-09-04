import { describe, expect, it } from 'vitest';
import type { FailedPayment } from '../payments/types';
import { computePaymentMethodSwitch as subject } from './paymentMethodSwitching';
import { evaluatePolicy } from '../policy/policyEngine';
import { computeRecoveryRecommendation } from './recoveryDecisionEngine';
import { computeSmartRetryTiming } from './retryTiming';

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_test_001' as FailedPayment['paymentId'],
    customerId: 'cust_test_001' as FailedPayment['customerId'],
    customerName: 'Test Customer',
    amount: 50000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 2,
    lastAttemptAt: '2025-06-01T11:59:00.000Z',
    failedAt: '2025-06-01T12:00:00.000Z',
    ...overrides,
  };
}

// ── EXPIRED CARD ──────────────────────────────────────────────────────────────

describe('EXPIRED_CARD', () => {
  it('recommends switching when card is expired', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    expect(result.shouldSwitch).toBe(true);
  });

  it('sets currentMethod to CARD', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    expect(result.currentMethod).toBe('CARD');
  });

  it('recommends UPI as the top alternative for expired card', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    expect(result.recommendedMethod).toBe('UPI');
  });

  it('includes CARD as a valid alternative (different valid card)', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).toContain('CARD');
  });

  it('does not only exclude alternatives — CARD remains valid as another card', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it('orders alternatives by descending score', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    const scores = result.alternatives.map((a) => a.score);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });

  it('includes a non-empty reason', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ── UPI TIMEOUT — FIRST ATTEMPT ───────────────────────────────────────────────

describe('UPI_TIMEOUT — first attempt', () => {
  it('does not recommend switching on first UPI timeout', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 1 }) });
    expect(result.shouldSwitch).toBe(false);
  });

  it('returns null recommendedMethod when not switching', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 1 }) });
    expect(result.recommendedMethod).toBeNull();
  });

  it('returns empty alternatives when not switching', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 1 }) });
    expect(result.alternatives).toHaveLength(0);
  });

  it('provides a meaningful no-switch reason', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 1 }) });
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ── UPI TIMEOUT — REPEATED ────────────────────────────────────────────────────

describe('UPI_TIMEOUT — repeated failures', () => {
  it('recommends switching after repeated UPI timeouts', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 2 }) });
    expect(result.shouldSwitch).toBe(true);
  });

  it('does not recommend UPI when switching away from repeated UPI failures', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 2 }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).not.toContain('UPI');
  });

  it('recommends CARD as the top alternative for repeated UPI failures', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 2 }) });
    expect(result.recommendedMethod).toBe('CARD');
  });

  it('includes NETBANKING as an alternative', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 2 }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).toContain('NETBANKING');
  });
});

// ── WALLET FAILURE ────────────────────────────────────────────────────────────

describe('WALLET + BANK_SERVER_ERROR (wallet failure)', () => {
  it('recommends switching for wallet bank server error', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'WALLET', failureReason: 'BANK_SERVER_ERROR' }) });
    expect(result.shouldSwitch).toBe(true);
  });

  it('excludes WALLET from alternatives', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'WALLET', failureReason: 'BANK_SERVER_ERROR' }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).not.toContain('WALLET');
  });

  it('recommends UPI as top alternative for wallet failure', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'WALLET', failureReason: 'BANK_SERVER_ERROR' }) });
    expect(result.recommendedMethod).toBe('UPI');
  });

  it('includes CARD as an alternative', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'WALLET', failureReason: 'BANK_SERVER_ERROR' }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).toContain('CARD');
  });
});

// ── NETBANKING FAILURE ────────────────────────────────────────────────────────

describe('NETBANKING + BANK_SERVER_ERROR (netbanking failure)', () => {
  it('recommends switching for netbanking bank server error', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'NETBANKING', failureReason: 'BANK_SERVER_ERROR' }) });
    expect(result.shouldSwitch).toBe(true);
  });

  it('excludes NETBANKING from alternatives', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'NETBANKING', failureReason: 'BANK_SERVER_ERROR' }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).not.toContain('NETBANKING');
  });

  it('recommends UPI as top alternative for netbanking failure', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'NETBANKING', failureReason: 'BANK_SERVER_ERROR' }) });
    expect(result.recommendedMethod).toBe('UPI');
  });

  it('includes CARD as an alternative', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'NETBANKING', failureReason: 'BANK_SERVER_ERROR' }) });
    const methods = result.alternatives.map((a) => a.method);
    expect(methods).toContain('CARD');
  });
});

// ── INSUFFICIENT FUNDS ────────────────────────────────────────────────────────

describe('INSUFFICIENT_BALANCE', () => {
  it('does not recommend switching for insufficient balance', () => {
    const result = subject({ payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }) });
    expect(result.shouldSwitch).toBe(false);
  });

  it('returns null recommendedMethod for insufficient balance', () => {
    const result = subject({ payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }) });
    expect(result.recommendedMethod).toBeNull();
  });

  it('returns empty alternatives for insufficient balance', () => {
    const result = subject({ payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }) });
    expect(result.alternatives).toHaveLength(0);
  });
});

// ── AUTHENTICATION FAILED ─────────────────────────────────────────────────────

describe('AUTHENTICATION_FAILED', () => {
  it('does not recommend switching for auth failure', () => {
    const result = subject({ payment: makePayment({ failureReason: 'AUTHENTICATION_FAILED' }) });
    expect(result.shouldSwitch).toBe(false);
  });

  it('returns null recommendedMethod for auth failure', () => {
    const result = subject({ payment: makePayment({ failureReason: 'AUTHENTICATION_FAILED' }) });
    expect(result.recommendedMethod).toBeNull();
  });
});

// ── CUSTOMER ABANDONED ────────────────────────────────────────────────────────

describe('CUSTOMER_ABANDONED', () => {
  it('does not recommend switching for customer abandoned', () => {
    const result = subject({ payment: makePayment({ failureReason: 'CUSTOMER_ABANDONED' }) });
    expect(result.shouldSwitch).toBe(false);
  });

  it('returns null recommendedMethod for customer abandoned', () => {
    const result = subject({ payment: makePayment({ failureReason: 'CUSTOMER_ABANDONED' }) });
    expect(result.recommendedMethod).toBeNull();
  });
});

// ── REPEATED CARD DECLINE ─────────────────────────────────────────────────────

describe('CARD + BANK_SERVER_ERROR repeated (card decline)', () => {
  it('recommends switching after repeated card declines', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'BANK_SERVER_ERROR', attemptCount: 2 }) });
    expect(result.shouldSwitch).toBe(true);
  });

  it('recommends UPI as top alternative for repeated card decline', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'BANK_SERVER_ERROR', attemptCount: 2 }) });
    expect(result.recommendedMethod).toBe('UPI');
  });

  it('does not switch for first-attempt card bank server error', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'BANK_SERVER_ERROR', attemptCount: 1 }) });
    expect(result.shouldSwitch).toBe(false);
  });
});

// ── GENERAL INVARIANTS ────────────────────────────────────────────────────────

describe('general invariants', () => {
  it('alternatives contain no duplicate methods', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    const methods = result.alternatives.map((a) => a.method);
    const unique = new Set(methods);
    expect(unique.size).toBe(methods.length);
  });

  it('all suitability scores are within 0.00–1.00', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    for (const alt of result.alternatives) {
      expect(alt.score).toBeGreaterThanOrEqual(0);
      expect(alt.score).toBeLessThanOrEqual(1);
    }
  });

  it('same input always produces the same output (deterministic)', () => {
    const payment = makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const a = subject({ payment });
    const b = subject({ payment });
    expect(a).toEqual(b);
  });

  it('does not mutate the input payment', () => {
    const payment = makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const before = JSON.stringify(payment);
    subject({ payment });
    expect(JSON.stringify(payment)).toBe(before);
  });

  it('recommendedMethod equals the first alternative method when switching', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    expect(result.shouldSwitch).toBe(true);
    expect(result.recommendedMethod).toBe(result.alternatives[0].method);
  });

  it('no-switch result always has empty alternatives and null recommendedMethod', () => {
    const result = subject({ payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE' }) });
    expect(result.shouldSwitch).toBe(false);
    expect(result.recommendedMethod).toBeNull();
    expect(result.alternatives).toHaveLength(0);
  });

  it('currentMethod always reflects the payment method', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'NETBANKING', failureReason: 'BANK_SERVER_ERROR' }) });
    expect(result.currentMethod).toBe('NETBANKING');
  });
});

// ── RETRY TIMING INTERACTION ──────────────────────────────────────────────────

describe('interaction with smart retry timing', () => {
  it('UPDATE_PAYMENT_METHOD recommendation does not get retry timing (expired card)', () => {
    const payment = makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const recommendation = computeRecoveryRecommendation(payment);
    const timing = computeSmartRetryTiming({ payment, recommendation });
    expect(timing).toBeNull();
  });

  it('UPDATE_PAYMENT_METHOD is enriched with paymentMethodSwitch shouldSwitch:true', () => {
    const payment = makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const switchRec = subject({ payment });
    expect(switchRec.shouldSwitch).toBe(true);
    expect(switchRec.recommendedMethod).not.toBeNull();
  });

  it('first UPI timeout keeps shouldSwitch false (retry preferred)', () => {
    const payment = makePayment({ paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const switchRec = subject({ payment });
    expect(switchRec.shouldSwitch).toBe(false);
  });
});

// ── POLICY ENGINE INTEGRATION ─────────────────────────────────────────────────

describe('PolicyEngine interaction', () => {
  it('existing expired-card policy (EXPIRED_CARD_NO_RETRY) still fires correctly', () => {
    const payment = makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const recommendation = computeRecoveryRecommendation(payment);
    // decision engine recommends UPDATE_PAYMENT_METHOD directly for expired card
    expect(recommendation.recommendedAction).toBe('UPDATE_PAYMENT_METHOD');
    const decision = evaluatePolicy(payment, recommendation);
    expect(decision.approved).toBe(true);
    expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
  });

  it('policy engine remains authoritative — switch recommendation is advisory only', () => {
    // Even if switchRec says shouldSwitch:true, the policy engine decides the final action.
    const payment = makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const switchRec = subject({ payment });
    const recommendation = computeRecoveryRecommendation(payment);
    const decision = evaluatePolicy(payment, recommendation);
    // Policy approved UPDATE_PAYMENT_METHOD regardless of switchRec internals
    expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
    // Switch rec is computed independently and does not override policy
    expect(switchRec.shouldSwitch).toBe(true);
  });

  it('low confidence causes escalation regardless of switch recommendation', () => {
    const payment = makePayment({
      paymentMethod: 'CARD',
      failureReason: 'CUSTOMER_ABANDONED',
      attemptCount: 1,
      previousSuccessfulPayments: 0,
    });
    const recommendation = computeRecoveryRecommendation(payment);
    const decision = evaluatePolicy(payment, recommendation);
    // CUSTOMER_ABANDONED has base confidence 0.55 which is < 0.60 threshold
    expect(decision.approved).toBe(false);
    expect(decision.finalAction).toBe('ESCALATE');
    // Switch recommendation is still computed (advisory) but policy wins
    const switchRec = subject({ payment });
    expect(switchRec.shouldSwitch).toBe(false);
  });
});

// ── EDGE CASES ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('when shouldSwitch is false, alternatives are empty (safe fallback)', () => {
    const cases: Array<Partial<FailedPayment>> = [
      { failureReason: 'INSUFFICIENT_BALANCE' },
      { failureReason: 'AUTHENTICATION_FAILED' },
      { failureReason: 'CUSTOMER_ABANDONED' },
      { paymentMethod: 'UPI', failureReason: 'UPI_TIMEOUT', attemptCount: 1 },
      { paymentMethod: 'CARD', failureReason: 'BANK_SERVER_ERROR', attemptCount: 1 },
    ];
    for (const overrides of cases) {
      const result = subject({ payment: makePayment(overrides) });
      if (!result.shouldSwitch) {
        expect(result.alternatives).toHaveLength(0);
        expect(result.recommendedMethod).toBeNull();
      }
    }
  });

  it('alternatives reason strings are non-empty', () => {
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    for (const alt of result.alternatives) {
      expect(typeof alt.reason).toBe('string');
      expect(alt.reason.length).toBeGreaterThan(0);
    }
  });

  it('all alternative methods are valid PaymentMethod values', () => {
    const valid = new Set(['UPI', 'CARD', 'NETBANKING', 'WALLET']);
    const result = subject({ payment: makePayment({ paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' }) });
    for (const alt of result.alternatives) {
      expect(valid.has(alt.method)).toBe(true);
    }
  });
});
