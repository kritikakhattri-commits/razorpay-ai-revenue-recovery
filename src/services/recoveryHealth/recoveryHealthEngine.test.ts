import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { BatchRecoveryResult } from '../recovery/types';
import type { PaymentFailureAnomaly, AnomalySeverity } from '../../domain/anomaly/types';
import type { StrategyAnalyticsResult, RecoveryStrategyMetrics } from '../../domain/strategyAnalytics/types';
import type { CustomerRecoveryPortfolio } from '../../domain/customerRecovery/types';
import type { QueueItem } from '../queue/types';
import type { RecoveryHealthInput } from './recoveryHealthEngine';
import {
  computeRecoveryHealth,
  buildRecoveryExecutiveSummary,
  scoreRecoveryPerformance,
  scoreRevenueRisk,
  scoreForecast,
  scoreAnomalyHealth,
  scoreStrategyEffectiveness,
  scoreRecoveryVelocity,
  classifyHealthStatus,
  selectWeakestComponent,
  deriveMainConcern,
  deriveMainOpportunity,
  HEALTH_STATUS_THRESHOLDS,
  COMPONENT_WEIGHTS,
} from './recoveryHealthEngine';
import { runDashboard } from '../../lib/dashboardData';
import { buildRecoveryQueue } from '../queue/recoveryQueue';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBatch(overrides: Partial<BatchRecoveryResult> = {}): BatchRecoveryResult {
  return {
    cases: [],
    totalPayments: 10,
    totalRevenueAtRisk: 1_000_000,
    totalRecoveredRevenue: 600_000,
    recoveryRate: 0.60,
    recoveredPaymentCount: 6,
    failedRecoveryCount: 2,
    pendingPaymentCount: 1,
    escalatedPaymentCount: 1,
    blockedPaymentCount: 0,
    totalExpectedRecoverableRevenue: 700_000,
    totalRevenueUnrecoverableInPaise: 300_000,
    riskCriticalCount: 1,
    riskHighCount: 2,
    riskMediumCount: 3,
    riskLowCount: 4,
    forecast: {
      totalFailedRevenueInPaise: 400_000,
      expectedRecoveredRevenueInPaise: 280_000,
      expectedUnrecoveredRevenueInPaise: 120_000,
      expectedRecoveryRate: 0.70,
      highConfidenceRecoveryInPaise: 200_000,
      mediumConfidenceRecoveryInPaise: 50_000,
      lowConfidenceRecoveryInPaise: 30_000,
      forecastConfidence: 'HIGH',
      byHorizon: {
        next24HoursInPaise: 180_000,
        next3DaysInPaise: 70_000,
        beyond3DaysInPaise: 30_000,
      },
    },
    ...overrides,
  };
}

function makeAnomaly(severity: AnomalySeverity, overrides: Partial<PaymentFailureAnomaly> = {}): PaymentFailureAnomaly {
  return {
    id: `anom_${severity}`,
    type: 'FAILURE_REASON_SPIKE',
    severity,
    title: `${severity} spike`,
    message: `${severity} anomaly message`,
    observedValue: 10,
    baselineValue: 5,
    ratioToBaseline: 2.0,
    anomalyScore: 50,
    affectedPaymentCount: 5,
    affectedRevenueInPaise: 50_000,
    revenueAtRiskInPaise: 30_000,
    windowStart: '2026-09-04T00:00:00.000Z',
    windowEnd: '2026-09-04T01:00:00.000Z',
    relatedPaymentIds: [],
    ...overrides,
  };
}

function makeStrategyMetrics(overrides: Partial<RecoveryStrategyMetrics> = {}): RecoveryStrategyMetrics {
  return {
    strategyKey: { type: 'RETRY', retryDelayBucket: '30_TO_60_MIN', paymentMethod: 'UPI' },
    label: '30–60 min UPI Retry',
    totalAttempts: 10,
    completedAttempts: 8,
    recoveredCount: 6,
    failedCount: 2,
    pendingCount: 0,
    escalatedCount: 0,
    blockedCount: 0,
    recoveryRate: 0.75,
    attemptedRevenueInPaise: 1_000_000,
    recoveredRevenueInPaise: 750_000,
    revenueRecoveryRate: 0.75,
    averageRecoveredRevenueInPaise: 125_000,
    averageRecoveryTimeMinutes: 42,
    performanceStatus: 'LEADING',
    dataSource: 'OBSERVED',
    ...overrides,
  };
}

