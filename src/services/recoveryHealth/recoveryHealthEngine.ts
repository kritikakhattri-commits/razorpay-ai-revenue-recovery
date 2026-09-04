// ── Recovery Health Engine ────────────────────────────────────────────────────
//
// Feature 16: Recovery Health Score / Executive Summary
//
// Pure, deterministic aggregation of Features 1–15.
// This file never imports or calls: RecoveryExecutor, PolicyEngine,
// AuditStore, AuditLogger, or any What-If simulation executor.
//
// Formula:
//   overallScore = Σ(componentScore × componentWeight), clamped 0–100
//
// Weights (must sum to 1.00):
//   Recovery Performance   0.30
//   Revenue Risk           0.25
//   Recovery Forecast      0.15
//   Anomaly Health         0.10
//   Strategy Effectiveness 0.10
//   Recovery Velocity      0.10

import type { BatchRecoveryResult } from '../recovery/types';
import type { PaymentFailureAnomaly, AnomalySeverity } from '../../domain/anomaly/types';
import type { StrategyAnalyticsResult } from '../../domain/strategyAnalytics/types';
import type { CustomerRecoveryPortfolio } from '../../domain/customerRecovery/types';
import type { QueueItem } from '../queue/types';
import type {
  RecoveryHealthComponent,
  RecoveryHealthComponentKey,
  RecoveryHealthScore,
  RecoveryHealthStatus,
  RecoveryExecutiveSummary,
} from '../../domain/recoveryHealth/types';
import { formatPaise, formatPercent, formatDelayMinutes } from '../../lib/formatters';

// ── Centralized thresholds ────────────────────────────────────────────────────

export const HEALTH_STATUS_THRESHOLDS: Record<RecoveryHealthStatus, number> = {
  EXCELLENT: 90,
  HEALTHY:   75,
  WATCH:     55,
  AT_RISK:   35,
  CRITICAL:   0,
};

export const COMPONENT_WEIGHTS: Record<RecoveryHealthComponentKey, number> = {
  RECOVERY_PERFORMANCE:   0.30,
  REVENUE_RISK:           0.25,
  FORECAST:               0.15,
  ANOMALIES:              0.10,
  STRATEGY_EFFECTIVENESS: 0.10,
  RECOVERY_VELOCITY:      0.10,
};

const COMPONENT_LABELS: Record<RecoveryHealthComponentKey, string> = {
  RECOVERY_PERFORMANCE:   'Recovery Performance',
  REVENUE_RISK:           'Revenue Risk',
  FORECAST:               'Recovery Forecast',
  ANOMALIES:              'Anomaly Health',
  STRATEGY_EFFECTIVENESS: 'Strategy Effectiveness',
  RECOVERY_VELOCITY:      'Recovery Velocity',
};

// Score for each anomaly severity level (no anomaly → 100).
const ANOMALY_SEVERITY_SCORE: Record<AnomalySeverity, number> = {
  CRITICAL: 15,
  HIGH:     40,
  MEDIUM:   65,
  LOW:      85,
};

// Ordered from worst to best for severity selection.
const SEVERITY_ORDER: readonly AnomalySeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// ── Utility ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function component(
  key: RecoveryHealthComponentKey,
  score: number,
  reason: string,
): RecoveryHealthComponent {
  const clamped = clamp(Math.round(score), 0, 100);
  return {
    key,
    label: COMPONENT_LABELS[key],
    score: clamped,
    weight: COMPONENT_WEIGHTS[key],
    contribution: Math.round(clamped * COMPONENT_WEIGHTS[key]),
    reason,
  };
}

// ── Status classification ─────────────────────────────────────────────────────

export function classifyHealthStatus(score: number): RecoveryHealthStatus {
  if (score >= HEALTH_STATUS_THRESHOLDS.EXCELLENT) return 'EXCELLENT';
  if (score >= HEALTH_STATUS_THRESHOLDS.HEALTHY)   return 'HEALTHY';
  if (score >= HEALTH_STATUS_THRESHOLDS.WATCH)     return 'WATCH';
  if (score >= HEALTH_STATUS_THRESHOLDS.AT_RISK)   return 'AT_RISK';
  return 'CRITICAL';
}

