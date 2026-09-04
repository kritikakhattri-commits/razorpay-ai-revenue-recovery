import { describe, it, expect } from 'vitest';
import {
  computeStrategyAnalytics,
  classifyRetryDelay,
  deriveStrategyKey,
  strategyKeyStr,
  strategyKeyLabel,
  compareByPerformance,
  MIN_COMPLETED_ATTEMPTS,
} from './strategyAnalyticsEngine';
import type { StrategyAnalyticsInput } from './strategyAnalyticsEngine';
import type { RecoveryCase } from '../recovery/types';
import type { FailedPayment, PaymentMethod, PaymentId, CustomerId } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult, ExecutionStatus } from '../../domain/executor/types';
import type { ExperimentResult } from '../../domain/experiment/types';
import type { CustomerRecoverySegment } from '../../domain/customerRecovery/types';
import type { RecoveryStrategyMetrics } from '../../domain/strategyAnalytics/types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_test_001' as PaymentId,
    customerId: 'cust_001' as CustomerId,
    customerName: 'Test Customer',
    amount: 100_000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 3,
    lastAttemptAt: '2026-09-01T10:00:00.000Z',
    failedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeRecommendation(
  overrides: Partial<RecoveryRecommendation> = {},
): RecoveryRecommendation {
  return {
    diagnosis: 'Test diagnosis',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 45,
    confidence: 0.75,
    reasoning: 'Test reasoning',
    maxAttempts: 3,
    ...overrides,
  };
}

function makePolicyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'Approved',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: [],
    approvedRetryAfterMinutes: 45,
    approvedRetryAt: '2026-09-01T10:45:00.000Z',
    ...overrides,
  };
}

function makeExecutionResult(
  overrides: Partial<RecoveryExecutionResult> = {},
): RecoveryExecutionResult {
  return {
    paymentId: 'pay_test_001' as PaymentId,
    action: 'RETRY_LATER',
    status: 'RECOVERED',
    executedAt: '2026-09-01T10:45:00.000Z',
    recoveredAmount: 100_000,
    message: 'Test result',
    ...overrides,
  };
}

function makeRecoveryCase(overrides: {
  payment?: Partial<FailedPayment>;
  recommendation?: Partial<RecoveryRecommendation>;
  policyDecision?: Partial<PolicyDecision>;
  executionResult?: Partial<RecoveryExecutionResult>;
  recoveredAmount?: number;
} = {}): RecoveryCase {
  const payment = makePayment(overrides.payment);
  const executionResult = makeExecutionResult({
    paymentId: payment.paymentId,
    ...overrides.executionResult,
  });
  const recoveredAmount = overrides.recoveredAmount ?? executionResult.recoveredAmount;

  return {
    payment,
    recommendation: makeRecommendation(overrides.recommendation),
    policyDecision: makePolicyDecision(overrides.policyDecision),
    executionResult,
    auditEntries: [],
    recoveredAmount,
    recoveryScore: {
      recoveryProbability: 0.75,
      expectedRecoverableAmountInPaise: 75_000,
      priority: 'HIGH',
    },
    smartRetryTiming: null,
    paymentMethodSwitch: {
      currentMethod: payment.paymentMethod,
      shouldSwitch: false,
      recommendedMethod: null,
      alternatives: [],
      reason: 'No switch needed',
    },
    revenueAtRiskScore: {
      score: 0.5,
      level: 'MEDIUM',
      revenueAtRiskInPaise: 50_000,
      factors: [],
    },
  };
}

function makeInput(
  cases: RecoveryCase[],
  experimentResults: ExperimentResult[] = [],
  segmentMap: Map<CustomerId, CustomerRecoverySegment> = new Map(),
): StrategyAnalyticsInput {
  return {
    cases,
    experimentResults,
    customerSegmentMap: segmentMap,
    generatedAt: '2026-09-01T12:00:00.000Z',
  };
}

// ── classifyRetryDelay tests ──────────────────────────────────────────────────

describe('classifyRetryDelay', () => {
  it('classifies 0 minutes as UNDER_30_MIN', () => {
    expect(classifyRetryDelay(0)).toBe('UNDER_30_MIN');
  });

  it('classifies 29 minutes as UNDER_30_MIN', () => {
    expect(classifyRetryDelay(29)).toBe('UNDER_30_MIN');
  });

  it('classifies exactly 30 minutes as 30_TO_60_MIN', () => {
    expect(classifyRetryDelay(30)).toBe('30_TO_60_MIN');
  });

  it('classifies 45 minutes as 30_TO_60_MIN', () => {
    expect(classifyRetryDelay(45)).toBe('30_TO_60_MIN');
  });

  it('classifies 59 minutes as 30_TO_60_MIN', () => {
    expect(classifyRetryDelay(59)).toBe('30_TO_60_MIN');
  });

  it('classifies exactly 60 minutes as 1_TO_3_HR', () => {
    expect(classifyRetryDelay(60)).toBe('1_TO_3_HR');
  });

  it('classifies 179 minutes as 1_TO_3_HR', () => {
    expect(classifyRetryDelay(179)).toBe('1_TO_3_HR');
  });

  it('classifies exactly 180 minutes as 3_TO_6_HR', () => {
    expect(classifyRetryDelay(180)).toBe('3_TO_6_HR');
  });

  it('classifies 359 minutes as 3_TO_6_HR', () => {
    expect(classifyRetryDelay(359)).toBe('3_TO_6_HR');
  });

  it('classifies exactly 360 minutes as 6_TO_24_HR', () => {
    expect(classifyRetryDelay(360)).toBe('6_TO_24_HR');
  });

  it('classifies 1439 minutes as 6_TO_24_HR', () => {
    expect(classifyRetryDelay(1439)).toBe('6_TO_24_HR');
  });

  it('classifies exactly 1440 minutes as OVER_24_HR', () => {
    expect(classifyRetryDelay(1440)).toBe('OVER_24_HR');
  });

  it('classifies 2880 minutes as OVER_24_HR', () => {
    expect(classifyRetryDelay(2880)).toBe('OVER_24_HR');
  });
});

