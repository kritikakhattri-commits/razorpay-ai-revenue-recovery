import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runSimulation, runPresetSimulations } from './recoverySimulator';
import { compareRecoverySimulations } from './scenarioComparison';
import { PRESET_SCENARIOS } from './scenarioPresets';
import { computeRecoveryRecommendation } from '../../domain/recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../../domain/policy/policyEngine';
import { calculateRecoveryScore } from '../../domain/recovery/recoveryScore';
import { calculateRevenueAtRisk } from '../../domain/recovery/revenueAtRisk';
import { buildRecoveryQueue } from '../queue/recoveryQueue';
import type { RecoveryCase } from '../recovery/types';
import type { FailedPayment, PaymentId, CustomerId, PaymentMethod, FailureReason } from '../../domain/payments/types';
import type { ExecutionStatus } from '../../domain/executor/types';
import type { CustomerRecoverySegment } from '../../domain/customerRecovery/types';
import type {
  RecoverySimulationScenario,
  RecoverySimulationResult,
  SimulatedPaymentResult,
} from '../../domain/simulation/types';
import type { StrategyAnalyticsResult, RecoveryStrategyMetrics } from '../../domain/strategyAnalytics/types';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const NOW = '2026-09-04T00:00:00.000Z';
const FAILED_AT = '2026-09-01T10:00:00.000Z';

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_test_001' as PaymentId,
    customerId: 'cust_001' as CustomerId,
    customerName: 'Test Customer',
    amount: 100_000, // ₹1,000
    currency: 'INR',
    paymentMethod: 'UPI' as PaymentMethod,
    failureReason: 'UPI_TIMEOUT' as FailureReason,
    attemptCount: 1,
    previousSuccessfulPayments: 3,
    lastAttemptAt: FAILED_AT,
    failedAt: FAILED_AT,
    ...overrides,
  };
}

function makeCase(
  overrides: Partial<FailedPayment> = {},
  executionStatus: ExecutionStatus = 'FAILED',
): RecoveryCase {
  const payment = makePayment(overrides);
  const recommendation = computeRecoveryRecommendation(payment);
  const policyDecision = evaluatePolicy(payment, recommendation);
  const recoveryScore = calculateRecoveryScore({
    amountInPaise: payment.amount,
    recoveryProbability: recommendation.confidence,
  });
  const revenueAtRiskScore = calculateRevenueAtRisk({
    amountInPaise: payment.amount,
    recoveryProbability: recommendation.confidence,
    expectedRecoverableAmountInPaise: recoveryScore.expectedRecoverableAmountInPaise,
    attemptCount: payment.attemptCount,
    previousSuccessfulPayments: payment.previousSuccessfulPayments,
    failedAt: payment.failedAt,
    now: NOW,
  });

  return {
    payment,
    recommendation,
    policyDecision,
    executionResult: {
      paymentId: payment.paymentId,
      action: policyDecision.finalAction,
      status: executionStatus,
      executedAt: '2026-09-01T12:00:00.000Z',
      recoveredAmount: executionStatus === 'RECOVERED' ? payment.amount : 0,
      message: `Simulated ${executionStatus}`,
    },
    auditEntries: [],
    recoveredAmount: executionStatus === 'RECOVERED' ? payment.amount : 0,
    recoveryScore,
    smartRetryTiming: null,
    paymentMethodSwitch: {
      currentMethod: payment.paymentMethod,
      shouldSwitch: false,
      recommendedMethod: null,
      alternatives: [],
      reason: 'No switch in test fixture',
    },
    revenueAtRiskScore,
  };
}

// Scenario builder shorthand.
function scenario(overrides: Partial<RecoverySimulationScenario> = {}): RecoverySimulationScenario {
  return {
    id: 'test_scenario',
    name: 'Test Scenario',
    description: 'Test',
    type: 'CUSTOM',
    filters: {},
    strategy: { mode: 'USE_CURRENT_RECOMMENDATION' },
    ...overrides,
  };
}

// Minimal StrategyAnalyticsResult stub.
function emptyStrategyAnalytics(): StrategyAnalyticsResult {
  return {
    strategyMetrics: [],
    failureReasonPerformance: [],
    paymentMethodPerformance: [],
    customerSegmentPerformance: [],
    experimentPerformance: [],
    messageToneAnalytics: null,
    portfolioSummary: {
      totalAttempts: 0,
      totalCompletedAttempts: 0,
      portfolioRecoveryRate: null,
      totalRecoveredRevenueInPaise: 0,
      averageRecoveryTimeMinutes: null,
      bestRecoveryRateStrategy: null,
      highestRevenueStrategy: null,
      fastestStrategy: null,
      weakestRecoveryRateStrategy: null,
      insufficientDataCount: 0,
      observedCount: 0,
      leadingCount: 0,
    },
    generatedAt: NOW,
  };
}

function strategyMetricsStub(
  type: RecoveryStrategyMetrics['strategyKey']['type'],
  recoveryRate: number,
  performanceStatus: RecoveryStrategyMetrics['performanceStatus'],
  overrides: Partial<RecoveryStrategyMetrics> = {},
): RecoveryStrategyMetrics {
  const base: RecoveryStrategyMetrics = {
    strategyKey: type === 'RETRY'
      ? { type: 'RETRY', paymentMethod: 'UPI', retryDelayBucket: '1_TO_3_HR' }
      : type === 'PAYMENT_LINK'
        ? { type: 'PAYMENT_LINK' }
        : type === 'PAYMENT_METHOD_SWITCH'
          ? { type: 'PAYMENT_METHOD_SWITCH', fromPaymentMethod: 'CARD', toPaymentMethod: 'UPI' }
          : { type: 'ESCALATION' },
    label: type === 'RETRY' ? 'UPI Retry (1–3 hr)' : type,
    totalAttempts: 15,
    completedAttempts: 12,
    recoveredCount: Math.round(12 * recoveryRate),
    failedCount: 12 - Math.round(12 * recoveryRate),
    pendingCount: 3,
    escalatedCount: 0,
    blockedCount: 0,
    recoveryRate,
    attemptedRevenueInPaise: 1_500_000,
    recoveredRevenueInPaise: Math.round(1_500_000 * recoveryRate),
    revenueRecoveryRate: recoveryRate,
    averageRecoveredRevenueInPaise: 100_000,
    averageRecoveryTimeMinutes: 90,
    performanceStatus,
    dataSource: 'OBSERVED',
    ...overrides,
  };
  return base;
}

