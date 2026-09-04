import type { RecoveryCase } from '../recovery/types';
import type { RecoveryForecast } from '../forecast/recoveryForecast';
import type { RevenueInsight, RevenueInsightSeverity } from '../../domain/insights/types';
import type { PaymentFailureAnomaly, AnomalySeverity } from '../../domain/anomaly/types';
import type { ExperimentComparison } from '../../domain/experiment/types';
import type { FailureReason, PaymentMethod } from '../../domain/payments/types';
import type { StrategyAnalyticsResult } from '../../domain/strategyAnalytics/types';
import { formatPaise, formatPercent } from '../../lib/formatters';
import { RECOVERY_PROBABILITY_HIGH } from '../../domain/recovery/recoveryScore';
import { buildRecoveryQueue } from '../queue/recoveryQueue';

export interface InsightEngineInput {
  cases: readonly RecoveryCase[];
  forecast: RecoveryForecast;
  generatedAt?: string;
  // Pre-computed anomalies from the anomaly engine. Passed in to avoid recalculation.
  anomalies?: readonly PaymentFailureAnomaly[];
  // Pre-computed experiment comparisons from the experiment engine.
  experimentComparisons?: readonly ExperimentComparison[];
  // Feature 14: pre-computed strategy analytics. Consumed here, not recalculated.
  strategyAnalytics?: StrategyAnalyticsResult;
}

// ── Thresholds ─────────────────────────────────────────────────────────────────
// All thresholds are centralized here so they can be updated in one place.

export const INSIGHT_THRESHOLDS = {
  // Failure reason concentration: share of failed revenue to trigger an insight
  FAILURE_CONCENTRATION_HIGH:   0.50, // ≥50% → HIGH severity
  FAILURE_CONCENTRATION_MEDIUM: 0.30, // ≥30% → MEDIUM severity

  // Critical-risk: any CRITICAL-risk payment triggers the insight
  CRITICAL_RISK_MIN_COUNT: 1,

  // High-confidence opportunity: share of expected recovery in HIGH-priority payments
  HIGH_CONFIDENCE_OPPORTUNITY_MIN_PCT: 0.25, // ≥25% of expected recovery

  // Payment method underperformance: percentage-point gap vs portfolio average
  METHOD_UNDERPERFORM_GAP: 0.10, // >10 pp below portfolio average

  // Method switching candidates
  SWITCH_CANDIDATE_MEDIUM_MIN: 5, // ≥5 → MEDIUM severity
  SWITCH_CANDIDATE_LOW_MIN:    3, // ≥3 → LOW severity (below 3 → no insight)

  // Near-term retry timing window
  TIMING_NEAR_TERM_MINUTES:    360, // 6 hours
  TIMING_NEAR_TERM_MEDIUM_MIN:   5, // ≥5 near-term retries → MEDIUM severity
  TIMING_NEAR_TERM_LOW_MIN:      3, // ≥3 → LOW severity (below 3 → no insight)

  // Aggregation
  TOP_N_OPPORTUNITIES: 5,
  MAX_INSIGHTS:        8,
} as const;

// ── Ranking helpers ────────────────────────────────────────────────────────────

function severityRank(s: RevenueInsightSeverity): number {
  return s === 'HIGH' ? 0 : s === 'MEDIUM' ? 1 : 2;
}

function rankInsights(insights: RevenueInsight[]): RevenueInsight[] {
  return [...insights].sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    return (b.metricValue ?? 0) - (a.metricValue ?? 0);
  });
}

// ── A: Top Recovery Opportunities ─────────────────────────────────────────────

function detectTopOpportunities(
  activeCases: readonly RecoveryCase[],
  generatedAt: string,
): RevenueInsight | null {
  if (activeCases.length === 0) return null;

  const top = buildRecoveryQueue(activeCases).items.slice(0, INSIGHT_THRESHOLDS.TOP_N_OPPORTUNITIES);
  const totalExpected = top.reduce(
    (s, item) => s + item.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );

  if (totalExpected === 0) return null;

  const n = top.length;
  const relatedPaymentIds = top.map((item) => item.paymentId as string);

  return {
    id: 'opportunity_top_recovery_opportunities',
    type: 'OPPORTUNITY',
    severity: 'HIGH',
    title: `Top ${n} recovery ${n === 1 ? 'opportunity' : 'opportunities'}`,
    message: `The top ${n} recovery ${n === 1 ? 'opportunity represents' : 'opportunities represent'} ${formatPaise(totalExpected)} in expected recovery.`,
    metricValue: totalExpected,
    metricUnit: 'PAISE',
    relatedPaymentIds,
    generatedAt,
  };
}