// ── deriveStrategyKey tests ───────────────────────────────────────────────────

describe('deriveStrategyKey', () => {
  it('uses policy-approved RETRY_LATER action, not recommendation', () => {
    const c = makeRecoveryCase({
      recommendation: { recommendedAction: 'RETRY_LATER', retryAfterMinutes: 30 },
      policyDecision: {
        finalAction: 'RETRY_LATER',
        approvedRetryAfterMinutes: 60, // policy overrides to 60
      },
    });
    const key = deriveStrategyKey(c);
    expect(key.type).toBe('RETRY');
    expect(key.retryDelayBucket).toBe('1_TO_3_HR');
  });

  it('uses policyDecision.approvedRetryAfterMinutes for retry delay bucket', () => {
    const c = makeRecoveryCase({
      policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 },
    });
    expect(deriveStrategyKey(c).retryDelayBucket).toBe('30_TO_60_MIN');
  });

  it('uses payment.paymentMethod for RETRY same-method key', () => {
    const c = makeRecoveryCase({
      payment: { paymentMethod: 'CARD' },
      policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 },
    });
    const key = deriveStrategyKey(c);
    expect(key.type).toBe('RETRY');
    expect(key.paymentMethod).toBe('CARD');
  });

  it('uses executed transition for PAYMENT_METHOD_SWITCH (not recommendation)', () => {
    const c = makeRecoveryCase({
      payment: { paymentMethod: 'CARD' },
      policyDecision: { finalAction: 'UPDATE_PAYMENT_METHOD', approved: true },
      executionResult: { action: 'UPDATE_PAYMENT_METHOD', status: 'PENDING', recoveredAmount: 0 },
    });
    // paymentMethodSwitch is set on the case
    const withSwitch = {
      ...c,
      paymentMethodSwitch: {
        currentMethod: 'CARD' as PaymentMethod,
        shouldSwitch: true,
        recommendedMethod: 'UPI' as PaymentMethod,
        alternatives: [],
        reason: 'Switch recommended',
      },
    };
    const key = deriveStrategyKey(withSwitch);
    expect(key.type).toBe('PAYMENT_METHOD_SWITCH');
    expect(key.fromPaymentMethod).toBe('CARD');
    expect(key.toPaymentMethod).toBe('UPI');
  });

  it('falls back to PAYMENT_LINK when UPDATE_PAYMENT_METHOD has no switch', () => {
    const c = makeRecoveryCase({
      policyDecision: { finalAction: 'UPDATE_PAYMENT_METHOD', approved: true },
      executionResult: { action: 'UPDATE_PAYMENT_METHOD', status: 'PENDING', recoveredAmount: 0 },
    });
    const key = deriveStrategyKey(c);
    expect(key.type).toBe('PAYMENT_LINK');
  });

  it('returns PAYMENT_LINK type for SEND_PAYMENT_LINK action', () => {
    const c = makeRecoveryCase({
      policyDecision: { finalAction: 'SEND_PAYMENT_LINK', approved: true },
      executionResult: { action: 'SEND_PAYMENT_LINK', status: 'RECOVERED', recoveredAmount: 100_000 },
    });
    expect(deriveStrategyKey(c).type).toBe('PAYMENT_LINK');
  });

  it('returns ESCALATION type for ESCALATE action', () => {
    const c = makeRecoveryCase({
      policyDecision: {
        finalAction: 'ESCALATE',
        approved: false,
        reason: 'Low confidence',
      },
      executionResult: { action: 'ESCALATE', status: 'ESCALATED', recoveredAmount: 0 },
    });
    expect(deriveStrategyKey(c).type).toBe('ESCALATION');
  });
});

// ── strategyKeyStr uniqueness tests ──────────────────────────────────────────

describe('strategyKeyStr', () => {
  it('produces distinct keys for same-method retry with different delay buckets', () => {
    const k1 = strategyKeyStr({ type: 'RETRY', paymentMethod: 'UPI', retryDelayBucket: '30_TO_60_MIN' });
    const k2 = strategyKeyStr({ type: 'RETRY', paymentMethod: 'UPI', retryDelayBucket: '1_TO_3_HR' });
    expect(k1).not.toBe(k2);
  });

  it('produces distinct keys for different payment methods with same bucket', () => {
    const k1 = strategyKeyStr({ type: 'RETRY', paymentMethod: 'UPI', retryDelayBucket: '30_TO_60_MIN' });
    const k2 = strategyKeyStr({ type: 'RETRY', paymentMethod: 'CARD', retryDelayBucket: '30_TO_60_MIN' });
    expect(k1).not.toBe(k2);
  });

  it('produces distinct keys for different switch transitions', () => {
    const k1 = strategyKeyStr({ type: 'PAYMENT_METHOD_SWITCH', fromPaymentMethod: 'CARD', toPaymentMethod: 'UPI' });
    const k2 = strategyKeyStr({ type: 'PAYMENT_METHOD_SWITCH', fromPaymentMethod: 'UPI', toPaymentMethod: 'CARD' });
    expect(k1).not.toBe(k2);
  });
});

// ── strategyKeyLabel tests ────────────────────────────────────────────────────