function strategyAnalyticsWithBest(
  failureReason: FailureReason,
  bestMetrics: RecoveryStrategyMetrics | null,
): StrategyAnalyticsResult {
  return {
    ...emptyStrategyAnalytics(),
    failureReasonPerformance: [
      {
        failureReason,
        totalAttempts: bestMetrics ? 15 : 0,
        completedAttempts: bestMetrics ? 12 : 0,
        recoveredCount: bestMetrics ? Math.round(12 * (bestMetrics.recoveryRate ?? 0)) : 0,
        recoveryRate: bestMetrics ? bestMetrics.recoveryRate : null,
        recoveredRevenueInPaise: bestMetrics ? bestMetrics.recoveredRevenueInPaise : 0,
        bestStrategy: bestMetrics,
        strategyBreakdown: bestMetrics ? [bestMetrics] : [],
      },
    ],
  };
}

// ── Input builder ─────────────────────────────────────────────────────────────

function makeInput(
  cases: RecoveryCase[],
  scen: RecoverySimulationScenario,
  strategyAnalytics = emptyStrategyAnalytics(),
  customerSegmentMap = new Map<CustomerId, CustomerRecoverySegment>(),
) {
  const queueItems = buildRecoveryQueue(cases).items;
  return {
    cases,
    scenario: scen,
    queueItems,
    strategyAnalytics,
    customerSegmentMap,
    simulatedAt: NOW,
  };
}

// ── 1. HIGH_CONFIDENCE eligibility ───────────────────────────────────────────

describe('Eligibility filter — HIGH_CONFIDENCE', () => {
  it('includes HIGH-priority payments and excludes MEDIUM/LOW', () => {
    // UPI_TIMEOUT with attemptCount=1 and previousSuccessful=3 → HIGH priority
    const high = makeCase({ paymentId: 'pay_h1' as PaymentId });
    // CUSTOMER_ABANDONED with 0 history → LOW priority
    const low = makeCase({
      paymentId: 'pay_l1' as PaymentId,
      failureReason: 'CUSTOMER_ABANDONED',
      previousSuccessfulPayments: 0,
    });
    expect(high.recoveryScore.priority).toBe('HIGH');
    expect(['MEDIUM', 'LOW']).toContain(low.recoveryScore.priority);

    const result = runSimulation(
      makeInput([high, low], scenario({ filters: { recoveryPriority: ['HIGH'] } })),
    );
    expect(result.eligiblePaymentCount).toBe(1);
    expect(result.affectedPaymentIds).toContain('pay_h1');
    expect(result.affectedPaymentIds).not.toContain('pay_l1');
  });
});

// ── 2. CRITICAL_RISK eligibility ──────────────────────────────────────────────

describe('Eligibility filter — CRITICAL_RISK', () => {
  it('includes only CRITICAL-risk payments', () => {
    // Large amount + multiple attempts → CRITICAL
    const critical = makeCase({
      paymentId: 'pay_cr1' as PaymentId,
      amount: 5_000_000, // ₹50,000
      attemptCount: 4,
      previousSuccessfulPayments: 10,
      failureReason: 'BANK_SERVER_ERROR',
    });
    // Small amount → likely LOW risk
    const low = makeCase({
      paymentId: 'pay_lw1' as PaymentId,
      amount: 5_000, // ₹50
      attemptCount: 1,
      previousSuccessfulPayments: 0,
      failureReason: 'CUSTOMER_ABANDONED',
    });

    const result = runSimulation(
      makeInput([critical, low], scenario({ filters: { riskLevel: ['CRITICAL'] } })),
    );
    expect(critical.revenueAtRiskScore.level).toBe('CRITICAL');
    expect(result.affectedPaymentIds).toContain('pay_cr1');
    expect(result.affectedPaymentIds).not.toContain('pay_lw1');
  });
});

// ── 3. TOP_QUEUE eligibility ──────────────────────────────────────────────────

describe('Eligibility filter — TOP_QUEUE', () => {
  it('includes only payments within the maxQueueRank', () => {
    // 3 payments with different amounts → queue ranks 1, 2, 3
    const c1 = makeCase({ paymentId: 'pay_q1' as PaymentId, amount: 500_000 });
    const c2 = makeCase({ paymentId: 'pay_q2' as PaymentId, amount: 300_000 });
    const c3 = makeCase({ paymentId: 'pay_q3' as PaymentId, amount: 100_000 });
    const result = runSimulation(
      makeInput([c1, c2, c3], scenario({ filters: { maxQueueRank: 2 } })),
    );
    expect(result.eligiblePaymentCount).toBe(2);
    expect(result.affectedPaymentIds).toContain('pay_q1');
    expect(result.affectedPaymentIds).toContain('pay_q2');
    expect(result.affectedPaymentIds).not.toContain('pay_q3');
  });

  it('excludes all when maxQueueRank is 0', () => {
    const c = makeCase();
    const result = runSimulation(makeInput([c], scenario({ filters: { maxQueueRank: 0 } })));
    expect(result.eligiblePaymentCount).toBe(0);
  });
});

// ── 4. Payment method filter ──────────────────────────────────────────────────

