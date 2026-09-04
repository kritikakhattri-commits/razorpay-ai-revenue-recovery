import { describe, it, expect } from 'vitest';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryCase } from './types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { AuditEntry } from '../../domain/audit/types';
import type { RecoveryExecutionResult, ExecutionStatus } from '../../domain/executor/types';
import { BatchRecoveryService, type RecoveryProcessor } from './batchRecoveryService';
import { calculateRecoveryScore } from '../../domain/recovery/recoveryScore';
import { computePaymentMethodSwitch } from '../../domain/recovery/paymentMethodSwitching';
import { calculateRevenueAtRisk } from '../../domain/recovery/revenueAtRisk';

const FIXED_TIMESTAMP = '2025-06-01T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePayment(
  id: string,
  amount: number,
  overrides: Partial<FailedPayment> = {},
): FailedPayment {
  return {
    paymentId: id as FailedPayment['paymentId'],
    customerId: 'cust_batch_001' as FailedPayment['customerId'],
    customerName: 'Batch Test Customer',
    amount,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 3,
    lastAttemptAt: FIXED_TIMESTAMP,
    failedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

function makeRecommendation(): RecoveryRecommendation {
  return {
    diagnosis: 'UPI timeout detected.',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: 0.85,
    reasoning: 'Retry recommended based on history.',
    maxAttempts: 2,
  };
}

function makePolicyDecision(approved: boolean): PolicyDecision {
  return {
    approved,
    finalAction: approved ? 'RETRY_LATER' : 'ESCALATE',
    reason: approved ? 'Approved by policy.' : 'Max retry limit reached.',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: approved ? [] : ['MAX_RETRY_ATTEMPTS'],
  };
}

function makeAuditEntry(paymentId: string): AuditEntry {
  return {
    auditId: `audit_${paymentId}_1`,
    paymentId,
    eventType: 'PAYMENT_FAILED',
    timestamp: FIXED_TIMESTAMP,
    message: 'Payment failed.',
    metadata: {},
  };
}

function makeExecutionResult(
  paymentId: string,
  status: ExecutionStatus,
  recoveredAmount: number,
): RecoveryExecutionResult {
  const approved = status !== 'ESCALATED' && status !== 'BLOCKED';
  return {
    paymentId: paymentId as FailedPayment['paymentId'],
    action: approved ? 'RETRY_LATER' : 'ESCALATE',
    status,
    executedAt: FIXED_TIMESTAMP,
    recoveredAmount,
    message: `Execution status: ${status}`,
  };
}

function makeCase(payment: FailedPayment, status: ExecutionStatus, recoveredAmount: number): RecoveryCase {
  const approved = status !== 'ESCALATED' && status !== 'BLOCKED';
  const recommendation = makeRecommendation();
  return {
    payment,
    recommendation,
    policyDecision: makePolicyDecision(approved),
    executionResult: makeExecutionResult(payment.paymentId, status, recoveredAmount),
    auditEntries: [makeAuditEntry(payment.paymentId)],
    recoveredAmount,
    recoveryScore: calculateRecoveryScore({
      amountInPaise: payment.amount,
      recoveryProbability: recommendation.confidence,
    }),
    smartRetryTiming: null,
    paymentMethodSwitch: computePaymentMethodSwitch({ payment }),
    revenueAtRiskScore: calculateRevenueAtRisk({
      amountInPaise: payment.amount,
      recoveryProbability: recommendation.confidence,
      expectedRecoverableAmountInPaise: calculateRecoveryScore({
        amountInPaise: payment.amount,
        recoveryProbability: recommendation.confidence,
      }).expectedRecoverableAmountInPaise,
      attemptCount: payment.attemptCount,
      previousSuccessfulPayments: payment.previousSuccessfulPayments,
      failedAt: payment.failedAt,
      now: FIXED_TIMESTAMP,
    }),
  };
}

function makeStubOrchestrator(cases: RecoveryCase[]): RecoveryProcessor {
  const caseMap = new Map(cases.map((c) => [c.payment.paymentId as string, c]));
  return {
    recover(payment: FailedPayment): RecoveryCase {
      const c = caseMap.get(payment.paymentId as string);
      if (!c) throw new Error(`No stub case configured for payment ${payment.paymentId}`);
      return c;
    },
  };
}

// ---------------------------------------------------------------------------
// Empty batch
// ---------------------------------------------------------------------------

describe('empty batch', () => {
  it('returns an empty cases array', () => {
    const service = new BatchRecoveryService(makeStubOrchestrator([]));
    const result = service.process([]);
    expect(result.cases).toHaveLength(0);
  });

  it('totalPayments is 0', () => {
    const service = new BatchRecoveryService(makeStubOrchestrator([]));
    expect(service.process([]).totalPayments).toBe(0);
  });

  it('all monetary amounts are 0', () => {
    const service = new BatchRecoveryService(makeStubOrchestrator([]));
    const result = service.process([]);
    expect(result.totalRevenueAtRisk).toBe(0);
    expect(result.totalRecoveredRevenue).toBe(0);
  });

  it('recoveryRate is 0 for an empty batch (zero denominator)', () => {
    const service = new BatchRecoveryService(makeStubOrchestrator([]));
    expect(service.process([]).recoveryRate).toBe(0);
  });

  it('all status counts are 0', () => {
    const service = new BatchRecoveryService(makeStubOrchestrator([]));
    const result = service.process([]);
    expect(result.recoveredPaymentCount).toBe(0);
    expect(result.failedRecoveryCount).toBe(0);
    expect(result.pendingPaymentCount).toBe(0);
    expect(result.escalatedPaymentCount).toBe(0);
    expect(result.blockedPaymentCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single payment
// ---------------------------------------------------------------------------

describe('single payment — RECOVERED', () => {
  const payment = makePayment('pay_single_1', 250000);
  const recoveryCase = makeCase(payment, 'RECOVERED', 250000);
  const service = new BatchRecoveryService(makeStubOrchestrator([recoveryCase]));
  const result = service.process([payment]);

  it('returns one case', () => {
    expect(result.cases).toHaveLength(1);
  });

  it('totalPayments is 1', () => {
    expect(result.totalPayments).toBe(1);
  });

  it('totalRevenueAtRisk equals payment amount', () => {
    expect(result.totalRevenueAtRisk).toBe(250000);
  });

  it('totalRecoveredRevenue equals recovered amount', () => {
    expect(result.totalRecoveredRevenue).toBe(250000);
  });

  it('recoveryRate is 1.0 when fully recovered', () => {
    expect(result.recoveryRate).toBe(1.0);
  });

  it('recoveredPaymentCount is 1', () => {
    expect(result.recoveredPaymentCount).toBe(1);
  });

  it('all other status counts are 0', () => {
    expect(result.failedRecoveryCount).toBe(0);
    expect(result.pendingPaymentCount).toBe(0);
    expect(result.escalatedPaymentCount).toBe(0);
    expect(result.blockedPaymentCount).toBe(0);
  });
});

describe('single payment — FAILED', () => {
  const payment = makePayment('pay_single_2', 150000);
  const recoveryCase = makeCase(payment, 'FAILED', 0);
  const service = new BatchRecoveryService(makeStubOrchestrator([recoveryCase]));
  const result = service.process([payment]);

  it('totalRecoveredRevenue is 0', () => {
    expect(result.totalRecoveredRevenue).toBe(0);
  });

  it('recoveryRate is 0', () => {
    expect(result.recoveryRate).toBe(0);
  });

  it('failedRecoveryCount is 1', () => {
    expect(result.failedRecoveryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple payments
// ---------------------------------------------------------------------------

describe('multiple payments', () => {
  const payments = [
    makePayment('pay_multi_1', 100000),
    makePayment('pay_multi_2', 200000),
    makePayment('pay_multi_3', 300000),
    makePayment('pay_multi_4', 400000),
    makePayment('pay_multi_5', 500000),
  ];

  const cases = [
    makeCase(payments[0], 'RECOVERED', 100000),
    makeCase(payments[1], 'FAILED', 0),
    makeCase(payments[2], 'PENDING', 0),
    makeCase(payments[3], 'ESCALATED', 0),
    makeCase(payments[4], 'BLOCKED', 0),
  ];

  const service = new BatchRecoveryService(makeStubOrchestrator(cases));
  const result = service.process(payments);

  it('returns 5 cases', () => {
    expect(result.cases).toHaveLength(5);
  });

  it('totalPayments is 5', () => {
    expect(result.totalPayments).toBe(5);
  });

  it('totalRevenueAtRisk sums all payment amounts', () => {
    expect(result.totalRevenueAtRisk).toBe(1500000);
  });

  it('totalRecoveredRevenue sums only recovered amounts', () => {
    expect(result.totalRecoveredRevenue).toBe(100000);
  });

  it('recoveryRate equals recovered / at-risk', () => {
    expect(result.recoveryRate).toBeCloseTo(100000 / 1500000);
  });

  it('recoveredPaymentCount is 1', () => {
    expect(result.recoveredPaymentCount).toBe(1);
  });

  it('failedRecoveryCount is 1', () => {
    expect(result.failedRecoveryCount).toBe(1);
  });

  it('pendingPaymentCount is 1', () => {
    expect(result.pendingPaymentCount).toBe(1);
  });

  it('escalatedPaymentCount is 1', () => {
    expect(result.escalatedPaymentCount).toBe(1);
  });

  it('blockedPaymentCount is 1', () => {
    expect(result.blockedPaymentCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Revenue calculations
// ---------------------------------------------------------------------------

describe('totalRevenueAtRisk calculation', () => {
  it('sums all payment amounts regardless of outcome', () => {
    const payments = [
      makePayment('pay_risk_1', 123456),
      makePayment('pay_risk_2', 654321),
      makePayment('pay_risk_3', 100000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 123456),
      makeCase(payments[1], 'FAILED', 0),
      makeCase(payments[2], 'ESCALATED', 0),
    ];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(result.totalRevenueAtRisk).toBe(877777);
  });
});

describe('totalRecoveredRevenue calculation', () => {
  it('sums only recoveredAmount fields from RecoveryCases', () => {
    const payments = [
      makePayment('pay_rec_1', 500000),
      makePayment('pay_rec_2', 300000),
      makePayment('pay_rec_3', 200000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 500000),
      makeCase(payments[1], 'RECOVERED', 300000),
      makeCase(payments[2], 'FAILED', 0),
    ];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(result.totalRecoveredRevenue).toBe(800000);
  });

  it('is 0 when no payments are recovered', () => {
    const payments = [makePayment('pay_none_1', 999999)];
    const cases = [makeCase(payments[0], 'FAILED', 0)];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(result.totalRecoveredRevenue).toBe(0);
  });
});

describe('recoveryRate calculation', () => {
  it('is the exact ratio of recovered to at-risk', () => {
    const payments = [
      makePayment('pay_rate_1', 100000),
      makePayment('pay_rate_2', 100000),
      makePayment('pay_rate_3', 100000),
      makePayment('pay_rate_4', 100000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 100000),
      makeCase(payments[1], 'RECOVERED', 100000),
      makeCase(payments[2], 'FAILED', 0),
      makeCase(payments[3], 'ESCALATED', 0),
    ];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(result.recoveryRate).toBeCloseTo(0.5);
  });
});

describe('zero-risk batch', () => {
  it('returns recoveryRate 0 when all payment amounts are 0 (zero denominator guard)', () => {
    const payments = [makePayment('pay_zero_1', 0), makePayment('pay_zero_2', 0)];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 0),
      makeCase(payments[1], 'RECOVERED', 0),
    ];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(result.recoveryRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Status counts
// ---------------------------------------------------------------------------

describe('status counts — all five statuses', () => {
  const payments = [
    makePayment('pay_st_rec', 100000),
    makePayment('pay_st_fail', 200000),
    makePayment('pay_st_pend', 300000),
    makePayment('pay_st_esc', 400000),
    makePayment('pay_st_blk', 500000),
  ];
  const cases = [
    makeCase(payments[0], 'RECOVERED', 100000),
    makeCase(payments[1], 'FAILED', 0),
    makeCase(payments[2], 'PENDING', 0),
    makeCase(payments[3], 'ESCALATED', 0),
    makeCase(payments[4], 'BLOCKED', 0),
  ];
  const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);

  it('recoveredPaymentCount is 1', () => expect(result.recoveredPaymentCount).toBe(1));
  it('failedRecoveryCount is 1', () => expect(result.failedRecoveryCount).toBe(1));
  it('pendingPaymentCount is 1', () => expect(result.pendingPaymentCount).toBe(1));
  it('escalatedPaymentCount is 1', () => expect(result.escalatedPaymentCount).toBe(1));
  it('blockedPaymentCount is 1', () => expect(result.blockedPaymentCount).toBe(1));
});

describe('status counts — multiple per status', () => {
  const payments = [
    makePayment('pay_mr_1', 100000),
    makePayment('pay_mr_2', 200000),
    makePayment('pay_mr_3', 300000),
    makePayment('pay_mr_4', 400000),
    makePayment('pay_mr_5', 500000),
    makePayment('pay_mr_6', 600000),
  ];
  const cases = [
    makeCase(payments[0], 'RECOVERED', 100000),
    makeCase(payments[1], 'RECOVERED', 200000),
    makeCase(payments[2], 'RECOVERED', 300000),
    makeCase(payments[3], 'FAILED', 0),
    makeCase(payments[4], 'ESCALATED', 0),
    makeCase(payments[5], 'ESCALATED', 0),
  ];
  const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);

  it('recoveredPaymentCount is 3', () => expect(result.recoveredPaymentCount).toBe(3));
  it('failedRecoveryCount is 1', () => expect(result.failedRecoveryCount).toBe(1));
  it('escalatedPaymentCount is 2', () => expect(result.escalatedPaymentCount).toBe(2));
});

// ---------------------------------------------------------------------------
// Totals reconcile with totalPayments
// ---------------------------------------------------------------------------

describe('totals reconcile with totalPayments', () => {
  it('sum of all status counts equals totalPayments', () => {
    const payments = [
      makePayment('pay_tot_1', 100000),
      makePayment('pay_tot_2', 200000),
      makePayment('pay_tot_3', 300000),
      makePayment('pay_tot_4', 400000),
      makePayment('pay_tot_5', 500000),
      makePayment('pay_tot_6', 600000),
      makePayment('pay_tot_7', 700000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 100000),
      makeCase(payments[1], 'RECOVERED', 200000),
      makeCase(payments[2], 'FAILED', 0),
      makeCase(payments[3], 'PENDING', 0),
      makeCase(payments[4], 'PENDING', 0),
      makeCase(payments[5], 'ESCALATED', 0),
      makeCase(payments[6], 'BLOCKED', 0),
    ];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);

    const countSum =
      result.recoveredPaymentCount +
      result.failedRecoveryCount +
      result.pendingPaymentCount +
      result.escalatedPaymentCount +
      result.blockedPaymentCount;

    expect(countSum).toBe(result.totalPayments);
    expect(countSum).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Input ordering
// ---------------------------------------------------------------------------

describe('input ordering', () => {
  it('cases preserve the order of the input payments array', () => {
    const payments = [
      makePayment('pay_ord_1', 100000),
      makePayment('pay_ord_2', 200000),
      makePayment('pay_ord_3', 300000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 100000),
      makeCase(payments[1], 'ESCALATED', 0),
      makeCase(payments[2], 'FAILED', 0),
    ];
    const result = new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);

    expect(result.cases[0].payment.paymentId).toBe(payments[0].paymentId);
    expect(result.cases[1].payment.paymentId).toBe(payments[1].paymentId);
    expect(result.cases[2].payment.paymentId).toBe(payments[2].paymentId);
  });
});

// ---------------------------------------------------------------------------
// Immutability — input array and payment objects not mutated
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('does not mutate the input payments array', () => {
    const payments = [
      makePayment('pay_imm_1', 100000),
      makePayment('pay_imm_2', 200000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 100000),
      makeCase(payments[1], 'FAILED', 0),
    ];
    const inputCopy = [...payments];
    new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(payments).toHaveLength(inputCopy.length);
    expect(payments[0]).toBe(inputCopy[0]);
    expect(payments[1]).toBe(inputCopy[1]);
  });

  it('does not mutate individual FailedPayment objects', () => {
    const payments = [makePayment('pay_imm_3', 350000)];
    const cases = [makeCase(payments[0], 'RECOVERED', 350000)];
    const snapshot = JSON.stringify(payments[0]);
    new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);
    expect(JSON.stringify(payments[0])).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical results across two runs with the same deterministic orchestrator', () => {
    const payments = [
      makePayment('pay_det_1', 100000),
      makePayment('pay_det_2', 200000),
      makePayment('pay_det_3', 300000),
    ];
    const cases = [
      makeCase(payments[0], 'RECOVERED', 100000),
      makeCase(payments[1], 'ESCALATED', 0),
      makeCase(payments[2], 'PENDING', 0),
    ];

    const run = () =>
      new BatchRecoveryService(makeStubOrchestrator(cases)).process(payments);

    const first = run();
    const second = run();

    expect(first.totalPayments).toBe(second.totalPayments);
    expect(first.totalRevenueAtRisk).toBe(second.totalRevenueAtRisk);
    expect(first.totalRecoveredRevenue).toBe(second.totalRecoveredRevenue);
    expect(first.recoveryRate).toBe(second.recoveryRate);
    expect(first.recoveredPaymentCount).toBe(second.recoveredPaymentCount);
    expect(first.failedRecoveryCount).toBe(second.failedRecoveryCount);
    expect(first.pendingPaymentCount).toBe(second.pendingPaymentCount);
    expect(first.escalatedPaymentCount).toBe(second.escalatedPaymentCount);
    expect(first.blockedPaymentCount).toBe(second.blockedPaymentCount);
    for (let i = 0; i < first.cases.length; i++) {
      expect(first.cases[i].payment.paymentId).toBe(second.cases[i].payment.paymentId);
      expect(first.cases[i].executionResult.status).toBe(second.cases[i].executionResult.status);
    }
  });
});