// ── Component: Recovery Performance (weight 0.30) ─────────────────────────────
//
// Uses COMPLETED attempt count (RECOVERED + FAILED execution outcomes only).
// Pending / escalated / blocked are excluded — outcomes are not yet resolved.
// Neutral 50 when no completed attempts exist.

export function scoreRecoveryPerformance(batch: BatchRecoveryResult): RecoveryHealthComponent {
  const completedCount = batch.recoveredPaymentCount + batch.failedRecoveryCount;

  if (completedCount === 0) {
    return component(
      'RECOVERY_PERFORMANCE',
      50,
      'No completed recovery attempts yet — score is neutral pending outcomes.',
    );
  }

  const rate = batch.recoveredPaymentCount / completedCount;
  const pct  = Math.round(rate * 100);

  return component(
    'RECOVERY_PERFORMANCE',
    rate * 100,
    `${pct}% of completed recovery attempts succeeded (${batch.recoveredPaymentCount} of ${completedCount}).`,
  );
}

// ── Component: Revenue Risk (weight 0.25) ─────────────────────────────────────
//
// riskRatio = totalRevenueUnrecoverableInPaise / totalRevenueAtRisk
// riskHealth = 1 − riskRatio  → normalized 0–100
// CRITICAL-risk concentration applies an additional penalty (up to 20 points).

export function scoreRevenueRisk(batch: BatchRecoveryResult): RecoveryHealthComponent {
  if (batch.totalRevenueAtRisk === 0) {
    return component(
      'REVENUE_RISK',
      100,
      'No active failed revenue in the current portfolio.',
    );
  }

  const riskRatio  = batch.totalRevenueUnrecoverableInPaise / batch.totalRevenueAtRisk;
  const baseScore  = (1 - riskRatio) * 100;

  const criticalPenalty = batch.totalPayments > 0
    ? clamp(Math.round((batch.riskCriticalCount / batch.totalPayments) * 20), 0, 20)
    : 0;

  return component(
    'REVENUE_RISK',
    baseScore - criticalPenalty,
    `${formatPaise(batch.totalRevenueUnrecoverableInPaise)} remains at risk across active failed payments (${batch.riskCriticalCount} critical-risk payments).`,
  );
}

// ── Component: Recovery Forecast (weight 0.15) ────────────────────────────────
//
// base     = expectedRecoveryRate × 100
// +10 / ±0 / −10  for HIGH / MEDIUM / LOW forecast confidence
// +5 if > 50% of expected recovery is within next 24 hours

export function scoreForecast(batch: BatchRecoveryResult): RecoveryHealthComponent {
  const { forecast } = batch;

  if (forecast.totalFailedRevenueInPaise === 0) {
    return component(
      'FORECAST',
      100,
      'No active failed revenue — no forward-looking recovery needed.',
    );
  }

  const base   = forecast.expectedRecoveryRate * 100;
  const confBonus  = forecast.forecastConfidence === 'HIGH' ? 10 : forecast.forecastConfidence === 'MEDIUM' ? 0 : -10;
  const nearTermShare = forecast.expectedRecoveredRevenueInPaise > 0
    ? forecast.byHorizon.next24HoursInPaise / forecast.expectedRecoveredRevenueInPaise
    : 0;
  const nearTermBonus = nearTermShare > 0.5 ? 5 : 0;

  return component(
    'FORECAST',
    base + confBonus + nearTermBonus,
    `${formatPaise(forecast.expectedRecoveredRevenueInPaise)} is expected to recover (${formatPercent(forecast.expectedRecoveryRate)} rate, ${forecast.forecastConfidence} confidence).`,
  );
}

// ── Component: Anomaly Health (weight 0.10) ────────────────────────────────────
//
// Score by worst-severity anomaly:
//   CRITICAL → 15   HIGH → 40   MEDIUM → 65   LOW → 85   none → 100
// Modest concentration penalty: −3 for 2 anomalies, −5 for 3+.