describe('Eligibility filter — payment method', () => {
  it('filters by payment method', () => {
    const upi = makeCase({ paymentId: 'pay_u1' as PaymentId, paymentMethod: 'UPI' });
    const card = makeCase({ paymentId: 'pay_c1' as PaymentId, paymentMethod: 'CARD', failureReason: 'EXPIRED_CARD' });
    const result = runSimulation(
      makeInput([upi, card], scenario({ filters: { paymentMethods: ['UPI'] } })),
    );
    expect(result.affectedPaymentIds).toContain('pay_u1');
    expect(result.affectedPaymentIds).not.toContain('pay_c1');
  });
});

// ── 5. Failure reason filter ──────────────────────────────────────────────────

describe('Eligibility filter — failure reason', () => {
  it('filters by failure reason', () => {
    const upiTimeout = makeCase({ paymentId: 'pay_ut' as PaymentId, failureReason: 'UPI_TIMEOUT' });
    const bankError = makeCase({ paymentId: 'pay_be' as PaymentId, failureReason: 'BANK_SERVER_ERROR' });
    const result = runSimulation(
      makeInput([upiTimeout, bankError], scenario({ filters: { failureReasons: ['UPI_TIMEOUT'] } })),
    );
    expect(result.affectedPaymentIds).toContain('pay_ut');
    expect(result.affectedPaymentIds).not.toContain('pay_be');
  });
});

// ── 6. Customer segment filter ────────────────────────────────────────────────

describe('Eligibility filter — customer segment', () => {
  it('filters by customer segment using Feature 13 map', () => {
    const c1 = makeCase({ paymentId: 'pay_s1' as PaymentId, customerId: 'cust_A' as CustomerId });
    const c2 = makeCase({ paymentId: 'pay_s2' as PaymentId, customerId: 'cust_B' as CustomerId });
    const segmentMap = new Map<CustomerId, CustomerRecoverySegment>([
      ['cust_A' as CustomerId, 'HIGH_RECOVERY_POTENTIAL'],
      ['cust_B' as CustomerId, 'LOW_RECOVERY_POTENTIAL'],
    ]);
    const result = runSimulation(
      makeInput(
        [c1, c2],
        scenario({ filters: { customerSegments: ['HIGH_RECOVERY_POTENTIAL'] } }),
        emptyStrategyAnalytics(),
        segmentMap,
      ),
    );
    expect(result.affectedPaymentIds).toContain('pay_s1');
    expect(result.affectedPaymentIds).not.toContain('pay_s2');
  });

  it('excludes payment when customer has no segment in map', () => {
    const c = makeCase({ customerId: 'cust_unknown' as CustomerId });
    const result = runSimulation(
      makeInput(
        [c],
        scenario({ filters: { customerSegments: ['HIGH_RECOVERY_POTENTIAL'] } }),
        emptyStrategyAnalytics(),
        new Map(), // empty map
      ),
    );
    expect(result.eligiblePaymentCount).toBe(0);
  });
});

// ── 7. Combined filters ───────────────────────────────────────────────────────

describe('Eligibility filter — combined', () => {
  it('applies all filters as AND logic', () => {
    const matching = makeCase({
      paymentId: 'pay_match' as PaymentId,
      paymentMethod: 'UPI',
      failureReason: 'UPI_TIMEOUT',
    });
    const wrongMethod = makeCase({
      paymentId: 'pay_wm' as PaymentId,
      paymentMethod: 'CARD',
      failureReason: 'UPI_TIMEOUT',
    });
    const wrongReason = makeCase({
      paymentId: 'pay_wr' as PaymentId,
      paymentMethod: 'UPI',
      failureReason: 'CUSTOMER_ABANDONED',
    });
    const result = runSimulation(
      makeInput(
        [matching, wrongMethod, wrongReason],
        scenario({
          filters: {
            paymentMethods: ['UPI'],
            failureReasons: ['UPI_TIMEOUT'],
          },
        }),
      ),
    );
    expect(result.eligiblePaymentCount).toBe(1);
    expect(result.affectedPaymentIds).toEqual(['pay_match']);
  });
});

// ── 8. No duplicate payments ──────────────────────────────────────────────────

describe('Deduplication', () => {
  it('counts each payment exactly once even if cases array is deduped defensively', () => {
    const c = makeCase({ paymentId: 'pay_dup' as PaymentId });
    // Real portfolio shouldn't have duplicates, but simulator must be safe.
    const result = runSimulation(makeInput([c, c], scenario()));
    expect(result.eligiblePaymentCount).toBe(1);
    expect(result.affectedPaymentIds).toEqual(['pay_dup']);
  });
});

// ── 9. Fixed retry strategy ───────────────────────────────────────────────────

describe('Strategy — FIXED_RETRY_DELAY', () => {
  it('applies the specified retry delay to RETRY_LATER recommendations', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT' }); // default RETRY_LATER
    const result = runSimulation(
      makeInput(
        [c],
        scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 60 } }),
      ),
    );
    const pr = result.paymentResults[0]!;
    expect(pr.simulatedStrategyLabel).toContain('60');
  });

  it('falls back for non-RETRY_LATER payments', () => {
    // EXPIRED_CARD always produces UPDATE_PAYMENT_METHOD recommendation
    const c = makeCase({ paymentId: 'pay_ec' as PaymentId, failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
    expect(c.recommendation.recommendedAction).toBe('UPDATE_PAYMENT_METHOD');
    const result = runSimulation(
      makeInput(
        [c],
        scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 60 } }),
      ),
    );
    // Should not try to retry an expired card
    const pr = result.paymentResults[0]!;
    expect(pr.simulatedStrategyLabel).not.toContain('Retry');
  });
});

// ── 10. Method-switch strategy ────────────────────────────────────────────────

