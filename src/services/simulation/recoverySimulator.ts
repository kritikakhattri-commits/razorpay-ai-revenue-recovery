import type { CustomerId } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { RecoveryCase } from '../recovery/types';
import type { QueueItem } from '../queue/types';
import type { CustomerRecoverySegment } from '../../domain/customerRecovery/types';
import type { StrategyAnalyticsResult, RecoveryStrategyMetrics, RetryDelayBucket } from '../../domain/strategyAnalytics/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type {
  RecoverySimulationScenario,
  RecoverySimulationResult,
  SimulatedPaymentResult,
  SimulationFilters,
  SimulationStrategy,
  SimulationStrategyMode,
  SimulationPolicyOutcome,
} from '../../domain/simulation/types';
import { evaluatePolicy } from '../../domain/policy/policyEngine';
import { formatPaise } from '../../lib/formatters';

// ── Input type ────────────────────────────────────────────────────────────────

export interface RecoverySimulationInput {
  readonly cases: readonly RecoveryCase[];
  readonly scenario: RecoverySimulationScenario;
  // Pre-ranked queue items. Queue ranks are not recomputed for simulation.
  readonly queueItems: readonly QueueItem[];
  readonly strategyAnalytics: StrategyAnalyticsResult;
  readonly customerSegmentMap: ReadonlyMap<CustomerId, CustomerRecoverySegment>;
  readonly simulatedAt?: string;
}

// ── Retry delay bucket → representative minutes ───────────────────────────────
//
// Conservative lower bounds to stay within each bucket and avoid policy blocks.
// UNDER_30_MIN → 30 (minimum policy-safe delay).

function bucketRepresentativeMinutes(bucket: RetryDelayBucket): number {
  switch (bucket) {
    case 'UNDER_30_MIN': return 30;
    case '30_TO_60_MIN': return 45;
    case '1_TO_3_HR':    return 120;
    case '3_TO_6_HR':    return 270;
    case '6_TO_24_HR':   return 540;
    case 'OVER_24_HR':   return 1440;
  }
}

// ── Eligibility filter ────────────────────────────────────────────────────────

function isEligibleForScenario(
  recoveryCase: RecoveryCase,
  filters: SimulationFilters,
  queueRankMap: ReadonlyMap<string, number>,
  customerSegmentMap: ReadonlyMap<CustomerId, CustomerRecoverySegment>,
): boolean {
  const { recoveryPriority, riskLevel, paymentMethods, failureReasons, maxQueueRank, customerSegments } = filters;

  if (recoveryPriority && recoveryPriority.length > 0) {
    if (!recoveryPriority.includes(recoveryCase.recoveryScore.priority)) return false;
  }

  if (riskLevel && riskLevel.length > 0) {
    if (!riskLevel.includes(recoveryCase.revenueAtRiskScore.level)) return false;
  }

  if (paymentMethods && paymentMethods.length > 0) {
    if (!paymentMethods.includes(recoveryCase.payment.paymentMethod)) return false;
  }

  if (failureReasons && failureReasons.length > 0) {
    if (!failureReasons.includes(recoveryCase.payment.failureReason)) return false;
  }

  if (maxQueueRank !== undefined) {
    const rank = queueRankMap.get(String(recoveryCase.payment.paymentId));
    if (rank === undefined || rank > maxQueueRank) return false;
  }

  if (customerSegments && customerSegments.length > 0) {
    const segment = customerSegmentMap.get(recoveryCase.payment.customerId);
    if (!segment || !customerSegments.includes(segment)) return false;
  }

  return true;
}

// ── Candidate strategy derivation ─────────────────────────────────────────────
//
// Maps a Feature 14 strategy key to a RecoveryRecommendation.

function mapStrategyMetricsToRecommendation(
  strategyMetrics: RecoveryStrategyMetrics,
  fallback: RecoveryRecommendation,
): RecoveryRecommendation {
  switch (strategyMetrics.strategyKey.type) {
    case 'RETRY': {
      const delayMinutes = strategyMetrics.strategyKey.retryDelayBucket
        ? bucketRepresentativeMinutes(strategyMetrics.strategyKey.retryDelayBucket)
        : (fallback.retryAfterMinutes ?? 60);
      return { ...fallback, recommendedAction: 'RETRY_LATER', retryAfterMinutes: delayMinutes };
    }
    case 'PAYMENT_LINK':
      return { ...fallback, recommendedAction: 'SEND_PAYMENT_LINK', retryAfterMinutes: null };
    case 'PAYMENT_METHOD_SWITCH':
      return { ...fallback, recommendedAction: 'UPDATE_PAYMENT_METHOD', retryAfterMinutes: null };
    case 'ESCALATION':
      return { ...fallback, recommendedAction: 'ESCALATE', retryAfterMinutes: null };
  }
}