describe('strategyKeyLabel', () => {
  it('formats RETRY label with method and bucket', () => {
    const label = strategyKeyLabel({ type: 'RETRY', paymentMethod: 'UPI', retryDelayBucket: '30_TO_60_MIN' });
    expect(label).toBe('UPI Retry (30–60 min)');
  });

  it('formats PAYMENT_METHOD_SWITCH label', () => {
    const label = strategyKeyLabel({ type: 'PAYMENT_METHOD_SWITCH', fromPaymentMethod: 'CARD', toPaymentMethod: 'UPI' });
    expect(label).toBe('Card → UPI Switch');
  });

  it('formats PAYMENT_LINK label', () => {
    expect(strategyKeyLabel({ type: 'PAYMENT_LINK' })).toBe('Payment Link');
  });

  it('formats ESCALATION label', () => {
    expect(strategyKeyLabel({ type: 'ESCALATION' })).toBe('Escalation');
  });
});

// ── computeStrategyAnalytics — basic counting ─────────────────────────────────

describe('computeStrategyAnalytics basic counting', () => {
  it('returns empty result for empty dataset', () => {
    const result = computeStrategyAnalytics(makeInput([]));
    expect(result.strategyMetrics).toHaveLength(0);
    expect(result.portfolioSummary.totalAttempts).toBe(0);
    expect(result.portfolioSummary.portfolioRecoveryRate).toBeNull();
    expect(result.portfolioSummary.bestRecoveryRateStrategy).toBeNull();
  });

  it('counts totalAttempts correctly', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_003' as PaymentId } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.portfolioSummary.totalAttempts).toBe(3);
  });

  it('groups same strategy into one metrics entry', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId }, policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 50 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    // Both land in 30_TO_60_MIN bucket → one strategy entry
    expect(result.strategyMetrics).toHaveLength(1);
    expect(result.strategyMetrics[0].totalAttempts).toBe(2);
  });

  it('creates separate entries for different strategies', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId }, policyDecision: { finalAction: 'SEND_PAYMENT_LINK', approved: true }, executionResult: { action: 'SEND_PAYMENT_LINK', status: 'PENDING', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics).toHaveLength(2);
  });
});

// ── Outcome status counting ───────────────────────────────────────────────────

describe('outcome status counting', () => {
  function makeCasesWithStatuses(statuses: ExecutionStatus[]): RecoveryCase[] {
    return statuses.map((status, i) => makeRecoveryCase({
      payment: { paymentId: `pay_${i}` as PaymentId },
      executionResult: {
        status,
        recoveredAmount: status === 'RECOVERED' ? 100_000 : 0,
      },
    }));
  }

  it('counts recoveredCount correctly', () => {
    const cases = makeCasesWithStatuses(['RECOVERED', 'RECOVERED', 'FAILED']);
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].recoveredCount).toBe(2);
  });

  it('counts failedCount correctly', () => {
    const cases = makeCasesWithStatuses(['RECOVERED', 'FAILED', 'FAILED']);
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].failedCount).toBe(2);
  });

  it('PENDING does NOT count towards completedAttempts', () => {
    const cases = makeCasesWithStatuses(['RECOVERED', 'PENDING', 'PENDING']);
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].completedAttempts).toBe(1);
    expect(result.strategyMetrics[0].pendingCount).toBe(2);
  });

  it('ESCALATED counts as completed', () => {
    const cases = makeCasesWithStatuses(['ESCALATED', 'ESCALATED']);
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].completedAttempts).toBe(2);
    expect(result.strategyMetrics[0].escalatedCount).toBe(2);
  });

  it('BLOCKED counts as completed', () => {
    const cases = makeCasesWithStatuses(['BLOCKED', 'BLOCKED']);
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].completedAttempts).toBe(2);
    expect(result.strategyMetrics[0].blockedCount).toBe(2);
  });

  it('completedAttempts = recovered + failed + escalated + blocked', () => {
    const cases = makeCasesWithStatuses(['RECOVERED', 'FAILED', 'ESCALATED', 'BLOCKED', 'PENDING']);
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].completedAttempts).toBe(4);
    expect(result.strategyMetrics[0].totalAttempts).toBe(5);
  });
});

// ── Recovery rate calculation ─────────────────────────────────────────────────

describe('recovery rate', () => {
  it('recovery rate = recoveredCount / completedAttempts', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_003' as PaymentId }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_004' as PaymentId }, executionResult: { status: 'FAILED', recoveredAmount: 0 } } ),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].recoveryRate).toBeCloseTo(0.5);
  });

  it('recovery rate is null when completedAttempts is 0 (all pending)', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, executionResult: { status: 'PENDING', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].recoveryRate).toBeNull();
  });

  it('PENDING does not inflate recovery rate denominator', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId }, executionResult: { status: 'PENDING', recoveredAmount: 0 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_003' as PaymentId }, executionResult: { status: 'PENDING', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    // Only 1 completed (RECOVERED), so rate = 1/1 = 100%, not 1/3
    expect(result.strategyMetrics[0].recoveryRate).toBeCloseTo(1.0);
  });
});

// ── Revenue metrics ───────────────────────────────────────────────────────────

