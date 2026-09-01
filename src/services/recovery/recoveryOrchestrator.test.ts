import { describe, it, expect, beforeEach } from 'vitest';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryExecutionResult } from '../../domain/executor/types';
import type { RecoveryActionExecutor } from '../../domain/executor/recoveryActionExecutor';
import { computeRecoveryRecommendation } from '../../domain/recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../../domain/policy/policyEngine';
import { SimulatedRecoveryActionExecutor } from '../../domain/executor/simulatedRecoveryActionExecutor';
import { InMemoryAuditStore } from '../../domain/audit/inMemoryAuditStore';
import { AuditLogger, makeCounterIdGenerator } from '../audit/auditLogger';
import { RecoveryOrchestrator } from './recoveryOrchestrator';
import type { RecoveryCase } from './types';

const FIXED_TIMESTAMP = '2025-06-01T12:00:00.000Z';
const fixedClock = () => FIXED_TIMESTAMP;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_orch_base' as FailedPayment['paymentId'],
    customerId: 'cust_orch_001' as FailedPayment['customerId'],
    customerName: 'Orchestrator Test',
    amount: 249900,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
    lastAttemptAt: '2025-06-01T11:59:30.000Z',
    failedAt: '2025-06-01T12:00:00.000Z',
    ...overrides,
  };
}

// Tracking executor: throws if invoked with a rejected PolicyDecision, proving
// the orchestrator never passes rejected decisions to the executor.
// Returns the provided result for approved decisions and records invocation count.
function makeTrackingExecutor(result: RecoveryExecutionResult) {
  let callCount = 0;
  const executor: RecoveryActionExecutor = {
    execute(_payment: FailedPayment, decision: { approved: boolean }): RecoveryExecutionResult {
      if (!decision.approved) {
        throw new Error(
          'RecoveryActionExecutor must not be called with a rejected PolicyDecision — ' +
          'the orchestrator must resolve rejected decisions without invoking the executor',
        );
      }
      callCount++;
      return result;
    },
  };
  return { executor, getCallCount: () => callCount };
}

function makeOrchestrator(executor: RecoveryActionExecutor) {
  const store = new InMemoryAuditStore();
  const logger = new AuditLogger(store, fixedClock, makeCounterIdGenerator('orch'));
  const orchestrator = new RecoveryOrchestrator({
    decisionEngine: computeRecoveryRecommendation,
    policyEngine: evaluatePolicy,
    executor,
    auditLogger: logger,
    auditStore: store,
    clock: fixedClock,
  });
  return { orchestrator, store };
}

function approvedResult(
  paymentId: string,
  overrides: Partial<RecoveryExecutionResult> = {},
): RecoveryExecutionResult {
  return {
    paymentId: paymentId as RecoveryExecutionResult['paymentId'],
    action: 'RETRY_LATER',
    status: 'RECOVERED',
    executedAt: FIXED_TIMESTAMP,
    recoveredAmount: 249900,
    message: 'Retry succeeded.',
    ...overrides,
  };
}

function eventTypes(recoveryCase: RecoveryCase): string[] {
  return recoveryCase.auditEntries.map((e) => e.eventType);
}

// ---------------------------------------------------------------------------
// Scenario A — Successful UPI recovery
// ---------------------------------------------------------------------------

