import { describe, it, expect } from 'vitest';
import type { FailedPayment } from '../payments/types';
import type { PolicyDecision } from '../policy/types';
import {
  SimulatedRecoveryActionExecutor,
  computeSimulationScore,
} from './simulatedRecoveryActionExecutor';

const FIXED_CLOCK = '2025-01-01T00:00:00.000Z';

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_unit_001' as FailedPayment['paymentId'],
    customerId: 'cust_unit_001' as FailedPayment['customerId'],
    customerName: 'Unit Test Customer',
    amount: 100000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
    lastAttemptAt: '2025-01-01T10:00:00.000Z',
    failedAt: '2025-01-01T10:00:30.000Z',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'All policy checks passed.',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: [],
    ...overrides,
  };
}

// Finds a deterministic paymentId whose simulation score falls in [min, max).
// Always searches from index 0 so the result is stable across test runs.
function paymentWithScore(
  min: number,
  max: number,
  overrides: Partial<FailedPayment> = {},
): FailedPayment {
  for (let i = 0; i < 10_000; i++) {
    const payment = makePayment({
      paymentId: `pay_search_${i}` as FailedPayment['paymentId'],
      ...overrides,
    });
    const score = computeSimulationScore(payment);
    if (score >= min && score < max) return payment;
  }
  throw new Error(`No paymentId found with score in [${min}, ${max}) for the given overrides`);
}

const executor = new SimulatedRecoveryActionExecutor(() => FIXED_CLOCK);