describe('revenue metrics', () => {
  it('attemptedRevenueInPaise sums all payment amounts', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, amount: 100_000 }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, amount: 200_000 }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].attemptedRevenueInPaise).toBe(300_000);
  });

  it('recoveredRevenueInPaise sums only recovered amounts', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, amount: 100_000 }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 }, recoveredAmount: 100_000 }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, amount: 200_000 }, executionResult: { status: 'FAILED', recoveredAmount: 0 }, recoveredAmount: 0 }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].recoveredRevenueInPaise).toBe(100_000);
  });

  it('revenueRecoveryRate = recoveredRevenue / attemptedRevenue', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, amount: 100_000 }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 }, recoveredAmount: 100_000 }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, amount: 100_000 }, executionResult: { status: 'FAILED', recoveredAmount: 0 }, recoveredAmount: 0 }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].revenueRecoveryRate).toBeCloseTo(0.5);
  });

  it('averageRecoveredRevenueInPaise is null when no recoveries', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].averageRecoveredRevenueInPaise).toBeNull();
  });

  it('averageRecoveredRevenueInPaise is correct when there are recoveries', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, amount: 100_000 }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 }, recoveredAmount: 100_000 }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, amount: 200_000 }, executionResult: { status: 'RECOVERED', recoveredAmount: 200_000 }, recoveredAmount: 200_000 }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].averageRecoveredRevenueInPaise).toBe(150_000);
  });
});

// ── Average recovery time ─────────────────────────────────────────────────────

describe('average recovery time', () => {
  it('averageRecoveryTimeMinutes is null when no recoveries', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].averageRecoveryTimeMinutes).toBeNull();
  });

  it('averageRecoveryTimeMinutes is computed from failedAt to executedAt', () => {
    const failedAt = '2026-09-01T10:00:00.000Z';
    const executedAt = '2026-09-01T11:00:00.000Z'; // exactly 60 minutes later
    const cases = [
      makeRecoveryCase({
        payment: { paymentId: 'pay_001' as PaymentId, failedAt },
        executionResult: { status: 'RECOVERED', recoveredAmount: 100_000, executedAt },
      }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].averageRecoveryTimeMinutes).toBe(60);
  });

  it('averages recovery times across multiple recoveries', () => {
    const failedAt = '2026-09-01T10:00:00.000Z';
    const cases = [
      makeRecoveryCase({
        payment: { paymentId: 'pay_001' as PaymentId, failedAt },
        executionResult: { status: 'RECOVERED', recoveredAmount: 100_000, executedAt: '2026-09-01T10:30:00.000Z' }, // 30 min
      }),
      makeRecoveryCase({
        payment: { paymentId: 'pay_002' as PaymentId, failedAt },
        executionResult: { status: 'RECOVERED', recoveredAmount: 100_000, executedAt: '2026-09-01T11:30:00.000Z' }, // 90 min
      }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].averageRecoveryTimeMinutes).toBe(60); // (30 + 90) / 2
  });
});

// ── Minimum sample size and performance status ────────────────────────────────

describe('minimum sample size', () => {
  it(`performanceStatus is INSUFFICIENT_DATA when completedAttempts < ${MIN_COMPLETED_ATTEMPTS}`, () => {
    const cases = Array.from({ length: MIN_COMPLETED_ATTEMPTS - 1 }, (_, i) =>
      makeRecoveryCase({ payment: { paymentId: `pay_${i}` as PaymentId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
    );
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].performanceStatus).toBe('INSUFFICIENT_DATA');
  });

  it(`performanceStatus is OBSERVED when completedAttempts >= ${MIN_COMPLETED_ATTEMPTS}`, () => {
    const cases = Array.from({ length: MIN_COMPLETED_ATTEMPTS }, (_, i) =>
      makeRecoveryCase({ payment: { paymentId: `pay_${i}` as PaymentId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
    );
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].performanceStatus).not.toBe('INSUFFICIENT_DATA');
  });

  it('PENDING cases do not count toward minimum sample threshold', () => {
    const cases = Array.from({ length: MIN_COMPLETED_ATTEMPTS + 1 }, (_, i) =>
      makeRecoveryCase({ payment: { paymentId: `pay_${i}` as PaymentId }, executionResult: { status: 'PENDING', recoveredAmount: 0 } }),
    );
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].performanceStatus).toBe('INSUFFICIENT_DATA');
  });
});

// ── Best strategy selection ───────────────────────────────────────────────────

