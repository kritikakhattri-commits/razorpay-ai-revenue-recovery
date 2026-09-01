import { describe, it, expect, beforeEach } from 'vitest';
import { AuditLogger, makeCounterIdGenerator } from './auditLogger';
import { InMemoryAuditStore } from '../../domain/audit/inMemoryAuditStore';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult } from '../../domain/executor/types';

const FIXED_TIMESTAMP = '2025-06-01T10:00:00.000Z';
const fixedClock = () => FIXED_TIMESTAMP;

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_test_001' as FailedPayment['paymentId'],
    customerId: 'cust_test_001' as FailedPayment['customerId'],
    customerName: 'Test Customer',
    amount: 249900,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
    lastAttemptAt: '2025-06-01T09:59:30.000Z',
    failedAt: '2025-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<RecoveryRecommendation> = {}): RecoveryRecommendation {
  return {
    diagnosis: 'UPI timeout detected.',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: 0.88,
    reasoning: 'Transient failure. High confidence in retry.',
    maxAttempts: 3,
    ...overrides,
  };
}

function makeApprovedDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'All policy rules passed.',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: ['NON_RETRY_RECOVERY_ACTIONS'],
    ...overrides,
  };
}

function makeRejectedDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    approved: false,
    finalAction: 'ESCALATE',
    reason: 'Max retry attempts exceeded.',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: ['MAX_RETRY_ATTEMPTS'],
    ...overrides,
  };
}

function makeResult(overrides: Partial<RecoveryExecutionResult> = {}): RecoveryExecutionResult {
  return {
    paymentId: 'pay_test_001' as RecoveryExecutionResult['paymentId'],
    action: 'RETRY_LATER',
    status: 'RECOVERED',
    executedAt: FIXED_TIMESTAMP,
    recoveredAmount: 249900,
    message: 'Retry succeeded.',
    ...overrides,
  };
}

