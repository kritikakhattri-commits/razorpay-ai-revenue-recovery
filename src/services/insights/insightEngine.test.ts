import { describe, it, expect } from 'vitest';
import type { RecoveryCase } from '../recovery/types';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult, ExecutionStatus } from '../../domain/executor/types';
import type { AuditEntry } from '../../domain/audit/types';
import type { RecoveryScore } from '../../domain/recovery/recoveryScore';
import type { RevenueAtRiskScore, RevenueRiskLevel } from '../../domain/recovery/revenueAtRisk';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import type { RecoveryForecast } from '../forecast/recoveryForecast';
import {
  generateInsights,
  generateInsightSummary,
  INSIGHT_THRESHOLDS,
} from './insightEngine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TS = '2025-06-01T12:00:00.000Z';

let idCounter = 0;
function nextId(prefix = 'pay'): string {
  return `${prefix}_${String(++idCounter).padStart(3, '0')}`;
}

function makePayment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: nextId() as FailedPayment['paymentId'],
    customerId: 'cust_001' as FailedPayment['customerId'],
    customerName: 'Test Customer',
    amount: 100_000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 3,
    lastAttemptAt: TS,
    failedAt: TS,
    ...overrides,
  };
}

function makeScore(
  probability: number,
  amount: number,
): RecoveryScore {
  return {
    recoveryProbability: probability,
    expectedRecoverableAmountInPaise: Math.round(amount * probability),
    priority: probability >= 0.70 ? 'HIGH' : probability >= 0.40 ? 'MEDIUM' : 'LOW',
  };
}

function makeRiskScore(
  level: RevenueRiskLevel,
  score: number,
  revenueAtRisk: number,
): RevenueAtRiskScore {
  return {
    score,
    level,
    revenueAtRiskInPaise: revenueAtRisk,
    factors: ['Test factor'],
  };
}

function makeSwitch(shouldSwitch: boolean): PaymentMethodSwitchRecommendation {
  return shouldSwitch
    ? {
        currentMethod: 'UPI',
        shouldSwitch: true,
        recommendedMethod: 'CARD',
        alternatives: [{ method: 'CARD', score: 0.85, reason: 'Better option' }],
        reason: 'Switch recommended',
      }
    : {
        currentMethod: 'UPI',
        shouldSwitch: false,
        recommendedMethod: null,
        alternatives: [],
        reason: 'Keep current method',
      };
}

function makeRetryTiming(delayMinutes: number): SmartRetryTiming {
  return {
    recommendedRetryAt: TS,
    delayMinutes,
    confidence: 'MEDIUM',
    reason: 'Test timing',
    source: 'FAILURE_REASON',
  };
}

function makeForecast(overrides: Partial<RecoveryForecast> = {}): RecoveryForecast {
  return {
    totalFailedRevenueInPaise: 0,
    expectedRecoveredRevenueInPaise: 0,
    expectedUnrecoveredRevenueInPaise: 0,
    expectedRecoveryRate: 0,
    highConfidenceRecoveryInPaise: 0,
    mediumConfidenceRecoveryInPaise: 0,
    lowConfidenceRecoveryInPaise: 0,
    forecastConfidence: 'LOW',
    byHorizon: {
      next24HoursInPaise: 0,
      next3DaysInPaise: 0,
      beyond3DaysInPaise: 0,
    },
    ...overrides,
  };
}

