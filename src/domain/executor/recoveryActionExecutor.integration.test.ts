/**
 * Integration tests: FailedPayment → RecoveryDecisionEngine → PolicyEngine → SimulatedRecoveryActionExecutor
 *
 * Covers the four representative cases required by the spec plus dataset-wide
 * invariant checks using all 40 synthetic records.
 */
import { describe, it, expect } from 'vitest';
import type { FailedPayment } from '../payments/types';
import { computeRecoveryRecommendation } from '../recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../policy/policyEngine';
import { SimulatedRecoveryActionExecutor } from './simulatedRecoveryActionExecutor';
import { loadFailedPayments } from '../../lib/failedPaymentLoader';

const executor = new SimulatedRecoveryActionExecutor();

function runPipeline(payment: FailedPayment) {
  const recommendation = computeRecoveryRecommendation(payment);
  const decision = evaluatePolicy(payment, recommendation);
  const result = executor.execute(payment, decision);
  return { recommendation, decision, result };
}

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_integ_base' as FailedPayment['paymentId'],
    customerId: 'cust_integ_001' as FailedPayment['customerId'],
    customerName: 'Integration Test Customer',
    amount: 500000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
    lastAttemptAt: '2025-06-01T10:00:00.000Z',
    failedAt: '2025-06-01T10:00:30.000Z',
    ...overrides,
  };
}