describe('best strategy selection', () => {
  function makeObservedStrategy(overrides: Partial<RecoveryStrategyMetrics>): RecoveryStrategyMetrics {
    return {
      strategyKey: { type: 'RETRY', paymentMethod: 'UPI', retryDelayBucket: '30_TO_60_MIN' },
      label: 'UPI Retry (30–60 min)',
      totalAttempts: 10,
      completedAttempts: 10,
      recoveredCount: 7,
      failedCount: 3,
      pendingCount: 0,
      escalatedCount: 0,
      blockedCount: 0,
      recoveryRate: 0.7,
      attemptedRevenueInPaise: 1_000_000,
      recoveredRevenueInPaise: 700_000,
      revenueRecoveryRate: 0.7,
      averageRecoveredRevenueInPaise: 100_000,
      averageRecoveryTimeMinutes: 45,
      performanceStatus: 'OBSERVED',
      dataSource: 'OBSERVED',
      ...overrides,
    };
  }

  it('compareByPerformance: higher recovery rate wins', () => {
    const a = makeObservedStrategy({ recoveryRate: 0.8, label: 'A' });
    const b = makeObservedStrategy({ recoveryRate: 0.6, label: 'B' });
    expect(compareByPerformance(a, b)).toBeLessThan(0); // a wins (comes first)
  });

  it('compareByPerformance: tie on rate → higher revenue wins', () => {
    const a = makeObservedStrategy({ recoveryRate: 0.7, recoveredRevenueInPaise: 800_000, label: 'A' });
    const b = makeObservedStrategy({ recoveryRate: 0.7, recoveredRevenueInPaise: 600_000, label: 'B' });
    expect(compareByPerformance(a, b)).toBeLessThan(0); // a wins
  });

  it('compareByPerformance: tie on rate and revenue → faster time wins', () => {
    const a = makeObservedStrategy({ recoveryRate: 0.7, recoveredRevenueInPaise: 700_000, averageRecoveryTimeMinutes: 30, label: 'A' });
    const b = makeObservedStrategy({ recoveryRate: 0.7, recoveredRevenueInPaise: 700_000, averageRecoveryTimeMinutes: 90, label: 'B' });
    expect(compareByPerformance(a, b)).toBeLessThan(0); // a wins (faster)
  });

  it('compareByPerformance: full tie → label alphabetically first wins', () => {
    const a = makeObservedStrategy({ recoveryRate: 0.7, recoveredRevenueInPaise: 700_000, averageRecoveryTimeMinutes: 45, label: 'A Strategy' });
    const b = makeObservedStrategy({ recoveryRate: 0.7, recoveredRevenueInPaise: 700_000, averageRecoveryTimeMinutes: 45, label: 'B Strategy' });
    expect(compareByPerformance(a, b)).toBeLessThan(0); // 'A' < 'B'
  });

  it('portfolio summary identifies LEADING strategy by recovery rate', () => {
    const highRateCases = Array.from({ length: 8 }, (_, i) =>
      makeRecoveryCase({
        payment: { paymentId: `pay_h_${i}` as PaymentId, paymentMethod: 'UPI' },
        policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 },
        executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 },
      }),
    );
    const lowRateCases = Array.from({ length: 8 }, (_, i) =>
      makeRecoveryCase({
        payment: { paymentId: `pay_l_${i}` as PaymentId, paymentMethod: 'CARD' },
        policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 180 },
        executionResult: { status: i < 2 ? 'RECOVERED' : 'FAILED', recoveredAmount: i < 2 ? 100_000 : 0 },
      }),
    );
    const result = computeStrategyAnalytics(makeInput([...highRateCases, ...lowRateCases]));
    const leadingMetrics = result.strategyMetrics.filter((m) => m.performanceStatus === 'LEADING');
    expect(leadingMetrics).toHaveLength(1);
    expect(leadingMetrics[0].recoveryRate).toBeGreaterThan(0.5);
  });

  it('INSUFFICIENT_DATA strategies are not eligible for LEADING', () => {
    // Only 3 cases (below minimum sample of 5)
    const cases = Array.from({ length: 3 }, (_, i) =>
      makeRecoveryCase({ payment: { paymentId: `pay_${i}` as PaymentId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
    );
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics.some((m) => m.performanceStatus === 'LEADING')).toBe(false);
    expect(result.portfolioSummary.bestRecoveryRateStrategy).toBeNull();
  });
});

// ── Same-method retry vs method switch ───────────────────────────────────────

describe('same-method retry grouping', () => {
  it('UPI → UPI retry and CARD → CARD retry are tracked separately', () => {
    const upiCases = Array.from({ length: 3 }, (_, i) =>
      makeRecoveryCase({
        payment: { paymentId: `pay_upi_${i}` as PaymentId, paymentMethod: 'UPI' },
        policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 },
      }),
    );
    const cardCases = Array.from({ length: 3 }, (_, i) =>
      makeRecoveryCase({
        payment: { paymentId: `pay_card_${i}` as PaymentId, paymentMethod: 'CARD' },
        policyDecision: { finalAction: 'RETRY_LATER', approvedRetryAfterMinutes: 45 },
      }),
    );
    const result = computeStrategyAnalytics(makeInput([...upiCases, ...cardCases]));
    const strategyTypes = result.strategyMetrics.map((m) => m.label);
    expect(strategyTypes).toContain('UPI Retry (30–60 min)');
    expect(strategyTypes).toContain('Card Retry (30–60 min)');
    expect(result.strategyMetrics).toHaveLength(2);
  });
});

describe('payment method switch grouping', () => {
  it('CARD → UPI and UPI → CARD are tracked separately', () => {
    function makeSwitchCase(
      id: string,
      from: PaymentMethod,
      to: PaymentMethod,
    ): RecoveryCase {
      const c = makeRecoveryCase({
        payment: { paymentId: id as PaymentId, paymentMethod: from },
        policyDecision: { finalAction: 'UPDATE_PAYMENT_METHOD', approved: true },
        executionResult: { action: 'UPDATE_PAYMENT_METHOD', status: 'PENDING', recoveredAmount: 0 },
      });
      return {
        ...c,
        paymentMethodSwitch: {
          currentMethod: from,
          shouldSwitch: true,
          recommendedMethod: to,
          alternatives: [],
          reason: 'Switch',
        },
      };
    }
    const cases = [
      makeSwitchCase('pay_c2u', 'CARD', 'UPI'),
      makeSwitchCase('pay_u2c', 'UPI', 'CARD'),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    const labels = result.strategyMetrics.map((m) => m.label);
    expect(labels).toContain('Card → UPI Switch');
    expect(labels).toContain('UPI → Card Switch');
  });
});

// ── Failure reason performance ────────────────────────────────────────────────

describe('failure reason performance', () => {
  it('groups performance by failure reason', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, failureReason: 'UPI_TIMEOUT' } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, failureReason: 'EXPIRED_CARD' } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    const reasons = result.failureReasonPerformance.map((f) => f.failureReason);
    expect(reasons).toContain('UPI_TIMEOUT');
    expect(reasons).toContain('EXPIRED_CARD');
  });

  it('bestStrategy is null when no failure reason strategy meets minimum sample', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, failureReason: 'UPI_TIMEOUT' } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    const upiPerf = result.failureReasonPerformance.find((f) => f.failureReason === 'UPI_TIMEOUT');
    expect(upiPerf?.bestStrategy).toBeNull();
  });

  it('calculates recovery rate per failure reason correctly', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, failureReason: 'UPI_TIMEOUT' }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, failureReason: 'UPI_TIMEOUT' }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_003' as PaymentId, failureReason: 'EXPIRED_CARD' }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    const upiPerf = result.failureReasonPerformance.find((f) => f.failureReason === 'UPI_TIMEOUT');
    expect(upiPerf?.recoveryRate).toBeCloseTo(0.5);
    const cardPerf = result.failureReasonPerformance.find((f) => f.failureReason === 'EXPIRED_CARD');
    expect(cardPerf?.recoveryRate).toBeCloseTo(0);
  });
});