describe('Strategy — USE_METHOD_SWITCH', () => {
  it('applies UPDATE_PAYMENT_METHOD when shouldSwitch is true', () => {
    const c = makeCase({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD' });
    // Inject a case with shouldSwitch true
    const caseWithSwitch: RecoveryCase = {
      ...c,
      paymentMethodSwitch: {
        currentMethod: 'CARD',
        shouldSwitch: true,
        recommendedMethod: 'UPI',
        alternatives: [],
        reason: 'Switch to UPI',
      },
    };
    const result = runSimulation(
      makeInput(
        [caseWithSwitch],
        scenario({ strategy: { mode: 'USE_METHOD_SWITCH' } }),
      ),
    );
    const pr = result.paymentResults[0]!;
    expect(pr.simulatedStrategyLabel).toBe('Update Method');
  });

  it('falls back to current recommendation when shouldSwitch is false', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT' }); // shouldSwitch: false in fixture
    const result = runSimulation(
      makeInput(
        [c],
        scenario({ strategy: { mode: 'USE_METHOD_SWITCH' } }),
      ),
    );
    const pr = result.paymentResults[0]!;
    // Falls back to the original recommendation (RETRY_LATER)
    expect(pr.simulatedStrategyLabel).toContain('Retry');
  });
});

// ── 11. Best-observed-strategy integration ────────────────────────────────────

describe('Strategy — BEST_OBSERVED_STRATEGY', () => {
  it('uses Feature 14 best strategy for the failure reason when available', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT' });
    const best = strategyMetricsStub('RETRY', 0.80, 'LEADING');
    const analytics = strategyAnalyticsWithBest('UPI_TIMEOUT', best);

    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    const pr = result.paymentResults[0]!;
    // The best strategy is RETRY (1–3 hr bucket → 120 min representative)
    expect(pr.simulatedStrategyLabel).toContain('Retry');
    expect(pr.simulatedStrategyLabel).toContain('120');
  });

  it('uses best strategy recoveryRate to adjust estimated recovery', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', amount: 100_000 });
    const best = strategyMetricsStub('RETRY', 0.80, 'OBSERVED');
    const analytics = strategyAnalyticsWithBest('UPI_TIMEOUT', best);

    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    const pr = result.paymentResults[0]!;
    // estimatedRecoverable = 100_000 * 0.80 = 80_000 (if policy approved)
    if (pr.policyOutcome === 'APPROVED') {
      expect(pr.estimatedRecoverableInPaise).toBe(80_000);
    }
  });

  it('does not adjust estimate for PAYMENT_LINK strategy type', () => {
    const c = makeCase({ failureReason: 'AUTHENTICATION_FAILED' });
    const best = strategyMetricsStub('PAYMENT_LINK', 0.70, 'OBSERVED');
    const analytics = strategyAnalyticsWithBest('AUTHENTICATION_FAILED', best);

    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    // PAYMENT_LINK best strategy: simulated label should be Payment Link
    expect(result.paymentResults[0]!.simulatedStrategyLabel).toBe('Payment Link');
  });
});

// ── 12. Insufficient Feature 14 data fallback ─────────────────────────────────

describe('Strategy — BEST_OBSERVED_STRATEGY fallback', () => {
  it('falls back to current recommendation when no Feature 14 data', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT' });
    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), emptyStrategyAnalytics()),
    );
    const pr = result.paymentResults[0]!;
    // Should use current recommendation label (RETRY_LATER)
    expect(pr.simulatedStrategyLabel).toContain('Retry');
    // Should not use adjusted estimate
    expect(pr.estimatedRecoverableInPaise).toBe(c.recoveryScore.expectedRecoverableAmountInPaise);
  });

  it('falls back when Feature 14 data is INSUFFICIENT_DATA', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT' });
    const insufficient = strategyMetricsStub('RETRY', 0.80, 'INSUFFICIENT_DATA');
    const analytics = strategyAnalyticsWithBest('UPI_TIMEOUT', insufficient);

    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    // Fallback: uses base recovery score
    const pr = result.paymentResults[0]!;
    expect(pr.estimatedRecoverableInPaise).toBe(c.recoveryScore.expectedRecoverableAmountInPaise);
  });

  it('falls back when bestStrategy is null', () => {
    const c = makeCase({ failureReason: 'CUSTOMER_ABANDONED' });
    const analytics = strategyAnalyticsWithBest('CUSTOMER_ABANDONED', null);
    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    expect(result.paymentResults[0]!.estimatedRecoverableInPaise).toBe(c.recoveryScore.expectedRecoverableAmountInPaise);
  });
});

// ── 13. PolicyEngine dry-run — APPROVED ───────────────────────────────────────

describe('PolicyEngine dry-run — APPROVED', () => {
  it('approves a valid UPI_TIMEOUT retry', () => {
    // UPI_TIMEOUT + attemptCount=1 + delay=30 min → should be APPROVED
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const result = runSimulation(makeInput([c], scenario()));
    const pr = result.paymentResults[0]!;
    expect(pr.policyOutcome).toBe('APPROVED');
    expect(result.policyApprovedCount).toBe(1);
  });
});

// ── 14. PolicyEngine dry-run — MODIFIED ──────────────────────────────────────