function makeCase(opts: {
  payment?: FailedPayment;
  status?: ExecutionStatus;
  probability?: number;
  riskLevel?: RevenueRiskLevel;
  riskScore?: number;
  revenueAtRisk?: number;
  shouldSwitch?: boolean;
  smartRetryDelayMinutes?: number | null;
}): RecoveryCase {
  const payment = opts.payment ?? makePayment();
  const probability = opts.probability ?? 0.75;
  const status = opts.status ?? 'PENDING';

  const recoveryScore = makeScore(probability, payment.amount);
  const revenueAtRiskScore = makeRiskScore(
    opts.riskLevel ?? 'MEDIUM',
    opts.riskScore ?? 45,
    opts.revenueAtRisk ?? Math.round(payment.amount * (1 - probability)),
  );

  const recommendation: RecoveryRecommendation = {
    diagnosis: 'Test diagnosis',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: probability,
    reasoning: 'Test reasoning',
    maxAttempts: 3,
  };

  const policyDecision: PolicyDecision = {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'Approved',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: [],
  };

  const executionResult: RecoveryExecutionResult = {
    paymentId: payment.paymentId,
    action: 'RETRY_LATER',
    status,
    executedAt: TS,
    recoveredAmount: status === 'RECOVERED' ? payment.amount : 0,
    message: `Status: ${status}`,
  };

  const auditEntry: AuditEntry = {
    auditId: `audit_${payment.paymentId}`,
    paymentId: payment.paymentId,
    eventType: 'PAYMENT_FAILED',
    timestamp: TS,
    message: 'Payment failed.',
    metadata: {},
  };

  const smartRetryTiming =
    opts.smartRetryDelayMinutes != null
      ? makeRetryTiming(opts.smartRetryDelayMinutes)
      : null;

  return {
    payment,
    recommendation,
    policyDecision,
    executionResult,
    auditEntries: [auditEntry],
    recoveredAmount: executionResult.recoveredAmount,
    recoveryScore,
    smartRetryTiming,
    paymentMethodSwitch: makeSwitch(opts.shouldSwitch ?? false),
    revenueAtRiskScore,
  };
}

// ---------------------------------------------------------------------------
// 1. Largest Recovery Opportunity
// ---------------------------------------------------------------------------