export function scoreAnomalyHealth(anomalies: readonly PaymentFailureAnomaly[]): RecoveryHealthComponent {
  if (anomalies.length === 0) {
    return component('ANOMALIES', 100, 'No active payment failure anomalies detected.');
  }

  const worstSeverity = SEVERITY_ORDER.find((sev) => anomalies.some((a) => a.severity === sev)) ?? 'LOW';
  const baseScore = ANOMALY_SEVERITY_SCORE[worstSeverity];
  const concentrationPenalty = anomalies.length > 2 ? 5 : anomalies.length > 1 ? 3 : 0;
  const worstAnomaly = anomalies.find((a) => a.severity === worstSeverity) ?? anomalies[0]!;

  return component(
    'ANOMALIES',
    baseScore - concentrationPenalty,
    `${worstSeverity}-severity anomaly active: ${worstAnomaly.title} (${anomalies.length} total anomaly${anomalies.length !== 1 ? 'ies' : ''}).`,
  );
}

// ── Component: Strategy Effectiveness (weight 0.10) ──────────────────────────
//
// Neutral 50 when no strategy has sufficient completed data (INSUFFICIENT_DATA).
// Otherwise: score = bestRecoveryRate × 100.

export function scoreStrategyEffectiveness(strategyAnalytics: StrategyAnalyticsResult): RecoveryHealthComponent {
  const observed = strategyAnalytics.strategyMetrics.filter(
    (m) => m.performanceStatus !== 'INSUFFICIENT_DATA',
  );

  if (observed.length === 0 || !strategyAnalytics.portfolioSummary.bestRecoveryRateStrategy) {
    return component(
      'STRATEGY_EFFECTIVENESS',
      50,
      'Insufficient completed recovery attempts to assess strategy effectiveness.',
    );
  }

  const best     = strategyAnalytics.portfolioSummary.bestRecoveryRateStrategy;
  const bestRate = best.recoveryRate ?? 0;

  return component(
    'STRATEGY_EFFECTIVENESS',
    bestRate * 100,
    `${best.label} leads with ${formatPercent(bestRate)} observed recovery rate across ${best.completedAttempts} completed attempts.`,
  );
}

// ── Component: Recovery Velocity (weight 0.10) ────────────────────────────────
//
// Based on averageRecoveryTimeMinutes from Feature 14.
// Neutral 50 when no successful recoveries exist (null timing).
//
// Bands:
//   < 60 min  →  90 (excellent)
//   1–6 hr    →  75 (healthy)
//   6–24 hr   →  55 (watch)
//   1–3 days  →  35 (at risk)
//   3+ days   →  20 (poor)

export function scoreRecoveryVelocity(strategyAnalytics: StrategyAnalyticsResult): RecoveryHealthComponent {
  const { averageRecoveryTimeMinutes } = strategyAnalytics.portfolioSummary;

  if (averageRecoveryTimeMinutes === null) {
    return component(
      'RECOVERY_VELOCITY',
      50,
      'No successful recoveries yet to measure velocity — score is neutral.',
    );
  }

  const minutes = averageRecoveryTimeMinutes;

  let score: number;
  let bandLabel: string;

  if (minutes < 60) {
    score = 90; bandLabel = 'under 1 hour';
  } else if (minutes < 360) {
    score = 75; bandLabel = '1–6 hours';
  } else if (minutes < 1440) {
    score = 55; bandLabel = '6–24 hours';
  } else if (minutes < 4320) {
    score = 35; bandLabel = '1–3 days';
  } else {
    score = 20; bandLabel = 'over 3 days';
  }

  return component(
    'RECOVERY_VELOCITY',
    score,
    `Average successful recovery time is ${formatDelayMinutes(Math.round(minutes))} (${bandLabel}).`,
  );
}

// ── Weighted overall score ────────────────────────────────────────────────────

export function computeWeightedScore(components: readonly RecoveryHealthComponent[]): number {
  const raw = components.reduce((sum, c) => sum + c.score * c.weight, 0);
  return clamp(Math.round(raw), 0, 100);
}

// ── Strongest / Weakest component ────────────────────────────────────────────
//
// Deterministic tie-breaking: secondary sort by key name (ascending alphabetical).