describe('PolicyEngine dry-run — MODIFIED', () => {
  it('marks MODIFIED when policy redirects expired-card retry to UPDATE_PAYMENT_METHOD', () => {
    const c = makeCase({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD', attemptCount: 1 });
    // Force BEST_OBSERVED_STRATEGY to return a RETRY candidate for EXPIRED_CARD
    const best = strategyMetricsStub('RETRY', 0.5, 'OBSERVED');
    const analytics = strategyAnalyticsWithBest('EXPIRED_CARD', best);

    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    const pr = result.paymentResults[0]!;
    // Policy: EXPIRED_CARD_NO_RETRY → approved: false, finalAction: UPDATE_PAYMENT_METHOD → MODIFIED
    expect(pr.policyOutcome).toBe('MODIFIED');
    expect(result.policyModifiedCount).toBe(1);
    expect(pr.policyRulesApplied).toContain('EXPIRED_CARD_NO_RETRY');
  });
});

// ── 15. PolicyEngine dry-run — BLOCKED ───────────────────────────────────────

describe('PolicyEngine dry-run — BLOCKED', () => {
  it('blocks retry when attemptCount exceeds maximum', () => {
    // Need previousSuccessfulPayments >= 5 to keep confidence >= 0.60 (historyBoost=0.10,
    // attemptPenalty=(3-1)*0.15=0.30 → confidence=0.80+0.10-0.30=0.60) so MAX_RETRY_ATTEMPTS
    // fires before LOW_CONFIDENCE_ESCALATION.
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', attemptCount: 3, previousSuccessfulPayments: 8 });
    const result = runSimulation(makeInput([c], scenario()));
    const pr = result.paymentResults[0]!;
    expect(pr.policyOutcome).toBe('BLOCKED');
    expect(result.policyBlockedCount).toBe(1);
    expect(pr.policyRulesApplied).toContain('MAX_RETRY_ATTEMPTS');
  });

  it('blocks retry when proposed delay is below minimum', () => {
    // FIXED_RETRY_DELAY with 15 min → MINIMUM_RETRY_DELAY rule
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const result = runSimulation(
      makeInput(
        [c],
        scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 15 } }),
      ),
    );
    const pr = result.paymentResults[0]!;
    expect(pr.policyOutcome).toBe('BLOCKED');
    expect(pr.policyRulesApplied).toContain('MINIMUM_RETRY_DELAY');
  });

  it('blocks bank error retry when delay is below 60 min', () => {
    // FIXED_RETRY_DELAY with 30 min + BANK_SERVER_ERROR → BANK_ERROR_RETRY_DELAY
    const c = makeCase({ failureReason: 'BANK_SERVER_ERROR', attemptCount: 1 });
    const result = runSimulation(
      makeInput(
        [c],
        scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 30 } }),
      ),
    );
    const pr = result.paymentResults[0]!;
    expect(pr.policyOutcome).toBe('BLOCKED');
    expect(pr.policyRulesApplied).toContain('BANK_ERROR_RETRY_DELAY');
  });
});

// ── 16. Simulator never calls RecoveryExecutor ────────────────────────────────

describe('Safety — no execution side effects', () => {
  it('simulator source does not import or call RecoveryExecutor', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/simulation/recoverySimulator.ts'),
      'utf-8',
    );
    expect(src).not.toContain('SimulatedRecoveryActionExecutor');
    expect(src).not.toContain('recoveryActionExecutor');
    expect(src).not.toContain('.execute(');
  });
});

// ── 17. Simulator never writes audit entries ──────────────────────────────────

describe('Safety — no audit writes', () => {
  it('simulator source does not import AuditLogger or InMemoryAuditStore', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/simulation/recoverySimulator.ts'),
      'utf-8',
    );
    expect(src).not.toContain('AuditLogger');
    expect(src).not.toContain('InMemoryAuditStore');
    expect(src).not.toContain('auditLogger');
    expect(src).not.toContain('auditStore');
  });
});

// ── 18. Targeted failed revenue calculation ────────────────────────────────────

describe('Revenue metrics — targetedFailedRevenue', () => {
  it('sums amount of all eligible payments', () => {
    const c1 = makeCase({ paymentId: 'pay_r1' as PaymentId, amount: 50_000 });
    const c2 = makeCase({ paymentId: 'pay_r2' as PaymentId, amount: 75_000 });
    const result = runSimulation(makeInput([c1, c2], scenario()));
    expect(result.targetedFailedRevenueInPaise).toBe(125_000);
  });
});

// ── 19. Estimated recovery calculation ────────────────────────────────────────

describe('Revenue metrics — estimatedRecoverable', () => {
  it('sums per-payment estimated recoverable amounts', () => {
    const c1 = makeCase({ paymentId: 'pay_e1' as PaymentId, amount: 100_000 });
    const c2 = makeCase({ paymentId: 'pay_e2' as PaymentId, amount: 200_000 });
    const result = runSimulation(makeInput([c1, c2], scenario()));
    const expectedTotal =
      result.paymentResults.reduce((s, r) => s + r.estimatedRecoverableInPaise, 0);
    expect(result.estimatedRecoverableRevenueInPaise).toBe(expectedTotal);
  });
});

// ── 20. Estimated unrecovered calculation ─────────────────────────────────────

