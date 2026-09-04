import type { RecoveryCase } from '../recovery/types';
import type {
  RecoveryExperiment,
  ExperimentVariantId,
  ExperimentAssignment,
  ExperimentOutcome,
  ExperimentOutcomeStatus,
  VariantMetrics,
  ExperimentComparison,
  ExperimentResult,
  ExperimentDimension,
} from '../../domain/experiment/types';
import type { RecoveryMessageTone } from '../../domain/messaging/types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const EXPERIMENT_CONSTANTS = {
  // Minimum completed payments per variant before a comparison is considered valid.
  MIN_COMPLETED_PER_VARIANT: 10,
  // Minimum absolute recovery-rate difference (in decimal) before a leading variant is declared.
  MIN_EFFECT_SIZE_RATE: 0.05, // 5 percentage points
} as const;

// ── Deterministic hash ────────────────────────────────────────────────────────
//
// FNV-1a 32-bit — same algorithm used in simulatedRecoveryActionExecutor for
// consistency. Produces a 0–99 bucket from an arbitrary string seed.

function fnv1a32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

// ── Assignment ─────────────────────────────────────────────────────────────────
//
// Customer-level assignment: same customerId + experimentId → same bucket → same variant.
// This prevents one customer from experiencing different strategies across multiple payments
// within the same experiment.

export function computeAssignmentBucket(customerId: string, experimentId: string): number {
  return fnv1a32(`${customerId}:${experimentId}`);
}

export function assignVariant(
  experiment: RecoveryExperiment,
  customerId: string,
): ExperimentAssignment | null {
  if (experiment.status !== 'RUNNING') return null;

  const bucket = computeAssignmentBucket(customerId, experiment.id);
  const variantId: ExperimentVariantId = bucket < experiment.allocationPercent.a ? 'A' : 'B';

  return {
    experimentId: experiment.id,
    variantId,
    assignedEntityId: customerId,
    bucket,
  };
}

// ── Eligibility ───────────────────────────────────────────────────────────────
//
// Only payments whose recovery context is compatible with the experiment dimension
// are included. This prevents experimental variants from being applied to cases
// where they would be unsafe or meaningless.

export function isEligible(
  experiment: RecoveryExperiment,
  recoveryCase: RecoveryCase,
): boolean {
  switch (experiment.dimension) {
    case 'RETRY_TIMING':
      // Only include payments where:
      // - Policy approved the action (not blocked or escalated)
      // - Final action is RETRY_LATER (retry is actually happening)
      // This automatically excludes EXPIRED_CARD (UPDATE_PAYMENT_METHOD),
      // ESCALATED, and BLOCKED cases.
      return (
        recoveryCase.policyDecision.approved &&
        recoveryCase.policyDecision.finalAction === 'RETRY_LATER'
      );

    case 'MESSAGE_TONE':
      // Include any policy-approved case. When policy approves, finalAction is one of
      // RETRY_LATER, UPDATE_PAYMENT_METHOD, or SEND_PAYMENT_LINK — all of which
      // can receive a recovery message.
      return recoveryCase.policyDecision.approved;

    default: {
      const _exhaustive: never = experiment.dimension;
      throw new Error(`Unhandled experiment dimension: ${String(_exhaustive)}`);
    }
  }
}

// ── Outcome computation ───────────────────────────────────────────────────────

function computeRecoveryTimeMinutes(
  failedAt: string,
  executedAt: string,
  status: ExperimentOutcomeStatus,
): number | null {
  if (status !== 'RECOVERED') return null;
  const elapsed = new Date(executedAt).getTime() - new Date(failedAt).getTime();
  return Math.max(0, Math.round(elapsed / 60_000));
}

