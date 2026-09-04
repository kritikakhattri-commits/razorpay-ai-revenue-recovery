// ── Recovery Health Score — domain types ─────────────────────────────────────
//
// Feature 16: Recovery Health Score / Executive Summary
//
// These types are read-only analytics. They never drive or modify recovery
// actions, policy rules, audit entries, or experiment assignments.

export type RecoveryHealthStatus =
  | 'EXCELLENT'
  | 'HEALTHY'
  | 'WATCH'
  | 'AT_RISK'
  | 'CRITICAL';

export type RecoveryHealthComponentKey =
  | 'RECOVERY_PERFORMANCE'
  | 'REVENUE_RISK'
  | 'FORECAST'
  | 'ANOMALIES'
  | 'STRATEGY_EFFECTIVENESS'
  | 'RECOVERY_VELOCITY';

// A single weighted health dimension.
export interface RecoveryHealthComponent {
  readonly key: RecoveryHealthComponentKey;
  readonly label: string;
  // Normalized 0–100 score for this dimension.
  readonly score: number;
  // Fractional weight, e.g. 0.30. All weights sum to 1.00.
  readonly weight: number;
  // Math.round(score × weight) — pre-computed contribution to the total.
  readonly contribution: number;
  // Deterministic, human-readable explanation of this component's score.
  readonly reason: string;
}

// The composite Recovery Health Score.
export interface RecoveryHealthScore {
  // Weighted sum of all component scores, clamped to 0–100.
  readonly score: number;
  readonly status: RecoveryHealthStatus;
  readonly components: readonly RecoveryHealthComponent[];
  // Component with the highest score (deterministic tie-breaking by key name).
  readonly strongestComponent: RecoveryHealthComponent;
  // Component with the lowest score (deterministic tie-breaking by key name).
  readonly weakestComponent: RecoveryHealthComponent;
  // Primary concern derived from the portfolio state. null if none.
  readonly mainConcern: string | null;
  // Primary recovery opportunity derived from the portfolio state. null if none.
  readonly mainOpportunity: string | null;
  // Deterministic executive summary sentence(s), template-driven.
  readonly executiveSummary: string;
  // ISO timestamp injected by the caller — separate from score calculation.
  readonly generatedAt: string;
}

// Read-only executive summary combining health score with key portfolio metrics.
export interface RecoveryExecutiveSummary {
  readonly health: RecoveryHealthScore;
  // Actual revenue recovered (already secured).
  readonly actualRecoveredRevenueInPaise: number;
  // Total failed revenue across all active cases.
  readonly activeFailedRevenueInPaise: number;
  // Forecasted recoverable revenue (forward-looking; not actual).
  readonly forecastedRecoveryInPaise: number;
  // Revenue estimated unrecoverable (at risk of permanent loss).
  readonly revenueAtRiskInPaise: number;
  // Actual rate: recoveredPaymentCount / (recovered + failed). null if no completed attempts.
  readonly actualRecoveryRate: number | null;
  // Forecasted rate from Feature 6. null if no failed revenue.
  readonly forecastRecoveryRate: number | null;
  readonly criticalRiskPaymentCount: number;
  readonly activeAnomalyCount: number;
  // Sum of expected recovery for the top 5 queue items.
  readonly topRecoveryOpportunityInPaise: number;
  // Label of the best observed strategy from Feature 14. null if insufficient data.
  readonly bestObservedStrategy: string | null;
  readonly mainConcern: string | null;
  readonly mainOpportunity: string | null;
}