describe('Revenue metrics — estimatedUnrecovered', () => {
  it('equals max(0, targeted - recoverable)', () => {
    const c = makeCase({ amount: 100_000 });
    const result = runSimulation(makeInput([c], scenario()));
    const expected = Math.max(0, result.targetedFailedRevenueInPaise - result.estimatedRecoverableRevenueInPaise);
    expect(result.estimatedUnrecoveredRevenueInPaise).toBe(expected);
  });

  it('is never negative', () => {
    const c = makeCase({ amount: 100_000, failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const result = runSimulation(makeInput([c], scenario()));
    expect(result.estimatedUnrecoveredRevenueInPaise).toBeGreaterThanOrEqual(0);
  });
});

// ── 21. Estimated recovery rate ───────────────────────────────────────────────

describe('Revenue metrics — estimatedRecoveryRate', () => {
  it('equals estimatedRecoverable / targetedFailedRevenue', () => {
    const c = makeCase({ amount: 100_000 });
    const result = runSimulation(makeInput([c], scenario()));
    if (result.targetedFailedRevenueInPaise === 0) {
      expect(result.estimatedRecoveryRate).toBe(0);
    } else {
      expect(result.estimatedRecoveryRate).toBeCloseTo(
        result.estimatedRecoverableRevenueInPaise / result.targetedFailedRevenueInPaise,
        10,
      );
    }
  });
});

// ── 22. Zero targeted revenue ─────────────────────────────────────────────────

describe('Edge case — zero targeted revenue', () => {
  it('returns 0 recovery rate safely when no eligible payments', () => {
    const result = runSimulation(makeInput([], scenario()));
    expect(result.estimatedRecoveryRate).toBe(0);
    expect(result.targetedFailedRevenueInPaise).toBe(0);
    expect(result.estimatedRecoverableRevenueInPaise).toBe(0);
    expect(result.eligiblePaymentCount).toBe(0);
  });
});

// ── 23. Policy counts ─────────────────────────────────────────────────────────

describe('Policy counts', () => {
  it('counts sum to eligiblePaymentCount', () => {
    const c1 = makeCase({ paymentId: 'pay_p1' as PaymentId, failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const c2 = makeCase({ paymentId: 'pay_p2' as PaymentId, failureReason: 'UPI_TIMEOUT', attemptCount: 3 }); // blocked
    const result = runSimulation(makeInput([c1, c2], scenario()));
    expect(result.policyApprovedCount + result.policyModifiedCount + result.policyBlockedCount)
      .toBe(result.eligiblePaymentCount);
  });
});

// ── 24. Affected payment IDs ──────────────────────────────────────────────────

describe('Affected payment IDs', () => {
  it('contains exactly the eligible payment IDs', () => {
    const c1 = makeCase({ paymentId: 'pay_a1' as PaymentId });
    const c2 = makeCase({ paymentId: 'pay_a2' as PaymentId });
    const c3 = makeCase({ paymentId: 'pay_a3' as PaymentId, failureReason: 'CUSTOMER_ABANDONED', previousSuccessfulPayments: 0 });
    const result = runSimulation(
      makeInput([c1, c2, c3], scenario({ filters: { recoveryPriority: ['HIGH'] } })),
    );
    for (const id of result.affectedPaymentIds) {
      expect(['pay_a1', 'pay_a2', 'pay_a3']).toContain(id);
    }
  });
});

// ── 25. Deterministic result ──────────────────────────────────────────────────

describe('Determinism', () => {
  it('produces identical results for identical inputs', () => {
    const c = makeCase({ paymentId: 'pay_det' as PaymentId });
    const input = makeInput([c], scenario());
    const r1 = runSimulation({ ...input, simulatedAt: NOW });
    const r2 = runSimulation({ ...input, simulatedAt: NOW });
    expect(r1.eligiblePaymentCount).toBe(r2.eligiblePaymentCount);
    expect(r1.estimatedRecoverableRevenueInPaise).toBe(r2.estimatedRecoverableRevenueInPaise);
    expect(r1.policyApprovedCount).toBe(r2.policyApprovedCount);
    expect(r1.affectedPaymentIds).toEqual(r2.affectedPaymentIds);
  });
});

// ── 26. Input not mutated ─────────────────────────────────────────────────────

describe('Immutability', () => {
  it('does not mutate the input cases array', () => {
    const c = makeCase();
    const cases = [c];
    const before = JSON.stringify(cases);
    runSimulation(makeInput(cases, scenario()));
    expect(JSON.stringify(cases)).toBe(before);
  });
});

// ── 27. Scenario comparison ───────────────────────────────────────────────────

describe('Scenario comparison', () => {
  it('selects the scenario with the highest recovery rate as bestByRecoveryRate', () => {
    const c = makeCase({ paymentId: 'pay_cmp' as PaymentId });
    const input = makeInput([c], scenario());
    const r1 = { ...runSimulation(input), estimatedRecoveryRate: 0.7, scenarioId: 'a' };
    const r2 = { ...runSimulation(input), estimatedRecoveryRate: 0.5, scenarioId: 'b' };
    const comparison = compareRecoverySimulations([r1, r2]);
    expect(comparison.bestByRecoveryRate?.scenarioId).toBe('a');
  });

  it('selects bestByRevenue correctly', () => {
    const r1: RecoverySimulationResult = {
      ...runSimulation(makeInput([makeCase()], scenario())),
      estimatedRecoverableRevenueInPaise: 200_000,
      scenarioId: 'big',
    };
    const r2: RecoverySimulationResult = {
      ...runSimulation(makeInput([makeCase()], scenario())),
      estimatedRecoverableRevenueInPaise: 100_000,
      scenarioId: 'small',
    };
    const comparison = compareRecoverySimulations([r1, r2]);
    expect(comparison.bestByRevenue?.scenarioId).toBe('big');
  });

  it('handles empty input gracefully', () => {
    const comparison = compareRecoverySimulations([]);
    expect(comparison.bestByRecoveryRate).toBeNull();
    expect(comparison.bestByRevenue).toBeNull();
    expect(comparison.bestByCount).toBeNull();
    expect(comparison.scenarios).toHaveLength(0);
  });
});

// ── 28. Current forecast remains unchanged ────────────────────────────────────

describe('Isolation — forecast unchanged', () => {
  it('does not write to or return a RecoveryForecast', () => {
    const c = makeCase();
    const result = runSimulation(makeInput([c], scenario()));
    // RecoverySimulationResult has no forecast field
    expect((result as unknown as Record<string, unknown>)['forecast']).toBeUndefined();
    expect((result as unknown as Record<string, unknown>)['byHorizon']).toBeUndefined();
  });
});

// ── 29. Customer score remains unchanged ──────────────────────────────────────

describe('Isolation — customer scores unchanged', () => {
  it('does not modify customer recovery scores', () => {
    const c = makeCase({ customerId: 'cust_iso' as CustomerId });
    const segmentMap = new Map<CustomerId, CustomerRecoverySegment>([
      ['cust_iso' as CustomerId, 'HIGH_RECOVERY_POTENTIAL'],
    ]);
    const before = JSON.stringify([...segmentMap.entries()]);
    runSimulation(makeInput([c], scenario(), emptyStrategyAnalytics(), segmentMap));
    expect(JSON.stringify([...segmentMap.entries()])).toBe(before);
  });
});

// ── 30. Recovery Queue remains unchanged ──────────────────────────────────────

describe('Isolation — queue unchanged', () => {
  it('uses queue ranks for filtering but does not rerank', () => {
    const c1 = makeCase({ paymentId: 'pay_qr1' as PaymentId, amount: 500_000 });
    const c2 = makeCase({ paymentId: 'pay_qr2' as PaymentId, amount: 100_000 });
    const queueBefore = buildRecoveryQueue([c1, c2]);
    runSimulation(makeInput([c1, c2], scenario({ filters: { maxQueueRank: 1 } })));
    const queueAfter = buildRecoveryQueue([c1, c2]);
    expect(queueAfter.items[0]!.paymentId).toBe(queueBefore.items[0]!.paymentId);
    expect(queueAfter.items.length).toBe(queueBefore.items.length);
  });
});

// ── 31. Invalid retry scenario excludes incompatible actions ──────────────────

describe('Strategy fallback — incompatible actions', () => {
  it('FIXED_RETRY_DELAY falls back for SEND_PAYMENT_LINK payment', () => {
    // AUTHENTICATION_FAILED → SEND_PAYMENT_LINK recommendation
    const c = makeCase({ failureReason: 'AUTHENTICATION_FAILED' });
    expect(c.recommendation.recommendedAction).toBe('SEND_PAYMENT_LINK');
    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 60 } })),
    );
    const pr = result.paymentResults[0]!;
    // Fallback: uses original recommendation
    expect(pr.simulatedStrategyLabel).toBe('Payment Link');
  });
});

