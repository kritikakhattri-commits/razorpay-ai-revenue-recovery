import { describe, it, expect } from 'vitest';
import type { FailedPayment } from '../payments/types';
import type { RecoveryRecommendation } from '../recovery/types';
import { evaluatePolicy } from './policyEngine';

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
    previousSuccessfulPayments: 3,
    lastAttemptAt: '2024-01-15T10:30:00.000Z',
    failedAt: '2024-01-15T10:30:05.000Z',
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<RecoveryRecommendation> = {}): RecoveryRecommendation {
  return {
    diagnosis: 'Transient timeout.',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: 0.80,
    reasoning: 'UPI timeout is temporary.',
    maxAttempts: 3,
    ...overrides,
  };
}

describe('evaluatePolicy', () => {
  describe('RULE 1 — MAX_RETRY_ATTEMPTS', () => {
    it('approves RETRY_LATER when attemptCount is 1', () => {
      const decision = evaluatePolicy(makePayment({ attemptCount: 1 }), makeRecommendation());
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('RETRY_LATER');
    });

    it('escalates RETRY_LATER when attemptCount is exactly 2', () => {
      const decision = evaluatePolicy(makePayment({ attemptCount: 2 }), makeRecommendation());
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');
    });

    it('escalates RETRY_LATER when attemptCount is 3', () => {
      const decision = evaluatePolicy(makePayment({ attemptCount: 3 }), makeRecommendation());
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');
    });

    it('does not apply MAX_RETRY_ATTEMPTS when recommended action is not RETRY_LATER', () => {
      const decision = evaluatePolicy(
        makePayment({ attemptCount: 5, failureReason: 'AUTHENTICATION_FAILED' }),
        makeRecommendation({ recommendedAction: 'SEND_PAYMENT_LINK', retryAfterMinutes: null }),
      );
      expect(decision.policyRulesApplied).not.toContain('MAX_RETRY_ATTEMPTS');
    });
  });

  describe('RULE 2 — EXPIRED_CARD_NO_RETRY', () => {
    it('overrides RETRY_LATER to UPDATE_PAYMENT_METHOD for expired card', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'EXPIRED_CARD' }),
        makeRecommendation({ recommendedAction: 'RETRY_LATER', retryAfterMinutes: 30 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
      expect(decision.policyRulesApplied).toContain('EXPIRED_CARD_NO_RETRY');
    });

    it('does not trigger EXPIRED_CARD_NO_RETRY when action is already UPDATE_PAYMENT_METHOD', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'EXPIRED_CARD' }),
        makeRecommendation({
          recommendedAction: 'UPDATE_PAYMENT_METHOD',
          retryAfterMinutes: null,
          confidence: 0.88,
        }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
      expect(decision.policyRulesApplied).not.toContain('EXPIRED_CARD_NO_RETRY');
    });
  });

  describe('RULE 3 — LOW_CONFIDENCE_ESCALATION', () => {
    it('escalates when confidence is 0.59', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ confidence: 0.59 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('LOW_CONFIDENCE_ESCALATION');
    });

    it('escalates when confidence is 0.00', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ confidence: 0.0 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('LOW_CONFIDENCE_ESCALATION');
    });

    it('does not escalate when confidence is exactly 0.60', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ confidence: 0.60 }),
      );
      expect(decision.policyRulesApplied).not.toContain('LOW_CONFIDENCE_ESCALATION');
    });

    it('approves when confidence is exactly 0.60 and no other rule blocks', () => {
      const decision = evaluatePolicy(
        makePayment({ attemptCount: 1 }),
        makeRecommendation({ confidence: 0.60, retryAfterMinutes: 30 }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('RETRY_LATER');
    });

    it('applies LOW_CONFIDENCE_ESCALATION to non-retry actions too', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'AUTHENTICATION_FAILED' }),
        makeRecommendation({
          recommendedAction: 'SEND_PAYMENT_LINK',
          retryAfterMinutes: null,
          confidence: 0.55,
        }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('LOW_CONFIDENCE_ESCALATION');
    });
  });

  describe('RULE 4 — MINIMUM_RETRY_DELAY', () => {
    it('escalates when retryAfterMinutes is 29', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ retryAfterMinutes: 29 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MINIMUM_RETRY_DELAY');
    });

    it('escalates when retryAfterMinutes is 1', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ retryAfterMinutes: 1 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MINIMUM_RETRY_DELAY');
    });

    it('approves when retryAfterMinutes is exactly 30', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ retryAfterMinutes: 30 }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.policyRulesApplied).not.toContain('MINIMUM_RETRY_DELAY');
    });

    it('approves when retryAfterMinutes is 60', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ retryAfterMinutes: 60 }),
      );
      expect(decision.approved).toBe(true);
    });
  });

  describe('RULE 5 — BANK_ERROR_RETRY_DELAY', () => {
    it('escalates BANK_SERVER_ERROR retry with 59-minute delay', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'BANK_SERVER_ERROR' }),
        makeRecommendation({ retryAfterMinutes: 59 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('BANK_ERROR_RETRY_DELAY');
    });

    it('escalates BANK_SERVER_ERROR retry with 30-minute delay (passes RULE 4, fails RULE 5)', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'BANK_SERVER_ERROR' }),
        makeRecommendation({ retryAfterMinutes: 30 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('BANK_ERROR_RETRY_DELAY');
      expect(decision.policyRulesApplied).not.toContain('MINIMUM_RETRY_DELAY');
    });

    it('approves BANK_SERVER_ERROR retry when delay is exactly 60 minutes', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'BANK_SERVER_ERROR' }),
        makeRecommendation({ retryAfterMinutes: 60 }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('RETRY_LATER');
      expect(decision.policyRulesApplied).not.toContain('BANK_ERROR_RETRY_DELAY');
    });

    it('approves BANK_SERVER_ERROR retry when delay is 90 minutes', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'BANK_SERVER_ERROR' }),
        makeRecommendation({ retryAfterMinutes: 90 }),
      );
      expect(decision.approved).toBe(true);
    });

    it('does not apply BANK_ERROR_RETRY_DELAY to non-bank failures with a 30-min delay', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'UPI_TIMEOUT' }),
        makeRecommendation({ retryAfterMinutes: 30 }),
      );
      expect(decision.policyRulesApplied).not.toContain('BANK_ERROR_RETRY_DELAY');
    });
  });

  describe('RULE 6 — MISSING_RETRY_DELAY', () => {
    it('escalates RETRY_LATER when retryAfterMinutes is null', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({ recommendedAction: 'RETRY_LATER', retryAfterMinutes: null }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MISSING_RETRY_DELAY');
    });
  });

  describe('RULE 7 — NON_RETRY_RECOVERY_ACTIONS', () => {
    it('approves SEND_PAYMENT_LINK when confidence >= 0.60', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'AUTHENTICATION_FAILED' }),
        makeRecommendation({
          recommendedAction: 'SEND_PAYMENT_LINK',
          retryAfterMinutes: null,
          confidence: 0.62,
        }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('SEND_PAYMENT_LINK');
    });

    it('approves UPDATE_PAYMENT_METHOD when confidence >= 0.60', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'EXPIRED_CARD' }),
        makeRecommendation({
          recommendedAction: 'UPDATE_PAYMENT_METHOD',
          retryAfterMinutes: null,
          confidence: 0.88,
        }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
    });

    it('escalates SEND_PAYMENT_LINK when confidence is below 0.60', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'CUSTOMER_ABANDONED' }),
        makeRecommendation({
          recommendedAction: 'SEND_PAYMENT_LINK',
          retryAfterMinutes: null,
          confidence: 0.55,
        }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
    });
  });

  describe('ESCALATE pass-through', () => {
    it('passes through an ESCALATE recommendation as approved', () => {
      const decision = evaluatePolicy(
        makePayment(),
        makeRecommendation({
          recommendedAction: 'ESCALATE',
          retryAfterMinutes: null,
          confidence: 0.90,
        }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.originalRecommendedAction).toBe('ESCALATE');
    });
  });

  describe('output shape — originalRecommendedAction', () => {
    it('always records the original recommended action even when overridden', () => {
      const decision = evaluatePolicy(
        makePayment({ failureReason: 'EXPIRED_CARD' }),
        makeRecommendation({ recommendedAction: 'RETRY_LATER' }),
      );
      expect(decision.originalRecommendedAction).toBe('RETRY_LATER');
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
    });

    it('originalRecommendedAction matches finalAction when approved without override', () => {
      const decision = evaluatePolicy(makePayment(), makeRecommendation());
      expect(decision.originalRecommendedAction).toBe(decision.finalAction);
    });
  });

  describe('immutability — inputs are never mutated', () => {
    it('does not mutate the FailedPayment', () => {
      const payment = makePayment({ attemptCount: 3 });
      const before = JSON.stringify(payment);
      evaluatePolicy(payment, makeRecommendation());
      expect(JSON.stringify(payment)).toBe(before);
    });

    it('does not mutate the RecoveryRecommendation', () => {
      const rec = makeRecommendation({ confidence: 0.40 });
      const before = JSON.stringify(rec);
      evaluatePolicy(makePayment(), rec);
      expect(JSON.stringify(rec)).toBe(before);
    });
  });

  describe('determinism — same input always produces same output', () => {
    const cases: [string, Partial<FailedPayment>, Partial<RecoveryRecommendation>][] = [
      ['approved retry', { attemptCount: 1 }, { confidence: 0.80, retryAfterMinutes: 30 }],
      ['max attempts', { attemptCount: 3 }, { confidence: 0.80, retryAfterMinutes: 30 }],
      ['expired card', { failureReason: 'EXPIRED_CARD' }, { recommendedAction: 'RETRY_LATER', retryAfterMinutes: 30 }],
      ['low confidence', {}, { confidence: 0.50 }],
      ['null delay', {}, { retryAfterMinutes: null }],
      ['send payment link', { failureReason: 'AUTHENTICATION_FAILED' }, { recommendedAction: 'SEND_PAYMENT_LINK', retryAfterMinutes: null, confidence: 0.62 }],
    ];

    it.each(cases)('%s — repeated calls return identical result', (_label, paymentOverrides, recOverrides) => {
      const payment = makePayment(paymentOverrides);
      const rec = makeRecommendation(recOverrides);
      expect(evaluatePolicy(payment, rec)).toEqual(evaluatePolicy(payment, rec));
    });
  });

  describe('reason field', () => {
    it('includes a non-empty human-readable reason in all decisions', () => {
      const cases = [
        [makePayment(), makeRecommendation()],
        [makePayment({ attemptCount: 3 }), makeRecommendation()],
        [makePayment({ failureReason: 'EXPIRED_CARD' }), makeRecommendation()],
        [makePayment(), makeRecommendation({ confidence: 0.40 })],
      ] as const;
      for (const [payment, rec] of cases) {
        const decision = evaluatePolicy(payment, rec);
        expect(typeof decision.reason).toBe('string');
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
