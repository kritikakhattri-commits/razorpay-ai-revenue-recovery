import type { RecoveryCase } from '../recovery/types';
import type { ExperimentResult } from '../../domain/experiment/types';
import type { CustomerId, FailureReason, PaymentMethod } from '../../domain/payments/types';
import type { CustomerRecoverySegment } from '../../domain/customerRecovery/types';
import type {
  RecoveryStrategyKey,
  RecoveryStrategyMetrics,
  RetryDelayBucket,
  StrategyPerformanceStatus,
  FailureReasonPerformance,
  PaymentMethodPerformance,
  CustomerSegmentPerformance,
  ExperimentStrategyPerformance,
  MessageToneAnalytics,
  StrategyPortfolioSummary,
  StrategyAnalyticsResult,
} from '../../domain/strategyAnalytics/types';

// ── Constants ──────────────────────────────────────────────────────────────────
//
// Minimum completed attempts required before a strategy is considered OBSERVED.
// Below this threshold performanceStatus = INSUFFICIENT_DATA and the strategy
// is not eligible to be declared LEADING.

export const MIN_COMPLETED_ATTEMPTS = 5;

// ── Retry delay classification ─────────────────────────────────────────────────
//
// Boundaries (minutes):
//   < 30        → UNDER_30_MIN
//   30 – <60    → 30_TO_60_MIN
//   60 – <180   → 1_TO_3_HR
//   180 – <360  → 3_TO_6_HR
//   360 – <1440 → 6_TO_24_HR
//   ≥ 1440      → OVER_24_HR

export function classifyRetryDelay(minutes: number): RetryDelayBucket {
  if (minutes < 30) return 'UNDER_30_MIN';
  if (minutes < 60) return '30_TO_60_MIN';
  if (minutes < 180) return '1_TO_3_HR';
  if (minutes < 360) return '3_TO_6_HR';
  if (minutes < 1440) return '6_TO_24_HR';
  return 'OVER_24_HR';
}

// ── Strategy key helpers ───────────────────────────────────────────────────────

export function strategyKeyStr(key: RecoveryStrategyKey): string {
  switch (key.type) {
    case 'RETRY':
      return `RETRY:${key.paymentMethod ?? ''}:${key.retryDelayBucket ?? ''}`;
    case 'PAYMENT_METHOD_SWITCH':
      return `SWITCH:${key.fromPaymentMethod ?? ''}:${key.toPaymentMethod ?? ''}`;
    case 'PAYMENT_LINK':
      return 'PAYMENT_LINK';
    case 'ESCALATION':
      return 'ESCALATION';
  }
}

const METHOD_LABEL: Record<PaymentMethod, string> = {
  UPI: 'UPI',
  CARD: 'Card',
  NETBANKING: 'Netbanking',
  WALLET: 'Wallet',
};

export function retryBucketLabel(bucket: RetryDelayBucket): string {
  switch (bucket) {
    case 'UNDER_30_MIN': return '<30 min';
    case '30_TO_60_MIN': return '30–60 min';
    case '1_TO_3_HR':    return '1–3 hr';
    case '3_TO_6_HR':    return '3–6 hr';
    case '6_TO_24_HR':   return '6–24 hr';
    case 'OVER_24_HR':   return '24+ hr';
  }
}

export function strategyKeyLabel(key: RecoveryStrategyKey): string {
  switch (key.type) {
    case 'RETRY': {
      const method = key.paymentMethod ? METHOD_LABEL[key.paymentMethod] : '';
      const bucket = key.retryDelayBucket ? retryBucketLabel(key.retryDelayBucket) : '';
      return `${method} Retry (${bucket})`.trim();
    }
    case 'PAYMENT_METHOD_SWITCH': {
      const from = key.fromPaymentMethod ? METHOD_LABEL[key.fromPaymentMethod] : '?';
      const to = key.toPaymentMethod ? METHOD_LABEL[key.toPaymentMethod] : '?';
      return `${from} → ${to} Switch`;
    }
    case 'PAYMENT_LINK':
      return 'Payment Link';
    case 'ESCALATION':
      return 'Escalation';
  }
}

