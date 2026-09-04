import type { CustomerId, PaymentMethod } from '../../domain/payments/types';
import type {
  CustomerRecoveryPortfolio,
  CustomerRecoveryQueueItem,
  CustomerRecoveryScore,
  CustomerRecoverySegment,
  HistoricalCustomerPayment,
} from '../../domain/customerRecovery/types';
import type { RecoveryCase } from '../recovery/types';

export const CUSTOMER_RECOVERY_SCORE_WEIGHTS = {
  HISTORICAL_PAYMENT_SUCCESS: 35,
  CURRENT_PAYMENT_RECOVERABILITY: 25,
  FAILURE_PERSISTENCE: 15,
  CUSTOMER_PAYMENT_HISTORY_DEPTH: 10,
  PAYMENT_METHOD_CONSISTENCY: 5,
  CURRENT_REVENUE_OPPORTUNITY: 10,
} as const;

export const CUSTOMER_RECOVERY_SEGMENT_THRESHOLDS = {
  HIGH_RECOVERY_POTENTIAL: 75,
  MEDIUM_RECOVERY_POTENTIAL: 45,
} as const;

const HISTORY_DEPTH_STRONG = 6;
const HISTORY_DEPTH_MODERATE = 3;
const HISTORY_DEPTH_LIMITED = 1;

const REVENUE_OPPORTUNITY_HIGH = 2_000_000;
const REVENUE_OPPORTUNITY_MEDIUM = 500_000;
const REVENUE_OPPORTUNITY_LOW = 100_000;

const PAYMENT_WINDOWS = [
  { label: '00:00-06:00', startHour: 0, endHour: 6 },
  { label: '06:00-12:00', startHour: 6, endHour: 12 },
  { label: '12:00-18:00', startHour: 12, endHour: 18 },
  { label: '18:00-24:00', startHour: 18, endHour: 24 },
] as const;