// ── B: Failure Reason Concentration ───────────────────────────────────────────

function detectFailureConcentration(
  activeCases: readonly RecoveryCase[],
  generatedAt: string,
): RevenueInsight | null {
  if (activeCases.length === 0) return null;

  const totalFailed = activeCases.reduce((s, c) => s + c.payment.amount, 0);
  if (totalFailed === 0) return null;

  const byReason = new Map<FailureReason, { count: number; revenue: number; ids: string[] }>();
  for (const c of activeCases) {
    const r = c.payment.failureReason;
    const existing = byReason.get(r) ?? { count: 0, revenue: 0, ids: [] };
    byReason.set(r, {
      count: existing.count + 1,
      revenue: existing.revenue + c.payment.amount,
      ids: [...existing.ids, c.payment.paymentId as string],
    });
  }

  // Dominant failure reason by failed revenue
  let topReason: FailureReason | null = null;
  let topEntry = { count: 0, revenue: 0, ids: [] as string[] };
  for (const [reason, entry] of byReason) {
    if (entry.revenue > topEntry.revenue) {
      topReason = reason;
      topEntry = entry;
    }
  }

  if (!topReason) return null;

  const pct = topEntry.revenue / totalFailed;

  let severity: RevenueInsightSeverity;
  if (pct >= INSIGHT_THRESHOLDS.FAILURE_CONCENTRATION_HIGH) {
    severity = 'HIGH';
  } else if (pct >= INSIGHT_THRESHOLDS.FAILURE_CONCENTRATION_MEDIUM) {
    severity = 'MEDIUM';
  } else {
    return null;
  }

  const pctDisplay = `${Math.round(pct * 100)}%`;
  const countDisplay = `${topEntry.count} payment${topEntry.count !== 1 ? 's' : ''}`;

  return {
    id: 'risk_failure_reason_concentration',
    type: 'RISK',
    severity,
    title: 'Largest current failure category',
    message: `${topReason.replace(/_/g, ' ')} accounts for ${pctDisplay} of active failed payments (${countDisplay}) and ${formatPaise(topEntry.revenue)} in failed revenue.`,
    metricValue: topEntry.revenue,
    metricUnit: 'PAISE',
    relatedPaymentIds: topEntry.ids,
    generatedAt,
  };
}

// ── C: Payment Method Performance ─────────────────────────────────────────────

function detectMethodUnderperformance(
  activeCases: readonly RecoveryCase[],
  generatedAt: string,
): RevenueInsight | null {
  if (activeCases.length === 0) return null;

  const totalFailed = activeCases.reduce((s, c) => s + c.payment.amount, 0);
  const totalExpected = activeCases.reduce(
    (s, c) => s + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );
  if (totalFailed === 0 || totalExpected === 0) return null;

  const portfolioRate = totalExpected / totalFailed;

  const byMethod = new Map<PaymentMethod, { failed: number; expected: number; ids: string[] }>();
  for (const c of activeCases) {
    const m = c.payment.paymentMethod;
    const existing = byMethod.get(m) ?? { failed: 0, expected: 0, ids: [] };
    byMethod.set(m, {
      failed: existing.failed + c.payment.amount,
      expected: existing.expected + c.recoveryScore.expectedRecoverableAmountInPaise,
      ids: [...existing.ids, c.payment.paymentId as string],
    });
  }

  // Find the worst underperforming method (highest gap, meeting threshold)
  let worstMethod: PaymentMethod | null = null;
  let worstRate = Infinity;
  let worstIds: string[] = [];

  for (const [method, entry] of byMethod) {
    if (entry.failed === 0) continue;
    const rate = entry.expected / entry.failed;
    const gap = portfolioRate - rate;
    if (gap >= INSIGHT_THRESHOLDS.METHOD_UNDERPERFORM_GAP && rate < worstRate) {
      worstRate = rate;
      worstMethod = method;
      worstIds = entry.ids;
    }
  }

  if (!worstMethod) return null;

  return {
    id: 'trend_payment_method_underperformance',
    type: 'TREND',
    severity: 'MEDIUM',
    title: 'Payment method underperformance',
    message: `${worstMethod} failures currently have an expected recovery rate of ${formatPercent(worstRate)}, below the portfolio average of ${formatPercent(portfolioRate)}.`,
    metricValue: worstRate,
    metricUnit: 'PERCENT',
    relatedPaymentIds: worstIds,
    generatedAt,
  };
}