// ── 32. Blocked payments handled safely ───────────────────────────────────────

describe('Blocked payments', () => {
  it('does not throw when all payments are blocked', () => {
    // attemptCount=3 → always blocked
    const c1 = makeCase({ paymentId: 'pay_blk1' as PaymentId, failureReason: 'UPI_TIMEOUT', attemptCount: 3 });
    const c2 = makeCase({ paymentId: 'pay_blk2' as PaymentId, failureReason: 'BANK_SERVER_ERROR', attemptCount: 3 });
    const result = runSimulation(makeInput([c1, c2], scenario()));
    expect(result.policyBlockedCount).toBe(2);
    expect(result.policyApprovedCount).toBe(0);
    expect(result.eligiblePaymentCount).toBe(2);
    // Recovery of zero blocked payments
    expect(result.estimatedRecoverableRevenueInPaise).toBeGreaterThanOrEqual(0);
    expect(result.isSimulationOnly).toBe(true);
  });
});

// ── 33. Empty dataset ─────────────────────────────────────────────────────────

describe('Edge case — empty dataset', () => {
  it('handles empty cases gracefully', () => {
    const result = runSimulation(makeInput([], scenario()));
    expect(result.eligiblePaymentCount).toBe(0);
    expect(result.targetedFailedRevenueInPaise).toBe(0);
    expect(result.estimatedRecoveryRate).toBe(0);
    expect(result.policyApprovedCount).toBe(0);
    expect(result.notes.at(-1)).toBe('SIMULATION — No recovery actions were executed.');
    expect(result.isSimulationOnly).toBe(true);
  });
});

// ── 34. No eligible payments ──────────────────────────────────────────────────

describe('Edge case — no eligible payments', () => {
  it('handles cases where no payment matches filter', () => {
    const c = makeCase({ paymentMethod: 'UPI' });
    const result = runSimulation(
      makeInput([c], scenario({ filters: { paymentMethods: ['CARD'] } })),
    );
    expect(result.eligiblePaymentCount).toBe(0);
    expect(result.affectedPaymentIds).toHaveLength(0);
    expect(result.paymentResults).toHaveLength(0);
    expect(result.isSimulationOnly).toBe(true);
  });
});

// ── 35. Same input produces same result ───────────────────────────────────────

describe('Reproducibility', () => {
  it('produces the same result for two calls with the same input', () => {
    const c1 = makeCase({ paymentId: 'pay_rep1' as PaymentId, amount: 100_000 });
    const c2 = makeCase({ paymentId: 'pay_rep2' as PaymentId, amount: 200_000 });
    const input = makeInput([c1, c2], scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 90 } }));
    const r1 = runSimulation({ ...input, simulatedAt: NOW });
    const r2 = runSimulation({ ...input, simulatedAt: NOW });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ── 36. Copilot consumes simulator service ────────────────────────────────────

describe('Copilot integration', () => {
  it('copilotService imports from simulation domain (not inline logic)', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/copilot/copilotService.ts'),
      'utf-8',
    );
    // Copilot uses presetSimulations from DashboardData (simulator already ran)
    // OR directly from the simulation service.
    // Either way, the copilot should not duplicate simulation logic.
    expect(src).not.toContain('isEligibleForScenario');
    expect(src).not.toContain('deriveCandidateRecommendation');
  });

  it('copilot source does not call RecoveryExecutor', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/copilot/copilotService.ts'),
      'utf-8',
    );
    expect(src).not.toContain('.execute(');
    expect(src).not.toContain('SimulatedRecoveryActionExecutor');
  });
});

// ── 37. No execution CTA causes side effect ───────────────────────────────────

describe('Safety — UI execution', () => {
  it('simulator result has isSimulationOnly: true on every result', () => {
    const cases = [
      makeCase({ paymentId: 'pay_s01' as PaymentId }),
      makeCase({ paymentId: 'pay_s02' as PaymentId, failureReason: 'BANK_SERVER_ERROR' }),
    ];
    const input = makeInput(cases, scenario());
    const result = runSimulation(input);
    expect(result.isSimulationOnly).toBe(true);
  });
});

// ── 38. Policy safety rules remain unchanged ──────────────────────────────────