describe('AuditLogger', () => {
  let store: InMemoryAuditStore;
  let logger: AuditLogger;

  beforeEach(() => {
    store = new InMemoryAuditStore();
    logger = new AuditLogger(store, fixedClock, makeCounterIdGenerator('test'));
  });

  describe('logPaymentFailed', () => {
    it('appends a PAYMENT_FAILED entry', () => {
      logger.logPaymentFailed(makePayment());
      expect(store.getAll()[0].eventType).toBe('PAYMENT_FAILED');
    });

    it('message includes the failure reason', () => {
      logger.logPaymentFailed(makePayment({ failureReason: 'UPI_TIMEOUT' }));
      expect(store.getAll()[0].message).toBe('Payment failed with UPI_TIMEOUT.');
    });

    it('metadata contains failureReason, paymentMethod, attemptCount, amount', () => {
      logger.logPaymentFailed(makePayment());
      const { metadata } = store.getAll()[0];
      expect(metadata['failureReason']).toBe('UPI_TIMEOUT');
      expect(metadata['paymentMethod']).toBe('UPI');
      expect(metadata['attemptCount']).toBe(1);
      expect(metadata['amount']).toBe(249900);
    });

    it('uses the injected clock for timestamp', () => {
      logger.logPaymentFailed(makePayment());
      expect(store.getAll()[0].timestamp).toBe(FIXED_TIMESTAMP);
    });

    it('uses the injected ID generator for auditId', () => {
      logger.logPaymentFailed(makePayment());
      expect(store.getAll()[0].auditId).toBe('test_1');
    });

    it('paymentId on the entry matches the payment', () => {
      logger.logPaymentFailed(makePayment({ paymentId: 'pay_abc' as FailedPayment['paymentId'] }));
      expect(store.getAll()[0].paymentId).toBe('pay_abc');
    });
  });

  describe('logRecoveryRecommendation', () => {
    it('appends a RECOVERY_RECOMMENDED entry', () => {
      logger.logRecoveryRecommendation(makePayment(), makeRecommendation());
      expect(store.getAll()[0].eventType).toBe('RECOVERY_RECOMMENDED');
    });

    it('message includes recommendedAction and confidence to 2 decimal places', () => {
      logger.logRecoveryRecommendation(makePayment(), makeRecommendation({ recommendedAction: 'RETRY_LATER', confidence: 0.88 }));
      expect(store.getAll()[0].message).toBe('Recovery engine recommended RETRY_LATER with confidence 0.88.');
    });

    it('formats confidence with 2 decimal places even for round values', () => {
      logger.logRecoveryRecommendation(makePayment(), makeRecommendation({ confidence: 0.8 }));
      expect(store.getAll()[0].message).toContain('0.80');
    });

    it('metadata contains recommendedAction, confidence, retryAfterMinutes, maxAttempts', () => {
      logger.logRecoveryRecommendation(makePayment(), makeRecommendation());
      const { metadata } = store.getAll()[0];
      expect(metadata['recommendedAction']).toBe('RETRY_LATER');
      expect(metadata['confidence']).toBe(0.88);
      expect(metadata['retryAfterMinutes']).toBe(30);
      expect(metadata['maxAttempts']).toBe(3);
    });

    it('metadata preserves null retryAfterMinutes for non-retry actions', () => {
      logger.logRecoveryRecommendation(makePayment(), makeRecommendation({ retryAfterMinutes: null }));
      expect(store.getAll()[0].metadata['retryAfterMinutes']).toBeNull();
    });
  });

  describe('logPolicyDecision — approved', () => {
    it('appends POLICY_APPROVED', () => {
      logger.logPolicyDecision(makePayment(), makeApprovedDecision());
      expect(store.getAll()[0].eventType).toBe('POLICY_APPROVED');
    });

    it('message names the approved final action', () => {
      logger.logPolicyDecision(makePayment(), makeApprovedDecision({ finalAction: 'RETRY_LATER' }));
      expect(store.getAll()[0].message).toBe('Policy approved RETRY_LATER.');
    });

    it('metadata includes finalAction, originalRecommendedAction, policyRulesApplied', () => {
      logger.logPolicyDecision(makePayment(), makeApprovedDecision());
      const { metadata } = store.getAll()[0];
      expect(metadata['finalAction']).toBe('RETRY_LATER');
      expect(metadata['originalRecommendedAction']).toBe('RETRY_LATER');
      expect(metadata['policyRulesApplied']).toEqual(['NON_RETRY_RECOVERY_ACTIONS']);
    });

    it('metadata does not include reason for approved decisions', () => {
      logger.logPolicyDecision(makePayment(), makeApprovedDecision());
      expect(store.getAll()[0].metadata['reason']).toBeUndefined();
    });
  });

  describe('logPolicyDecision — rejected', () => {
    it('appends POLICY_REJECTED', () => {
      logger.logPolicyDecision(makePayment(), makeRejectedDecision());
      expect(store.getAll()[0].eventType).toBe('POLICY_REJECTED');
    });

    it('message names the original recommended action and mentions escalation', () => {
      logger.logPolicyDecision(makePayment(), makeRejectedDecision({ originalRecommendedAction: 'RETRY_LATER' }));
      expect(store.getAll()[0].message).toBe('Policy rejected RETRY_LATER and escalated the case.');
    });

    it('metadata includes reason for rejected decisions', () => {
      logger.logPolicyDecision(makePayment(), makeRejectedDecision({ reason: 'Max retry attempts exceeded.' }));
      expect(store.getAll()[0].metadata['reason']).toBe('Max retry attempts exceeded.');
    });

    it('metadata includes policyRulesApplied', () => {
      logger.logPolicyDecision(makePayment(), makeRejectedDecision());
      expect(store.getAll()[0].metadata['policyRulesApplied']).toEqual(['MAX_RETRY_ATTEMPTS']);
    });
  });

  describe('logActionExecuted', () => {
    it('appends ACTION_EXECUTED', () => {
      logger.logActionExecuted(makeResult());
      expect(store.getAll()[0].eventType).toBe('ACTION_EXECUTED');
    });

    it('message includes the action name and paymentId', () => {
      logger.logActionExecuted(makeResult({ action: 'RETRY_LATER', paymentId: 'pay_test_001' as RecoveryExecutionResult['paymentId'] }));
      const msg = store.getAll()[0].message;
      expect(msg).toContain('RETRY_LATER');
      expect(msg).toContain('pay_test_001');
    });

    it('metadata includes action and status', () => {
      logger.logActionExecuted(makeResult({ action: 'SEND_PAYMENT_LINK', status: 'PENDING' }));
      const { metadata } = store.getAll()[0];
      expect(metadata['action']).toBe('SEND_PAYMENT_LINK');
      expect(metadata['status']).toBe('PENDING');
    });

    it('paymentId on the entry comes from result.paymentId', () => {
      logger.logActionExecuted(makeResult({ paymentId: 'pay_exec_xyz' as RecoveryExecutionResult['paymentId'] }));
      expect(store.getAll()[0].paymentId).toBe('pay_exec_xyz');
    });
  });

  describe('logFinalOutcome — PAYMENT_RECOVERED', () => {
    it('appends PAYMENT_RECOVERED for RECOVERED status', () => {
      logger.logFinalOutcome(makeResult({ status: 'RECOVERED', recoveredAmount: 249900 }));
      expect(store.getAll()[0].eventType).toBe('PAYMENT_RECOVERED');
    });

    it('2499 paise → ₹24.99', () => {
      logger.logFinalOutcome(makeResult({ status: 'RECOVERED', recoveredAmount: 2499 }));
      expect(store.getAll()[0].message).toBe('Recovery action completed successfully. ₹24.99 recovered.');
    });

    it('5000 paise → ₹50.00 (always 2 decimal places, even for whole-rupee amounts)', () => {
      logger.logFinalOutcome(makeResult({ status: 'RECOVERED', recoveredAmount: 5000 }));
      expect(store.getAll()[0].message).toBe('Recovery action completed successfully. ₹50.00 recovered.');
    });

    it('250050 paise → ₹2,500.50 (2 decimal places with comma separator)', () => {
      logger.logFinalOutcome(makeResult({ status: 'RECOVERED', recoveredAmount: 250050 }));
      expect(store.getAll()[0].message).toBe('Recovery action completed successfully. ₹2,500.50 recovered.');
    });

    it('249900 paise → ₹2,499.00', () => {
      logger.logFinalOutcome(makeResult({ status: 'RECOVERED', recoveredAmount: 249900 }));
      expect(store.getAll()[0].message).toBe('Recovery action completed successfully. ₹2,499.00 recovered.');
    });

    it('metadata stores recoveredAmount as raw paise, not rupees', () => {
      logger.logFinalOutcome(makeResult({ status: 'RECOVERED', recoveredAmount: 249900 }));
      expect(store.getAll()[0].metadata['recoveredAmount']).toBe(249900);
    });
  });

  describe('logFinalOutcome — RECOVERY_FAILED', () => {
    it('appends RECOVERY_FAILED for FAILED status', () => {
      logger.logFinalOutcome(makeResult({ status: 'FAILED', recoveredAmount: 0 }));
      expect(store.getAll()[0].eventType).toBe('RECOVERY_FAILED');
    });

    it('message indicates failure', () => {
      logger.logFinalOutcome(makeResult({ status: 'FAILED', recoveredAmount: 0 }));
      expect(store.getAll()[0].message).toBe('Recovery action failed. Payment could not be recovered.');
    });

    it('metadata does not include recoveredAmount for non-RECOVERED statuses', () => {
      logger.logFinalOutcome(makeResult({ status: 'FAILED', recoveredAmount: 0 }));
      expect(store.getAll()[0].metadata['recoveredAmount']).toBeUndefined();
    });
  });

  describe('logFinalOutcome — RECOVERY_PENDING', () => {
    it('appends RECOVERY_PENDING for PENDING status', () => {
      logger.logFinalOutcome(makeResult({ status: 'PENDING', recoveredAmount: 0, action: 'UPDATE_PAYMENT_METHOD' }));
      expect(store.getAll()[0].eventType).toBe('RECOVERY_PENDING');
    });

    it('message indicates pending state', () => {
      logger.logFinalOutcome(makeResult({ status: 'PENDING', recoveredAmount: 0 }));
      expect(store.getAll()[0].message).toBe('Recovery action pending. Awaiting customer or external action.');
    });
  });

  describe('logFinalOutcome — ESCALATED', () => {
    it('appends ESCALATED for ESCALATED status', () => {
      logger.logFinalOutcome(makeResult({ status: 'ESCALATED', recoveredAmount: 0, action: 'ESCALATE' }));
      expect(store.getAll()[0].eventType).toBe('ESCALATED');
    });

    it('message indicates manual review', () => {
      logger.logFinalOutcome(makeResult({ status: 'ESCALATED', recoveredAmount: 0, action: 'ESCALATE' }));
      expect(store.getAll()[0].message).toBe('Payment escalated for manual review.');
    });
  });

  describe('logFinalOutcome — ACTION_BLOCKED', () => {
    it('appends ACTION_BLOCKED for BLOCKED status', () => {
      logger.logFinalOutcome(makeResult({ status: 'BLOCKED', recoveredAmount: 0, action: 'RETRY_LATER' }));
      expect(store.getAll()[0].eventType).toBe('ACTION_BLOCKED');
    });

    it('message indicates blocked by policy', () => {
      logger.logFinalOutcome(makeResult({ status: 'BLOCKED', recoveredAmount: 0 }));
      expect(store.getAll()[0].message).toBe('Recovery action blocked by policy.');
    });
  });

  describe('determinism', () => {
    it('auditIds increment sequentially with each log call', () => {
      logger.logPaymentFailed(makePayment());
      logger.logPaymentFailed(makePayment());
      logger.logPaymentFailed(makePayment());
      const all = store.getAll();
      expect(all[0].auditId).toBe('test_1');
      expect(all[1].auditId).toBe('test_2');
      expect(all[2].auditId).toBe('test_3');
    });

    it('all entries carry the fixed clock timestamp', () => {
      logger.logPaymentFailed(makePayment());
      logger.logRecoveryRecommendation(makePayment(), makeRecommendation());
      logger.logPolicyDecision(makePayment(), makeApprovedDecision());
      for (const entry of store.getAll()) {
        expect(entry.timestamp).toBe(FIXED_TIMESTAMP);
      }
    });

    it('makeCounterIdGenerator produces isolated counters per call', () => {
      const gen1 = makeCounterIdGenerator('alpha');
      const gen2 = makeCounterIdGenerator('beta');
      expect(gen1()).toBe('alpha_1');
      expect(gen2()).toBe('beta_1');
      expect(gen1()).toBe('alpha_2');
      expect(gen2()).toBe('beta_2');
    });

    it('a fresh AuditLogger with a fresh counter generator starts IDs from 1', () => {
      const store2 = new InMemoryAuditStore();
      const logger2 = new AuditLogger(store2, fixedClock, makeCounterIdGenerator('fresh'));
      logger2.logPaymentFailed(makePayment());
      expect(store2.getAll()[0].auditId).toBe('fresh_1');
    });
  });
});