// ── Strategy key derivation ────────────────────────────────────────────────────
//
// Source of truth: policyDecision.finalAction (not recommendation.recommendedAction).
// Retry delay: policyDecision.approvedRetryAfterMinutes (not recommendation.retryAfterMinutes).
// This ensures analytics reflect the policy-approved and executed strategy.

export function deriveStrategyKey(recoveryCase: RecoveryCase): RecoveryStrategyKey {
  const { policyDecision, payment, paymentMethodSwitch } = recoveryCase;

  switch (policyDecision.finalAction) {
    case 'RETRY_LATER': {
      const delayMinutes = policyDecision.approvedRetryAfterMinutes ?? 60;
      return {
        type: 'RETRY',
        paymentMethod: payment.paymentMethod,
        retryDelayBucket: classifyRetryDelay(delayMinutes),
      };
    }
    case 'UPDATE_PAYMENT_METHOD': {
      if (paymentMethodSwitch.shouldSwitch && paymentMethodSwitch.recommendedMethod !== null) {
        return {
          type: 'PAYMENT_METHOD_SWITCH',
          fromPaymentMethod: payment.paymentMethod,
          toPaymentMethod: paymentMethodSwitch.recommendedMethod,
        };
      }
      return { type: 'PAYMENT_LINK' };
    }
    case 'SEND_PAYMENT_LINK': {
      return { type: 'PAYMENT_LINK' };
    }
    case 'ESCALATE': {
      return { type: 'ESCALATION' };
    }
  }
}

// ── Mutable accumulators (internal only) ──────────────────────────────────────

type MutableStrategyAcc = {
  strategyKey: RecoveryStrategyKey;
  label: string;
  totalAttempts: number;
  completedAttempts: number;
  recoveredCount: number;
  failedCount: number;
  pendingCount: number;
  escalatedCount: number;
  blockedCount: number;
  attemptedRevenueInPaise: number;
  recoveredRevenueInPaise: number;
  recoveryTimesMinutes: number[];
};

type MutableSimpleAcc = {
  totalAttempts: number;
  completedAttempts: number;
  recoveredCount: number;
  totalFailedRevenueInPaise: number;
  recoveredRevenueInPaise: number;
  recoveryTimesMinutes: number[];
};

function makeStrategyAcc(key: RecoveryStrategyKey): MutableStrategyAcc {
  return {
    strategyKey: key,
    label: strategyKeyLabel(key),
    totalAttempts: 0,
    completedAttempts: 0,
    recoveredCount: 0,
    failedCount: 0,
    pendingCount: 0,
    escalatedCount: 0,
    blockedCount: 0,
    attemptedRevenueInPaise: 0,
    recoveredRevenueInPaise: 0,
    recoveryTimesMinutes: [],
  };
}

function makeSimpleAcc(): MutableSimpleAcc {
  return {
    totalAttempts: 0,
    completedAttempts: 0,
    recoveredCount: 0,
    totalFailedRevenueInPaise: 0,
    recoveredRevenueInPaise: 0,
    recoveryTimesMinutes: [],
  };
}

function computeRecoveryTimeMinutes(recoveryCase: RecoveryCase): number | null {
  if (recoveryCase.executionResult.status !== 'RECOVERED') return null;
  const failedMs = new Date(recoveryCase.payment.failedAt).getTime();
  const executedMs = new Date(recoveryCase.executionResult.executedAt).getTime();
  const diffMs = executedMs - failedMs;
  return diffMs >= 0 ? Math.round(diffMs / 60_000) : null;
}