function deriveCandidateRecommendation(
  recoveryCase: RecoveryCase,
  strategy: SimulationStrategy,
  strategyAnalytics: StrategyAnalyticsResult,
): RecoveryRecommendation {
  const { recommendation, paymentMethodSwitch, payment } = recoveryCase;

  switch (strategy.mode) {
    case 'USE_CURRENT_RECOMMENDATION':
      return recommendation;

    case 'FIXED_RETRY_DELAY': {
      if (recommendation.recommendedAction !== 'RETRY_LATER') {
        // Cannot apply a fixed retry delay to a non-retry action; fall back.
        return recommendation;
      }
      return {
        ...recommendation,
        retryAfterMinutes: strategy.retryDelayMinutes ?? recommendation.retryAfterMinutes ?? 60,
      };
    }

    case 'USE_METHOD_SWITCH': {
      if (paymentMethodSwitch.shouldSwitch) {
        return { ...recommendation, recommendedAction: 'UPDATE_PAYMENT_METHOD', retryAfterMinutes: null };
      }
      return recommendation;
    }

    case 'BEST_OBSERVED_STRATEGY': {
      const frPerf = strategyAnalytics.failureReasonPerformance.find(
        (f) => f.failureReason === payment.failureReason,
      );
      const bestStrategy = frPerf?.bestStrategy ?? null;

      if (!bestStrategy || bestStrategy.performanceStatus === 'INSUFFICIENT_DATA') {
        // Insufficient Feature 14 data: safe fallback to current recommendation.
        return recommendation;
      }

      return mapStrategyMetricsToRecommendation(bestStrategy, recommendation);
    }
  }
}

// ── Policy dry-run ────────────────────────────────────────────────────────────
//
// evaluatePolicy is already a pure function with no side effects. Calling it here
// constitutes a dry-run: no audit is written, no executor is called, no state changes.

function classifyPolicyOutcome(decision: PolicyDecision): SimulationPolicyOutcome {
  if (decision.approved) return 'APPROVED';
  // Policy overrode the action to something other than ESCALATE (e.g., EXPIRED_CARD → UPDATE_PAYMENT_METHOD).
  if (decision.finalAction !== 'ESCALATE') return 'MODIFIED';
  return 'BLOCKED';
}

// ── Estimated recovery ────────────────────────────────────────────────────────
//
// Methodology:
//   Base:     recoveryCase.recoveryScore.expectedRecoverableAmountInPaise
//   Adjusted: only for BEST_OBSERVED_STRATEGY with approved policy and Feature 14 data that has
//             performanceStatus !== INSUFFICIENT_DATA and a non-null recoveryRate.
//             adjustment = Math.round(payment.amount × observedRecoveryRate)
//             clamped to [0, payment.amount].
//
// No adjustment is applied for MODIFIED/BLOCKED outcomes or other strategy modes.

function computeEstimatedRecoverable(
  recoveryCase: RecoveryCase,
  policyOutcome: SimulationPolicyOutcome,
  strategyAnalytics: StrategyAnalyticsResult,
  mode: SimulationStrategyMode,
): number {
  const base = recoveryCase.recoveryScore.expectedRecoverableAmountInPaise;

  if (mode === 'BEST_OBSERVED_STRATEGY' && policyOutcome === 'APPROVED') {
    const frPerf = strategyAnalytics.failureReasonPerformance.find(
      (f) => f.failureReason === recoveryCase.payment.failureReason,
    );
    const bestStrategy = frPerf?.bestStrategy ?? null;

    if (
      bestStrategy &&
      bestStrategy.performanceStatus !== 'INSUFFICIENT_DATA' &&
      bestStrategy.recoveryRate !== null
    ) {
      const adjusted = Math.round(recoveryCase.payment.amount * bestStrategy.recoveryRate);
      return Math.max(0, Math.min(adjusted, recoveryCase.payment.amount));
    }
  }

  return base;
}

// ── Strategy labels ───────────────────────────────────────────────────────────

function currentStrategyLabel(recoveryCase: RecoveryCase): string {
  const action = recoveryCase.policyDecision.finalAction;
  const delay = recoveryCase.policyDecision.approvedRetryAfterMinutes;
  switch (action) {
    case 'RETRY_LATER':
      return delay != null ? `Retry (${delay} min)` : 'Retry Later';
    case 'SEND_PAYMENT_LINK':
      return 'Payment Link';
    case 'UPDATE_PAYMENT_METHOD':
      return 'Update Method';
    case 'ESCALATE':
      return 'Escalate';
  }
}

