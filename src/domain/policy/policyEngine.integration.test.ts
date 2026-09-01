/**
 * Integration tests: FailedPayment → RecoveryDecisionEngine → PolicyEngine
 *
 * These tests verify that the full recovery pipeline produces correct
 * PolicyDecisions for representative payment scenarios drawn from the
 * synthetic dataset (data/failed-payments.json).
 */
import { describe, it, expect } from 'vitest';
import type { FailedPayment } from '../payments/types';
import { computeRecoveryRecommendation } from '../recovery/recoveryDecisionEngine';
import { evaluatePolicy } from './policyEngine';

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_int001' as FailedPayment['paymentId'],
    customerId: 'cust_int001' as FailedPayment['customerId'],
    customerName: 'Integration Test',
    amount: 100000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
    lastAttemptAt: '2025-01-10T09:00:00.000Z',
    failedAt: '2025-01-10T09:00:31.000Z',
    ...overrides,
  };
}

function pipeline(payment: FailedPayment) {
  const recommendation = computeRecoveryRecommendation(payment);
  const decision = evaluatePolicy(payment, recommendation);
  return { recommendation, decision };
}

describe('FailedPayment → RecoveryDecisionEngine → PolicyEngine', () => {
  describe('Scenario A — UPI_TIMEOUT, first attempt, confident recovery', () => {
    // Mirrors: pay_RhKu7Y3DeF (UPI_TIMEOUT, attemptCount=0, previousSuccessfulPayments=12)
    it('approves RETRY_LATER for a fresh UPI timeout with good payment history', () => {
      const payment = makePayment({
        paymentId: 'pay_int_A' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 1,
        previousSuccessfulPayments: 8,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.recommendedAction).toBe('RETRY_LATER');
      expect(recommendation.confidence).toBeGreaterThanOrEqual(0.60);
      expect(recommendation.retryAfterMinutes).toBe(30);

      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('RETRY_LATER');
      expect(decision.originalRecommendedAction).toBe('RETRY_LATER');
      expect(decision.policyRulesApplied).toHaveLength(0);
    });
  });

  describe('Scenario B — UPI_TIMEOUT, repeated attempts, retry rejected', () => {
    // Mirrors: pay_ViSi6Q5JkL (UPI_TIMEOUT, attemptCount=3, previousSuccessfulPayments=1)
    it('escalates when attemptCount reaches the retry ceiling', () => {
      const payment = makePayment({
        paymentId: 'pay_int_B' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 3,
        previousSuccessfulPayments: 10,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.recommendedAction).toBe('RETRY_LATER');

      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.originalRecommendedAction).toBe('RETRY_LATER');
      // MAX_RETRY_ATTEMPTS should trigger (attemptCount=3 >= 2)
      expect(decision.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');
    });

    it('escalates at exactly 2 attempts (boundary)', () => {
      const payment = makePayment({
        paymentId: 'pay_int_B2' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 2,
        previousSuccessfulPayments: 10,
      });
      const { decision } = pipeline(payment);

      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');
    });
  });

  describe('Scenario C — EXPIRED_CARD → UPDATE_PAYMENT_METHOD', () => {
    // Mirrors any EXPIRED_CARD record in the dataset
    it('produces UPDATE_PAYMENT_METHOD for expired card regardless of attempt count', () => {
      const payment = makePayment({
        paymentId: 'pay_int_C' as FailedPayment['paymentId'],
        failureReason: 'EXPIRED_CARD',
        paymentMethod: 'CARD',
        attemptCount: 1,
        previousSuccessfulPayments: 5,
      });
      const { recommendation, decision } = pipeline(payment);

      // The recovery engine correctly maps EXPIRED_CARD → UPDATE_PAYMENT_METHOD
      expect(recommendation.recommendedAction).toBe('UPDATE_PAYMENT_METHOD');
      expect(recommendation.retryAfterMinutes).toBeNull();

      // Policy engine approves it
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
      expect(decision.policyRulesApplied).not.toContain('EXPIRED_CARD_NO_RETRY');
    });

    it('catches a hypothetical misrouted RETRY_LATER for an expired card', () => {
      // This cannot happen from our RecoveryDecisionEngine, but the PolicyEngine
      // acts as a safety net for future callers or AI-sourced recommendations.
      const payment = makePayment({
        paymentId: 'pay_int_C2' as FailedPayment['paymentId'],
        failureReason: 'EXPIRED_CARD',
        paymentMethod: 'CARD',
        attemptCount: 1,
      });
      const misroutedRec = {
        diagnosis: 'Hypothetical misrouted recommendation.',
        recommendedAction: 'RETRY_LATER' as const,
        retryAfterMinutes: 30,
        confidence: 0.80,
        reasoning: 'Incorrectly recommended retry.',
        maxAttempts: 1,
      };
      const decision = evaluatePolicy(payment, misroutedRec);

      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
      expect(decision.policyRulesApplied).toContain('EXPIRED_CARD_NO_RETRY');
    });
  });

  describe('Scenario D — Low-confidence recommendation escalates', () => {
    // Mirrors: CUSTOMER_ABANDONED with many failed attempts (confidence collapses to 0)
    // e.g., pay_PoVe3M8StU (UPI_TIMEOUT, attemptCount=4, previousSuccessfulPayments=25)
    // confidence = 0.80 + 0.15 - 0.45 = 0.50 → LOW_CONFIDENCE_ESCALATION
    it('escalates when accumulated attempt penalties push confidence below 0.60', () => {
      const payment = makePayment({
        paymentId: 'pay_int_D' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 4,
        previousSuccessfulPayments: 25,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.confidence).toBeLessThan(0.60);
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('LOW_CONFIDENCE_ESCALATION');
    });

    it('escalates CUSTOMER_ABANDONED when confidence is zero due to repeated failures', () => {
      // baseConfidence=0.55, attemptPenalty=(5-1)*0.15=0.60 → confidence=0.0 (clamped)
      const payment = makePayment({
        paymentId: 'pay_int_D2' as FailedPayment['paymentId'],
        failureReason: 'CUSTOMER_ABANDONED',
        attemptCount: 5,
        previousSuccessfulPayments: 0,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.confidence).toBe(0);
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('LOW_CONFIDENCE_ESCALATION');
    });
  });

  describe('Scenario E — BANK_SERVER_ERROR', () => {
    // The recovery engine always sets 60-minute delay for BANK_SERVER_ERROR.
    // The policy engine should approve at exactly 60 minutes.
    it('approves BANK_SERVER_ERROR retry when the engine returns 60-minute delay', () => {
      const payment = makePayment({
        paymentId: 'pay_int_E' as FailedPayment['paymentId'],
        failureReason: 'BANK_SERVER_ERROR',
        attemptCount: 1,
        previousSuccessfulPayments: 5,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.recommendedAction).toBe('RETRY_LATER');
      expect(recommendation.retryAfterMinutes).toBe(60);

      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('RETRY_LATER');
      expect(decision.policyRulesApplied).not.toContain('BANK_ERROR_RETRY_DELAY');
    });
  });

  describe('Scenario F — AUTHENTICATION_FAILED → SEND_PAYMENT_LINK', () => {
    // Mirrors: pay_AnPa9W4GhI (AUTHENTICATION_FAILED, attemptCount=2, previousSuccessfulPayments=0)
    // confidence = 0.62 + 0 - 0.15 = 0.47 → LOW_CONFIDENCE_ESCALATION
    it('escalates when AUTHENTICATION_FAILED confidence collapses after repeated attempts', () => {
      const payment = makePayment({
        paymentId: 'pay_int_F' as FailedPayment['paymentId'],
        failureReason: 'AUTHENTICATION_FAILED',
        attemptCount: 2,
        previousSuccessfulPayments: 0,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.recommendedAction).toBe('SEND_PAYMENT_LINK');
      expect(recommendation.confidence).toBeLessThan(0.60);
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
    });

    it('approves SEND_PAYMENT_LINK on first attempt with no prior history', () => {
      const payment = makePayment({
        paymentId: 'pay_int_F2' as FailedPayment['paymentId'],
        failureReason: 'AUTHENTICATION_FAILED',
        attemptCount: 1,
        previousSuccessfulPayments: 0,
      });
      const { recommendation, decision } = pipeline(payment);

      expect(recommendation.recommendedAction).toBe('SEND_PAYMENT_LINK');
      expect(recommendation.confidence).toBeGreaterThanOrEqual(0.60);
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('SEND_PAYMENT_LINK');
    });
  });

  describe('pipeline immutability', () => {
    it('running the full pipeline twice on the same payment returns identical decisions', () => {
      const payment = makePayment({
        paymentId: 'pay_int_det' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 1,
        previousSuccessfulPayments: 3,
      });
      const first = pipeline(payment);
      const second = pipeline(payment);
      expect(first.decision).toEqual(second.decision);
      expect(first.recommendation).toEqual(second.recommendation);
    });

    it('does not mutate the payment object through the full pipeline', () => {
      const payment = makePayment();
      const snapshot = JSON.stringify(payment);
      pipeline(payment);
      expect(JSON.stringify(payment)).toBe(snapshot);
    });
  });
});