describe('FailedPayment → RecoveryDecisionEngine → PolicyEngine → SimulatedRecoveryActionExecutor', () => {
  describe('Case A — UPI_TIMEOUT, single attempt → RETRY_LATER → approved → simulated outcome', () => {
    it('policy approves RETRY_LATER and executor produces a deterministic binary outcome', () => {
      const payment = makePayment({
        paymentId: 'pay_integ_A' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 1,
        paymentMethod: 'UPI',
      });

      const { recommendation, decision, result } = runPipeline(payment);

      expect(recommendation.recommendedAction).toBe('RETRY_LATER');
      expect(recommendation.retryAfterMinutes).toBe(30);
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('RETRY_LATER');

      // Executor must produce RECOVERED or FAILED (not PENDING / ESCALATED / BLOCKED)
      expect(['RECOVERED', 'FAILED']).toContain(result.status);
      expect(result.action).toBe('RETRY_LATER');

      if (result.status === 'RECOVERED') {
        expect(result.recoveredAmount).toBe(payment.amount);
      } else {
        expect(result.recoveredAmount).toBe(0);
      }
    });

    it('outcome is deterministic across repeated calls', () => {
      const payment = makePayment({
        paymentId: 'pay_integ_A2' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 1,
      });

      const { result: r1 } = runPipeline(payment);
      const { result: r2 } = runPipeline(payment);

      expect(r1.status).toBe(r2.status);
      expect(r1.recoveredAmount).toBe(r2.recoveredAmount);
    });
  });

  describe('Case B — UPI_TIMEOUT with attemptCount >= 2 → policy ESCALATES → no automatic retry', () => {
    it('policy rejects RETRY_LATER at 2 attempts and executor returns ESCALATED', () => {
      const payment = makePayment({
        paymentId: 'pay_integ_B' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 2,
        paymentMethod: 'UPI',
      });

      const { recommendation, decision, result } = runPipeline(payment);

      expect(recommendation.recommendedAction).toBe('RETRY_LATER');

      // Policy must reject due to MAX_RETRY_ATTEMPTS
      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(decision.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');

      // Executor must not retry; status reflects the escalation
      expect(result.status).toBe('ESCALATED');
      expect(result.recoveredAmount).toBe(0);
      expect(result.action).toBe('ESCALATE');
    });

    it('also escalates at 3 attempts (above ceiling)', () => {
      const payment = makePayment({
        paymentId: 'pay_integ_B2' as FailedPayment['paymentId'],
        failureReason: 'UPI_TIMEOUT',
        attemptCount: 3,
      });

      const { decision, result } = runPipeline(payment);

      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(result.status).toBe('ESCALATED');
      expect(result.recoveredAmount).toBe(0);
    });
  });

  describe('Case C — EXPIRED_CARD → UPDATE_PAYMENT_METHOD → PENDING', () => {
    it('decision engine recommends UPDATE_PAYMENT_METHOD and executor returns PENDING', () => {
      const payment = makePayment({
        paymentId: 'pay_integ_C' as FailedPayment['paymentId'],
        failureReason: 'EXPIRED_CARD',
        paymentMethod: 'CARD',
        attemptCount: 1,
        previousSuccessfulPayments: 5,
      });

      const { recommendation, decision, result } = runPipeline(payment);

      expect(recommendation.recommendedAction).toBe('UPDATE_PAYMENT_METHOD');
      expect(recommendation.retryAfterMinutes).toBeNull();

      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('UPDATE_PAYMENT_METHOD');

      expect(result.status).toBe('PENDING');
      expect(result.recoveredAmount).toBe(0);
      expect(result.action).toBe('UPDATE_PAYMENT_METHOD');
    });

    it('EXPIRED_CARD never auto-recovers regardless of attempt count', () => {
      for (const attemptCount of [1, 2, 3]) {
        const payment = makePayment({
          paymentId: `pay_integ_C_att${attemptCount}` as FailedPayment['paymentId'],
          failureReason: 'EXPIRED_CARD',
          paymentMethod: 'CARD',
          attemptCount,
          previousSuccessfulPayments: 10,
        });

        const { result } = runPipeline(payment);

        // Status may be PENDING, ESCALATED, or BLOCKED — never RECOVERED
        expect(result.status).not.toBe('RECOVERED');
        expect(result.recoveredAmount).toBe(0);
      }
    });
  });

  describe('Case D — CUSTOMER_ABANDONED → SEND_PAYMENT_LINK → deterministic outcome', () => {
    it('policy approves SEND_PAYMENT_LINK when confidence meets threshold', () => {
      // previousSuccessfulPayments=5 → confidence = 0.55 + 0.10 = 0.65 >= 0.60 → approved
      const payment = makePayment({
        paymentId: 'pay_integ_D' as FailedPayment['paymentId'],
        failureReason: 'CUSTOMER_ABANDONED',
        paymentMethod: 'UPI',
        attemptCount: 1,
        previousSuccessfulPayments: 5,
      });

      const { recommendation, decision, result } = runPipeline(payment);

      expect(recommendation.recommendedAction).toBe('SEND_PAYMENT_LINK');
      expect(decision.approved).toBe(true);
      expect(decision.finalAction).toBe('SEND_PAYMENT_LINK');

      // Executor must produce RECOVERED or PENDING (not FAILED)
      expect(['RECOVERED', 'PENDING']).toContain(result.status);
      expect(result.action).toBe('SEND_PAYMENT_LINK');

      if (result.status === 'RECOVERED') {
        expect(result.recoveredAmount).toBe(payment.amount);
      } else {
        expect(result.recoveredAmount).toBe(0);
      }
    });

    it('CUSTOMER_ABANDONED outcome is deterministic', () => {
      const payment = makePayment({
        paymentId: 'pay_integ_D2' as FailedPayment['paymentId'],
        failureReason: 'CUSTOMER_ABANDONED',
        previousSuccessfulPayments: 5,
      });

      const { result: r1 } = runPipeline(payment);
      const { result: r2 } = runPipeline(payment);

      expect(r1.status).toBe(r2.status);
      expect(r1.recoveredAmount).toBe(r2.recoveredAmount);
      expect(r1.message).toBe(r2.message);
    });

    it('escalates CUSTOMER_ABANDONED when confidence is too low', () => {
      // 0 prior successes + 1 attempt: confidence = 0.55 + 0 - 0 = 0.55 < 0.60 → escalated
      const payment = makePayment({
        paymentId: 'pay_integ_D3' as FailedPayment['paymentId'],
        failureReason: 'CUSTOMER_ABANDONED',
        previousSuccessfulPayments: 0,
        attemptCount: 1,
      });

      const { decision, result } = runPipeline(payment);

      expect(decision.approved).toBe(false);
      expect(decision.finalAction).toBe('ESCALATE');
      expect(result.status).toBe('ESCALATED');
      expect(result.recoveredAmount).toBe(0);
    });
  });

  describe('Dataset-wide invariants', () => {
    it('processes all 40 synthetic dataset payments without throwing', () => {
      const payments = loadFailedPayments();
      expect(payments).toHaveLength(40);
      for (const payment of payments) {
        expect(() => runPipeline(payment)).not.toThrow();
      }
    });

    it('recoveredAmount invariant holds for every dataset payment', () => {
      const payments = loadFailedPayments();
      for (const payment of payments) {
        const { result } = runPipeline(payment);
        if (result.status === 'RECOVERED') {
          expect(result.recoveredAmount).toBe(payment.amount);
        } else {
          expect(result.recoveredAmount).toBe(0);
        }
      }
    });

    it('every result has a non-empty paymentId, action, status, executedAt, and message', () => {
      const payments = loadFailedPayments();
      for (const payment of payments) {
        const { result } = runPipeline(payment);
        expect(result.paymentId).toBeTruthy();
        expect(result.action).toBeTruthy();
        expect(result.status).toBeTruthy();
        expect(result.executedAt).toBeTruthy();
        expect(result.message).toBeTruthy();
      }
    });

    it('pipeline is deterministic for all dataset payments', () => {
      const payments = loadFailedPayments();
      for (const payment of payments) {
        const { result: r1 } = runPipeline(payment);
        const { result: r2 } = runPipeline(payment);
        expect(r1.status).toBe(r2.status);
        expect(r1.recoveredAmount).toBe(r2.recoveredAmount);
      }
    });

    it('dataset pipeline does not mutate any payment', () => {
      const payments = loadFailedPayments();
      const snapshots = payments.map((p) => JSON.stringify(p));
      for (const payment of payments) {
        runPipeline(payment);
      }
      payments.forEach((p, i) => {
        expect(JSON.stringify(p)).toBe(snapshots[i]);
      });
    });
  });
});