// ── Payment method performance ────────────────────────────────────────────────

describe('payment method performance', () => {
  it('groups performance by payment method', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, paymentMethod: 'UPI' } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, paymentMethod: 'CARD' } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    const methods = result.paymentMethodPerformance.map((p) => p.paymentMethod);
    expect(methods).toContain('UPI');
    expect(methods).toContain('CARD');
  });

  it('calculates totalFailedRevenueInPaise per payment method', () => {
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, paymentMethod: 'UPI', amount: 100_000 }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, paymentMethod: 'UPI', amount: 200_000 }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases));
    const upiPerf = result.paymentMethodPerformance.find((p) => p.paymentMethod === 'UPI');
    expect(upiPerf?.totalFailedRevenueInPaise).toBe(300_000);
  });
});

// ── Customer segment performance ──────────────────────────────────────────────

describe('customer segment performance', () => {
  it('shows all four segments even when some have no data', () => {
    const result = computeStrategyAnalytics(makeInput([]));
    expect(result.customerSegmentPerformance).toHaveLength(4);
    const segments = result.customerSegmentPerformance.map((s) => s.segment);
    expect(segments).toContain('HIGH_RECOVERY_POTENTIAL');
    expect(segments).toContain('MEDIUM_RECOVERY_POTENTIAL');
    expect(segments).toContain('LOW_RECOVERY_POTENTIAL');
    expect(segments).toContain('INSUFFICIENT_HISTORY');
  });

  it('consumes Feature 13 segment map — does not recalculate scores', () => {
    const customerId = 'cust_001' as CustomerId;
    const segmentMap = new Map<CustomerId, CustomerRecoverySegment>([
      [customerId, 'HIGH_RECOVERY_POTENTIAL'],
    ]);
    const cases = [
      makeRecoveryCase({
        payment: { paymentId: 'pay_001' as PaymentId, customerId },
        executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 },
      }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases, [], segmentMap));
    const highPerf = result.customerSegmentPerformance.find(
      (s) => s.segment === 'HIGH_RECOVERY_POTENTIAL',
    );
    expect(highPerf?.totalAttempts).toBe(1);
    expect(highPerf?.recoveredCount).toBe(1);
  });

  it('segments without matching cases have zero attempts and null recovery rate', () => {
    const result = computeStrategyAnalytics(makeInput([]));
    const lowPerf = result.customerSegmentPerformance.find(
      (s) => s.segment === 'LOW_RECOVERY_POTENTIAL',
    );
    expect(lowPerf?.totalAttempts).toBe(0);
    expect(lowPerf?.recoveryRate).toBeNull();
  });

  it('calculates segment recovery rate correctly', () => {
    const customerId = 'cust_001' as CustomerId;
    const segmentMap = new Map<CustomerId, CustomerRecoverySegment>([
      [customerId, 'MEDIUM_RECOVERY_POTENTIAL'],
    ]);
    const cases = [
      makeRecoveryCase({ payment: { paymentId: 'pay_001' as PaymentId, customerId }, executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } }),
      makeRecoveryCase({ payment: { paymentId: 'pay_002' as PaymentId, customerId }, executionResult: { status: 'FAILED', recoveredAmount: 0 } }),
    ];
    const result = computeStrategyAnalytics(makeInput(cases, [], segmentMap));
    const medPerf = result.customerSegmentPerformance.find(
      (s) => s.segment === 'MEDIUM_RECOVERY_POTENTIAL',
    );
    expect(medPerf?.recoveryRate).toBeCloseTo(0.5);
  });
});

// ── Experiment integration ────────────────────────────────────────────────────