describe('Scenario A — successful UPI recovery', () => {
  // Payment: UPI_TIMEOUT, first attempt, 5 prior successes
  // Confidence = 0.80 + min(5×0.02, 0.15) − max(0, 1−1)×0.15 = 0.90
  // Policy: RETRY_LATER, 30 min, attemptCount=1 < 2 → APPROVED
  // Executor: RECOVERED

  const payment = makePayment({
    paymentId: 'pay_upi_recovered' as FailedPayment['paymentId'],
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
  });

  let recoveryCase: RecoveryCase;

  beforeEach(() => {
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, {
        action: 'RETRY_LATER',
        status: 'RECOVERED',
        recoveredAmount: payment.amount,
      }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    recoveryCase = orchestrator.recover(payment);
  });

  it('policy approves RETRY_LATER', () => {
    expect(recoveryCase.policyDecision.approved).toBe(true);
    expect(recoveryCase.policyDecision.finalAction).toBe('RETRY_LATER');
  });

  it('execution result is RECOVERED', () => {
    expect(recoveryCase.executionResult.status).toBe('RECOVERED');
  });

  it('recoveredAmount equals execution result recoveredAmount', () => {
    expect(recoveryCase.recoveredAmount).toBe(recoveryCase.executionResult.recoveredAmount);
    expect(recoveryCase.recoveredAmount).toBe(payment.amount);
  });

  it('audit sequence is PAYMENT_FAILED → RECOVERY_RECOMMENDED → POLICY_APPROVED → ACTION_EXECUTED → PAYMENT_RECOVERED', () => {
    expect(eventTypes(recoveryCase)).toEqual([
      'PAYMENT_FAILED',
      'RECOVERY_RECOMMENDED',
      'POLICY_APPROVED',
      'ACTION_EXECUTED',
      'PAYMENT_RECOVERED',
    ]);
  });

  it('contains exactly 5 audit entries', () => {
    expect(recoveryCase.auditEntries).toHaveLength(5);
  });

  it('all audit entries carry the payment ID', () => {
    for (const entry of recoveryCase.auditEntries) {
      expect(entry.paymentId).toBe(payment.paymentId);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario B — Failed retry
// ---------------------------------------------------------------------------

describe('Scenario B — failed retry', () => {
  // Same policy approval path as A; executor returns FAILED instead of RECOVERED.

  const payment = makePayment({
    paymentId: 'pay_upi_failed' as FailedPayment['paymentId'],
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
  });

  let recoveryCase: RecoveryCase;

  beforeEach(() => {
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, {
        action: 'RETRY_LATER',
        status: 'FAILED',
        recoveredAmount: 0,
        message: 'Retry failed. The failure persists.',
      }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    recoveryCase = orchestrator.recover(payment);
  });

  it('policy approves RETRY_LATER', () => {
    expect(recoveryCase.policyDecision.approved).toBe(true);
    expect(recoveryCase.policyDecision.finalAction).toBe('RETRY_LATER');
  });

  it('execution result is FAILED', () => {
    expect(recoveryCase.executionResult.status).toBe('FAILED');
  });

  it('recoveredAmount is 0', () => {
    expect(recoveryCase.recoveredAmount).toBe(0);
  });

  it('audit sequence is PAYMENT_FAILED → RECOVERY_RECOMMENDED → POLICY_APPROVED → ACTION_EXECUTED → RECOVERY_FAILED', () => {
    expect(eventTypes(recoveryCase)).toEqual([
      'PAYMENT_FAILED',
      'RECOVERY_RECOMMENDED',
      'POLICY_APPROVED',
      'ACTION_EXECUTED',
      'RECOVERY_FAILED',
    ]);
  });

  it('contains exactly 5 audit entries', () => {
    expect(recoveryCase.auditEntries).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Scenario C — Expired card → UPDATE_PAYMENT_METHOD → PENDING
// ---------------------------------------------------------------------------

describe('Scenario C — expired card', () => {
  // Payment: EXPIRED_CARD, first attempt, 3 prior successes
  // Confidence = 0.88 + min(3×0.02, 0.15) − 0 = 0.94
  // Policy: NON_RETRY_RECOVERY_ACTIONS → UPDATE_PAYMENT_METHOD approved
  // Executor: PENDING (customer must update card)

  const payment = makePayment({
    paymentId: 'pay_expired_card' as FailedPayment['paymentId'],
    failureReason: 'EXPIRED_CARD',
    paymentMethod: 'CARD',
    attemptCount: 1,
    previousSuccessfulPayments: 3,
  });

  let recoveryCase: RecoveryCase;

  beforeEach(() => {
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, {
        action: 'UPDATE_PAYMENT_METHOD',
        status: 'PENDING',
        recoveredAmount: 0,
        message: 'Customer action required: update payment method.',
      }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    recoveryCase = orchestrator.recover(payment);
  });

  it('decision engine recommends UPDATE_PAYMENT_METHOD', () => {
    expect(recoveryCase.recommendation.recommendedAction).toBe('UPDATE_PAYMENT_METHOD');
    expect(recoveryCase.recommendation.retryAfterMinutes).toBeNull();
  });

  it('policy approves UPDATE_PAYMENT_METHOD', () => {
    expect(recoveryCase.policyDecision.approved).toBe(true);
    expect(recoveryCase.policyDecision.finalAction).toBe('UPDATE_PAYMENT_METHOD');
  });

  it('execution result is PENDING', () => {
    expect(recoveryCase.executionResult.status).toBe('PENDING');
  });

  it('recoveredAmount is 0', () => {
    expect(recoveryCase.recoveredAmount).toBe(0);
  });

  it('audit sequence is PAYMENT_FAILED → RECOVERY_RECOMMENDED → POLICY_APPROVED → ACTION_EXECUTED → RECOVERY_PENDING', () => {
    expect(eventTypes(recoveryCase)).toEqual([
      'PAYMENT_FAILED',
      'RECOVERY_RECOMMENDED',
      'POLICY_APPROVED',
      'ACTION_EXECUTED',
      'RECOVERY_PENDING',
    ]);
  });

  it('contains exactly 5 audit entries', () => {
    expect(recoveryCase.auditEntries).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Scenario D — Retry limit exceeded → POLICY_REJECTED → ESCALATED
// ---------------------------------------------------------------------------

describe('Scenario D — retry limit exceeded', () => {
  // Payment: UPI_TIMEOUT, attemptCount=2 (hits MAX_AUTO_RETRY_ATTEMPTS=2)
  // Confidence = 0.80 + 0.10 − 0.15 = 0.75 ≥ 0.60 → passes confidence check
  // Policy: MAX_RETRY_ATTEMPTS → REJECTED, finalAction=ESCALATE
  // Orchestrator: constructs ESCALATED result directly — executor is NOT called.
  // KEY INVARIANT: ACTION_EXECUTED must NOT appear in the audit trail

  const payment = makePayment({
    paymentId: 'pay_max_retry' as FailedPayment['paymentId'],
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 2,
    previousSuccessfulPayments: 5,
  });

  let recoveryCase: RecoveryCase;

  beforeEach(() => {
    // Tracking executor throws if called with a rejected decision —
    // this proves the orchestrator does not reach the executor for rejected cases.
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    recoveryCase = orchestrator.recover(payment);
  });

  it('policy rejects the recommendation', () => {
    expect(recoveryCase.policyDecision.approved).toBe(false);
  });

  it('policy applies MAX_RETRY_ATTEMPTS rule', () => {
    expect(recoveryCase.policyDecision.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');
  });

  it('policy escalates rather than executing a retry', () => {
    expect(recoveryCase.policyDecision.finalAction).toBe('ESCALATE');
  });

  it('execution result is ESCALATED — the retry was not executed', () => {
    expect(recoveryCase.executionResult.status).toBe('ESCALATED');
  });

  it('recoveredAmount is 0 — no money recovered', () => {
    expect(recoveryCase.recoveredAmount).toBe(0);
  });

  it('ACTION_EXECUTED is absent — rejected actions must not produce this event', () => {
    expect(eventTypes(recoveryCase)).not.toContain('ACTION_EXECUTED');
  });

  it('audit sequence is PAYMENT_FAILED → RECOVERY_RECOMMENDED → POLICY_REJECTED → ESCALATED', () => {
    expect(eventTypes(recoveryCase)).toEqual([
      'PAYMENT_FAILED',
      'RECOVERY_RECOMMENDED',
      'POLICY_REJECTED',
      'ESCALATED',
    ]);
  });

  it('contains exactly 4 audit entries', () => {
    expect(recoveryCase.auditEntries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Scenario E — Low confidence → POLICY_REJECTED → ESCALATED
// ---------------------------------------------------------------------------

describe('Scenario E — low confidence', () => {
  // Payment: CUSTOMER_ABANDONED, 1 attempt, 0 prior successes
  // Confidence = 0.55 + 0 − 0 = 0.55 < MIN_CONFIDENCE (0.60)
  // Policy: LOW_CONFIDENCE_ESCALATION → REJECTED, finalAction=ESCALATE
  // Orchestrator: constructs ESCALATED result directly — executor is NOT called.
  // KEY INVARIANT: ACTION_EXECUTED must NOT appear

  const payment = makePayment({
    paymentId: 'pay_low_conf' as FailedPayment['paymentId'],
    failureReason: 'CUSTOMER_ABANDONED',
    paymentMethod: 'WALLET',
    attemptCount: 1,
    previousSuccessfulPayments: 0,
  });

  let recoveryCase: RecoveryCase;

  beforeEach(() => {
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    recoveryCase = orchestrator.recover(payment);
  });

  it('confidence is below the minimum threshold', () => {
    expect(recoveryCase.recommendation.confidence).toBeLessThan(0.60);
  });

  it('policy rejects due to LOW_CONFIDENCE_ESCALATION', () => {
    expect(recoveryCase.policyDecision.approved).toBe(false);
    expect(recoveryCase.policyDecision.policyRulesApplied).toContain('LOW_CONFIDENCE_ESCALATION');
  });

  it('final action is ESCALATE', () => {
    expect(recoveryCase.policyDecision.finalAction).toBe('ESCALATE');
  });

  it('execution result is ESCALATED', () => {
    expect(recoveryCase.executionResult.status).toBe('ESCALATED');
  });

  it('recoveredAmount is 0', () => {
    expect(recoveryCase.recoveredAmount).toBe(0);
  });

  it('ACTION_EXECUTED is absent from the audit trail', () => {
    expect(eventTypes(recoveryCase)).not.toContain('ACTION_EXECUTED');
  });

  it('audit sequence is PAYMENT_FAILED → RECOVERY_RECOMMENDED → POLICY_REJECTED → ESCALATED', () => {
    expect(eventTypes(recoveryCase)).toEqual([
      'PAYMENT_FAILED',
      'RECOVERY_RECOMMENDED',
      'POLICY_REJECTED',
      'ESCALATED',
    ]);
  });

  it('contains exactly 4 audit entries', () => {
    expect(recoveryCase.auditEntries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Scenario F — Customer abandoned with approved SEND_PAYMENT_LINK → PENDING
// ---------------------------------------------------------------------------

describe('Scenario F — customer abandoned, payment link approved', () => {
  // Payment: CUSTOMER_ABANDONED, 1 attempt, 5 prior successes
  // Confidence = 0.55 + min(5×0.02, 0.15) − 0 = 0.65 ≥ 0.60
  // Policy: NON_RETRY_RECOVERY_ACTIONS → SEND_PAYMENT_LINK approved
  // Executor: PENDING (awaiting customer action)

  const payment = makePayment({
    paymentId: 'pay_abandoned_link' as FailedPayment['paymentId'],
    failureReason: 'CUSTOMER_ABANDONED',
    paymentMethod: 'UPI',
    attemptCount: 1,
    previousSuccessfulPayments: 5,
  });

  let recoveryCase: RecoveryCase;

  beforeEach(() => {
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, {
        action: 'SEND_PAYMENT_LINK',
        status: 'PENDING',
        recoveredAmount: 0,
        message: 'Payment link sent. Awaiting customer action.',
      }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    recoveryCase = orchestrator.recover(payment);
  });

  it('confidence is at or above the minimum threshold', () => {
    expect(recoveryCase.recommendation.confidence).toBeGreaterThanOrEqual(0.60);
  });

  it('decision engine recommends SEND_PAYMENT_LINK', () => {
    expect(recoveryCase.recommendation.recommendedAction).toBe('SEND_PAYMENT_LINK');
  });

  it('policy approves SEND_PAYMENT_LINK', () => {
    expect(recoveryCase.policyDecision.approved).toBe(true);
    expect(recoveryCase.policyDecision.finalAction).toBe('SEND_PAYMENT_LINK');
  });

  it('execution result is PENDING', () => {
    expect(recoveryCase.executionResult.status).toBe('PENDING');
  });

  it('recoveredAmount is 0 while awaiting customer', () => {
    expect(recoveryCase.recoveredAmount).toBe(0);
  });

  it('audit sequence is PAYMENT_FAILED → RECOVERY_RECOMMENDED → POLICY_APPROVED → ACTION_EXECUTED → RECOVERY_PENDING', () => {
    expect(eventTypes(recoveryCase)).toEqual([
      'PAYMENT_FAILED',
      'RECOVERY_RECOMMENDED',
      'POLICY_APPROVED',
      'ACTION_EXECUTED',
      'RECOVERY_PENDING',
    ]);
  });

  it('contains exactly 5 audit entries', () => {
    expect(recoveryCase.auditEntries).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Executor invocation contract
// ---------------------------------------------------------------------------

describe('executor invocation contract', () => {
  it('executor is NOT called when policy rejects (retry limit exceeded)', () => {
    // attemptCount=2 triggers MAX_RETRY_ATTEMPTS → rejected
    const payment = makePayment({
      paymentId: 'pay_exec_d' as FailedPayment['paymentId'],
      failureReason: 'UPI_TIMEOUT',
      attemptCount: 2,
      previousSuccessfulPayments: 5,
    });
    const { executor, getCallCount } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);

    orchestrator.recover(payment);

    expect(getCallCount()).toBe(0);
  });

  it('executor is NOT called when policy rejects (low confidence)', () => {
    // CUSTOMER_ABANDONED, 0 prior successes → confidence 0.55 < 0.60
    const payment = makePayment({
      paymentId: 'pay_exec_e' as FailedPayment['paymentId'],
      failureReason: 'CUSTOMER_ABANDONED',
      attemptCount: 1,
      previousSuccessfulPayments: 0,
    });
    const { executor, getCallCount } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);

    orchestrator.recover(payment);

    expect(getCallCount()).toBe(0);
  });

  it('executor is called exactly once when policy approves', () => {
    const payment = makePayment({
      paymentId: 'pay_exec_a' as FailedPayment['paymentId'],
      failureReason: 'UPI_TIMEOUT',
      attemptCount: 1,
      previousSuccessfulPayments: 5,
    });
    const { executor, getCallCount } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'RECOVERED', recoveredAmount: payment.amount }),
    );
    const { orchestrator } = makeOrchestrator(executor);

    orchestrator.recover(payment);

    expect(getCallCount()).toBe(1);
  });

  it('executor is called exactly once for an approved SEND_PAYMENT_LINK', () => {
    const payment = makePayment({
      paymentId: 'pay_exec_f' as FailedPayment['paymentId'],
      failureReason: 'CUSTOMER_ABANDONED',
      attemptCount: 1,
      previousSuccessfulPayments: 5,
    });
    const { executor, getCallCount } = makeTrackingExecutor(
      approvedResult(payment.paymentId, {
        action: 'SEND_PAYMENT_LINK',
        status: 'PENDING',
        recoveredAmount: 0,
      }),
    );
    const { orchestrator } = makeOrchestrator(executor);

    orchestrator.recover(payment);

    expect(getCallCount()).toBe(1);
  });

  it('rejected result has recoveredAmount=0 and the correct status', () => {
    const payment = makePayment({
      paymentId: 'pay_exec_rej' as FailedPayment['paymentId'],
      failureReason: 'UPI_TIMEOUT',
      attemptCount: 2,
      previousSuccessfulPayments: 5,
    });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);

    const recoveryCase = orchestrator.recover(payment);

    expect(recoveryCase.policyDecision.approved).toBe(false);
    expect(recoveryCase.executionResult.status).toBe('ESCALATED');
    expect(recoveryCase.executionResult.recoveredAmount).toBe(0);
    expect(recoveryCase.executionResult.action).toBe('ESCALATE');
    expect(recoveryCase.executionResult.paymentId).toBe(payment.paymentId);
  });

  it('rejected result executedAt uses the injected clock', () => {
    const payment = makePayment({
      paymentId: 'pay_exec_clock' as FailedPayment['paymentId'],
      failureReason: 'UPI_TIMEOUT',
      attemptCount: 2,
      previousSuccessfulPayments: 5,
    });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);

    const recoveryCase = orchestrator.recover(payment);

    expect(recoveryCase.executionResult.executedAt).toBe(FIXED_TIMESTAMP);
  });
});

// ---------------------------------------------------------------------------
// Audit ordering
// ---------------------------------------------------------------------------

describe('audit ordering', () => {
  it('audit entries in RecoveryCase match workflow execution order', () => {
    const payment = makePayment({ paymentId: 'pay_audit_order' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'RECOVERED', recoveredAmount: payment.amount }),
    );
    const { orchestrator, store } = makeOrchestrator(executor);
    const recoveryCase = orchestrator.recover(payment);

    const fromStore = store.getByPaymentId(payment.paymentId);
    expect(recoveryCase.auditEntries).toEqual([...fromStore]);
  });

  it('each audit entry has a monotonically incrementing auditId', () => {
    const payment = makePayment({ paymentId: 'pay_audit_ids' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'RECOVERED', recoveredAmount: payment.amount }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    const { auditEntries } = orchestrator.recover(payment);

    const ids = auditEntries.map((e) => parseInt(e.auditId.split('_').pop() ?? '0', 10));
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('all audit entries carry a timestamp', () => {
    const payment = makePayment({ paymentId: 'pay_audit_ts' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    const { auditEntries } = orchestrator.recover(payment);

    for (const entry of auditEntries) {
      expect(entry.timestamp).toBe(FIXED_TIMESTAMP);
    }
  });

  it('approved flow produces entries in the exact order: A→B→C→D→E', () => {
    const payment = makePayment({ paymentId: 'pay_order_check' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'RECOVERED', recoveredAmount: payment.amount }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    const { auditEntries } = orchestrator.recover(payment);

    expect(auditEntries[0].eventType).toBe('PAYMENT_FAILED');
    expect(auditEntries[1].eventType).toBe('RECOVERY_RECOMMENDED');
    expect(auditEntries[2].eventType).toBe('POLICY_APPROVED');
    expect(auditEntries[3].eventType).toBe('ACTION_EXECUTED');
    expect(auditEntries[4].eventType).toBe('PAYMENT_RECOVERED');
  });

  it('rejected flow produces entries in the exact order: A→B→C→D (no ACTION_EXECUTED)', () => {
    const payment = makePayment({
      paymentId: 'pay_order_rejected' as FailedPayment['paymentId'],
      attemptCount: 3,
      previousSuccessfulPayments: 10,
    });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    const { auditEntries } = orchestrator.recover(payment);

    expect(auditEntries[0].eventType).toBe('PAYMENT_FAILED');
    expect(auditEntries[1].eventType).toBe('RECOVERY_RECOMMENDED');
    expect(auditEntries[2].eventType).toBe('POLICY_REJECTED');
    expect(auditEntries[3].eventType).toBe('ESCALATED');
    expect(auditEntries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('the same payment produces identical RecoveryCases across two runs', () => {
    const payment = makePayment({ paymentId: 'pay_determ' as FailedPayment['paymentId'] });
    const fixedResult = approvedResult(payment.paymentId, {
      status: 'RECOVERED',
      recoveredAmount: payment.amount,
    });

    const run = () => {
      const { executor } = makeTrackingExecutor(fixedResult);
      const { orchestrator } = makeOrchestrator(executor);
      return orchestrator.recover(payment);
    };

    const first = run();
    const second = run();

    expect(first.recommendation).toEqual(second.recommendation);
    expect(first.policyDecision).toEqual(second.policyDecision);
    expect(first.executionResult).toEqual(second.executionResult);
    expect(first.recoveredAmount).toBe(second.recoveredAmount);
    expect(eventTypes(first)).toEqual(eventTypes(second));
  });

  it('the real SimulatedRecoveryActionExecutor produces the same outcome for the same payment', () => {
    const payment = makePayment({ paymentId: 'pay_sim_determ' as FailedPayment['paymentId'] });
    const simExecutor = new SimulatedRecoveryActionExecutor(fixedClock);

    const run = () => {
      const { orchestrator } = makeOrchestrator(simExecutor);
      return orchestrator.recover(payment);
    };

    const first = run();
    const second = run();

    expect(first.executionResult.status).toBe(second.executionResult.status);
    expect(first.recoveredAmount).toBe(second.recoveredAmount);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('does not mutate the input FailedPayment', () => {
    const payment = makePayment({ paymentId: 'pay_immut' as FailedPayment['paymentId'] });
    const snapshot = JSON.stringify(payment);
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    orchestrator.recover(payment);
    expect(JSON.stringify(payment)).toBe(snapshot);
  });

  it('RecoveryCase fields reference the original objects without mutation', () => {
    const payment = makePayment({ paymentId: 'pay_ref' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    const recoveryCase = orchestrator.recover(payment);

    expect(recoveryCase.payment).toEqual(payment);
  });

  it('auditEntries array is a snapshot — appending to it does not affect the store', () => {
    const payment = makePayment({ paymentId: 'pay_snap' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator, store } = makeOrchestrator(executor);
    const recoveryCase = orchestrator.recover(payment);

    const countBefore = store.getByPaymentId(payment.paymentId).length;
    (recoveryCase.auditEntries as unknown[]).push({});
    expect(store.getByPaymentId(payment.paymentId)).toHaveLength(countBefore);
  });
});

// ---------------------------------------------------------------------------
// recoveredAmount contract
// ---------------------------------------------------------------------------

describe('recoveredAmount contract', () => {
  it('equals executionResult.recoveredAmount for a successful recovery', () => {
    const payment = makePayment({ paymentId: 'pay_ra_ok' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'RECOVERED', recoveredAmount: 199900 }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    const recoveryCase = orchestrator.recover(payment);

    expect(recoveryCase.recoveredAmount).toBe(199900);
    expect(recoveryCase.recoveredAmount).toBe(recoveryCase.executionResult.recoveredAmount);
  });

  it('equals 0 for a failed retry', () => {
    const payment = makePayment({ paymentId: 'pay_ra_fail' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'FAILED', recoveredAmount: 0 }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    const recoveryCase = orchestrator.recover(payment);

    expect(recoveryCase.recoveredAmount).toBe(0);
  });

  it('equals 0 for a rejected action', () => {
    const payment = makePayment({
      paymentId: 'pay_ra_rejected' as FailedPayment['paymentId'],
      attemptCount: 2,
      previousSuccessfulPayments: 5,
    });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    const recoveryCase = orchestrator.recover(payment);

    expect(recoveryCase.recoveredAmount).toBe(0);
    expect(recoveryCase.recoveredAmount).toBe(recoveryCase.executionResult.recoveredAmount);
  });
});

// ---------------------------------------------------------------------------
// Safety invariants
// ---------------------------------------------------------------------------

describe('safety invariants', () => {
  it('never logs ACTION_EXECUTED when policy rejects', () => {
    const rejectedPayments: FailedPayment[] = [
      makePayment({ paymentId: 'pay_safe_1' as FailedPayment['paymentId'], attemptCount: 3, previousSuccessfulPayments: 10 }),
      makePayment({ paymentId: 'pay_safe_2' as FailedPayment['paymentId'], failureReason: 'CUSTOMER_ABANDONED', attemptCount: 1, previousSuccessfulPayments: 0 }),
    ];

    for (const payment of rejectedPayments) {
      const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
      const { orchestrator } = makeOrchestrator(executor);
      const recoveryCase = orchestrator.recover(payment);

      expect(recoveryCase.policyDecision.approved).toBe(false);
      expect(eventTypes(recoveryCase)).not.toContain('ACTION_EXECUTED');
    }
  });

  it('always logs ACTION_EXECUTED before the final outcome when policy approves', () => {
    const payment = makePayment({ paymentId: 'pay_safe_approved' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(
      approvedResult(payment.paymentId, { status: 'RECOVERED', recoveredAmount: payment.amount }),
    );
    const { orchestrator } = makeOrchestrator(executor);
    const { auditEntries, policyDecision } = orchestrator.recover(payment);

    expect(policyDecision.approved).toBe(true);
    const types = auditEntries.map((e) => e.eventType);
    const actionIdx = types.indexOf('ACTION_EXECUTED');
    const outcomeIdx = types.findIndex((t) =>
      ['PAYMENT_RECOVERED', 'RECOVERY_FAILED', 'RECOVERY_PENDING', 'ESCALATED', 'ACTION_BLOCKED'].includes(t),
    );
    expect(actionIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeLessThan(outcomeIdx);
  });

  it('PAYMENT_FAILED is always the first audit event', () => {
    const payments = [
      makePayment({ paymentId: 'pay_first_1' as FailedPayment['paymentId'] }),
      makePayment({ paymentId: 'pay_first_2' as FailedPayment['paymentId'], attemptCount: 3, previousSuccessfulPayments: 10 }),
    ];

    for (const payment of payments) {
      const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
      const { orchestrator } = makeOrchestrator(executor);
      const { auditEntries } = orchestrator.recover(payment);
      expect(auditEntries[0].eventType).toBe('PAYMENT_FAILED');
    }
  });

  it('RECOVERY_RECOMMENDED immediately follows PAYMENT_FAILED', () => {
    const payment = makePayment({ paymentId: 'pay_order_rec' as FailedPayment['paymentId'] });
    const { executor } = makeTrackingExecutor(approvedResult(payment.paymentId));
    const { orchestrator } = makeOrchestrator(executor);
    const { auditEntries } = orchestrator.recover(payment);
    expect(auditEntries[1].eventType).toBe('RECOVERY_RECOMMENDED');
  });

  it('multi-payment runs do not leak audit entries across payments', () => {
    const paymentA = makePayment({ paymentId: 'pay_iso_A' as FailedPayment['paymentId'] });
    const paymentB = makePayment({
      paymentId: 'pay_iso_B' as FailedPayment['paymentId'],
      failureReason: 'EXPIRED_CARD',
      paymentMethod: 'CARD',
    });

    // Shared store/logger; executor returns result keyed to the actual payment
    const store = new InMemoryAuditStore();
    const logger = new AuditLogger(store, fixedClock, makeCounterIdGenerator('iso'));
    const executor: RecoveryActionExecutor = {
      execute(payment) {
        return {
          paymentId: payment.paymentId,
          action: 'RETRY_LATER',
          status: 'PENDING',
          executedAt: FIXED_TIMESTAMP,
          recoveredAmount: 0,
          message: 'Test result.',
        };
      },
    };

    const orchestrator = new RecoveryOrchestrator({
      decisionEngine: computeRecoveryRecommendation,
      policyEngine: evaluatePolicy,
      executor,
      auditLogger: logger,
      auditStore: store,
      clock: fixedClock,
    });

    const caseA = orchestrator.recover(paymentA);
    const caseB = orchestrator.recover(paymentB);

    for (const entry of caseA.auditEntries) {
      expect(entry.paymentId).toBe(paymentA.paymentId);
    }
    for (const entry of caseB.auditEntries) {
      expect(entry.paymentId).toBe(paymentB.paymentId);
    }
  });
});
