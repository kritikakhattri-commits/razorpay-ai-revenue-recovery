export type ExperimentStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'COMPLETED';

export type ExperimentDimension = 'RETRY_TIMING' | 'MESSAGE_TONE';

export type ExperimentVariantId = 'A' | 'B';

// ── Strategy union ────────────────────────────────────────────────────────────

export interface RetryTimingStrategy {
  readonly dimension: 'RETRY_TIMING';
  readonly retryDelayMinutes: number;
}

export interface MessageToneStrategy {
  readonly dimension: 'MESSAGE_TONE';
  readonly tone: 'NEUTRAL' | 'FRIENDLY';
}

export type ExperimentVariantStrategy = RetryTimingStrategy | MessageToneStrategy;

// ── Variant and Experiment ─────────────────────────────────────────────────────

export interface RecoveryStrategyVariant {
  readonly id: ExperimentVariantId;
  readonly name: string;
  readonly description: string;
  readonly strategy: ExperimentVariantStrategy;
}

export interface RecoveryExperiment {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: ExperimentStatus;
  readonly dimension: ExperimentDimension;
  readonly variantA: RecoveryStrategyVariant;
  readonly variantB: RecoveryStrategyVariant;
  // Must sum to 100.
  readonly allocationPercent: { readonly a: number; readonly b: number };
  readonly startedAt?: string;
  readonly endedAt?: string;
}

// ── Assignment ─────────────────────────────────────────────────────────────────
//
// Assignment is customer-level: same customerId + experimentId → same variant.
// This prevents the same customer from experiencing inconsistent strategies
// across multiple failed payments within one experiment window.

export interface ExperimentAssignment {
  readonly experimentId: string;
  readonly variantId: ExperimentVariantId;
  readonly assignedEntityId: string; // customerId
  readonly bucket: number;           // 0–99, for transparency / debugging
}

// ── Outcome ───────────────────────────────────────────────────────────────────

export type ExperimentOutcomeStatus =
  | 'RECOVERED'
  | 'FAILED'
  | 'PENDING'
  | 'ESCALATED'
  | 'BLOCKED';

export interface ExperimentOutcome {
  readonly experimentId: string;
  readonly variantId: ExperimentVariantId;
  readonly paymentId: string;
  readonly customerId: string;
  readonly status: ExperimentOutcomeStatus;
  readonly failedAmountInPaise: number;
  readonly recoveredAmountInPaise: number;
  // Minutes between payment.failedAt and executionResult.executedAt. Null unless RECOVERED.
  readonly recoveryTimeMinutes: number | null;
  // For RETRY_TIMING experiments: the delay the variant suggested (candidate, not policy-enforced).
  readonly candidateRetryDelayMinutes: number | null;
  // The delay PolicyEngine actually approved (from PolicyDecision.approvedRetryAfterMinutes).
  readonly policyApprovedRetryDelayMinutes: number | null;
  readonly assignedAt: string;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface VariantMetrics {
  readonly variantId: ExperimentVariantId;
  readonly variantName: string;
  readonly assignedCount: number;
  // PENDING is NOT counted as completed (it is still in-flight).
  readonly completedCount: number;
  readonly recoveredCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
  readonly escalatedCount: number;
  readonly blockedCount: number;
  // recoveredCount / completedCount. 0 when completedCount === 0.
  readonly recoveryRate: number;
  readonly recoveredRevenueInPaise: number;
  // recoveredRevenueInPaise / recoveredCount. 0 when recoveredCount === 0.
  readonly avgRecoveredRevenuePerPaymentInPaise: number;
  // Average minutes from failedAt to executedAt for RECOVERED cases. null if no RECOVERED cases.
  readonly avgRecoveryTimeMinutes: number | null;
}

// ── Comparison ────────────────────────────────────────────────────────────────

export interface ExperimentComparison {
  readonly experimentId: string;
  readonly variantA: VariantMetrics;
  readonly variantB: VariantMetrics;
  // variantA.recoveryRate − variantB.recoveryRate (positive = A better)
  readonly recoveryRateDifference: number;
  // variantA.recoveredRevenueInPaise − variantB.recoveredRevenueInPaise
  readonly recoveredRevenueDifferenceInPaise: number;
  readonly leadingVariantId: ExperimentVariantId | null;
  readonly status: 'INSUFFICIENT_DATA' | 'A_LEADING' | 'B_LEADING' | 'NO_CLEAR_DIFFERENCE';
}

// ── Bundled result ─────────────────────────────────────────────────────────────

export interface ExperimentResult {
  readonly experiment: RecoveryExperiment;
  readonly outcomes: readonly ExperimentOutcome[];
  readonly comparison: ExperimentComparison;
}