describe('experiment integration', () => {
  function makeExperimentResult(overrides: {
    status?: string;
    aRate?: number;
    bRate?: number;
    aCount?: number;
    bCount?: number;
  } = {}): ExperimentResult {
    const aRate = overrides.aRate ?? 0.62;
    const bRate = overrides.bRate ?? 0.54;
    const aCount = overrides.aCount ?? 15;
    const bCount = overrides.bCount ?? 15;
    const status = overrides.status ?? 'A_LEADING';
    return {
      experiment: {
        id: 'exp_retry_001',
        name: 'Retry Timing Optimization',
        description: 'Test retry timing',
        status: 'RUNNING',
        dimension: 'RETRY_TIMING',
        variantA: {
          id: 'A',
          name: 'Quick Retry',
          description: 'Quick',
          strategy: { dimension: 'RETRY_TIMING', retryDelayMinutes: 30 },
        },
        variantB: {
          id: 'B',
          name: 'Slow Retry',
          description: 'Slow',
          strategy: { dimension: 'RETRY_TIMING', retryDelayMinutes: 120 },
        },
        allocationPercent: { a: 50, b: 50 },
      },
      outcomes: [],
      comparison: {
        experimentId: 'exp_retry_001',
        variantA: {
          variantId: 'A', variantName: 'Quick Retry',
          assignedCount: aCount, completedCount: aCount,
          recoveredCount: Math.round(aRate * aCount), failedCount: Math.round((1 - aRate) * aCount),
          pendingCount: 0, escalatedCount: 0, blockedCount: 0,
          recoveryRate: aRate, recoveredRevenueInPaise: Math.round(aRate * aCount * 100_000),
          avgRecoveredRevenuePerPaymentInPaise: 100_000, avgRecoveryTimeMinutes: 35,
        },
        variantB: {
          variantId: 'B', variantName: 'Slow Retry',
          assignedCount: bCount, completedCount: bCount,
          recoveredCount: Math.round(bRate * bCount), failedCount: Math.round((1 - bRate) * bCount),
          pendingCount: 0, escalatedCount: 0, blockedCount: 0,
          recoveryRate: bRate, recoveredRevenueInPaise: Math.round(bRate * bCount * 100_000),
          avgRecoveredRevenuePerPaymentInPaise: 100_000, avgRecoveryTimeMinutes: 120,
        },
        recoveryRateDifference: aRate - bRate,
        recoveredRevenueDifferenceInPaise: 0,
        leadingVariantId: status === 'A_LEADING' ? 'A' : status === 'B_LEADING' ? 'B' : null,
        status: status as 'A_LEADING' | 'B_LEADING' | 'INSUFFICIENT_DATA' | 'NO_CLEAR_DIFFERENCE',
      },
    };
  }

  it('reuses Feature 10 experiment output — does not recalculate', () => {
    const expResult = makeExperimentResult();
    const result = computeStrategyAnalytics(makeInput([], [expResult]));
    expect(result.experimentPerformance).toHaveLength(1);
    expect(result.experimentPerformance[0].experimentId).toBe('exp_retry_001');
    expect(result.experimentPerformance[0].dataSource).toBe('EXPERIMENT');
  });

  it('propagates experiment variant recovery rates unchanged', () => {
    const expResult = makeExperimentResult({ aRate: 0.62, bRate: 0.54 });
    const result = computeStrategyAnalytics(makeInput([], [expResult]));
    expect(result.experimentPerformance[0].variantARecoveryRate).toBeCloseTo(0.62);
    expect(result.experimentPerformance[0].variantBRecoveryRate).toBeCloseTo(0.54);
  });

  it('propagates leading variant correctly', () => {
    const expResult = makeExperimentResult({ status: 'A_LEADING' });
    const result = computeStrategyAnalytics(makeInput([], [expResult]));
    expect(result.experimentPerformance[0].leadingVariantId).toBe('A');
  });
});

// ── Message tone analytics ────────────────────────────────────────────────────

describe('message tone analytics', () => {
  function makeMessageToneExperiment(
    aIsNeutral: boolean,
    leadingVariant: 'A' | 'B' | null,
  ): ExperimentResult {
    const aStrategy = aIsNeutral
      ? { dimension: 'MESSAGE_TONE' as const, tone: 'NEUTRAL' as const }
      : { dimension: 'MESSAGE_TONE' as const, tone: 'FRIENDLY' as const };
    const bStrategy = aIsNeutral
      ? { dimension: 'MESSAGE_TONE' as const, tone: 'FRIENDLY' as const }
      : { dimension: 'MESSAGE_TONE' as const, tone: 'NEUTRAL' as const };
    return {
      experiment: {
        id: 'exp_tone_001',
        name: 'Recovery Message Tone',
        description: 'Tone test',
        status: 'RUNNING',
        dimension: 'MESSAGE_TONE',
        variantA: { id: 'A', name: aIsNeutral ? 'Neutral' : 'Friendly', description: '', strategy: aStrategy },
        variantB: { id: 'B', name: aIsNeutral ? 'Friendly' : 'Neutral', description: '', strategy: bStrategy },
        allocationPercent: { a: 50, b: 50 },
      },
      outcomes: [],
      comparison: {
        experimentId: 'exp_tone_001',
        variantA: {
          variantId: 'A', variantName: aIsNeutral ? 'Neutral' : 'Friendly',
          assignedCount: 12, completedCount: 12,
          recoveredCount: aIsNeutral ? 7 : 8,
          failedCount: aIsNeutral ? 5 : 4,
          pendingCount: 0, escalatedCount: 0, blockedCount: 0,
          recoveryRate: aIsNeutral ? 7 / 12 : 8 / 12,
          recoveredRevenueInPaise: 700_000,
          avgRecoveredRevenuePerPaymentInPaise: 100_000,
          avgRecoveryTimeMinutes: null,
        },
        variantB: {
          variantId: 'B', variantName: aIsNeutral ? 'Friendly' : 'Neutral',
          assignedCount: 12, completedCount: 12,
          recoveredCount: aIsNeutral ? 8 : 7,
          failedCount: aIsNeutral ? 4 : 5,
          pendingCount: 0, escalatedCount: 0, blockedCount: 0,
          recoveryRate: aIsNeutral ? 8 / 12 : 7 / 12,
          recoveredRevenueInPaise: 800_000,
          avgRecoveredRevenuePerPaymentInPaise: 100_000,
          avgRecoveryTimeMinutes: null,
        },
        recoveryRateDifference: 0,
        recoveredRevenueDifferenceInPaise: 0,
        leadingVariantId: leadingVariant,
        status: leadingVariant ? (leadingVariant === 'A' ? 'A_LEADING' : 'B_LEADING') : 'INSUFFICIENT_DATA',
      },
    };
  }

  it('message tone analytics are null when no MESSAGE_TONE experiment exists', () => {
    const result = computeStrategyAnalytics(makeInput([], []));
    expect(result.messageToneAnalytics).toBeNull();
  });

  it('message tone analytics have EXPERIMENT dataSource', () => {
    const toneExp = makeMessageToneExperiment(true, null);
    const result = computeStrategyAnalytics(makeInput([], [toneExp]));
    expect(result.messageToneAnalytics?.dataSource).toBe('EXPERIMENT');
  });

  it('correctly identifies neutral and friendly rates when A is neutral', () => {
    const toneExp = makeMessageToneExperiment(true, 'B'); // A=Neutral, B=Friendly, B leads
    const result = computeStrategyAnalytics(makeInput([], [toneExp]));
    const tone = result.messageToneAnalytics!;
    expect(tone.neutralRecoveryRate).toBeCloseTo(7 / 12);
    expect(tone.friendlyRecoveryRate).toBeCloseTo(8 / 12);
    expect(tone.leadingTone).toBe('FRIENDLY');
  });

  it('correctly identifies neutral and friendly rates when B is neutral', () => {
    const toneExp = makeMessageToneExperiment(false, 'A'); // A=Friendly, B=Neutral, A leads
    const result = computeStrategyAnalytics(makeInput([], [toneExp]));
    const tone = result.messageToneAnalytics!;
    expect(tone.friendlyRecoveryRate).toBeCloseTo(8 / 12);
    expect(tone.neutralRecoveryRate).toBeCloseTo(7 / 12);
    expect(tone.leadingTone).toBe('FRIENDLY');
  });

  it('message tone analytics include a note explaining draft-only limitation', () => {
    const toneExp = makeMessageToneExperiment(true, null);
    const result = computeStrategyAnalytics(makeInput([], [toneExp]));
    expect(result.messageToneAnalytics?.note).toBeTruthy();
    expect(result.messageToneAnalytics?.note.length).toBeGreaterThan(20);
  });

  it('message draft performance does not appear in observed strategy metrics', () => {
    // Ensure message tone experiments don't pollute execution-based strategy metrics
    const toneExp = makeMessageToneExperiment(true, null);
    const result = computeStrategyAnalytics(makeInput([], [toneExp]));
    const observedMetrics = result.strategyMetrics.filter(
      (m) => m.dataSource === 'OBSERVED',
    );
    // No observed strategy entries from a tone experiment alone
    expect(observedMetrics.filter((m) => m.label.toLowerCase().includes('neutral'))).toHaveLength(0);
    expect(observedMetrics.filter((m) => m.label.toLowerCase().includes('friendly'))).toHaveLength(0);
  });
});