function accumulateStrategy(acc: MutableStrategyAcc, recoveryCase: RecoveryCase): void {
  const status = recoveryCase.executionResult.status;
  acc.totalAttempts++;
  acc.attemptedRevenueInPaise += recoveryCase.payment.amount;

  switch (status) {
    case 'RECOVERED': {
      acc.recoveredCount++;
      acc.completedAttempts++;
      acc.recoveredRevenueInPaise += recoveryCase.recoveredAmount;
      const rt = computeRecoveryTimeMinutes(recoveryCase);
      if (rt !== null) acc.recoveryTimesMinutes.push(rt);
      break;
    }
    case 'FAILED':
      acc.failedCount++;
      acc.completedAttempts++;
      break;
    case 'PENDING':
      acc.pendingCount++;
      break;
    case 'ESCALATED':
      acc.escalatedCount++;
      acc.completedAttempts++;
      break;
    case 'BLOCKED':
      acc.blockedCount++;
      acc.completedAttempts++;
      break;
  }
}

function accumulateSimple(acc: MutableSimpleAcc, recoveryCase: RecoveryCase): void {
  const status = recoveryCase.executionResult.status;
  acc.totalAttempts++;
  acc.totalFailedRevenueInPaise += recoveryCase.payment.amount;

  if (status !== 'PENDING') acc.completedAttempts++;
  if (status === 'RECOVERED') {
    acc.recoveredCount++;
    acc.recoveredRevenueInPaise += recoveryCase.recoveredAmount;
    const rt = computeRecoveryTimeMinutes(recoveryCase);
    if (rt !== null) acc.recoveryTimesMinutes.push(rt);
  }
}

function avgMinutes(times: number[]): number | null {
  if (times.length === 0) return null;
  return Math.round(times.reduce((s, t) => s + t, 0) / times.length);
}

function finalizeStrategyAcc(acc: MutableStrategyAcc): RecoveryStrategyMetrics {
  const { completedAttempts, recoveredCount, attemptedRevenueInPaise, recoveredRevenueInPaise } = acc;

  const recoveryRate = completedAttempts === 0 ? null : recoveredCount / completedAttempts;
  const revenueRecoveryRate =
    attemptedRevenueInPaise === 0 ? null : recoveredRevenueInPaise / attemptedRevenueInPaise;
  const averageRecoveredRevenueInPaise =
    recoveredCount === 0 ? null : Math.round(recoveredRevenueInPaise / recoveredCount);
  const averageRecoveryTimeMinutes = avgMinutes(acc.recoveryTimesMinutes);

  const performanceStatus: StrategyPerformanceStatus =
    completedAttempts < MIN_COMPLETED_ATTEMPTS ? 'INSUFFICIENT_DATA' : 'OBSERVED';

  return {
    strategyKey: acc.strategyKey,
    label: acc.label,
    totalAttempts: acc.totalAttempts,
    completedAttempts,
    recoveredCount,
    failedCount: acc.failedCount,
    pendingCount: acc.pendingCount,
    escalatedCount: acc.escalatedCount,
    blockedCount: acc.blockedCount,
    recoveryRate,
    attemptedRevenueInPaise,
    recoveredRevenueInPaise,
    revenueRecoveryRate,
    averageRecoveredRevenueInPaise,
    averageRecoveryTimeMinutes,
    performanceStatus,
    dataSource: 'OBSERVED',
  };
}

// ── Deterministic strategy comparison ─────────────────────────────────────────
//
// Rules (higher = better), applied in order:
//   1. Recovery rate descending  (null treated as -1)
//   2. Recovered revenue descending
//   3. Average recovery time ascending  (null = Infinity, i.e. no-data is slowest)
//   4. Label lexicographic ascending    (deterministic tie-break)