export function selectStrongestComponent(
  components: readonly RecoveryHealthComponent[],
): RecoveryHealthComponent {
  return [...components].sort((a, b) => {
    const diff = b.score - a.score;
    return diff !== 0 ? diff : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  })[0]!;
}

export function selectWeakestComponent(
  components: readonly RecoveryHealthComponent[],
): RecoveryHealthComponent {
  return [...components].sort((a, b) => {
    const diff = a.score - b.score;
    return diff !== 0 ? diff : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  })[0]!;
}

// ── Main Concern ─────────────────────────────────────────────────────────────
//
// Ranked priority:
//  1. CRITICAL anomalies
//  2. HIGH anomalies
//  3. CRITICAL-risk revenue concentration > 40%
//  4. Poor actual recovery rate (< 40% of completed attempts)
//  5. Large unresolved risk fraction (> 60% of failed revenue)

export function deriveMainConcern(
  anomalies: readonly PaymentFailureAnomaly[],
  batch: BatchRecoveryResult,
): string | null {
  const criticalAnomaly = anomalies.find((a) => a.severity === 'CRITICAL');
  if (criticalAnomaly) return criticalAnomaly.message;

  const highAnomaly = anomalies.find((a) => a.severity === 'HIGH');
  if (highAnomaly) return highAnomaly.message;

  if (batch.totalPayments > 0 && batch.riskCriticalCount / batch.totalPayments > 0.40) {
    return `${formatPaise(batch.totalRevenueUnrecoverableInPaise)} is concentrated in CRITICAL-risk payments (${batch.riskCriticalCount} of ${batch.totalPayments}).`;
  }

  const completedCount = batch.recoveredPaymentCount + batch.failedRecoveryCount;
  if (completedCount > 0) {
    const completedRate = batch.recoveredPaymentCount / completedCount;
    if (completedRate < 0.40) {
      const pct = Math.round(completedRate * 100);
      return `Only ${pct}% of completed recovery attempts are succeeding — below the 40% operational threshold.`;
    }
  }

  if (
    batch.totalRevenueAtRisk > 0 &&
    batch.totalRevenueUnrecoverableInPaise / batch.totalRevenueAtRisk > 0.60
  ) {
    return `${formatPaise(batch.totalRevenueUnrecoverableInPaise)} remains at risk with limited recovery expected from the current portfolio.`;
  }

  return null;
}

// ── Main Opportunity ─────────────────────────────────────────────────────────
//
// Ranked priority:
//  1. Top 5 Recovery Queue expected recovery
//  2. Near-term (24h) forecast
//  3. Best observed strategy
//  4. High-recovery-potential customer segment

export function deriveMainOpportunity(
  batch: BatchRecoveryResult,
  queueItems: readonly QueueItem[],
  strategyAnalytics: StrategyAnalyticsResult,
  customerRecovery: CustomerRecoveryPortfolio,
): string | null {
  if (queueItems.length > 0) {
    const topN = Math.min(5, queueItems.length);
    const topExpected = queueItems
      .slice(0, topN)
      .reduce((sum, item) => sum + item.recoveryScore.expectedRecoverableAmountInPaise, 0);
    if (topExpected > 0) {
      return `The top ${topN} Recovery Queue item${topN !== 1 ? 's' : ''} represent ${formatPaise(topExpected)} in expected recovery.`;
    }
  }

  if (batch.forecast.byHorizon.next24HoursInPaise > 0) {
    return `${formatPaise(batch.forecast.byHorizon.next24HoursInPaise)} is expected to recover within the next 24 hours.`;
  }

  const best = strategyAnalytics.portfolioSummary.bestRecoveryRateStrategy;
  if (best && best.recoveryRate !== null) {
    return `${best.label} has the highest observed recovery rate at ${formatPercent(best.recoveryRate)}.`;
  }

  if (customerRecovery.highRecoveryPotentialCount > 0) {
    return `${customerRecovery.highRecoveryPotentialCount} high-recovery-potential customer${customerRecovery.highRecoveryPotentialCount !== 1 ? 's' : ''} represent ${formatPaise(customerRecovery.totalExpectedRecoverableRevenueInPaise)} in expected recovery.`;
  }

  return null;
}

// ── Executive summary text ────────────────────────────────────────────────────
//
// Template-driven. Does not call an LLM.