// ── Immutability and determinism ──────────────────────────────────────────────

describe('immutability and determinism', () => {
  it('does not mutate input cases array', () => {
    const cases = [makeRecoveryCase()];
    const originalCasesLength = cases.length;
    const originalPaymentId = cases[0].payment.paymentId;
    computeStrategyAnalytics(makeInput(cases));
    expect(cases.length).toBe(originalCasesLength);
    expect(cases[0].payment.paymentId).toBe(originalPaymentId);
  });

  it('same input produces same output', () => {
    const cases = Array.from({ length: 7 }, (_, i) =>
      makeRecoveryCase({
        payment: { paymentId: `pay_${i}` as PaymentId },
        executionResult: { status: i < 5 ? 'RECOVERED' : 'FAILED', recoveredAmount: i < 5 ? 100_000 : 0 },
      }),
    );
    const input = makeInput(cases);
    const result1 = computeStrategyAnalytics(input);
    const result2 = computeStrategyAnalytics(input);
    expect(result1.strategyMetrics[0].recoveryRate).toBe(result2.strategyMetrics[0].recoveryRate);
    expect(result1.portfolioSummary.portfolioRecoveryRate).toBe(
      result2.portfolioSummary.portfolioRecoveryRate,
    );
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('single completed attempt — INSUFFICIENT_DATA, no LEADING', () => {
    const cases = [makeRecoveryCase({ executionResult: { status: 'RECOVERED', recoveredAmount: 100_000 } })];
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].performanceStatus).toBe('INSUFFICIENT_DATA');
    expect(result.portfolioSummary.bestRecoveryRateStrategy).toBeNull();
  });

  it('all-pending dataset — recoveryRate is null', () => {
    const cases = Array.from({ length: 10 }, (_, i) =>
      makeRecoveryCase({ payment: { paymentId: `pay_${i}` as PaymentId }, executionResult: { status: 'PENDING', recoveredAmount: 0 } }),
    );
    const result = computeStrategyAnalytics(makeInput(cases));
    expect(result.strategyMetrics[0].recoveryRate).toBeNull();
    expect(result.strategyMetrics[0].performanceStatus).toBe('INSUFFICIENT_DATA');
  });

  it('portfolioSummary is consistent with strategyMetrics totals', () => {
    const cases = Array.from({ length: 6 }, (_, i) =>
      makeRecoveryCase({
        payment: { paymentId: `pay_${i}` as PaymentId, amount: 100_000 },
        executionResult: { status: i < 4 ? 'RECOVERED' : 'FAILED', recoveredAmount: i < 4 ? 100_000 : 0 },
      }),
    );
    const result = computeStrategyAnalytics(makeInput(cases));
    const sumAttempts = result.strategyMetrics.reduce((s, m) => s + m.totalAttempts, 0);
    expect(result.portfolioSummary.totalAttempts).toBe(sumAttempts);
    const sumRevenue = result.strategyMetrics.reduce((s, m) => s + m.recoveredRevenueInPaise, 0);
    expect(result.portfolioSummary.totalRecoveredRevenueInPaise).toBe(sumRevenue);
  });
});