export function compareByPerformance(
  a: RecoveryStrategyMetrics,
  b: RecoveryStrategyMetrics,
): number {
  const rateA = a.recoveryRate ?? -1;
  const rateB = b.recoveryRate ?? -1;
  if (rateA !== rateB) return rateB - rateA;

  if (a.recoveredRevenueInPaise !== b.recoveredRevenueInPaise) {
    return b.recoveredRevenueInPaise - a.recoveredRevenueInPaise;
  }

  const timeA = a.averageRecoveryTimeMinutes ?? Infinity;
  const timeB = b.averageRecoveryTimeMinutes ?? Infinity;
  if (timeA !== timeB) return timeA - timeB;

  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

function selectBestAmongObserved(
  metrics: readonly RecoveryStrategyMetrics[],
): RecoveryStrategyMetrics | null {
  const observed = metrics.filter((m) => m.performanceStatus !== 'INSUFFICIENT_DATA');
  if (observed.length === 0) return null;
  return [...observed].sort(compareByPerformance)[0] ?? null;
}

function selectHighestRevenue(
  metrics: readonly RecoveryStrategyMetrics[],
): RecoveryStrategyMetrics | null {
  const observed = metrics.filter(
    (m) => m.performanceStatus !== 'INSUFFICIENT_DATA' && m.recoveredRevenueInPaise > 0,
  );
  if (observed.length === 0) return null;
  return [...observed].sort((a, b) => {
    const diff = b.recoveredRevenueInPaise - a.recoveredRevenueInPaise;
    if (diff !== 0) return diff;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  })[0] ?? null;
}

function selectFastest(
  metrics: readonly RecoveryStrategyMetrics[],
): RecoveryStrategyMetrics | null {
  const observed = metrics.filter(
    (m) =>
      m.performanceStatus !== 'INSUFFICIENT_DATA' && m.averageRecoveryTimeMinutes !== null,
  );
  if (observed.length === 0) return null;
  return [...observed].sort((a, b) => {
    const diff =
      (a.averageRecoveryTimeMinutes ?? Infinity) - (b.averageRecoveryTimeMinutes ?? Infinity);
    if (diff !== 0) return diff;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  })[0] ?? null;
}

function selectWeakest(
  metrics: readonly RecoveryStrategyMetrics[],
): RecoveryStrategyMetrics | null {
  const observed = metrics.filter((m) => m.performanceStatus !== 'INSUFFICIENT_DATA');
  if (observed.length === 0) return null;
  return [...observed].sort((a, b) => compareByPerformance(b, a))[0] ?? null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface StrategyAnalyticsInput {
  readonly cases: readonly RecoveryCase[];
  readonly experimentResults: readonly ExperimentResult[];
  // Map from customerId → segment, consumed from Feature 13 output.
  readonly customerSegmentMap: ReadonlyMap<CustomerId, CustomerRecoverySegment>;
  readonly generatedAt?: string;
}

const ALL_SEGMENTS: readonly CustomerRecoverySegment[] = [
  'HIGH_RECOVERY_POTENTIAL',
  'MEDIUM_RECOVERY_POTENTIAL',
  'LOW_RECOVERY_POTENTIAL',
  'INSUFFICIENT_HISTORY',
];

export function computeStrategyAnalytics(
  input: StrategyAnalyticsInput,
): StrategyAnalyticsResult {
  const { cases, experimentResults, customerSegmentMap } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  // ── Single pass over cases to populate all accumulators ────────────────────

  const overallMap = new Map<string, MutableStrategyAcc>();
  const byFailureReason = new Map<FailureReason, Map<string, MutableStrategyAcc>>();
  const byPaymentMethod = new Map<
    PaymentMethod,
    { overall: MutableSimpleAcc; strategies: Map<string, MutableStrategyAcc> }
  >();
  const bySegment = new Map<CustomerRecoverySegment, MutableSimpleAcc>();

  for (const recoveryCase of cases) {
    const stratKey = deriveStrategyKey(recoveryCase);
    const keyStr = strategyKeyStr(stratKey);

    // Overall strategy aggregation
    let overallAcc = overallMap.get(keyStr);
    if (!overallAcc) {
      overallAcc = makeStrategyAcc(stratKey);
      overallMap.set(keyStr, overallAcc);
    }
    accumulateStrategy(overallAcc, recoveryCase);

    // Per-failure-reason strategy aggregation
    const reason = recoveryCase.payment.failureReason;
    let reasonMap = byFailureReason.get(reason);
    if (!reasonMap) {
      reasonMap = new Map();
      byFailureReason.set(reason, reasonMap);
    }
    let reasonAcc = reasonMap.get(keyStr);
    if (!reasonAcc) {
      reasonAcc = makeStrategyAcc(stratKey);
      reasonMap.set(keyStr, reasonAcc);
    }
    accumulateStrategy(reasonAcc, recoveryCase);

    // Per-payment-method aggregation
    const method = recoveryCase.payment.paymentMethod;
    let methodEntry = byPaymentMethod.get(method);
    if (!methodEntry) {
      methodEntry = { overall: makeSimpleAcc(), strategies: new Map() };
      byPaymentMethod.set(method, methodEntry);
    }
    accumulateSimple(methodEntry.overall, recoveryCase);
    let methodStratAcc = methodEntry.strategies.get(keyStr);
    if (!methodStratAcc) {
      methodStratAcc = makeStrategyAcc(stratKey);
      methodEntry.strategies.set(keyStr, methodStratAcc);
    }
    accumulateStrategy(methodStratAcc, recoveryCase);

    // Per-segment aggregation — consumes Feature 13 output, no recalculation
    const segment = customerSegmentMap.get(recoveryCase.payment.customerId);
    if (segment) {
      let segAcc = bySegment.get(segment);
      if (!segAcc) {
        segAcc = makeSimpleAcc();
        bySegment.set(segment, segAcc);
      }
      accumulateSimple(segAcc, recoveryCase);
    }
  }

  // ── Finalize overall strategy metrics ──────────────────────────────────────

  const rawMetrics = [...overallMap.values()].map(finalizeStrategyAcc);

  // Identify the LEADING strategy key before building the final array
  const bestObserved = selectBestAmongObserved(rawMetrics);
  const leadingKeyStr = bestObserved !== null ? strategyKeyStr(bestObserved.strategyKey) : null;

  const strategyMetrics: RecoveryStrategyMetrics[] = rawMetrics
    .map((m): RecoveryStrategyMetrics => {
      if (
        leadingKeyStr !== null &&
        strategyKeyStr(m.strategyKey) === leadingKeyStr &&
        m.performanceStatus === 'OBSERVED'
      ) {
        return { ...m, performanceStatus: 'LEADING' };
      }
      return m;
    })
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // ── Failure reason performance ─────────────────────────────────────────────

  const failureReasonPerformance: FailureReasonPerformance[] = [
    ...byFailureReason.entries(),
  ]
    .map(([failureReason, stratMap]): FailureReasonPerformance => {
      const stratMetrics = [...stratMap.values()].map(finalizeStrategyAcc);
      const totalAttempts = stratMetrics.reduce((s, m) => s + m.totalAttempts, 0);
      const completedAttempts = stratMetrics.reduce((s, m) => s + m.completedAttempts, 0);
      const recoveredCount = stratMetrics.reduce((s, m) => s + m.recoveredCount, 0);
      const recoveredRevenueInPaise = stratMetrics.reduce(
        (s, m) => s + m.recoveredRevenueInPaise,
        0,
      );
      const recoveryRate =
        completedAttempts === 0 ? null : recoveredCount / completedAttempts;
      return {
        failureReason,
        totalAttempts,
        completedAttempts,
        recoveredCount,
        recoveryRate,
        recoveredRevenueInPaise,
        bestStrategy: selectBestAmongObserved(stratMetrics),
        strategyBreakdown: [...stratMetrics].sort((a, b) =>
          a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
        ),
      };
    })
    .sort((a, b) =>
      a.failureReason < b.failureReason ? -1 : a.failureReason > b.failureReason ? 1 : 0,
    );

  // ── Payment method performance ─────────────────────────────────────────────

  const paymentMethodPerformance: PaymentMethodPerformance[] = [
    ...byPaymentMethod.entries(),
  ]
    .map(([paymentMethod, entry]): PaymentMethodPerformance => {
      const { overall, strategies } = entry;
      const stratMetrics = [...strategies.values()].map(finalizeStrategyAcc);
      const recoveryRate =
        overall.completedAttempts === 0
          ? null
          : overall.recoveredCount / overall.completedAttempts;
      return {
        paymentMethod,
        totalAttempts: overall.totalAttempts,
        completedAttempts: overall.completedAttempts,
        recoveredCount: overall.recoveredCount,
        totalFailedRevenueInPaise: overall.totalFailedRevenueInPaise,
        recoveredRevenueInPaise: overall.recoveredRevenueInPaise,
        recoveryRate,
        averageRecoveryTimeMinutes: avgMinutes(overall.recoveryTimesMinutes),
        bestStrategy: selectBestAmongObserved(stratMetrics),
      };
    })
    .sort((a, b) =>
      a.paymentMethod < b.paymentMethod ? -1 : a.paymentMethod > b.paymentMethod ? 1 : 0,
    );

  // ── Customer segment performance ───────────────────────────────────────────

  const customerSegmentPerformance: CustomerSegmentPerformance[] = ALL_SEGMENTS.map(
    (segment): CustomerSegmentPerformance => {
      const acc = bySegment.get(segment);
      if (!acc) {
        return {
          segment,
          totalAttempts: 0,
          completedAttempts: 0,
          recoveredCount: 0,
          recoveryRate: null,
          recoveredRevenueInPaise: 0,
          averageRecoveryTimeMinutes: null,
        };
      }
      const recoveryRate =
        acc.completedAttempts === 0 ? null : acc.recoveredCount / acc.completedAttempts;
      return {
        segment,
        totalAttempts: acc.totalAttempts,
        completedAttempts: acc.completedAttempts,
        recoveredCount: acc.recoveredCount,
        recoveryRate,
        recoveredRevenueInPaise: acc.recoveredRevenueInPaise,
        averageRecoveryTimeMinutes: avgMinutes(acc.recoveryTimesMinutes),
      };
    },
  );

  // ── Experiment performance (reuses Feature 10 output) ─────────────────────

  const experimentPerformance: ExperimentStrategyPerformance[] = experimentResults.map(
    (result): ExperimentStrategyPerformance => ({
      experimentId: result.experiment.id,
      experimentName: result.experiment.name,
      dimension: result.experiment.dimension,
      variantAId: 'A',
      variantAName: result.comparison.variantA.variantName,
      variantARecoveryRate: result.comparison.variantA.recoveryRate,
      variantACompletedCount: result.comparison.variantA.completedCount,
      variantBId: 'B',
      variantBName: result.comparison.variantB.variantName,
      variantBRecoveryRate: result.comparison.variantB.recoveryRate,
      variantBCompletedCount: result.comparison.variantB.completedCount,
      leadingVariantId: result.comparison.leadingVariantId,
      comparisonStatus: result.comparison.status,
      dataSource: 'EXPERIMENT',
    }),
  );

  // ── Message tone analytics ─────────────────────────────────────────────────
  //
  // Messages are draft-only — no delivery tracking.
  // Tone performance is EXPERIMENT-DERIVED (Feature 10 MESSAGE_TONE experiment)
  // and must NOT be mixed with execution-based strategy metrics.

  const messageToneResult = experimentResults.find(
    (r) => r.experiment.dimension === 'MESSAGE_TONE',
  );
  const messageToneAnalytics: MessageToneAnalytics | null = messageToneResult
    ? buildMessageToneAnalytics(messageToneResult)
    : null;

  // ── Portfolio summary ──────────────────────────────────────────────────────

  const totalAttempts = strategyMetrics.reduce((s, m) => s + m.totalAttempts, 0);
  const totalCompletedAttempts = strategyMetrics.reduce((s, m) => s + m.completedAttempts, 0);
  const totalRecoveredCount = strategyMetrics.reduce((s, m) => s + m.recoveredCount, 0);
  const totalRecoveredRevenueInPaise = strategyMetrics.reduce(
    (s, m) => s + m.recoveredRevenueInPaise,
    0,
  );
  const portfolioRecoveryRate =
    totalCompletedAttempts === 0 ? null : totalRecoveredCount / totalCompletedAttempts;

  const allRecoveryTimes = [...overallMap.values()].flatMap((acc) => acc.recoveryTimesMinutes);
  const averageRecoveryTimeMinutes = avgMinutes(allRecoveryTimes);

  const bestRecoveryRateStrategy =
    strategyMetrics.find((m) => m.performanceStatus === 'LEADING') ??
    selectBestAmongObserved(strategyMetrics);

  const highestRevenueStrategy = selectHighestRevenue(strategyMetrics);
  const fastestStrategy = selectFastest(strategyMetrics);
  const rawWeakest = selectWeakest(strategyMetrics);

  const weakestRecoveryRateStrategy =
    rawWeakest !== null &&
    bestRecoveryRateStrategy !== null &&
    strategyKeyStr(rawWeakest.strategyKey) !== strategyKeyStr(bestRecoveryRateStrategy.strategyKey)
      ? rawWeakest
      : null;

  const insufficientDataCount = strategyMetrics.filter(
    (m) => m.performanceStatus === 'INSUFFICIENT_DATA',
  ).length;
  const observedCount = strategyMetrics.filter(
    (m) => m.performanceStatus === 'OBSERVED',
  ).length;
  const leadingCount = strategyMetrics.filter(
    (m) => m.performanceStatus === 'LEADING',
  ).length;

  const portfolioSummary: StrategyPortfolioSummary = {
    totalAttempts,
    totalCompletedAttempts,
    portfolioRecoveryRate,
    totalRecoveredRevenueInPaise,
    averageRecoveryTimeMinutes,
    bestRecoveryRateStrategy,
    highestRevenueStrategy,
    fastestStrategy,
    weakestRecoveryRateStrategy,
    insufficientDataCount,
    observedCount,
    leadingCount,
  };

  return {
    strategyMetrics,
    failureReasonPerformance,
    paymentMethodPerformance,
    customerSegmentPerformance,
    experimentPerformance,
    messageToneAnalytics,
    portfolioSummary,
    generatedAt,
  };
}

// ── Message tone analytics builder ────────────────────────────────────────────

function buildMessageToneAnalytics(result: ExperimentResult): MessageToneAnalytics {
  const { experiment, comparison } = result;
  const varA = experiment.variantA;
  const varB = experiment.variantB;

  const aIsNeutral =
    varA.strategy.dimension === 'MESSAGE_TONE' && varA.strategy.tone === 'NEUTRAL';

  const neutralMetrics = aIsNeutral ? comparison.variantA : comparison.variantB;
  const friendlyMetrics = aIsNeutral ? comparison.variantB : comparison.variantA;
  const neutralName = aIsNeutral ? varA.name : varB.name;
  const friendlyName = aIsNeutral ? varB.name : varA.name;

  let leadingTone: 'NEUTRAL' | 'FRIENDLY' | null = null;
  if (comparison.leadingVariantId) {
    const leadingIsA = comparison.leadingVariantId === 'A';
    const leadingIsNeutral = leadingIsA ? aIsNeutral : !aIsNeutral;
    leadingTone = leadingIsNeutral ? 'NEUTRAL' : 'FRIENDLY';
  }

  return {
    experimentId: experiment.id,
    neutralName,
    neutralRecoveryRate: neutralMetrics.recoveryRate,
    neutralCompletedCount: neutralMetrics.completedCount,
    friendlyName,
    friendlyRecoveryRate: friendlyMetrics.recoveryRate,
    friendlyCompletedCount: friendlyMetrics.completedCount,
    leadingTone,
    comparisonStatus: comparison.status,
    dataSource: 'EXPERIMENT',
    note:
      'Recovery messages are generated as drafts only — delivery is not tracked. ' +
      'This performance is experiment-derived: recovery outcomes for cases assigned ' +
      'to each message tone variant, not message delivery performance.',
  };
}