function buildExecutiveSummaryText(
  score: number,
  status: RecoveryHealthStatus,
  strongest: RecoveryHealthComponent,
  weakest: RecoveryHealthComponent,
): string {
  const header = `Recovery health is ${status} at ${score}/100.`;
  const strengthLine = `${strongest.label} is the strongest area (score: ${strongest.score}).`;

  const parts: string[] = [header, strengthLine];

  if (weakest.key !== strongest.key && weakest.score < 60) {
    parts.push(`${weakest.label} is the primary weakness (score: ${weakest.score}).`);
  }

  return parts.join(' ');
}

// ── Public input type ─────────────────────────────────────────────────────────

export interface RecoveryHealthInput {
  readonly batch: BatchRecoveryResult;
  readonly anomalies: readonly PaymentFailureAnomaly[];
  readonly strategyAnalytics: StrategyAnalyticsResult;
  readonly customerRecovery: CustomerRecoveryPortfolio;
  readonly queueItems: readonly QueueItem[];
  // ISO timestamp to stamp the result. Separate from score calculation.
  // Callers inject the current time; tests inject a deterministic value.
  readonly generatedAt?: string;
}

// ── Main exports ──────────────────────────────────────────────────────────────

export function computeRecoveryHealth(input: RecoveryHealthInput): RecoveryHealthScore {
  const { batch, anomalies, strategyAnalytics, customerRecovery, queueItems } = input;
  const generatedAt = input.generatedAt ?? '1970-01-01T00:00:00.000Z';

  const components: RecoveryHealthComponent[] = [
    scoreRecoveryPerformance(batch),
    scoreRevenueRisk(batch),
    scoreForecast(batch),
    scoreAnomalyHealth(anomalies),
    scoreStrategyEffectiveness(strategyAnalytics),
    scoreRecoveryVelocity(strategyAnalytics),
  ];

  const score       = computeWeightedScore(components);
  const status      = classifyHealthStatus(score);
  const strongest   = selectStrongestComponent(components);
  const weakest     = selectWeakestComponent(components);
  const mainConcern = deriveMainConcern(anomalies, batch);
  const mainOpportunity = deriveMainOpportunity(batch, queueItems, strategyAnalytics, customerRecovery);
  const executiveSummary = buildExecutiveSummaryText(score, status, strongest, weakest);

  return {
    score,
    status,
    components,
    strongestComponent: strongest,
    weakestComponent: weakest,
    mainConcern,
    mainOpportunity,
    executiveSummary,
    generatedAt,
  };
}

export function buildRecoveryExecutiveSummary(
  input: RecoveryHealthInput & { readonly health: RecoveryHealthScore },
): RecoveryExecutiveSummary {
  const { batch, anomalies, health, queueItems, strategyAnalytics } = input;

  const completedCount = batch.recoveredPaymentCount + batch.failedRecoveryCount;
  const actualRecoveryRate = completedCount > 0 ? batch.recoveredPaymentCount / completedCount : null;

  const topExpected = queueItems
    .slice(0, 5)
    .reduce((sum, item) => sum + item.recoveryScore.expectedRecoverableAmountInPaise, 0);

  const best = strategyAnalytics.portfolioSummary.bestRecoveryRateStrategy;

  return {
    health,
    actualRecoveredRevenueInPaise: batch.totalRecoveredRevenue,
    activeFailedRevenueInPaise: batch.totalRevenueAtRisk,
    forecastedRecoveryInPaise: batch.forecast.expectedRecoveredRevenueInPaise,
    revenueAtRiskInPaise: batch.totalRevenueUnrecoverableInPaise,
    actualRecoveryRate,
    forecastRecoveryRate: batch.forecast.totalFailedRevenueInPaise > 0 ? batch.forecast.expectedRecoveryRate : null,
    criticalRiskPaymentCount: batch.riskCriticalCount,
    activeAnomalyCount: anomalies.length,
    topRecoveryOpportunityInPaise: topExpected,
    bestObservedStrategy: best?.label ?? null,
    mainConcern: health.mainConcern,
    mainOpportunity: health.mainOpportunity,
  };
}