function buildOutcome(
  experiment: RecoveryExperiment,
  variantId: ExperimentVariantId,
  recoveryCase: RecoveryCase,
  assignedAt: string,
): ExperimentOutcome {
  const { payment, policyDecision, executionResult } = recoveryCase;

  const status = executionResult.status as ExperimentOutcomeStatus;

  const recoveryTimeMinutes = computeRecoveryTimeMinutes(
    payment.failedAt,
    executionResult.executedAt,
    status,
  );

  // For RETRY_TIMING experiments: record both candidate (from variant) and policy-approved delay.
  let candidateRetryDelayMinutes: number | null = null;
  let policyApprovedRetryDelayMinutes: number | null = null;

  if (experiment.dimension === 'RETRY_TIMING') {
    const variant = variantId === 'A' ? experiment.variantA : experiment.variantB;
    if (variant.strategy.dimension === 'RETRY_TIMING') {
      candidateRetryDelayMinutes = variant.strategy.retryDelayMinutes;
    }
    policyApprovedRetryDelayMinutes = policyDecision.approvedRetryAfterMinutes ?? null;
  }

  return {
    experimentId: experiment.id,
    variantId,
    paymentId: payment.paymentId,
    customerId: payment.customerId,
    status,
    failedAmountInPaise: payment.amount,
    recoveredAmountInPaise: executionResult.recoveredAmount,
    recoveryTimeMinutes,
    candidateRetryDelayMinutes,
    policyApprovedRetryDelayMinutes,
    assignedAt,
  };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export function computeVariantMetrics(
  allOutcomes: readonly ExperimentOutcome[],
  variantId: ExperimentVariantId,
  experiment: RecoveryExperiment,
): VariantMetrics {
  const variant = variantId === 'A' ? experiment.variantA : experiment.variantB;
  const outcomes = allOutcomes.filter((o) => o.variantId === variantId);

  let recoveredCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let escalatedCount = 0;
  let blockedCount = 0;
  let recoveredRevenueInPaise = 0;
  const recoveryTimes: number[] = [];

  for (const o of outcomes) {
    switch (o.status) {
      case 'RECOVERED':
        recoveredCount++;
        recoveredRevenueInPaise += o.recoveredAmountInPaise;
        if (o.recoveryTimeMinutes !== null) recoveryTimes.push(o.recoveryTimeMinutes);
        break;
      case 'FAILED':     failedCount++;     break;
      case 'PENDING':    pendingCount++;    break;
      case 'ESCALATED':  escalatedCount++;  break;
      case 'BLOCKED':    blockedCount++;    break;
    }
  }

  // PENDING is intentionally excluded from completedCount — it is still in-flight.
  const completedCount = recoveredCount + failedCount + escalatedCount + blockedCount;
  const recoveryRate = completedCount === 0 ? 0 : recoveredCount / completedCount;
  const avgRecoveredRevenuePerPaymentInPaise =
    recoveredCount === 0 ? 0 : Math.round(recoveredRevenueInPaise / recoveredCount);
  const avgRecoveryTimeMinutes =
    recoveryTimes.length === 0
      ? null
      : Math.round(recoveryTimes.reduce((s, t) => s + t, 0) / recoveryTimes.length);

  return {
    variantId,
    variantName: variant.name,
    assignedCount: outcomes.length,
    completedCount,
    recoveredCount,
    failedCount,
    pendingCount,
    escalatedCount,
    blockedCount,
    recoveryRate,
    recoveredRevenueInPaise,
    avgRecoveredRevenuePerPaymentInPaise,
    avgRecoveryTimeMinutes,
  };
}

// ── Comparison ────────────────────────────────────────────────────────────────

export function compareVariants(
  experiment: RecoveryExperiment,
  allOutcomes: readonly ExperimentOutcome[],
): ExperimentComparison {
  const aMetrics = computeVariantMetrics(allOutcomes, 'A', experiment);
  const bMetrics = computeVariantMetrics(allOutcomes, 'B', experiment);

  const recoveryRateDifference = aMetrics.recoveryRate - bMetrics.recoveryRate;
  const recoveredRevenueDifferenceInPaise =
    aMetrics.recoveredRevenueInPaise - bMetrics.recoveredRevenueInPaise;

  const bothHaveMinSample =
    aMetrics.completedCount >= EXPERIMENT_CONSTANTS.MIN_COMPLETED_PER_VARIANT &&
    bMetrics.completedCount >= EXPERIMENT_CONSTANTS.MIN_COMPLETED_PER_VARIANT;

  let status: ExperimentComparison['status'];
  let leadingVariantId: ExperimentVariantId | null;

  if (!bothHaveMinSample) {
    status = 'INSUFFICIENT_DATA';
    leadingVariantId = null;
  } else {
    const absRateDiff = Math.abs(recoveryRateDifference);
    if (absRateDiff < EXPERIMENT_CONSTANTS.MIN_EFFECT_SIZE_RATE) {
      status = 'NO_CLEAR_DIFFERENCE';
      leadingVariantId = null;
    } else if (recoveryRateDifference > 0) {
      status = 'A_LEADING';
      leadingVariantId = 'A';
    } else {
      status = 'B_LEADING';
      leadingVariantId = 'B';
    }
  }

  return {
    experimentId: experiment.id,
    variantA: aMetrics,
    variantB: bMetrics,
    recoveryRateDifference,
    recoveredRevenueDifferenceInPaise,
    leadingVariantId,
    status,
  };
}

// ── Conflict detection ─────────────────────────────────────────────────────────

export function detectConflicts(
  experiments: readonly RecoveryExperiment[],
): Map<ExperimentDimension, string[]> {
  const runningByDimension = new Map<ExperimentDimension, string[]>();

  for (const exp of experiments) {
    if (exp.status !== 'RUNNING') continue;
    const existing = runningByDimension.get(exp.dimension) ?? [];
    existing.push(exp.id);
    runningByDimension.set(exp.dimension, existing);
  }

  const conflicts = new Map<ExperimentDimension, string[]>();
  for (const [dimension, ids] of runningByDimension) {
    if (ids.length > 1) conflicts.set(dimension, ids);
  }
  return conflicts;
}

// ── Allocation validation ─────────────────────────────────────────────────────

export function validateAllocation(experiment: RecoveryExperiment): void {
  const total = experiment.allocationPercent.a + experiment.allocationPercent.b;
  if (total !== 100) {
    throw new Error(
      `[ExperimentEngine] Experiment "${experiment.id}" allocation must sum to 100, got ${total}`,
    );
  }
}

// ── Assigned message tone helper ──────────────────────────────────────────────
//
// Returns the message tone assigned to a customer in the first RUNNING MESSAGE_TONE
// experiment, or undefined if no such experiment is running.
// Callers (Feature 9 integration) use this to apply the experiment tone when
// generating recovery message drafts.

export function getAssignedMessageTone(
  experiments: readonly RecoveryExperiment[],
  customerId: string,
): RecoveryMessageTone | undefined {
  const messageToneExp = experiments.find(
    (e) => e.status === 'RUNNING' && e.dimension === 'MESSAGE_TONE',
  );
  if (!messageToneExp) return undefined;

  const assignment = assignVariant(messageToneExp, customerId);
  if (!assignment) return undefined;

  const variant =
    assignment.variantId === 'A' ? messageToneExp.variantA : messageToneExp.variantB;

  if (variant.strategy.dimension === 'MESSAGE_TONE') {
    return variant.strategy.tone;
  }
  return undefined;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function runExperiment(
  experiment: RecoveryExperiment,
  cases: readonly RecoveryCase[],
  now: string = new Date().toISOString(),
): ExperimentResult {
  validateAllocation(experiment);

  const outcomes: ExperimentOutcome[] = [];

  if (experiment.status === 'RUNNING') {
    for (const recoveryCase of cases) {
      if (!isEligible(experiment, recoveryCase)) continue;

      const assignment = assignVariant(experiment, recoveryCase.payment.customerId);
      if (!assignment) continue;

      outcomes.push(buildOutcome(experiment, assignment.variantId, recoveryCase, now));
    }
  }

  const comparison = compareVariants(experiment, outcomes);

  return { experiment, outcomes, comparison };
}

export function runAllExperiments(
  experiments: readonly RecoveryExperiment[],
  cases: readonly RecoveryCase[],
  now: string = new Date().toISOString(),
): ExperimentResult[] {
  return experiments.map((exp) => runExperiment(exp, cases, now));
}