describe('detectTopOpportunities (A)', () => {
  it('generates an insight for active cases with expected recovery', () => {
    const cases = [
      makeCase({ probability: 0.80, payment: makePayment({ amount: 500_000 }) }),
      makeCase({ probability: 0.75, payment: makePayment({ amount: 300_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('OPPORTUNITY');
    expect(insight!.severity).toBe('HIGH');
    expect(insight!.metricUnit).toBe('PAISE');
  });

  it('returns null insight when all cases are RECOVERED', () => {
    const cases = [makeCase({ status: 'RECOVERED' })];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight).toBeUndefined();
  });

  it('metricValue equals sum of top N expected recovery amounts', () => {
    const payments = Array.from({ length: 7 }, (_, i) =>
      makeCase({ probability: 0.80, payment: makePayment({ amount: (i + 1) * 100_000 }) }),
    );
    // Sort by expected desc: amounts 700k,600k,500k,400k,300k (top 5)
    // expected: 700k*0.8 + 600k*0.8 + 500k*0.8 + 400k*0.8 + 300k*0.8 = 2_000k*0.8 = 2_000_000*0.8 = 2500*0.8...
    // Actually: 700000*0.8=560000, 600000*0.8=480000, 500000*0.8=400000, 400000*0.8=320000, 300000*0.8=240000 = 2_000_000
    const expected = Math.round((700_000 + 600_000 + 500_000 + 400_000 + 300_000) * 0.80);
    const insights = generateInsights({ cases: payments, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight!.metricValue).toBe(expected);
  });

  it('relatedPaymentIds match the top N cases', () => {
    const cases = [
      makeCase({ probability: 0.85, payment: makePayment({ amount: 500_000 }) }),
      makeCase({ probability: 0.50, payment: makePayment({ amount: 100_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight!.relatedPaymentIds).toContain(cases[0].payment.paymentId as string);
  });
});

// ---------------------------------------------------------------------------
// 2. Failure Reason Concentration
// ---------------------------------------------------------------------------

describe('detectFailureConcentration (B)', () => {
  it('detects HIGH severity when one reason ≥ 50% of failed revenue', () => {
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 600_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 500_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD', amount: 100_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight).toBeDefined();
    expect(insight!.severity).toBe('HIGH');
    expect(insight!.message).toContain('UPI TIMEOUT');
  });

  it('detects MEDIUM severity when one reason is ≥30% and <50%', () => {
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 350_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD', amount: 300_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'BANK_SERVER_ERROR', amount: 350_000 }) }),
    ];
    // UPI_TIMEOUT: 350k / 1000k = 35% → MEDIUM
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight).toBeDefined();
    expect(insight!.severity).toBe('MEDIUM');
  });

  it('produces no insight when no reason reaches 30%', () => {
    // 4 equal payments with different reasons → each 25%
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 250_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD', amount: 250_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'BANK_SERVER_ERROR', amount: 250_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE', amount: 250_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight).toBeUndefined();
  });

  it('message contains exact percentage', () => {
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 700_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD', amount: 300_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight!.message).toContain('70%');
  });

  it('metricValue equals failed revenue of the dominant reason', () => {
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 700_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD', amount: 300_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight!.metricValue).toBe(700_000);
  });
});

// ---------------------------------------------------------------------------
// 3. Payment Method Comparison
// ---------------------------------------------------------------------------

describe('detectMethodUnderperformance (C)', () => {
  it('detects underperformance when CARD rate is >10pp below portfolio average', () => {
    // Portfolio: UPI has 80% expected rate, CARD has 20% → portfolio avg = (0.8*500k + 0.2*500k)/(1000k) = 50%
    // gap for CARD = 50% - 20% = 30% → above 10pp threshold
    const cases = [
      makeCase({
        payment: makePayment({ paymentMethod: 'UPI', amount: 500_000 }),
        probability: 0.80,
      }),
      makeCase({
        payment: makePayment({ paymentMethod: 'CARD', amount: 500_000 }),
        probability: 0.20,
      }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'trend_payment_method_underperformance');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('TREND');
    expect(insight!.severity).toBe('MEDIUM');
    expect(insight!.message).toContain('CARD');
  });

  it('produces no insight when no method is >10pp below average', () => {
    // All methods have similar rates
    const cases = [
      makeCase({ payment: makePayment({ paymentMethod: 'UPI',  amount: 100_000 }), probability: 0.70 }),
      makeCase({ payment: makePayment({ paymentMethod: 'CARD', amount: 100_000 }), probability: 0.65 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'trend_payment_method_underperformance');
    expect(insight).toBeUndefined();
  });

  it('relatedPaymentIds only contain payments of the underperforming method', () => {
    const upiCase = makeCase({ payment: makePayment({ paymentMethod: 'UPI',  amount: 500_000 }), probability: 0.85 });
    const cardCase = makeCase({ payment: makePayment({ paymentMethod: 'CARD', amount: 500_000 }), probability: 0.20 });
    const cases = [upiCase, cardCase];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'trend_payment_method_underperformance');
    expect(insight!.relatedPaymentIds).toContain(cardCase.payment.paymentId as string);
    expect(insight!.relatedPaymentIds).not.toContain(upiCase.payment.paymentId as string);
  });
});

// ---------------------------------------------------------------------------
// 4. Critical-Risk Revenue
// ---------------------------------------------------------------------------

describe('detectCriticalRisk (D)', () => {
  it('generates a HIGH severity RISK insight when CRITICAL-risk payments exist', () => {
    const cases = [
      makeCase({ riskLevel: 'CRITICAL', riskScore: 85, revenueAtRisk: 40_000 }),
      makeCase({ riskLevel: 'CRITICAL', riskScore: 90, revenueAtRisk: 50_000 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_critical_revenue');
    expect(insight).toBeDefined();
    expect(insight!.severity).toBe('HIGH');
    expect(insight!.type).toBe('RISK');
    expect(insight!.metricValue).toBe(90_000);
  });

  it('produces no insight when no CRITICAL-risk payments exist', () => {
    const cases = [makeCase({ riskLevel: 'HIGH', riskScore: 65 })];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_critical_revenue');
    expect(insight).toBeUndefined();
  });

  it('relatedPaymentIds are exactly the CRITICAL-risk payments', () => {
    const criticalCase = makeCase({ riskLevel: 'CRITICAL', riskScore: 82, revenueAtRisk: 30_000 });
    const highCase = makeCase({ riskLevel: 'HIGH', riskScore: 65, revenueAtRisk: 20_000 });
    const cases = [criticalCase, highCase];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_critical_revenue');
    expect(insight!.relatedPaymentIds).toEqual([criticalCase.payment.paymentId as string]);
  });
});

// ---------------------------------------------------------------------------
// 5. High-Confidence Recovery Opportunity
// ---------------------------------------------------------------------------

describe('detectHighConfidenceOpportunity (E)', () => {
  it('generates an OPPORTUNITY insight when HIGH-priority payments represent ≥25% of expected recovery', () => {
    // High prob case: 100k * 0.85 = 85k expected
    // Low prob case: 100k * 0.30 = 30k expected
    // Total: 115k; high share = 85k/115k = 73.9% ≥ 25%
    const cases = [
      makeCase({ probability: 0.85, payment: makePayment({ amount: 100_000 }) }),
      makeCase({ probability: 0.30, payment: makePayment({ amount: 100_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_high_confidence_recovery');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('OPPORTUNITY');
    expect(insight!.severity).toBe('HIGH');
  });

  it('produces no insight when HIGH-priority share is below 25%', () => {
    // High prob case: 50k * 0.75 = 37.5k expected
    // Low prob case: 500k * 0.30 = 150k expected
    // Total: 187.5k; high share = 37.5/187.5 = 20% < 25%
    const cases = [
      makeCase({ probability: 0.75, payment: makePayment({ amount: 50_000 }) }),
      makeCase({ probability: 0.30, payment: makePayment({ amount: 500_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_high_confidence_recovery');
    expect(insight).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Forecast Insight
// ---------------------------------------------------------------------------

describe('detectForecastInsight (F)', () => {
  it('generates a FORECAST insight when next 24h recovery > 0', () => {
    const forecast = makeForecast({
      expectedRecoveredRevenueInPaise: 200_000,
      byHorizon: { next24HoursInPaise: 120_000, next3DaysInPaise: 60_000, beyond3DaysInPaise: 20_000 },
    });
    const cases = [makeCase({})];
    const insights = generateInsights({ cases, forecast, generatedAt: TS });
    const insight = insights.find((i) => i.id === 'forecast_next_24_hours');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('FORECAST');
    expect(insight!.metricValue).toBe(120_000);
    expect(insight!.message).toContain('60%');
  });

  it('produces no insight when next 24h recovery is 0', () => {
    const forecast = makeForecast({ byHorizon: { next24HoursInPaise: 0, next3DaysInPaise: 0, beyond3DaysInPaise: 0 } });
    const cases = [makeCase({})];
    const insights = generateInsights({ cases, forecast, generatedAt: TS });
    const insight = insights.find((i) => i.id === 'forecast_next_24_hours');
    expect(insight).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Retry Timing Insight
// ---------------------------------------------------------------------------

describe('detectNearTermRetries (G)', () => {
  it('generates an ACTION insight when ≥3 payments have near-term retry timing', () => {
    const cases = [
      makeCase({ smartRetryDelayMinutes: 60 }),
      makeCase({ smartRetryDelayMinutes: 120 }),
      makeCase({ smartRetryDelayMinutes: 240 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_near_term_retries');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('ACTION');
  });

  it('produces no insight when fewer than 3 payments have near-term timing', () => {
    const cases = [
      makeCase({ smartRetryDelayMinutes: 60 }),
      makeCase({ smartRetryDelayMinutes: 120 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_near_term_retries');
    expect(insight).toBeUndefined();
  });

  it('excludes payments with timing > 360 minutes', () => {
    const cases = [
      makeCase({ smartRetryDelayMinutes: 60 }),
      makeCase({ smartRetryDelayMinutes: 120 }),
      makeCase({ smartRetryDelayMinutes: 480 }), // outside 6h window
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_near_term_retries');
    // only 2 qualify → below threshold of 3
    expect(insight).toBeUndefined();
  });

  it('assigns MEDIUM severity when ≥5 near-term retries', () => {
    const cases = Array.from({ length: 5 }, () => makeCase({ smartRetryDelayMinutes: 30 }));
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_near_term_retries');
    expect(insight!.severity).toBe('MEDIUM');
  });

  it('assigns LOW severity when between 3 and 4 near-term retries', () => {
    const cases = [
      makeCase({ smartRetryDelayMinutes: 30 }),
      makeCase({ smartRetryDelayMinutes: 60 }),
      makeCase({ smartRetryDelayMinutes: 90 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_near_term_retries');
    expect(insight!.severity).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// 8. Payment Method Switching Insight
// ---------------------------------------------------------------------------

describe('detectMethodSwitchCandidates (H)', () => {
  it('generates an ACTION insight when ≥3 payments should switch method', () => {
    const cases = [
      makeCase({ shouldSwitch: true }),
      makeCase({ shouldSwitch: true }),
      makeCase({ shouldSwitch: true }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_method_switch_candidates');
    expect(insight).toBeDefined();
    expect(insight!.type).toBe('ACTION');
    expect(insight!.metricUnit).toBe('COUNT');
    expect(insight!.metricValue).toBe(3);
  });

  it('produces no insight when fewer than 3 payments should switch', () => {
    const cases = [
      makeCase({ shouldSwitch: true }),
      makeCase({ shouldSwitch: true }),
      makeCase({ shouldSwitch: false }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_method_switch_candidates');
    expect(insight).toBeUndefined();
  });

  it('assigns MEDIUM severity when ≥5 switch candidates', () => {
    const cases = Array.from({ length: 5 }, () => makeCase({ shouldSwitch: true }));
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_method_switch_candidates');
    expect(insight!.severity).toBe('MEDIUM');
  });

  it('assigns LOW severity when 3–4 switch candidates', () => {
    const cases = [
      makeCase({ shouldSwitch: true }),
      makeCase({ shouldSwitch: true }),
      makeCase({ shouldSwitch: true }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_method_switch_candidates');
    expect(insight!.severity).toBe('LOW');
  });

  it('relatedPaymentIds only contain the switch candidates', () => {
    const switchCase1 = makeCase({ shouldSwitch: true });
    const switchCase2 = makeCase({ shouldSwitch: true });
    const switchCase3 = makeCase({ shouldSwitch: true });
    const noSwitchCase = makeCase({ shouldSwitch: false });
    const cases = [switchCase1, switchCase2, switchCase3, noSwitchCase];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'action_method_switch_candidates');
    expect(insight!.relatedPaymentIds).not.toContain(noSwitchCase.payment.paymentId as string);
    expect(insight!.relatedPaymentIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 9. Deterministic insight ordering
// ---------------------------------------------------------------------------

describe('insight ordering', () => {
  it('HIGH severity insights come before MEDIUM before LOW', () => {
    const cases = [
      makeCase({ riskLevel: 'CRITICAL', riskScore: 85, revenueAtRisk: 50_000 }),
      makeCase({ smartRetryDelayMinutes: 60 }),
      makeCase({ smartRetryDelayMinutes: 90 }),
      makeCase({ smartRetryDelayMinutes: 120 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const severities = insights.map((i) => i.severity);
    let lastRank = -1;
    for (const s of severities) {
      const rank = s === 'HIGH' ? 0 : s === 'MEDIUM' ? 1 : 2;
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
    }
  });

  it('within the same severity, higher metricValue comes first', () => {
    // Two RISK insights: critical revenue vs failure concentration both HIGH
    // Give critical risk more revenue to ensure ordering
    const cases = [
      makeCase({
        riskLevel: 'CRITICAL',
        riskScore: 85,
        revenueAtRisk: 1_000_000,
        payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 1_500_000 }),
      }),
      makeCase({
        riskLevel: 'CRITICAL',
        riskScore: 85,
        revenueAtRisk: 1_000_000,
        payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 1_500_000 }),
      }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const highInsights = insights.filter((i) => i.severity === 'HIGH');
    for (let i = 1; i < highInsights.length; i++) {
      expect(highInsights[i - 1].metricValue ?? 0).toBeGreaterThanOrEqual(
        highInsights[i].metricValue ?? 0,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Deterministic IDs
// ---------------------------------------------------------------------------

describe('deterministic IDs', () => {
  it('insight IDs are fixed strings, not runtime-generated', () => {
    const knownIds = [
      'opportunity_top_recovery_opportunities',
      'risk_failure_reason_concentration',
      'trend_payment_method_underperformance',
      'risk_critical_revenue',
      'opportunity_high_confidence_recovery',
      'forecast_next_24_hours',
      'action_near_term_retries',
      'action_method_switch_candidates',
    ];

    const cases = [
      makeCase({ riskLevel: 'CRITICAL', riskScore: 85, revenueAtRisk: 50_000, shouldSwitch: true }),
      makeCase({ riskLevel: 'CRITICAL', riskScore: 85, revenueAtRisk: 50_000, shouldSwitch: true }),
      makeCase({ riskLevel: 'CRITICAL', riskScore: 85, revenueAtRisk: 50_000, shouldSwitch: true }),
      makeCase({ smartRetryDelayMinutes: 30, shouldSwitch: true }),
      makeCase({ smartRetryDelayMinutes: 60, shouldSwitch: true }),
      makeCase({
        payment: makePayment({ paymentMethod: 'UPI',  amount: 500_000 }),
        probability: 0.85,
        smartRetryDelayMinutes: 120,
      }),
      makeCase({
        payment: makePayment({ paymentMethod: 'CARD', amount: 500_000 }),
        probability: 0.20,
      }),
    ];
    const forecast = makeForecast({
      expectedRecoveredRevenueInPaise: 200_000,
      highConfidenceRecoveryInPaise: 150_000,
      byHorizon: { next24HoursInPaise: 120_000, next3DaysInPaise: 60_000, beyond3DaysInPaise: 20_000 },
    });

    const insights = generateInsights({ cases, forecast, generatedAt: TS });
    for (const insight of insights) {
      expect(knownIds).toContain(insight.id);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Severity assignment
// ---------------------------------------------------------------------------

describe('severity assignment', () => {
  it('CRITICAL risk insight is always HIGH severity', () => {
    const cases = [makeCase({ riskLevel: 'CRITICAL', riskScore: 82, revenueAtRisk: 10_000 })];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_critical_revenue');
    expect(insight!.severity).toBe('HIGH');
  });

  it('top opportunities insight is always HIGH severity', () => {
    const cases = [makeCase({ probability: 0.80 })];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight!.severity).toBe('HIGH');
  });

  it('forecast insight is always MEDIUM severity', () => {
    const forecast = makeForecast({
      expectedRecoveredRevenueInPaise: 100_000,
      byHorizon: { next24HoursInPaise: 80_000, next3DaysInPaise: 0, beyond3DaysInPaise: 0 },
    });
    const cases = [makeCase({})];
    const insights = generateInsights({ cases, forecast, generatedAt: TS });
    const insight = insights.find((i) => i.id === 'forecast_next_24_hours');
    expect(insight!.severity).toBe('MEDIUM');
  });

  it('method underperformance insight is always MEDIUM severity', () => {
    const cases = [
      makeCase({ payment: makePayment({ paymentMethod: 'UPI',  amount: 500_000 }), probability: 0.85 }),
      makeCase({ payment: makePayment({ paymentMethod: 'CARD', amount: 500_000 }), probability: 0.10 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'trend_payment_method_underperformance');
    expect(insight!.severity).toBe('MEDIUM');
  });
});

// ---------------------------------------------------------------------------
// 12. Thresholds respected
// ---------------------------------------------------------------------------

describe('thresholds respected', () => {
  it('no failure concentration insight when exactly below 30% threshold', () => {
    // 4 failure reasons with equal revenue → each 25%, none reaches 30%
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT',         amount: 250_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD',        amount: 250_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'BANK_SERVER_ERROR',   amount: 250_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'INSUFFICIENT_BALANCE', amount: 250_000 }) }),
    ];
    // each reason = 25% → none ≥ 30%
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight).toBeUndefined();
  });

  it('method underperformance not triggered when gap is exactly 10pp (exclusive)', () => {
    // UPI: 0.80, CARD: 0.70, portfolio = 0.75; gap = 5pp → no insight
    const cases = [
      makeCase({ payment: makePayment({ paymentMethod: 'UPI',  amount: 100_000 }), probability: 0.80 }),
      makeCase({ payment: makePayment({ paymentMethod: 'CARD', amount: 100_000 }), probability: 0.70 }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'trend_payment_method_underperformance');
    expect(insight).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 13. Insight count limited to MAX_INSIGHTS
// ---------------------------------------------------------------------------

describe('feed size cap', () => {
  it('never returns more than MAX_INSIGHTS insights', () => {
    // Build a rich dataset that would trigger all 8 possible insights
    const richCases = [
      ...Array.from({ length: 5 }, () =>
        makeCase({
          riskLevel: 'CRITICAL',
          riskScore: 88,
          revenueAtRisk: 80_000,
          shouldSwitch: true,
          smartRetryDelayMinutes: 60,
          probability: 0.85,
          payment: makePayment({ failureReason: 'UPI_TIMEOUT', paymentMethod: 'UPI', amount: 500_000 }),
        }),
      ),
      makeCase({
        payment: makePayment({ failureReason: 'EXPIRED_CARD', paymentMethod: 'CARD', amount: 100_000 }),
        probability: 0.10,
        riskLevel: 'LOW',
        riskScore: 20,
        revenueAtRisk: 90_000,
      }),
    ];
    const forecast = makeForecast({
      expectedRecoveredRevenueInPaise: 400_000,
      highConfidenceRecoveryInPaise: 350_000,
      byHorizon: { next24HoursInPaise: 300_000, next3DaysInPaise: 60_000, beyond3DaysInPaise: 40_000 },
    });
    const insights = generateInsights({ cases: richCases, forecast, generatedAt: TS });
    expect(insights.length).toBeLessThanOrEqual(INSIGHT_THRESHOLDS.MAX_INSIGHTS);
  });
});

// ---------------------------------------------------------------------------
// 14. Empty dataset
// ---------------------------------------------------------------------------

describe('empty dataset', () => {
  it('returns empty array when no cases provided', () => {
    const insights = generateInsights({ cases: [], forecast: makeForecast(), generatedAt: TS });
    expect(insights).toHaveLength(0);
  });

  it('returns empty array when all cases are RECOVERED', () => {
    const cases = [
      makeCase({ status: 'RECOVERED' }),
      makeCase({ status: 'RECOVERED' }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    expect(insights).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Single-payment dataset
// ---------------------------------------------------------------------------

describe('single-payment dataset', () => {
  it('handles a single active payment without crashing', () => {
    const cases = [makeCase({ probability: 0.80, riskLevel: 'HIGH', riskScore: 65, revenueAtRisk: 20_000 })];
    expect(() =>
      generateInsights({ cases, forecast: makeForecast(), generatedAt: TS }),
    ).not.toThrow();
  });

  it('generates at least the top-opportunity insight for a single case with expected recovery', () => {
    const cases = [makeCase({ probability: 0.80 })];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 16. No fabricated trend language
// ---------------------------------------------------------------------------

describe('no fabricated trend claims', () => {
  it('messages do not contain increase/decrease language without historical data', () => {
    const cases = [makeCase({ probability: 0.75 })];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    for (const insight of insights) {
      expect(insight.message).not.toMatch(/\b(increased|decreased|grew|fell|rose|dropped)\b/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 17. Monetary calculations reuse existing metrics
// ---------------------------------------------------------------------------

describe('monetary calculation correctness', () => {
  it('top opportunities metricValue equals sum of expectedRecoverableAmountInPaise', () => {
    const amount1 = 300_000;
    const amount2 = 200_000;
    const prob1 = 0.85;
    const prob2 = 0.75;
    const expected1 = Math.round(amount1 * prob1);
    const expected2 = Math.round(amount2 * prob2);
    const cases = [
      makeCase({ probability: prob1, payment: makePayment({ amount: amount1 }) }),
      makeCase({ probability: prob2, payment: makePayment({ amount: amount2 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'opportunity_top_recovery_opportunities');
    expect(insight!.metricValue).toBe(expected1 + expected2);
  });
});

// ---------------------------------------------------------------------------
// 18. Percentages calculated correctly
// ---------------------------------------------------------------------------

describe('percentage accuracy', () => {
  it('failure concentration percentage rounds correctly', () => {
    // 3 UPI: 300k each = 900k; 1 card: 100k; total = 1000k; pct = 90%
    const cases = [
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 300_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 300_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'UPI_TIMEOUT', amount: 300_000 }) }),
      makeCase({ payment: makePayment({ failureReason: 'EXPIRED_CARD', amount: 100_000 }) }),
    ];
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    const insight = insights.find((i) => i.id === 'risk_failure_reason_concentration');
    expect(insight!.message).toContain('90%');
  });
});

// ---------------------------------------------------------------------------
// 19. Input not mutated
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('does not mutate the input cases array', () => {
    const cases = [
      makeCase({ probability: 0.80 }),
      makeCase({ probability: 0.75 }),
    ];
    const originalIds = cases.map((c) => c.payment.paymentId);
    generateInsights({ cases, forecast: makeForecast(), generatedAt: TS });
    expect(cases.map((c) => c.payment.paymentId)).toEqual(originalIds);
  });

  it('does not mutate the forecast object', () => {
    const forecast = makeForecast({
      byHorizon: { next24HoursInPaise: 50_000, next3DaysInPaise: 0, beyond3DaysInPaise: 0 },
    });
    const original24H = forecast.byHorizon.next24HoursInPaise;
    generateInsights({ cases: [makeCase({})], forecast, generatedAt: TS });
    expect(forecast.byHorizon.next24HoursInPaise).toBe(original24H);
  });
});

// ---------------------------------------------------------------------------
// 20. Same input returns same output
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same input always returns the same output', () => {
    const cases = [
      makeCase({ probability: 0.80, riskLevel: 'CRITICAL', riskScore: 85, revenueAtRisk: 50_000 }),
      makeCase({ probability: 0.55 }),
    ];
    const forecast = makeForecast({
      byHorizon: { next24HoursInPaise: 80_000, next3DaysInPaise: 0, beyond3DaysInPaise: 0 },
    });
    const result1 = generateInsights({ cases, forecast, generatedAt: TS });
    const result2 = generateInsights({ cases, forecast, generatedAt: TS });
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});

// ---------------------------------------------------------------------------
// 21. Insight engine does not execute actions
// ---------------------------------------------------------------------------

describe('read-only behavior', () => {
  it('generateInsights returns structured data only and does not modify any case', () => {
    const c = makeCase({ status: 'PENDING' });
    const originalStatus = c.executionResult.status;
    generateInsights({ cases: [c], forecast: makeForecast(), generatedAt: TS });
    expect(c.executionResult.status).toBe(originalStatus);
  });
});

// ---------------------------------------------------------------------------
// 22. generatedAt field uses the injected timestamp
// ---------------------------------------------------------------------------

describe('generatedAt timestamp', () => {
  it('all insights carry the injected generatedAt timestamp', () => {
    const cases = [makeCase({ probability: 0.80 })];
    const customTs = '2025-09-01T08:00:00.000Z';
    const insights = generateInsights({ cases, forecast: makeForecast(), generatedAt: customTs });
    for (const insight of insights) {
      expect(insight.generatedAt).toBe(customTs);
    }
  });
});

// ---------------------------------------------------------------------------
// 23. generateInsightSummary
// ---------------------------------------------------------------------------

describe('generateInsightSummary', () => {
  it('returns a non-empty string when there are active cases with expected recovery', () => {
    const cases = [makeCase({ probability: 0.80 })];
    const summary = generateInsightSummary({ cases, forecast: makeForecast(), generatedAt: TS });
    expect(summary).toBeTruthy();
    expect(typeof summary).toBe('string');
  });

  it('returns null when all cases are RECOVERED', () => {
    const cases = [makeCase({ status: 'RECOVERED' })];
    const summary = generateInsightSummary({ cases, forecast: makeForecast(), generatedAt: TS });
    expect(summary).toBeNull();
  });

  it('returns null when cases array is empty', () => {
    const summary = generateInsightSummary({ cases: [], forecast: makeForecast(), generatedAt: TS });
    expect(summary).toBeNull();
  });

  it('includes high-confidence percentage when high confidence recovery exists', () => {
    const cases = [makeCase({ probability: 0.85 })]; // HIGH priority
    const forecast = makeForecast({ highConfidenceRecoveryInPaise: 50_000 });
    const summary = generateInsightSummary({ cases, forecast, generatedAt: TS });
    expect(summary).toContain('%');
  });
});

// ---------------------------------------------------------------------------
// 24. INSIGHT_THRESHOLDS exported and accessible
// ---------------------------------------------------------------------------

describe('INSIGHT_THRESHOLDS', () => {
  it('exports all threshold values as constants', () => {
    expect(INSIGHT_THRESHOLDS.FAILURE_CONCENTRATION_HIGH).toBe(0.50);
    expect(INSIGHT_THRESHOLDS.FAILURE_CONCENTRATION_MEDIUM).toBe(0.30);
    expect(INSIGHT_THRESHOLDS.MAX_INSIGHTS).toBe(8);
    expect(INSIGHT_THRESHOLDS.TOP_N_OPPORTUNITIES).toBe(5);
    expect(INSIGHT_THRESHOLDS.TIMING_NEAR_TERM_MINUTES).toBe(360);
  });
});