function makeStrategyAnalytics(overrides: Partial<StrategyAnalyticsResult> = {}): StrategyAnalyticsResult {
  const best = makeStrategyMetrics();
  return {
    strategyMetrics: [best],
    failureReasonPerformance: [],
    paymentMethodPerformance: [],
    customerSegmentPerformance: [],
    experimentPerformance: [],
    messageToneAnalytics: null,
    portfolioSummary: {
      totalAttempts: 10,
      totalCompletedAttempts: 8,
      portfolioRecoveryRate: 0.75,
      totalRecoveredRevenueInPaise: 750_000,
      averageRecoveryTimeMinutes: 42,
      bestRecoveryRateStrategy: best,
      highestRevenueStrategy: best,
      fastestStrategy: best,
      weakestRecoveryRateStrategy: null,
      insufficientDataCount: 0,
      observedCount: 1,
      leadingCount: 1,
    },
    generatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function emptyStrategyAnalytics(): StrategyAnalyticsResult {
  return makeStrategyAnalytics({
    strategyMetrics: [],
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
  });
}

function makeCustomerRecovery(overrides: Partial<CustomerRecoveryPortfolio> = {}): CustomerRecoveryPortfolio {
  return {
    customers: [],
    totalCustomers: 0,
    totalActiveFailedRevenueInPaise: 0,
    totalExpectedRecoverableRevenueInPaise: 0,
    highRecoveryPotentialCount: 0,
    mediumRecoveryPotentialCount: 0,
    lowRecoveryPotentialCount: 0,
    insufficientHistoryCount: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<RecoveryHealthInput> = {}): RecoveryHealthInput {
  return {
    batch: makeBatch(),
    anomalies: [],
    strategyAnalytics: makeStrategyAnalytics(),
    customerRecovery: makeCustomerRecovery(),
    queueItems: [],
    generatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

// ── 1. Component weights total 100% ───────────────────────────────────────────

describe('Component weights', () => {
  it('COMPONENT_WEIGHTS values sum to 1.00', () => {
    const total = Object.values(COMPONENT_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1.00, 10);
  });

  it('COMPONENT_WEIGHTS has exactly 6 entries', () => {
    expect(Object.keys(COMPONENT_WEIGHTS)).toHaveLength(6);
  });
});

// ── 2. Overall score stays between 0–100 ─────────────────────────────────────

describe('Score bounds', () => {
  it('overall score is between 0 and 100 with standard input', () => {
    const result = computeRecoveryHealth(makeInput());
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('overall score is between 0 and 100 with empty portfolio', () => {
    const result = computeRecoveryHealth(makeInput({
      batch: makeBatch({ totalPayments: 0, totalRevenueAtRisk: 0, recoveredPaymentCount: 0, failedRecoveryCount: 0, totalRevenueUnrecoverableInPaise: 0, riskCriticalCount: 0, riskHighCount: 0, riskMediumCount: 0, riskLowCount: 0, forecast: { totalFailedRevenueInPaise: 0, expectedRecoveredRevenueInPaise: 0, expectedUnrecoveredRevenueInPaise: 0, expectedRecoveryRate: 0, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 0, lowConfidenceRecoveryInPaise: 0, forecastConfidence: 'LOW', byHorizon: { next24HoursInPaise: 0, next3DaysInPaise: 0, beyond3DaysInPaise: 0 } } }),
      anomalies: [],
      strategyAnalytics: emptyStrategyAnalytics(),
    }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('component scores are each between 0 and 100', () => {
    const result = computeRecoveryHealth(makeInput());
    for (const c of result.components) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });
});

// ── 3. Recovery Performance component ────────────────────────────────────────

describe('scoreRecoveryPerformance', () => {
  it('returns neutral 50 when no completed attempts', () => {
    const batch = makeBatch({ recoveredPaymentCount: 0, failedRecoveryCount: 0 });
    const c = scoreRecoveryPerformance(batch);
    expect(c.score).toBe(50);
    expect(c.key).toBe('RECOVERY_PERFORMANCE');
    expect(c.reason).toContain('neutral');
  });

  it('returns high score for high recovery rate', () => {
    const batch = makeBatch({ recoveredPaymentCount: 9, failedRecoveryCount: 1 });
    const c = scoreRecoveryPerformance(batch);
    expect(c.score).toBe(90);
  });

  it('returns medium score for 60% recovery rate', () => {
    const batch = makeBatch({ recoveredPaymentCount: 6, failedRecoveryCount: 4 });
    const c = scoreRecoveryPerformance(batch);
    expect(c.score).toBe(60);
  });

  it('returns 100 for 100% recovery rate', () => {
    const batch = makeBatch({ recoveredPaymentCount: 5, failedRecoveryCount: 0 });
    const c = scoreRecoveryPerformance(batch);
    expect(c.score).toBe(100);
  });

  it('reason mentions completed count', () => {
    const batch = makeBatch({ recoveredPaymentCount: 7, failedRecoveryCount: 3 });
    const c = scoreRecoveryPerformance(batch);
    expect(c.reason).toContain('7 of 10');
  });

  it('weight matches centralized constant', () => {
    const batch = makeBatch();
    const c = scoreRecoveryPerformance(batch);
    expect(c.weight).toBe(COMPONENT_WEIGHTS['RECOVERY_PERFORMANCE']);
  });
});

// ── 4. Revenue Risk component ────────────────────────────────────────────────

describe('scoreRevenueRisk', () => {
  it('returns 100 when no failed revenue', () => {
    const batch = makeBatch({ totalRevenueAtRisk: 0, totalRevenueUnrecoverableInPaise: 0 });
    const c = scoreRevenueRisk(batch);
    expect(c.score).toBe(100);
  });

  it('returns high score when risk ratio is low', () => {
    // 10% unrecoverable → riskHealth = 0.90 → 90 base
    const batch = makeBatch({ totalRevenueAtRisk: 1_000_000, totalRevenueUnrecoverableInPaise: 100_000, riskCriticalCount: 0, totalPayments: 10 });
    const c = scoreRevenueRisk(batch);
    expect(c.score).toBe(90);
  });

  it('applies critical concentration penalty', () => {
    // 50% unrecoverable → base 50, and 50% are critical → penalty 10 → score 40
    const batch = makeBatch({ totalRevenueAtRisk: 1_000_000, totalRevenueUnrecoverableInPaise: 500_000, riskCriticalCount: 5, totalPayments: 10 });
    const c = scoreRevenueRisk(batch);
    // base = 50, penalty = round(0.5 * 20) = 10, score = 40
    expect(c.score).toBe(40);
  });

  it('reason mentions unrecoverable revenue', () => {
    const batch = makeBatch({ totalRevenueAtRisk: 1_000_000, totalRevenueUnrecoverableInPaise: 300_000, riskCriticalCount: 1, totalPayments: 10 });
    const c = scoreRevenueRisk(batch);
    expect(c.reason).toContain('at risk');
  });
});

// ── 5. Forecast component ─────────────────────────────────────────────────────

describe('scoreForecast', () => {
  it('returns 100 when no failed revenue in forecast', () => {
    const batch = makeBatch({
      forecast: { totalFailedRevenueInPaise: 0, expectedRecoveredRevenueInPaise: 0, expectedUnrecoveredRevenueInPaise: 0, expectedRecoveryRate: 0, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 0, lowConfidenceRecoveryInPaise: 0, forecastConfidence: 'LOW', byHorizon: { next24HoursInPaise: 0, next3DaysInPaise: 0, beyond3DaysInPaise: 0 } },
    });
    const c = scoreForecast(batch);
    expect(c.score).toBe(100);
  });

  it('adds +10 bonus for HIGH confidence', () => {
    const batch = makeBatch({
      forecast: { totalFailedRevenueInPaise: 500_000, expectedRecoveredRevenueInPaise: 300_000, expectedUnrecoveredRevenueInPaise: 200_000, expectedRecoveryRate: 0.60, highConfidenceRecoveryInPaise: 200_000, mediumConfidenceRecoveryInPaise: 50_000, lowConfidenceRecoveryInPaise: 50_000, forecastConfidence: 'HIGH', byHorizon: { next24HoursInPaise: 100_000, next3DaysInPaise: 100_000, beyond3DaysInPaise: 100_000 } },
    });
    const c = scoreForecast(batch);
    // base = 60, conf = +10, near-term = 100k/300k ≈ 0.33 < 0.5 → 0 bonus = 70
    expect(c.score).toBe(70);
  });

  it('subtracts 10 for LOW confidence', () => {
    const batch = makeBatch({
      forecast: { totalFailedRevenueInPaise: 500_000, expectedRecoveredRevenueInPaise: 300_000, expectedUnrecoveredRevenueInPaise: 200_000, expectedRecoveryRate: 0.60, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 50_000, lowConfidenceRecoveryInPaise: 250_000, forecastConfidence: 'LOW', byHorizon: { next24HoursInPaise: 100_000, next3DaysInPaise: 100_000, beyond3DaysInPaise: 100_000 } },
    });
    const c = scoreForecast(batch);
    // base = 60, conf = -10 = 50, near-term = 0 bonus
    expect(c.score).toBe(50);
  });

  it('adds +5 near-term bonus when >50% expected within 24h', () => {
    const batch = makeBatch({
      forecast: { totalFailedRevenueInPaise: 500_000, expectedRecoveredRevenueInPaise: 300_000, expectedUnrecoveredRevenueInPaise: 200_000, expectedRecoveryRate: 0.60, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 300_000, lowConfidenceRecoveryInPaise: 0, forecastConfidence: 'MEDIUM', byHorizon: { next24HoursInPaise: 200_000, next3DaysInPaise: 50_000, beyond3DaysInPaise: 50_000 } },
    });
    const c = scoreForecast(batch);
    // base = 60, conf = 0, near-term = 200/300 ≈ 0.667 > 0.5 → +5 = 65
    expect(c.score).toBe(65);
  });
});

// ── 6. Anomaly Health component ───────────────────────────────────────────────

describe('scoreAnomalyHealth', () => {
  it('returns 100 when no anomalies', () => {
    const c = scoreAnomalyHealth([]);
    expect(c.score).toBe(100);
    expect(c.key).toBe('ANOMALIES');
  });

  it('returns 85 for a single LOW anomaly', () => {
    const c = scoreAnomalyHealth([makeAnomaly('LOW')]);
    expect(c.score).toBe(85);
  });

  it('returns 65 for a single MEDIUM anomaly', () => {
    const c = scoreAnomalyHealth([makeAnomaly('MEDIUM')]);
    expect(c.score).toBe(65);
  });

  it('returns 40 for a single HIGH anomaly', () => {
    const c = scoreAnomalyHealth([makeAnomaly('HIGH')]);
    expect(c.score).toBe(40);
  });

  it('returns 15 for a single CRITICAL anomaly', () => {
    const c = scoreAnomalyHealth([makeAnomaly('CRITICAL')]);
    expect(c.score).toBe(15);
  });

  it('uses worst severity when multiple anomalies present', () => {
    const c = scoreAnomalyHealth([makeAnomaly('LOW'), makeAnomaly('HIGH'), makeAnomaly('MEDIUM')]);
    // worst is HIGH (40) minus concentration penalty for 3 anomalies (−5) = 35
    expect(c.score).toBe(35);
  });

  it('applies concentration penalty −3 for 2 anomalies', () => {
    const c = scoreAnomalyHealth([makeAnomaly('MEDIUM'), makeAnomaly('MEDIUM', { id: 'anom_2' })]);
    // MEDIUM = 65 − 3 = 62
    expect(c.score).toBe(62);
  });

  it('applies concentration penalty −5 for 3+ anomalies', () => {
    const c = scoreAnomalyHealth([makeAnomaly('LOW'), makeAnomaly('LOW', { id: 'anom_2' }), makeAnomaly('LOW', { id: 'anom_3' })]);
    // LOW = 85 − 5 = 80
    expect(c.score).toBe(80);
  });

  it('reason mentions severity and count', () => {
    const c = scoreAnomalyHealth([makeAnomaly('HIGH')]);
    expect(c.reason).toContain('HIGH');
    expect(c.reason).toContain('1');
  });
});

// ── 7. Strategy Effectiveness component ──────────────────────────────────────

describe('scoreStrategyEffectiveness', () => {
  it('returns 50 when no observed strategies', () => {
    const c = scoreStrategyEffectiveness(emptyStrategyAnalytics());
    expect(c.score).toBe(50);
    expect(c.reason).toContain('Insufficient');
  });

  it('returns 75 when best rate is 0.75', () => {
    const c = scoreStrategyEffectiveness(makeStrategyAnalytics());
    expect(c.score).toBe(75);
  });

  it('returns neutral for INSUFFICIENT_DATA strategies', () => {
    const insufficient = makeStrategyAnalytics({
      strategyMetrics: [makeStrategyMetrics({ performanceStatus: 'INSUFFICIENT_DATA', completedAttempts: 2 })],
      portfolioSummary: {
        totalAttempts: 2,
        totalCompletedAttempts: 2,
        portfolioRecoveryRate: null,
        totalRecoveredRevenueInPaise: 0,
        averageRecoveryTimeMinutes: null,
        bestRecoveryRateStrategy: null,
        highestRevenueStrategy: null,
        fastestStrategy: null,
        weakestRecoveryRateStrategy: null,
        insufficientDataCount: 1,
        observedCount: 0,
        leadingCount: 0,
      },
    });
    const c = scoreStrategyEffectiveness(insufficient);
    expect(c.score).toBe(50);
  });

  it('reason mentions best strategy label', () => {
    const c = scoreStrategyEffectiveness(makeStrategyAnalytics());
    expect(c.reason).toContain('30–60 min UPI Retry');
  });
});

// ── 8. Recovery Velocity component ───────────────────────────────────────────

describe('scoreRecoveryVelocity', () => {
  it('returns 50 when averageRecoveryTimeMinutes is null', () => {
    const analytics = makeStrategyAnalytics({
      portfolioSummary: {
        ...makeStrategyAnalytics().portfolioSummary,
        averageRecoveryTimeMinutes: null,
      },
    });
    const c = scoreRecoveryVelocity(analytics);
    expect(c.score).toBe(50);
  });

  it('returns 90 for average recovery < 60 minutes', () => {
    const analytics = makeStrategyAnalytics({ portfolioSummary: { ...makeStrategyAnalytics().portfolioSummary, averageRecoveryTimeMinutes: 42 } });
    const c = scoreRecoveryVelocity(analytics);
    expect(c.score).toBe(90);
  });

  it('returns 75 for 1–6 hour average recovery', () => {
    const analytics = makeStrategyAnalytics({ portfolioSummary: { ...makeStrategyAnalytics().portfolioSummary, averageRecoveryTimeMinutes: 120 } });
    const c = scoreRecoveryVelocity(analytics);
    expect(c.score).toBe(75);
  });

  it('returns 55 for 6–24 hour average recovery', () => {
    const analytics = makeStrategyAnalytics({ portfolioSummary: { ...makeStrategyAnalytics().portfolioSummary, averageRecoveryTimeMinutes: 720 } });
    const c = scoreRecoveryVelocity(analytics);
    expect(c.score).toBe(55);
  });

  it('returns 35 for 1–3 day average recovery', () => {
    const analytics = makeStrategyAnalytics({ portfolioSummary: { ...makeStrategyAnalytics().portfolioSummary, averageRecoveryTimeMinutes: 2000 } });
    const c = scoreRecoveryVelocity(analytics);
    expect(c.score).toBe(35);
  });

  it('returns 20 for 3+ day average recovery', () => {
    const analytics = makeStrategyAnalytics({ portfolioSummary: { ...makeStrategyAnalytics().portfolioSummary, averageRecoveryTimeMinutes: 6000 } });
    const c = scoreRecoveryVelocity(analytics);
    expect(c.score).toBe(20);
  });
});

// ── 9. Weighted score calculation ─────────────────────────────────────────────

describe('computeWeightedScore', () => {
  it('computes correct weighted sum from known component scores', () => {
    const result = computeRecoveryHealth(makeInput());
    const expectedRaw = result.components.reduce((s, c) => s + c.score * c.weight, 0);
    expect(result.score).toBe(Math.round(expectedRaw));
  });

  it('contribution = round(score × weight) for each component', () => {
    const result = computeRecoveryHealth(makeInput());
    for (const c of result.components) {
      expect(c.contribution).toBe(Math.round(c.score * c.weight));
    }
  });
});

// ── 10. Health status thresholds ──────────────────────────────────────────────

describe('classifyHealthStatus', () => {
  it('score 90+ → EXCELLENT', () => {
    expect(classifyHealthStatus(90)).toBe('EXCELLENT');
    expect(classifyHealthStatus(100)).toBe('EXCELLENT');
  });

  it('score 75–89 → HEALTHY', () => {
    expect(classifyHealthStatus(75)).toBe('HEALTHY');
    expect(classifyHealthStatus(89)).toBe('HEALTHY');
  });

  it('score 55–74 → WATCH', () => {
    expect(classifyHealthStatus(55)).toBe('WATCH');
    expect(classifyHealthStatus(74)).toBe('WATCH');
  });

  it('score 35–54 → AT_RISK', () => {
    expect(classifyHealthStatus(35)).toBe('AT_RISK');
    expect(classifyHealthStatus(54)).toBe('AT_RISK');
  });

  it('score 0–34 → CRITICAL', () => {
    expect(classifyHealthStatus(0)).toBe('CRITICAL');
    expect(classifyHealthStatus(34)).toBe('CRITICAL');
  });

  it('threshold boundaries match HEALTH_STATUS_THRESHOLDS', () => {
    expect(classifyHealthStatus(HEALTH_STATUS_THRESHOLDS.EXCELLENT)).toBe('EXCELLENT');
    expect(classifyHealthStatus(HEALTH_STATUS_THRESHOLDS.HEALTHY)).toBe('HEALTHY');
    expect(classifyHealthStatus(HEALTH_STATUS_THRESHOLDS.WATCH)).toBe('WATCH');
    expect(classifyHealthStatus(HEALTH_STATUS_THRESHOLDS.AT_RISK)).toBe('AT_RISK');
    expect(classifyHealthStatus(HEALTH_STATUS_THRESHOLDS.CRITICAL)).toBe('CRITICAL');
  });
});

// ── 11. Strongest and weakest component selection ────────────────────────────

describe('selectStrongestComponent / selectWeakestComponent', () => {
  it('selects the component with the highest score', () => {
    const result = computeRecoveryHealth(makeInput({ anomalies: [] }));
    const max = Math.max(...result.components.map((c) => c.score));
    expect(result.strongestComponent.score).toBe(max);
  });

  it('selects the component with the lowest score', () => {
    const result = computeRecoveryHealth(makeInput({ anomalies: [makeAnomaly('HIGH')] }));
    const min = Math.min(...result.components.map((c) => c.score));
    expect(result.weakestComponent.score).toBe(min);
  });

  it('deterministic tie-breaking by key name (ascending)', () => {
    // Make all components score 50
    const batchNoCompleted = makeBatch({ recoveredPaymentCount: 0, failedRecoveryCount: 0 });
    const result = computeRecoveryHealth(makeInput({
      batch: batchNoCompleted,
      anomalies: [],
      strategyAnalytics: emptyStrategyAnalytics(),
    }));
    // Tie-break by key name — ANOMALIES < FORECAST < RECOVERY_PERFORMANCE < RECOVERY_VELOCITY < REVENUE_RISK < STRATEGY_EFFECTIVENESS
    // ANOMALIES should win for strongest (it will be 100, not 50 — no anomalies means anomaly score = 100)
    // But let's test a true tie scenario for the weakest among the 50s
    const fifties = result.components.filter((c) => c.score === 50);
    if (fifties.length > 1) {
      const sortedByKey = [...fifties].sort((a, b) => a.key < b.key ? -1 : 1);
      const weak = selectWeakestComponent(fifties);
      expect(weak.key).toBe(sortedByKey[0]!.key);
    }
  });

  it('strongest and weakest are never the same component (with 6 components)', () => {
    const result = computeRecoveryHealth(makeInput({ anomalies: [makeAnomaly('HIGH')] }));
    // Only the same if all scores identical — unlikely with health component variation
    // When ANOMALIES = 40, others > 40, so they differ
    expect(result.strongestComponent.key).not.toBe(result.weakestComponent.key);
  });
});

// ── 12. Main Concern derivation ───────────────────────────────────────────────

describe('deriveMainConcern', () => {
  it('returns CRITICAL anomaly message first', () => {
    const anomalies = [makeAnomaly('CRITICAL'), makeAnomaly('HIGH')];
    const concern = deriveMainConcern(anomalies, makeBatch());
    expect(concern).toBe('CRITICAL anomaly message');
  });

  it('returns HIGH anomaly message when no CRITICAL', () => {
    const anomalies = [makeAnomaly('HIGH')];
    const concern = deriveMainConcern(anomalies, makeBatch());
    expect(concern).toBe('HIGH anomaly message');
  });

  it('returns critical concentration concern when no anomalies and high concentration', () => {
    const batch = makeBatch({ totalPayments: 10, riskCriticalCount: 5, totalRevenueUnrecoverableInPaise: 500_000 });
    const concern = deriveMainConcern([], batch);
    expect(concern).toContain('CRITICAL-risk');
  });

  it('returns poor recovery rate concern when < 40% completion rate', () => {
    const batch = makeBatch({ recoveredPaymentCount: 3, failedRecoveryCount: 10 });
    const concern = deriveMainConcern([], batch);
    expect(concern).toContain('threshold');
  });

  it('returns null when everything is healthy', () => {
    const batch = makeBatch({ riskCriticalCount: 0, recoveredPaymentCount: 8, failedRecoveryCount: 2 });
    const concern = deriveMainConcern([], batch);
    expect(concern).toBeNull();
  });

  it('anomaly concern takes priority over concentration', () => {
    const batch = makeBatch({ totalPayments: 10, riskCriticalCount: 6 });
    const anomalies = [makeAnomaly('HIGH')];
    const concern = deriveMainConcern(anomalies, batch);
    expect(concern).toBe('HIGH anomaly message');
  });
});

// ── 13. Main Opportunity derivation ──────────────────────────────────────────

describe('deriveMainOpportunity', () => {
  it('returns top queue opportunity when queue items exist', () => {
    const queueItems = [
      { recoveryScore: { expectedRecoverableAmountInPaise: 50_000 } } as QueueItem,
      { recoveryScore: { expectedRecoverableAmountInPaise: 40_000 } } as QueueItem,
    ];
    const opp = deriveMainOpportunity(makeBatch(), queueItems, makeStrategyAnalytics(), makeCustomerRecovery());
    expect(opp).toContain('Recovery Queue');
    expect(opp).toContain('expected recovery');
  });

  it('returns forecast opportunity when queue is empty', () => {
    const opp = deriveMainOpportunity(makeBatch(), [], makeStrategyAnalytics(), makeCustomerRecovery());
    // batch.forecast.byHorizon.next24HoursInPaise = 180_000 > 0
    expect(opp).toContain('next 24 hours');
  });

  it('returns null when all sources are empty', () => {
    const batch = makeBatch({ forecast: { totalFailedRevenueInPaise: 0, expectedRecoveredRevenueInPaise: 0, expectedUnrecoveredRevenueInPaise: 0, expectedRecoveryRate: 0, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 0, lowConfidenceRecoveryInPaise: 0, forecastConfidence: 'LOW', byHorizon: { next24HoursInPaise: 0, next3DaysInPaise: 0, beyond3DaysInPaise: 0 } } });
    const opp = deriveMainOpportunity(batch, [], emptyStrategyAnalytics(), makeCustomerRecovery());
    expect(opp).toBeNull();
  });

  it('top queue uses up to 5 items', () => {
    const items: QueueItem[] = Array.from({ length: 10 }, (_, i) => ({
      recoveryScore: { expectedRecoverableAmountInPaise: 10_000 * (10 - i) },
    } as QueueItem));
    const opp = deriveMainOpportunity(makeBatch(), items, makeStrategyAnalytics(), makeCustomerRecovery());
    // top 5 only: 100k+90k+80k+70k+60k = 400k
    expect(opp).toContain('top 5');
  });
});

// ── 14. Executive summary model ──────────────────────────────────────────────

describe('buildRecoveryExecutiveSummary', () => {
  it('actual and forecast values are distinct fields', () => {
    const input = makeInput();
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.actualRecoveredRevenueInPaise).not.toBe(summary.forecastedRecoveryInPaise);
  });

  it('actualRecoveredRevenueInPaise matches batch.totalRecoveredRevenue', () => {
    const input = makeInput({ batch: makeBatch({ totalRecoveredRevenue: 123_456 }) });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.actualRecoveredRevenueInPaise).toBe(123_456);
  });

  it('forecastedRecoveryInPaise matches batch.forecast.expectedRecoveredRevenueInPaise', () => {
    const input = makeInput();
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.forecastedRecoveryInPaise).toBe(input.batch.forecast.expectedRecoveredRevenueInPaise);
  });

  it('actualRecoveryRate uses completed attempts (not total payments)', () => {
    const input = makeInput({ batch: makeBatch({ recoveredPaymentCount: 7, failedRecoveryCount: 3, totalPayments: 15 }) });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.actualRecoveryRate).toBeCloseTo(0.70, 5);
  });

  it('actualRecoveryRate is null when no completed attempts', () => {
    const input = makeInput({ batch: makeBatch({ recoveredPaymentCount: 0, failedRecoveryCount: 0 }) });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.actualRecoveryRate).toBeNull();
  });

  it('forecastRecoveryRate is null when totalFailedRevenue is 0', () => {
    const input = makeInput({ batch: makeBatch({ forecast: { totalFailedRevenueInPaise: 0, expectedRecoveredRevenueInPaise: 0, expectedUnrecoveredRevenueInPaise: 0, expectedRecoveryRate: 0, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 0, lowConfidenceRecoveryInPaise: 0, forecastConfidence: 'LOW', byHorizon: { next24HoursInPaise: 0, next3DaysInPaise: 0, beyond3DaysInPaise: 0 } } }) });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.forecastRecoveryRate).toBeNull();
  });

  it('activeAnomalyCount matches anomalies array length', () => {
    const input = makeInput({ anomalies: [makeAnomaly('HIGH'), makeAnomaly('MEDIUM')] });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.activeAnomalyCount).toBe(2);
  });

  it('topRecoveryOpportunityInPaise is top-5 sum of queue expected recovery', () => {
    const items: QueueItem[] = Array.from({ length: 7 }, (_, i) => ({
      recoveryScore: { expectedRecoverableAmountInPaise: (i + 1) * 10_000 },
    } as QueueItem));
    const input = makeInput({ queueItems: items });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    // top 5: 10k + 20k + 30k + 40k + 50k = 150k
    expect(summary.topRecoveryOpportunityInPaise).toBe(150_000);
  });

  it('bestObservedStrategy reflects Feature 14 label', () => {
    const input = makeInput();
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.bestObservedStrategy).toBe('30–60 min UPI Retry');
  });

  it('bestObservedStrategy is null when no observed strategies', () => {
    const input = makeInput({ strategyAnalytics: emptyStrategyAnalytics() });
    const health = computeRecoveryHealth(input);
    const summary = buildRecoveryExecutiveSummary({ ...input, health });
    expect(summary.bestObservedStrategy).toBeNull();
  });
});

// ── 15. Empty portfolio behavior ──────────────────────────────────────────────

describe('Empty portfolio', () => {
  it('produces a valid health score', () => {
    const emptyBatch = makeBatch({
      totalPayments: 0, totalRevenueAtRisk: 0, totalRecoveredRevenue: 0, recoveryRate: 0,
      recoveredPaymentCount: 0, failedRecoveryCount: 0, pendingPaymentCount: 0,
      escalatedPaymentCount: 0, blockedPaymentCount: 0, totalExpectedRecoverableRevenue: 0,
      totalRevenueUnrecoverableInPaise: 0, riskCriticalCount: 0, riskHighCount: 0,
      riskMediumCount: 0, riskLowCount: 0,
      forecast: { totalFailedRevenueInPaise: 0, expectedRecoveredRevenueInPaise: 0, expectedUnrecoveredRevenueInPaise: 0, expectedRecoveryRate: 0, highConfidenceRecoveryInPaise: 0, mediumConfidenceRecoveryInPaise: 0, lowConfidenceRecoveryInPaise: 0, forecastConfidence: 'LOW', byHorizon: { next24HoursInPaise: 0, next3DaysInPaise: 0, beyond3DaysInPaise: 0 } },
    });
    const result = computeRecoveryHealth(makeInput({ batch: emptyBatch, anomalies: [], strategyAnalytics: emptyStrategyAnalytics() }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.status).toBeDefined();
  });

  it('no-anomaly → anomaly health score 100', () => {
    const result = computeRecoveryHealth(makeInput({ anomalies: [] }));
    const anomalyComponent = result.components.find((c) => c.key === 'ANOMALIES')!;
    expect(anomalyComponent.score).toBe(100);
  });

  it('no strategy history → strategy effectiveness 50', () => {
    const result = computeRecoveryHealth(makeInput({ strategyAnalytics: emptyStrategyAnalytics() }));
    const stratComponent = result.components.find((c) => c.key === 'STRATEGY_EFFECTIVENESS')!;
    expect(stratComponent.score).toBe(50);
  });

  it('no completed outcomes → recovery performance 50', () => {
    const result = computeRecoveryHealth(makeInput({ batch: makeBatch({ recoveredPaymentCount: 0, failedRecoveryCount: 0 }) }));
    const perf = result.components.find((c) => c.key === 'RECOVERY_PERFORMANCE')!;
    expect(perf.score).toBe(50);
  });
});

// ── 16. Deterministic score ───────────────────────────────────────────────────

describe('Determinism', () => {
  it('same input produces the same score twice', () => {
    const input = makeInput({ anomalies: [makeAnomaly('MEDIUM')] });
    const r1 = computeRecoveryHealth(input);
    const r2 = computeRecoveryHealth(input);
    expect(r1.score).toBe(r2.score);
    expect(r1.status).toBe(r2.status);
  });

  it('generatedAt does not affect score', () => {
    const r1 = computeRecoveryHealth(makeInput({ generatedAt: '2026-01-01T00:00:00.000Z' }));
    const r2 = computeRecoveryHealth(makeInput({ generatedAt: '2020-06-15T12:00:00.000Z' }));
    expect(r1.score).toBe(r2.score);
  });
});

// ── 17. Input not mutated ─────────────────────────────────────────────────────

describe('Immutability', () => {
  it('does not mutate input batch or anomalies', () => {
    const input = makeInput({ anomalies: [makeAnomaly('HIGH')] });
    const before = JSON.stringify(input);
    computeRecoveryHealth(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ── 18. Simulation data does not affect health score ─────────────────────────

describe('Simulation isolation', () => {
  it('recoveryHealthEngine does not import simulation types', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/services/recoveryHealth/recoveryHealthEngine.ts'),
      'utf-8',
    );
    expect(source).not.toContain('recoverySimulator');
    expect(source).not.toContain('scenarioPresets');
    expect(source).not.toContain('RecoverySimulationResult');
  });

  it('health score does not include simulation fields', () => {
    const result = computeRecoveryHealth(makeInput());
    expect((result as unknown as Record<string, unknown>)['isSimulationOnly']).toBeUndefined();
    expect((result as unknown as Record<string, unknown>)['scenarioDeltaInPaise']).toBeUndefined();
  });
});

// ── 19. Safety: no executor/audit/policy imports ─────────────────────────────

describe('Safety boundaries', () => {
  it('health engine does not import executor, audit, or policy modules', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/services/recoveryHealth/recoveryHealthEngine.ts'),
      'utf-8',
    );
    // Check that no import-from statements reference these modules (^import at line start)
    expect(source).not.toMatch(/^import.*from '.*executor'/m);
    expect(source).not.toMatch(/^import.*from '.*auditLogger'/m);
    expect(source).not.toMatch(/^import.*from '.*inMemoryAuditStore'/m);
    expect(source).not.toMatch(/^import.*from '.*policyEngine'/m);
    expect(source).not.toMatch(/^import.*from '.*recoverySimulator'/m);
  });
});

// ── 20. Integration: live dashboard data ─────────────────────────────────────

describe('Live dashboard integration', () => {
  it('produces a valid health score with real dashboard data', () => {
    const data = runDashboard();
    const queueItems = buildRecoveryQueue(data.batch.cases).items;
    const result = computeRecoveryHealth({
      batch: data.batch,
      anomalies: data.anomalies,
      strategyAnalytics: data.strategyAnalytics,
      customerRecovery: data.customerRecovery,
      queueItems,
      generatedAt: '2026-09-04T00:00:00.000Z',
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(['EXCELLENT', 'HEALTHY', 'WATCH', 'AT_RISK', 'CRITICAL']).toContain(result.status);
    expect(result.components).toHaveLength(6);
    expect(result.executiveSummary.length).toBeGreaterThan(0);
  });

  it('executiveSummary contains status and score', () => {
    const data = runDashboard();
    const queueItems = buildRecoveryQueue(data.batch.cases).items;
    const result = computeRecoveryHealth({
      batch: data.batch,
      anomalies: data.anomalies,
      strategyAnalytics: data.strategyAnalytics,
      customerRecovery: data.customerRecovery,
      queueItems,
      generatedAt: '2026-09-04T00:00:00.000Z',
    });
    expect(result.executiveSummary).toContain(String(result.score));
    expect(result.executiveSummary).toContain(result.status);
  });

  it('runDashboard() includes recoveryHealth field', () => {
    const data = runDashboard();
    expect(data.recoveryHealth).toBeDefined();
    expect(data.recoveryHealth.health.score).toBeGreaterThanOrEqual(0);
    expect(data.recoveryHealth.health.score).toBeLessThanOrEqual(100);
  });
});

// ── 21. Copilot consumes Feature 16 output ───────────────────────────────────

describe('Copilot integration', () => {
  it('copilot service does not recalculate health score independently', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/services/copilot/copilotService.ts'),
      'utf-8',
    );
    // Copilot should read from data.recoveryHealth, not call computeRecoveryHealth
    expect(source).not.toContain('computeRecoveryHealth(');
  });

  it('RECOVERY_HEALTH intent is in copilot types', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/domain/copilot/types.ts'),
      'utf-8',
    );
    expect(source).toContain('RECOVERY_HEALTH');
  });
});

// ── 22. Executive summary text ────────────────────────────────────────────────

describe('Executive summary text', () => {
  it('contains the status word', () => {
    const result = computeRecoveryHealth(makeInput());
    expect(result.executiveSummary).toContain(result.status);
  });

  it('contains the overall score number', () => {
    const result = computeRecoveryHealth(makeInput());
    expect(result.executiveSummary).toContain(String(result.score));
  });

  it('mentions strongest component label', () => {
    const result = computeRecoveryHealth(makeInput());
    expect(result.executiveSummary).toContain(result.strongestComponent.label);
  });
});