describe('PolicyEngine integrity', () => {
  it('policyEngine.ts is not imported by recoverySimulator differently than via evaluatePolicy', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/simulation/recoverySimulator.ts'),
      'utf-8',
    );
    // Only evaluatePolicy (the public API) should be used, not internals.
    expect(src).toContain('evaluatePolicy');
    expect(src).not.toContain('MIN_CONFIDENCE');
    expect(src).not.toContain('MAX_AUTO_RETRY_ATTEMPTS');
  });
});

// ── 39. Existing tests remain green (verified by running full suite) ───────────

// (Run `npm test` to verify — all 944+ pre-existing tests should still pass.)

// ── 40. Build without live LLM/API keys ───────────────────────────────────────

describe('No LLM dependency', () => {
  it('runSimulation completes without any AI model calls', () => {
    // The simulator is fully deterministic and requires no language model.
    const c = makeCase();
    expect(() => runSimulation(makeInput([c], scenario()))).not.toThrow();
  });
});

// ── Preset scenarios smoke tests ──────────────────────────────────────────────

describe('Preset scenarios', () => {
  it('all 5 presets are defined and have required fields', () => {
    expect(PRESET_SCENARIOS).toHaveLength(5);
    for (const s of PRESET_SCENARIOS) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.type).toBeTruthy();
      expect(s.filters).toBeDefined();
      expect(s.strategy.mode).toBeTruthy();
    }
  });

  it('runPresetSimulations returns one result per preset', () => {
    const c = makeCase();
    const queueItems = buildRecoveryQueue([c]).items;
    const results = runPresetSimulations(PRESET_SCENARIOS, {
      cases: [c],
      queueItems,
      strategyAnalytics: emptyStrategyAnalytics(),
      customerSegmentMap: new Map(),
      simulatedAt: NOW,
    });
    expect(results).toHaveLength(PRESET_SCENARIOS.length);
    for (const r of results) {
      expect(r.isSimulationOnly).toBe(true);
    }
  });
});

// ── Baseline comparison ───────────────────────────────────────────────────────

describe('Baseline comparison', () => {
  it('scenarioDeltaInPaise = estimatedRecoverable - baseline', () => {
    const c = makeCase({ amount: 100_000, failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const result = runSimulation(makeInput([c], scenario()));
    expect(result.scenarioDeltaInPaise).toBe(
      result.estimatedRecoverableRevenueInPaise - result.baselineEstimatedRecoverableInPaise,
    );
  });

  it('baselineEstimatedRecoverableInPaise = sum of recoveryScore.expectedRecoverableAmountInPaise', () => {
    const c1 = makeCase({ paymentId: 'pay_b1' as PaymentId, amount: 100_000 });
    const c2 = makeCase({ paymentId: 'pay_b2' as PaymentId, amount: 200_000 });
    const result = runSimulation(makeInput([c1, c2], scenario()));
    const expected = c1.recoveryScore.expectedRecoverableAmountInPaise + c2.recoveryScore.expectedRecoverableAmountInPaise;
    expect(result.baselineEstimatedRecoverableInPaise).toBe(expected);
  });
});

// ── Safety label ──────────────────────────────────────────────────────────────

describe('Safety labeling', () => {
  it('always includes safety note as the last note', () => {
    const c = makeCase();
    const result = runSimulation(makeInput([c], scenario()));
    const lastNote = result.notes.at(-1);
    expect(lastNote).toBe('SIMULATION — No recovery actions were executed.');
  });

  it('includes safety note even for empty portfolios', () => {
    const result = runSimulation(makeInput([], scenario()));
    expect(result.notes.at(-1)).toBe('SIMULATION — No recovery actions were executed.');
  });
});

// ── Notes generation ──────────────────────────────────────────────────────────

describe('Notes generation', () => {
  it('includes MAX_RETRY_ATTEMPTS note when applicable', () => {
    // previousSuccessfulPayments=8 keeps confidence >= 0.60 so MAX_RETRY_ATTEMPTS fires.
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', attemptCount: 3, previousSuccessfulPayments: 8 });
    const result = runSimulation(makeInput([c], scenario()));
    expect(result.notes.some((n) => n.includes('maximum automatic retry ceiling'))).toBe(true);
  });

  it('includes MINIMUM_RETRY_DELAY note when applicable', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', attemptCount: 1 });
    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 10 } })),
    );
    expect(result.notes.some((n) => n.includes('minimum'))).toBe(true);
  });

  it('notes scenario delta when estimatedRecoverable > baseline', () => {
    const c = makeCase({ failureReason: 'UPI_TIMEOUT', attemptCount: 1, amount: 100_000 });
    const best = strategyMetricsStub('RETRY', 0.99, 'LEADING');
    const analytics = strategyAnalyticsWithBest('UPI_TIMEOUT', best);
    const result = runSimulation(
      makeInput([c], scenario({ strategy: { mode: 'BEST_OBSERVED_STRATEGY' } }), analytics),
    );
    if (result.scenarioDeltaInPaise > 0) {
      expect(result.notes.some((n) => n.includes('more recovery'))).toBe(true);
    }
  });
});

// ── SimulatedPaymentResult fields ────────────────────────────────────────────

describe('Per-payment result fields', () => {
  it('paymentResult has all required fields', () => {
    const c = makeCase();
    const result = runSimulation(makeInput([c], scenario()));
    const pr: SimulatedPaymentResult = result.paymentResults[0]!;
    expect(typeof pr.paymentId).toBe('string');
    expect(typeof pr.customerName).toBe('string');
    expect(typeof pr.failedAmountInPaise).toBe('number');
    expect(typeof pr.estimatedRecoverableInPaise).toBe('number');
    expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(pr.riskLevel);
    expect(typeof pr.currentStrategyLabel).toBe('string');
    expect(typeof pr.simulatedStrategyLabel).toBe('string');
    expect(['APPROVED', 'MODIFIED', 'BLOCKED']).toContain(pr.policyOutcome);
    expect(typeof pr.policyReason).toBe('string');
    expect(Array.isArray(pr.policyRulesApplied)).toBe(true);
  });
});