function simulatedStrategyLabel(candidate: RecoveryRecommendation): string {
  switch (candidate.recommendedAction) {
    case 'RETRY_LATER':
      return candidate.retryAfterMinutes !== null
        ? `Retry (${candidate.retryAfterMinutes} min)`
        : 'Retry Later';
    case 'SEND_PAYMENT_LINK':
      return 'Payment Link';
    case 'UPDATE_PAYMENT_METHOD':
      return 'Update Method';
    case 'ESCALATE':
      return 'Escalate';
  }
}

// ── Notes generation ──────────────────────────────────────────────────────────

function n(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function generateNotes(
  paymentResults: readonly SimulatedPaymentResult[],
  approvedCount: number,
  modifiedCount: number,
  blockedCount: number,
  scenarioDelta: number,
): string[] {
  const notes: string[] = [];

  // Aggregate policy rules across all payment results
  const ruleCounts: Record<string, number> = {};
  for (const r of paymentResults) {
    for (const rule of r.policyRulesApplied) {
      ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
    }
  }

  const mc = (key: string) => ruleCounts[key] ?? 0;

  if (mc('MAX_RETRY_ATTEMPTS') > 0) {
    notes.push(
      `${n(mc('MAX_RETRY_ATTEMPTS'), 'payment')} blocked: maximum automatic retry ceiling reached.`,
    );
  }
  if (mc('EXPIRED_CARD_NO_RETRY') > 0) {
    notes.push(
      `${n(mc('EXPIRED_CARD_NO_RETRY'), 'expired-card payment')} redirected to method update — retry is not viable.`,
    );
  }
  if (mc('MINIMUM_RETRY_DELAY') > 0) {
    notes.push(
      `${n(mc('MINIMUM_RETRY_DELAY'), 'retry delay')} blocked: proposed delay is below PolicyEngine minimum of 30 minutes.`,
    );
  }
  if (mc('BANK_ERROR_RETRY_DELAY') > 0) {
    notes.push(
      `${n(mc('BANK_ERROR_RETRY_DELAY'), 'bank-error payment')} blocked: minimum 60-minute retry delay required.`,
    );
  }
  if (mc('LOW_CONFIDENCE_ESCALATION') > 0) {
    notes.push(
      `${n(mc('LOW_CONFIDENCE_ESCALATION'), 'low-confidence recommendation')} escalated by PolicyEngine.`,
    );
  }
  if (mc('MISSING_RETRY_DELAY') > 0) {
    notes.push(
      `${n(mc('MISSING_RETRY_DELAY'), 'retry recommendation')} blocked: missing required delay value.`,
    );
  }

  if (modifiedCount > 0) {
    notes.push(
      `${n(modifiedCount, 'strategy', 'strategies')} redirected by PolicyEngine to a different action.`,
    );
  }

  if (paymentResults.length > 0 && approvedCount === 0 && blockedCount + modifiedCount > 0) {
    notes.push('No payments were approved for the simulated strategy — all were blocked or redirected by PolicyEngine.');
  }

  if (scenarioDelta > 0) {
    notes.push(`Scenario estimates ${formatPaise(scenarioDelta)} more recovery than the current baseline.`);
  } else if (scenarioDelta < 0) {
    notes.push(`Scenario estimates ${formatPaise(-scenarioDelta)} less recovery than the current baseline.`);
  } else if (paymentResults.length > 0) {
    notes.push('Estimated recovery matches the current baseline expectation.');
  }

  // Mandatory safety label — always last.
  notes.push('SIMULATION — No recovery actions were executed.');

  return notes;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function runSimulation(input: RecoverySimulationInput): RecoverySimulationResult {
  const { cases, scenario, queueItems, strategyAnalytics, customerSegmentMap } = input;
  const simulatedAt = input.simulatedAt ?? new Date().toISOString();

  // Build queue rank map (paymentId → rank) for TOP_QUEUE filtering.
  const queueRankMap = new Map<string, number>();
  for (const item of queueItems) {
    queueRankMap.set(String(item.paymentId), item.queueRank);
  }

  // 1. Filter eligible cases.
  const eligible = cases.filter((c) =>
    isEligibleForScenario(c, scenario.filters, queueRankMap, customerSegmentMap),
  );

  // 2. Deduplicate by paymentId (defensive; input should not have duplicates).
  const seenIds = new Set<string>();
  const deduped = eligible.filter((c) => {
    const id = String(c.payment.paymentId);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  // 3. Per-payment: derive candidate strategy, run PolicyEngine dry-run, compute estimates.
  const paymentResults: SimulatedPaymentResult[] = deduped.map((recoveryCase) => {
    const candidate = deriveCandidateRecommendation(recoveryCase, scenario.strategy, strategyAnalytics);

    // PolicyEngine dry-run — evaluatePolicy is pure, no audit writes, no executor calls.
    const policyDecision = evaluatePolicy(
      recoveryCase.payment,
      candidate,
      recoveryCase.smartRetryTiming,
    );
    const policyOutcome = classifyPolicyOutcome(policyDecision);

    const estimatedRecoverableInPaise = computeEstimatedRecoverable(
      recoveryCase,
      policyOutcome,
      strategyAnalytics,
      scenario.strategy.mode,
    );

    return {
      paymentId: String(recoveryCase.payment.paymentId),
      customerName: recoveryCase.payment.customerName,
      failedAmountInPaise: recoveryCase.payment.amount,
      estimatedRecoverableInPaise,
      riskLevel: recoveryCase.revenueAtRiskScore.level,
      currentStrategyLabel: currentStrategyLabel(recoveryCase),
      simulatedStrategyLabel: simulatedStrategyLabel(candidate),
      policyOutcome,
      policyReason: policyDecision.reason,
      policyRulesApplied: policyDecision.policyRulesApplied,
    };
  });

  // 4. Aggregate metrics.
  const eligiblePaymentCount = deduped.length;
  const targetedFailedRevenueInPaise = deduped.reduce((s, c) => s + c.payment.amount, 0);

  const estimatedRecoverableRevenueInPaise = paymentResults.reduce(
    (s, r) => s + r.estimatedRecoverableInPaise,
    0,
  );
  const estimatedUnrecoveredRevenueInPaise = Math.max(
    0,
    targetedFailedRevenueInPaise - estimatedRecoverableRevenueInPaise,
  );
  const estimatedRevenueAtRiskInPaise = estimatedUnrecoveredRevenueInPaise;
  const estimatedRecoveryRate =
    targetedFailedRevenueInPaise === 0
      ? 0
      : estimatedRecoverableRevenueInPaise / targetedFailedRevenueInPaise;

  const policyApprovedCount = paymentResults.filter((r) => r.policyOutcome === 'APPROVED').length;
  const policyModifiedCount = paymentResults.filter((r) => r.policyOutcome === 'MODIFIED').length;
  const policyBlockedCount = paymentResults.filter((r) => r.policyOutcome === 'BLOCKED').length;

  const affectedPaymentIds = deduped.map((c) => String(c.payment.paymentId));

  // 5. Baseline comparison (uses current recoveryScore expectations, not simulation adjustment).
  const baselineEstimatedRecoverableInPaise = deduped.reduce(
    (s, c) => s + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );
  const scenarioDeltaInPaise =
    estimatedRecoverableRevenueInPaise - baselineEstimatedRecoverableInPaise;

  // 6. Generate notes.
  const notes = generateNotes(
    paymentResults,
    policyApprovedCount,
    policyModifiedCount,
    policyBlockedCount,
    scenarioDeltaInPaise,
  );

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    scenarioDescription: scenario.description,
    eligiblePaymentCount,
    targetedFailedRevenueInPaise,
    estimatedRecoverableRevenueInPaise,
    estimatedUnrecoveredRevenueInPaise,
    estimatedRevenueAtRiskInPaise,
    estimatedRecoveryRate,
    policyApprovedCount,
    policyModifiedCount,
    policyBlockedCount,
    affectedPaymentIds,
    paymentResults,
    notes,
    baselineEstimatedRecoverableInPaise,
    scenarioDeltaInPaise,
    simulatedAt,
    isSimulationOnly: true,
  };
}

// ── Batch helper for pre-computing multiple scenarios ─────────────────────────

export interface BatchSimulationInput {
  readonly cases: readonly RecoveryCase[];
  readonly queueItems: readonly QueueItem[];
  readonly strategyAnalytics: StrategyAnalyticsResult;
  readonly customerSegmentMap: ReadonlyMap<CustomerId, CustomerRecoverySegment>;
  readonly simulatedAt?: string;
}

export function runPresetSimulations(
  scenarios: readonly RecoverySimulationScenario[],
  input: BatchSimulationInput,
): RecoverySimulationResult[] {
  return scenarios.map((scenario) =>
    runSimulation({ ...input, scenario }),
  );
}