type ScoreComponents = Record<keyof typeof CUSTOMER_RECOVERY_SCORE_WEIGHTS, number>;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function customerRecoveryWeightsTotal(): number {
  return Object.values(CUSTOMER_RECOVERY_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
}

function historyDepthComponent(successfulPaymentCount: number): number {
  if (successfulPaymentCount >= HISTORY_DEPTH_STRONG) return 1;
  if (successfulPaymentCount >= HISTORY_DEPTH_MODERATE) return 0.75;
  if (successfulPaymentCount >= HISTORY_DEPTH_LIMITED) return 0.5;
  return 0.35;
}

function historicalSuccessComponent(
  historicalSuccessRate: number | null,
  successfulPaymentCount: number,
): number {
  if (historicalSuccessRate !== null) return clamp01(historicalSuccessRate);
  if (successfulPaymentCount >= HISTORY_DEPTH_STRONG) return 0.85;
  if (successfulPaymentCount >= HISTORY_DEPTH_MODERATE) return 0.7;
  if (successfulPaymentCount >= HISTORY_DEPTH_LIMITED) return 0.55;
  return 0.45;
}

function weightedCurrentRecoverability(cases: readonly RecoveryCase[]): number {
  const totalAmount = cases.reduce((sum, c) => sum + c.payment.amount, 0);
  if (totalAmount <= 0) return 0;
  const weighted = cases.reduce(
    (sum, c) => sum + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );
  return clamp01(weighted / totalAmount);
}

function failurePersistenceComponent(cases: readonly RecoveryCase[]): number {
  if (cases.length === 0) return 1;
  const averageAttempts =
    cases.reduce((sum, c) => sum + c.payment.attemptCount, 0) / cases.length;
  return clamp01(1 - averageAttempts / 5);
}

function revenueOpportunityComponent(expectedRecoverableRevenueInPaise: number): number {
  if (expectedRecoverableRevenueInPaise >= REVENUE_OPPORTUNITY_HIGH) return 1;
  if (expectedRecoverableRevenueInPaise >= REVENUE_OPPORTUNITY_MEDIUM) return 0.75;
  if (expectedRecoverableRevenueInPaise >= REVENUE_OPPORTUNITY_LOW) return 0.55;
  if (expectedRecoverableRevenueInPaise > 0) return 0.35;
  return 0.3;
}

function successfulHistoryFor(
  customerId: CustomerId,
  history: readonly HistoricalCustomerPayment[],
): HistoricalCustomerPayment[] {
  return history.filter((h) => h.customerId === customerId && h.status === 'SUCCESSFUL');
}

function historicalSuccessRateFor(
  customerId: CustomerId,
  history: readonly HistoricalCustomerPayment[],
): number | null {
  const completed = history.filter((h) => h.customerId === customerId);
  if (completed.length === 0) return null;
  const successful = completed.filter((h) => h.status === 'SUCCESSFUL').length;
  return successful / completed.length;
}

function preferredMethodFrom(
  successes: readonly HistoricalCustomerPayment[],
): PaymentMethod | null {
  const counts = new Map<PaymentMethod, number>();
  for (const h of successes) {
    counts.set(h.paymentMethod, (counts.get(h.paymentMethod) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => {
    const countDiff = b[1] - a[1];
    if (countDiff !== 0) return countDiff;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  })[0]?.[0] ?? null;
}

function windowFor(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hour = date.getUTCHours();
  return PAYMENT_WINDOWS.find((w) => hour >= w.startHour && hour < w.endHour)?.label ?? null;
}

function preferredWindowFrom(
  successes: readonly HistoricalCustomerPayment[],
): string | null {
  const counts = new Map<string, number>();
  for (const h of successes) {
    if (!h.completedAt) continue;
    const window = windowFor(h.completedAt);
    if (!window) continue;
    counts.set(window, (counts.get(window) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => {
    const countDiff = b[1] - a[1];
    if (countDiff !== 0) return countDiff;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  })[0]?.[0] ?? null;
}

function methodConsistencyComponent(
  preferredMethod: PaymentMethod | null,
  cases: readonly RecoveryCase[],
): number {
  if (!preferredMethod || cases.length === 0) return 0.5;
  const matching = cases.filter((c) => c.payment.paymentMethod === preferredMethod).length;
  if (matching === cases.length) return 1;
  if (matching > 0) return 0.7;
  return 0.4;
}

function determineSegment(
  score: number,
  successfulPaymentCount: number,
  failedPaymentCount: number,
): CustomerRecoverySegment {
  if (successfulPaymentCount === 0 && failedPaymentCount <= 1) return 'INSUFFICIENT_HISTORY';
  if (score >= CUSTOMER_RECOVERY_SEGMENT_THRESHOLDS.HIGH_RECOVERY_POTENTIAL) {
    return 'HIGH_RECOVERY_POTENTIAL';
  }
  if (score >= CUSTOMER_RECOVERY_SEGMENT_THRESHOLDS.MEDIUM_RECOVERY_POTENTIAL) {
    return 'MEDIUM_RECOVERY_POTENTIAL';
  }
  return 'LOW_RECOVERY_POTENTIAL';
}

function buildFactors(input: {
  score: number;
  historicalSuccessRate: number | null;
  successfulPaymentCount: number;
  failedPaymentCount: number;
  currentRecoverability: number;
  averageAttempts: number;
  expectedRecoverableRevenueInPaise: number;
  preferredMethod: PaymentMethod | null;
  preferredWindow: string | null;
  segment: CustomerRecoverySegment;
}): string[] {
  const factors: string[] = [];
  if (input.segment === 'INSUFFICIENT_HISTORY') factors.push('Limited previous payment history');
  if (input.historicalSuccessRate !== null && input.historicalSuccessRate >= 0.75) {
    factors.push('Strong historical payment success rate');
  } else if (input.successfulPaymentCount >= HISTORY_DEPTH_STRONG) {
    factors.push('Strong history of successful payments');
  } else if (input.successfulPaymentCount === 0) {
    factors.push('No previous successful payments recorded');
  }
  if (input.currentRecoverability >= 0.75) factors.push('High recovery probability across active failures');
  if (input.currentRecoverability < 0.45) factors.push('Low recovery probability across active failures');
  if (input.averageAttempts >= 2) factors.push('Multiple unresolved recovery attempts');
  if (input.expectedRecoverableRevenueInPaise >= REVENUE_OPPORTUNITY_MEDIUM) {
    factors.push('High-value recoverable revenue opportunity');
  }
  if (input.preferredMethod) factors.push(`Historically successful with ${input.preferredMethod}`);
  if (input.preferredWindow) factors.push(`Most successful payments occur in ${input.preferredWindow}`);
  return factors.length > 0 ? factors : ['Customer recovery score based on current failed-payment intelligence'];
}

function scoreFrom(components: ScoreComponents): number {
  const total = customerRecoveryWeightsTotal();
  if (total !== 100) {
    throw new Error(`Customer recovery score weights must sum to 100, got ${total}`);
  }
  const weighted = Object.entries(CUSTOMER_RECOVERY_SCORE_WEIGHTS).reduce((sum, [key, weight]) => {
    const component = components[key as keyof ScoreComponents];
    return sum + component * weight;
  }, 0);
  return Math.max(0, Math.min(100, Math.round(weighted)));
}

export function calculateCustomerRecoveryScore(
  cases: readonly RecoveryCase[],
  history: readonly HistoricalCustomerPayment[] = [],
): CustomerRecoveryScore | null {
  if (cases.length === 0) return null;

  const customerId = cases[0].payment.customerId;
  const customerName = cases[0].payment.customerName;
  const activeFailedRevenueInPaise = cases.reduce((sum, c) => sum + c.payment.amount, 0);
  const expectedRecoverableRevenueInPaise = cases.reduce(
    (sum, c) => sum + c.recoveryScore.expectedRecoverableAmountInPaise,
    0,
  );
  const revenueAtRiskInPaise = cases.reduce(
    (sum, c) => sum + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const aggregatePreviousSuccesses = Math.max(
    ...cases.map((c) => c.payment.previousSuccessfulPayments),
  );
  const successes = successfulHistoryFor(customerId, history);
  const successfulPaymentCount =
    history.some((h) => h.customerId === customerId) ? successes.length : aggregatePreviousSuccesses;
  const failedPaymentCount = cases.length;
  const historicalSuccessRate = historicalSuccessRateFor(customerId, history);
  const preferredSuccessfulPaymentMethod = preferredMethodFrom(successes);
  const preferredSuccessfulPaymentWindow = preferredWindowFrom(successes);
  const currentRecoverability = weightedCurrentRecoverability(cases);
  const averageAttempts = cases.reduce((sum, c) => sum + c.payment.attemptCount, 0) / cases.length;

  const components: ScoreComponents = {
    HISTORICAL_PAYMENT_SUCCESS: historicalSuccessComponent(historicalSuccessRate, successfulPaymentCount),
    CURRENT_PAYMENT_RECOVERABILITY: currentRecoverability,
    FAILURE_PERSISTENCE: failurePersistenceComponent(cases),
    CUSTOMER_PAYMENT_HISTORY_DEPTH: historyDepthComponent(successfulPaymentCount),
    PAYMENT_METHOD_CONSISTENCY: methodConsistencyComponent(preferredSuccessfulPaymentMethod, cases),
    CURRENT_REVENUE_OPPORTUNITY: revenueOpportunityComponent(expectedRecoverableRevenueInPaise),
  };
  const score = scoreFrom(components);
  const segment = determineSegment(score, successfulPaymentCount, failedPaymentCount);

  return {
    customerId,
    customerName,
    score,
    segment,
    historicalSuccessRate,
    successfulPaymentCount,
    failedPaymentCount,
    activeFailedRevenueInPaise,
    expectedRecoverableRevenueInPaise,
    revenueAtRiskInPaise,
    preferredSuccessfulPaymentMethod,
    preferredSuccessfulPaymentWindow,
    factors: buildFactors({
      score,
      historicalSuccessRate,
      successfulPaymentCount,
      failedPaymentCount,
      currentRecoverability,
      averageAttempts,
      expectedRecoverableRevenueInPaise,
      preferredMethod: preferredSuccessfulPaymentMethod,
      preferredWindow: preferredSuccessfulPaymentWindow,
      segment,
    }),
  };
}

function groupByCustomer(cases: readonly RecoveryCase[]): RecoveryCase[][] {
  const groups = new Map<CustomerId, RecoveryCase[]>();
  for (const c of cases) {
    const existing = groups.get(c.payment.customerId) ?? [];
    groups.set(c.payment.customerId, [...existing, c]);
  }
  return [...groups.values()].sort((a, b) => {
    const aId = a[0].payment.customerId;
    const bId = b[0].payment.customerId;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

function compareCustomers(a: CustomerRecoveryScore, b: CustomerRecoveryScore): number {
  const expectedDiff = b.expectedRecoverableRevenueInPaise - a.expectedRecoverableRevenueInPaise;
  if (expectedDiff !== 0) return expectedDiff;
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) return scoreDiff;
  const failedRevenueDiff = b.activeFailedRevenueInPaise - a.activeFailedRevenueInPaise;
  if (failedRevenueDiff !== 0) return failedRevenueDiff;
  return a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0;
}

export function buildCustomerRecoveryPortfolio(
  cases: readonly RecoveryCase[],
  history: readonly HistoricalCustomerPayment[] = [],
): CustomerRecoveryPortfolio {
  const scores = groupByCustomer(cases)
    .map((group) => calculateCustomerRecoveryScore(group, history))
    .filter((score): score is CustomerRecoveryScore => score !== null)
    .sort(compareCustomers);

  let highRecoveryPotentialCount = 0;
  let mediumRecoveryPotentialCount = 0;
  let lowRecoveryPotentialCount = 0;
  let insufficientHistoryCount = 0;

  const customers: CustomerRecoveryQueueItem[] = scores.map((score, index) => {
    switch (score.segment) {
      case 'HIGH_RECOVERY_POTENTIAL':
        highRecoveryPotentialCount++;
        break;
      case 'MEDIUM_RECOVERY_POTENTIAL':
        mediumRecoveryPotentialCount++;
        break;
      case 'LOW_RECOVERY_POTENTIAL':
        lowRecoveryPotentialCount++;
        break;
      case 'INSUFFICIENT_HISTORY':
        insufficientHistoryCount++;
        break;
    }
    return { ...score, rank: index + 1 };
  });

  return {
    customers,
    totalCustomers: customers.length,
    totalActiveFailedRevenueInPaise: customers.reduce(
      (sum, c) => sum + c.activeFailedRevenueInPaise,
      0,
    ),
    totalExpectedRecoverableRevenueInPaise: customers.reduce(
      (sum, c) => sum + c.expectedRecoverableRevenueInPaise,
      0,
    ),
    highRecoveryPotentialCount,
    mediumRecoveryPotentialCount,
    lowRecoveryPotentialCount,
    insufficientHistoryCount,
  };
}

export function getCustomerRecoveryScoreById(
  customerId: CustomerId,
  cases: readonly RecoveryCase[],
  history: readonly HistoricalCustomerPayment[] = [],
): CustomerRecoveryScore | null {
  const customerCases = cases.filter((c) => c.payment.customerId === customerId);
  return calculateCustomerRecoveryScore(customerCases, history);
}