describe('SimulatedRecoveryActionExecutor', () => {
  describe('RETRY_LATER', () => {
    it('approved RETRY_LATER can return RECOVERED', () => {
      // UPI_TIMEOUT threshold is 75 — score < 75 → RECOVERED
      const payment = paymentWithScore(0, 75, { failureReason: 'UPI_TIMEOUT' });
      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('RECOVERED');
      expect(result.recoveredAmount).toBe(payment.amount);
      expect(result.action).toBe('RETRY_LATER');
      expect(result.paymentId).toBe(payment.paymentId);
    });

    it('approved RETRY_LATER can return FAILED', () => {
      // UPI_TIMEOUT threshold is 75 — score >= 75 → FAILED
      const payment = paymentWithScore(75, 100, { failureReason: 'UPI_TIMEOUT' });
      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('FAILED');
      expect(result.recoveredAmount).toBe(0);
      expect(result.action).toBe('RETRY_LATER');
    });

    it('RETRY_LATER + INSUFFICIENT_BALANCE has medium recovery likelihood', () => {
      // threshold is 45 — tests boundary existence on both sides
      const recovered = paymentWithScore(0, 45, { failureReason: 'INSUFFICIENT_BALANCE', paymentMethod: 'NETBANKING' });
      const failed = paymentWithScore(45, 100, { failureReason: 'INSUFFICIENT_BALANCE', paymentMethod: 'NETBANKING' });

      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      expect(executor.execute(recovered, decision).status).toBe('RECOVERED');
      expect(executor.execute(failed, decision).status).toBe('FAILED');
    });

    it('EXPIRED_CARD never recovers via RETRY_LATER', () => {
      // threshold is 0 — no score can be < 0, so FAILED always
      const payment = makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('FAILED');
      expect(result.recoveredAmount).toBe(0);
    });
  });

  describe('SEND_PAYMENT_LINK', () => {
    it('SEND_PAYMENT_LINK can return RECOVERED', () => {
      // AUTHENTICATION_FAILED threshold is 55 — score < 55 → RECOVERED
      const payment = paymentWithScore(0, 55, { failureReason: 'AUTHENTICATION_FAILED' });
      const decision = makeDecision({ finalAction: 'SEND_PAYMENT_LINK' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('RECOVERED');
      expect(result.recoveredAmount).toBe(payment.amount);
      expect(result.action).toBe('SEND_PAYMENT_LINK');
    });

    it('SEND_PAYMENT_LINK can return PENDING', () => {
      // AUTHENTICATION_FAILED threshold is 55 — score >= 55 → PENDING
      const payment = paymentWithScore(55, 100, { failureReason: 'AUTHENTICATION_FAILED' });
      const decision = makeDecision({ finalAction: 'SEND_PAYMENT_LINK' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('PENDING');
      expect(result.recoveredAmount).toBe(0);
      expect(result.action).toBe('SEND_PAYMENT_LINK');
    });

    it('EXPIRED_CARD never recovers via SEND_PAYMENT_LINK', () => {
      // threshold is 0 — no score can be < 0, so PENDING always
      const payment = makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
      const decision = makeDecision({ finalAction: 'SEND_PAYMENT_LINK' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('PENDING');
      expect(result.recoveredAmount).toBe(0);
    });
  });

  describe('UPDATE_PAYMENT_METHOD', () => {
    it('UPDATE_PAYMENT_METHOD always returns PENDING with zero recoveredAmount', () => {
      const payment = makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
      const decision = makeDecision({ finalAction: 'UPDATE_PAYMENT_METHOD' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('PENDING');
      expect(result.recoveredAmount).toBe(0);
      expect(result.action).toBe('UPDATE_PAYMENT_METHOD');
    });

    it('UPDATE_PAYMENT_METHOD message explains customer action is required', () => {
      const payment = makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
      const decision = makeDecision({ finalAction: 'UPDATE_PAYMENT_METHOD' });

      const result = executor.execute(payment, decision);

      expect(result.message.toLowerCase()).toMatch(/customer action required/);
    });
  });

  describe('ESCALATE', () => {
    it('approved ESCALATE returns ESCALATED with zero recoveredAmount', () => {
      const payment = makePayment();
      const decision = makeDecision({ finalAction: 'ESCALATE', reason: 'Manual review required.' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('ESCALATED');
      expect(result.recoveredAmount).toBe(0);
      expect(result.action).toBe('ESCALATE');
    });
  });

  describe('rejected policy (approved = false)', () => {
    it('rejected policy with ESCALATE finalAction → ESCALATED, no financial recovery', () => {
      const payment = makePayment();
      const decision = makeDecision({
        approved: false,
        finalAction: 'ESCALATE',
        reason: 'Max retry attempts exceeded.',
      });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('ESCALATED');
      expect(result.recoveredAmount).toBe(0);
    });

    it('rejected policy with non-ESCALATE finalAction → BLOCKED', () => {
      const payment = makePayment();
      const decision = makeDecision({
        approved: false,
        finalAction: 'UPDATE_PAYMENT_METHOD',
        reason: 'Expired card cannot be retried.',
        originalRecommendedAction: 'RETRY_LATER',
      });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('BLOCKED');
      expect(result.recoveredAmount).toBe(0);
    });

    it('rejected policy never executes financial recovery regardless of action', () => {
      const actions: PolicyDecision['finalAction'][] = [
        'RETRY_LATER',
        'SEND_PAYMENT_LINK',
        'UPDATE_PAYMENT_METHOD',
        'ESCALATE',
      ];
      for (const finalAction of actions) {
        const payment = makePayment();
        const decision = makeDecision({ approved: false, finalAction, reason: 'Policy rejected.' });

        const result = executor.execute(payment, decision);

        expect(result.status).not.toBe('RECOVERED');
        expect(result.recoveredAmount).toBe(0);
      }
    });
  });

  describe('recoveredAmount invariant', () => {
    it('recoveredAmount equals payment amount only when status is RECOVERED', () => {
      // Use a score < 75 so RETRY_LATER + UPI_TIMEOUT resolves to RECOVERED
      const payment = paymentWithScore(0, 75, { failureReason: 'UPI_TIMEOUT', amount: 250000 });
      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('RECOVERED');
      expect(result.recoveredAmount).toBe(250000);
    });

    it('recoveredAmount is zero for FAILED status', () => {
      const payment = paymentWithScore(75, 100, { failureReason: 'UPI_TIMEOUT' });
      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('FAILED');
      expect(result.recoveredAmount).toBe(0);
    });

    it('recoveredAmount is zero for PENDING status', () => {
      const payment = makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
      const decision = makeDecision({ finalAction: 'UPDATE_PAYMENT_METHOD' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('PENDING');
      expect(result.recoveredAmount).toBe(0);
    });

    it('recoveredAmount is zero for ESCALATED status', () => {
      const payment = makePayment();
      const decision = makeDecision({ finalAction: 'ESCALATE' });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('ESCALATED');
      expect(result.recoveredAmount).toBe(0);
    });

    it('recoveredAmount is zero for BLOCKED status', () => {
      const payment = makePayment();
      const decision = makeDecision({
        approved: false,
        finalAction: 'UPDATE_PAYMENT_METHOD',
        reason: 'Policy rejected.',
        originalRecommendedAction: 'RETRY_LATER',
      });

      const result = executor.execute(payment, decision);

      expect(result.status).toBe('BLOCKED');
      expect(result.recoveredAmount).toBe(0);
    });
  });

  describe('determinism', () => {
    it('same input always gives the same result', () => {
      const payment = makePayment({ paymentId: 'pay_determinism_001' as FailedPayment['paymentId'] });
      const decision = makeDecision();

      const r1 = executor.execute(payment, decision);
      const r2 = executor.execute(payment, decision);

      expect(r1.status).toBe(r2.status);
      expect(r1.recoveredAmount).toBe(r2.recoveredAmount);
      expect(r1.message).toBe(r2.message);
      expect(r1.action).toBe(r2.action);
      expect(r1.executedAt).toBe(r2.executedAt);
    });

    it('different paymentIds can produce different outcomes for the same action', () => {
      const recovered = paymentWithScore(0, 75, { failureReason: 'UPI_TIMEOUT' });
      const failed = paymentWithScore(75, 100, { failureReason: 'UPI_TIMEOUT' });
      const decision = makeDecision({ finalAction: 'RETRY_LATER' });

      const r1 = executor.execute(recovered, decision);
      const r2 = executor.execute(failed, decision);

      expect(r1.status).toBe('RECOVERED');
      expect(r2.status).toBe('FAILED');
    });
  });

  describe('immutability', () => {
    it('does not mutate FailedPayment', () => {
      const payment = makePayment();
      const snapshot = JSON.stringify(payment);
      const decision = makeDecision();

      executor.execute(payment, decision);

      expect(JSON.stringify(payment)).toBe(snapshot);
    });

    it('does not mutate PolicyDecision', () => {
      const payment = makePayment();
      const decision = makeDecision();
      const snapshot = JSON.stringify(decision);

      executor.execute(payment, decision);

      expect(JSON.stringify(decision)).toBe(snapshot);
    });
  });

  describe('result shape', () => {
    it('result contains all required fields with correct types', () => {
      const payment = makePayment();
      const decision = makeDecision();

      const result = executor.execute(payment, decision);

      expect(typeof result.paymentId).toBe('string');
      expect(typeof result.action).toBe('string');
      expect(typeof result.status).toBe('string');
      expect(typeof result.executedAt).toBe('string');
      expect(typeof result.recoveredAmount).toBe('number');
      expect(typeof result.message).toBe('string');
      expect(result.paymentId).toBe(payment.paymentId);
      expect(result.executedAt).toBe(FIXED_CLOCK);
    });
  });
});