// ── D: High-Risk Revenue ───────────────────────────────────────────────────────

function detectCriticalRisk(
  activeCases: readonly RecoveryCase[],
  generatedAt: string,
): RevenueInsight | null {
  const criticalCases = activeCases.filter((c) => c.revenueAtRiskScore.level === 'CRITICAL');
  if (criticalCases.length < INSIGHT_THRESHOLDS.CRITICAL_RISK_MIN_COUNT) return null;

  const totalAtRisk = criticalCases.reduce(
    (s, c) => s + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const n = criticalCases.length;

  return {
    id: 'risk_critical_revenue',
    type: 'RISK',
    severity: 'HIGH',
    title: 'Critical revenue at risk',
    message: `${n} CRITICAL-risk payment${n !== 1 ? 's' : ''} represent${n === 1 ? 's' : ''} ${formatPaise(totalAtRisk)} of revenue at risk.`,
    metricValue: totalAtRisk,
    metricUnit: 'PAISE',
    relatedPaymentIds: criticalCases.map((c) => c.payment.paymentId as string),
    generatedAt,
  };
}

// ── E: High-Confidence Recovery Opportunity ────────────────────────────────────

function detectHighConfidenceOpportunity(
  activeCases: readonly RecoveryCase[],
  totalExpectedRecovery: number,
  generatedAt: string,
): RevenueInsight | null {
  const highCases = activeCases.filter(
    (c) => c.recoveryScore.recoveryProbability >= RECOVERY_PROBABILITY_HIGH,
  );
  if (highCases.length === 0) return null;

  const highExpected = highCases.reduce(
    (s, c) => s + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );
  if (highExpected === 0) return null;

  if (totalExpectedRecovery > 0) {
    const pct = highExpected / totalExpectedRecovery;
    if (pct < INSIGHT_THRESHOLDS.HIGH_CONFIDENCE_OPPORTUNITY_MIN_PCT) return null;
  }

  const n = highCases.length;

  return {
    id: 'opportunity_high_confidence_recovery',
    type: 'OPPORTUNITY',
    severity: 'HIGH',
    title: 'High-confidence recovery opportunity',
    message: `${n} HIGH-priority payment${n !== 1 ? 's' : ''} represent${n === 1 ? 's' : ''} ${formatPaise(highExpected)} in expected recovery.`,
    metricValue: highExpected,
    metricUnit: 'PAISE',
    relatedPaymentIds: highCases.map((c) => c.payment.paymentId as string),
    generatedAt,
  };
}

// ── F: Forecast Insight ────────────────────────────────────────────────────────

function detectForecastInsight(
  forecast: RecoveryForecast,
  generatedAt: string,
): RevenueInsight | null {
  const next24H = forecast.byHorizon.next24HoursInPaise;
  if (next24H === 0) return null;

  const total = forecast.expectedRecoveredRevenueInPaise;
  const pct = total > 0 ? next24H / total : 0;
  const pctDisplay = `${Math.round(pct * 100)}%`;

  return {
    id: 'forecast_next_24_hours',
    type: 'FORECAST',
    severity: 'MEDIUM',
    title: 'Near-term recovery forecast',
    message: `${formatPaise(next24H)} of expected recovery (${pctDisplay} of forecast total) is scheduled within the next 24 hours.`,
    metricValue: next24H,
    metricUnit: 'PAISE',
    generatedAt,
  };
}

// ── G: Near-Term Retry Timing ──────────────────────────────────────────────────

function detectNearTermRetries(
  activeCases: readonly RecoveryCase[],
  generatedAt: string,
): RevenueInsight | null {
  const nearTerm = activeCases.filter(
    (c) =>
      c.smartRetryTiming !== null &&
      c.smartRetryTiming.delayMinutes <= INSIGHT_THRESHOLDS.TIMING_NEAR_TERM_MINUTES,
  );

  if (nearTerm.length < INSIGHT_THRESHOLDS.TIMING_NEAR_TERM_LOW_MIN) return null;

  const severity: RevenueInsightSeverity =
    nearTerm.length >= INSIGHT_THRESHOLDS.TIMING_NEAR_TERM_MEDIUM_MIN ? 'MEDIUM' : 'LOW';

  const n = nearTerm.length;
  const totalExpected = nearTerm.reduce(
    (s, c) => s + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );

  return {
    id: 'action_near_term_retries',
    type: 'ACTION',
    severity,
    title: 'Near-term retry opportunities',
    message: `${n} payment${n !== 1 ? 's' : ''} ${n === 1 ? 'is' : 'are'} scheduled for retry within the next 6 hours, representing ${formatPaise(totalExpected)} in expected recovery.`,
    metricValue: totalExpected,
    metricUnit: 'PAISE',
    relatedPaymentIds: nearTerm.map((c) => c.payment.paymentId as string),
    generatedAt,
  };
}

// ── H: Payment Method Switching ────────────────────────────────────────────────

function detectMethodSwitchCandidates(
  activeCases: readonly RecoveryCase[],
  generatedAt: string,
): RevenueInsight | null {
  const switchCandidates = activeCases.filter((c) => c.paymentMethodSwitch.shouldSwitch);

  if (switchCandidates.length < INSIGHT_THRESHOLDS.SWITCH_CANDIDATE_LOW_MIN) return null;

  const severity: RevenueInsightSeverity =
    switchCandidates.length >= INSIGHT_THRESHOLDS.SWITCH_CANDIDATE_MEDIUM_MIN ? 'MEDIUM' : 'LOW';

  const n = switchCandidates.length;

  return {
    id: 'action_method_switch_candidates',
    type: 'ACTION',
    severity,
    title: 'Payment method switching recommended',
    message: `${n} payment${n !== 1 ? 's' : ''} ${n === 1 ? 'is' : 'are'} better suited to an alternative payment method than another same-method retry.`,
    metricValue: n,
    metricUnit: 'COUNT',
    relatedPaymentIds: switchCandidates.map((c) => c.payment.paymentId as string),
    generatedAt,
  };
}

// ── Anomaly-derived insight (Feature 8 integration) ───────────────────────────
//
// Converts the top pre-computed anomaly into a RevenueInsight.
// The anomaly engine is the single source of truth — no recalculation here.

const ANOMALY_SEVERITY_MAP: Record<AnomalySeverity, RevenueInsightSeverity> = {
  CRITICAL: 'HIGH',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
};

function detectAnomalyInsight(
  anomalies: readonly PaymentFailureAnomaly[],
  generatedAt: string,
): RevenueInsight | null {
  if (anomalies.length === 0) return null;
  const top = anomalies[0];
  return {
    id: `anomaly_alert_${top.id}`,
    type: 'RISK',
    severity: ANOMALY_SEVERITY_MAP[top.severity],
    title: top.title,
    message: top.message,
    metricValue: top.affectedRevenueInPaise,
    metricUnit: 'PAISE',
    relatedPaymentIds: top.relatedPaymentIds,
    generatedAt,
  };
}

// ── I: Experiment-derived insight ─────────────────────────────────────────────
//
// Surfaces the first comparison that has declared a leading variant.
// Reads from pre-computed comparisons — never recalculates.

function detectExperimentInsight(
  comparisons: readonly ExperimentComparison[],
  generatedAt: string,
): RevenueInsight | null {
  const leading = comparisons.find(
    (c) => c.status === 'A_LEADING' || c.status === 'B_LEADING',
  );
  if (!leading) return null;

  const winner = leading.leadingVariantId!;
  const metrics = winner === 'A' ? leading.variantA : leading.variantB;
  const loser   = winner === 'A' ? leading.variantB : leading.variantA;

  const rateDiffPp = Math.abs(Math.round(leading.recoveryRateDifference * 100));

  return {
    id: `experiment_leading_variant_${leading.experimentId}`,
    type: 'OPPORTUNITY',
    severity: 'MEDIUM',
    title: `Experiment ${leading.experimentId}: Variant ${winner} leading`,
    message:
      `Variant ${winner} (${metrics.variantName}) has a ${formatPercent(metrics.recoveryRate)} recovery rate ` +
      `vs ${formatPercent(loser.recoveryRate)} for Variant ${winner === 'A' ? 'B' : 'A'} — ` +
      `a ${rateDiffPp}pp difference across ${metrics.completedCount + loser.completedCount} completed payments.`,
    metricValue: Math.abs(leading.recoveredRevenueDifferenceInPaise),
    metricUnit: 'PAISE',
    generatedAt,
  };
}

// ── J: Strategy Analytics insight (Feature 14 integration) ────────────────────
//
// Surfaces the leading strategy from Feature 14 output.
// No calculations are performed here — only consumption of pre-computed results.

function detectStrategyAnalyticsInsight(
  strategyAnalytics: StrategyAnalyticsResult | undefined,
  generatedAt: string,
): RevenueInsight | null {
  if (!strategyAnalytics) return null;
  const { bestRecoveryRateStrategy } = strategyAnalytics.portfolioSummary;
  if (!bestRecoveryRateStrategy || bestRecoveryRateStrategy.performanceStatus === 'INSUFFICIENT_DATA') {
    return null;
  }
  const rate = bestRecoveryRateStrategy.recoveryRate;
  if (rate === null) return null;
  const completed = bestRecoveryRateStrategy.completedAttempts;
  const revenue = bestRecoveryRateStrategy.recoveredRevenueInPaise;
  return {
    id: `strategy_leading_${bestRecoveryRateStrategy.label.replace(/\s+/g, '_').toLowerCase()}`,
    type: 'OPPORTUNITY',
    severity: 'MEDIUM',
    title: 'Leading recovery strategy',
    message:
      `${bestRecoveryRateStrategy.label} currently has the highest observed recovery rate ` +
      `at ${formatPercent(rate)} across ${completed} completed attempt${completed !== 1 ? 's' : ''}, ` +
      `recovering ${formatPaise(revenue)}.`,
    metricValue: revenue,
    metricUnit: 'PAISE',
    generatedAt,
  };
}

// ── Summary sentence (Step 16) ─────────────────────────────────────────────────

export function generateInsightSummary(input: InsightEngineInput): string | null {
  const activeCases = input.cases.filter((c) => c.executionResult.status !== 'RECOVERED');
  if (activeCases.length === 0) return null;

  const totalExpected = activeCases.reduce(
    (s, c) => s + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );
  if (totalExpected === 0) return null;

  const n = activeCases.length;
  const highPct =
    input.forecast.highConfidenceRecoveryInPaise > 0 && totalExpected > 0
      ? ` — ${Math.round((input.forecast.highConfidenceRecoveryInPaise / totalExpected) * 100)}% is high-confidence`
      : '';

  return `${formatPaise(totalExpected)} is forecast to recover across ${n} active failed payment${n !== 1 ? 's' : ''}${highPct}.`;
}

// ── Main Engine ────────────────────────────────────────────────────────────────

export function generateInsights(input: InsightEngineInput): RevenueInsight[] {
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  // Active cases: RECOVERED payments are already secured and excluded from the forward-looking feed.
  const activeCases = input.cases.filter((c) => c.executionResult.status !== 'RECOVERED');

  if (activeCases.length === 0) return [];

  const totalExpectedRecovery = activeCases.reduce(
    (s, c) => s + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );

  const candidates: Array<RevenueInsight | null> = [
    detectAnomalyInsight(input.anomalies ?? [], generatedAt),
    detectExperimentInsight(input.experimentComparisons ?? [], generatedAt),
    detectStrategyAnalyticsInsight(input.strategyAnalytics, generatedAt),
    detectCriticalRisk(activeCases, generatedAt),
    detectTopOpportunities(activeCases, generatedAt),
    detectHighConfidenceOpportunity(activeCases, totalExpectedRecovery, generatedAt),
    detectFailureConcentration(activeCases, generatedAt),
    detectMethodUnderperformance(activeCases, generatedAt),
    detectForecastInsight(input.forecast, generatedAt),
    detectNearTermRetries(activeCases, generatedAt),
    detectMethodSwitchCandidates(activeCases, generatedAt),
  ];

  const insights = candidates.filter((i): i is RevenueInsight => i !== null);
  return rankInsights(insights).slice(0, INSIGHT_THRESHOLDS.MAX_INSIGHTS);
}
