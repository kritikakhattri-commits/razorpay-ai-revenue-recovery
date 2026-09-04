import type { FailedPayment, FailureReason } from '../payments/types';
import type { RecoveryRecommendation } from './types';

export type RetryTimingConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type RetryTimingSource =
  | 'CUSTOMER_HISTORY'
  | 'FAILURE_REASON'
  | 'PAYMENT_METHOD'
  | 'FALLBACK';

export interface SmartRetryTiming {
  recommendedRetryAt: string;
  delayMinutes: number;
  confidence: RetryTimingConfidence;
  reason: string;
  source: RetryTimingSource;
}

export interface SmartRetryTimingInput {
  payment: FailedPayment;
  recommendation: RecoveryRecommendation;
  previousSuccessfulPaymentTimestamps?: readonly string[];
}

type TimingRule = {
  delayMinutes: number;
  confidence: RetryTimingConfidence;
  reason: string;
  source: RetryTimingSource;
};

const MIN_HISTORY_SAMPLES = 3;
const HIGH_ATTEMPT_COUNT = 2;

const FAILURE_REASON_RULES: Partial<Record<FailureReason, TimingRule>> = {
  UPI_TIMEOUT: {
    delayMinutes: 30,
    confidence: 'MEDIUM',
    reason: 'UPI timeout is likely temporary; retry after 30 minutes.',
    source: 'FAILURE_REASON',
  },
  BANK_SERVER_ERROR: {
    delayMinutes: 180,
    confidence: 'MEDIUM',
    reason: 'Bank server error is likely temporary; retry after 3 hours.',
    source: 'FAILURE_REASON',
  },
  INSUFFICIENT_BALANCE: {
    delayMinutes: 720,
    confidence: 'MEDIUM',
    reason: 'Insufficient balance needs a funding window; retry after 12 hours.',
    source: 'FAILURE_REASON',
  },
};

function parseTimestamp(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMinutes(timestamp: string, minutes: number): string {
  const base = parseTimestamp(timestamp);
  if (!base) {
    throw new Error(`Invalid failedAt timestamp: ${timestamp}`);
  }
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

function minutesBetween(startIso: string, end: Date): number {
  const start = parseTimestamp(startIso);
  if (!start) {
    throw new Error(`Invalid failedAt timestamp: ${startIso}`);
  }
  return Math.ceil((end.getTime() - start.getTime()) / 60_000);
}

function minuteOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function hasEnoughHistory(timestamps: readonly string[] | undefined): timestamps is readonly string[] {
  return Array.isArray(timestamps) && timestamps.length >= MIN_HISTORY_SAMPLES;
}

function computeHistoricalTiming(
  payment: FailedPayment,
  previousSuccessfulPaymentTimestamps: readonly string[] | undefined,
  minimumDelayMinutes: number,
): SmartRetryTiming | null {
  if (!hasEnoughHistory(previousSuccessfulPaymentTimestamps)) {
    return null;
  }

  const successfulDates = previousSuccessfulPaymentTimestamps
    .map(parseTimestamp)
    .filter((date): date is Date => date !== null);

  if (successfulDates.length < MIN_HISTORY_SAMPLES) {
    return null;
  }

  const averageMinute = Math.round(
    successfulDates.reduce((sum, date) => sum + minuteOfDay(date), 0) / successfulDates.length,
  );

  const failedAt = parseTimestamp(payment.failedAt);
  if (!failedAt) {
    throw new Error(`Invalid failedAt timestamp: ${payment.failedAt}`);
  }

  const earliestRetry = new Date(failedAt.getTime() + minimumDelayMinutes * 60_000);
  const recommended = new Date(failedAt.getTime());
  recommended.setUTCHours(Math.floor(averageMinute / 60), averageMinute % 60, 0, 0);

  if (recommended.getTime() < earliestRetry.getTime()) {
    recommended.setUTCDate(recommended.getUTCDate() + 1);
  }

  return {
    recommendedRetryAt: recommended.toISOString(),
    delayMinutes: minutesBetween(payment.failedAt, recommended),
    confidence: 'HIGH',
    reason: 'Customer historically completes payments around this time of day.',
    source: 'CUSTOMER_HISTORY',
  };
}

function getBaseRule(recommendation: RecoveryRecommendation, failureReason: FailureReason): TimingRule {
  const rule = FAILURE_REASON_RULES[failureReason];
  if (rule) return rule;

  return {
    delayMinutes: recommendation.retryAfterMinutes ?? 60,
    confidence: 'LOW',
    reason: 'No specific timing signal is available; using the default retry delay.',
    source: 'FALLBACK',
  };
}

function applyAttemptRisk(payment: FailedPayment, rule: TimingRule): TimingRule {
  if (payment.attemptCount < HIGH_ATTEMPT_COUNT) {
    return rule;
  }

  return {
    ...rule,
    delayMinutes: rule.delayMinutes + 120,
    confidence: 'LOW',
    reason: 'Multiple attempts have already failed; delaying the next retry reduces repeated failure risk.',
  };
}

export function computeSmartRetryTiming({
  payment,
  recommendation,
  previousSuccessfulPaymentTimestamps,
}: SmartRetryTimingInput): SmartRetryTiming | null {
  if (recommendation.recommendedAction !== 'RETRY_LATER') {
    return null;
  }

  if (recommendation.retryAfterMinutes === null || payment.failureReason === 'EXPIRED_CARD') {
    return null;
  }

  const baseRule = getBaseRule(recommendation, payment.failureReason);
  const attemptAwareRule = applyAttemptRisk(payment, baseRule);
  const historicalTiming = computeHistoricalTiming(
    payment,
    previousSuccessfulPaymentTimestamps,
    attemptAwareRule.delayMinutes,
  );

  if (historicalTiming) {
    return historicalTiming;
  }

  return {
    recommendedRetryAt: addMinutes(payment.failedAt, attemptAwareRule.delayMinutes),
    delayMinutes: attemptAwareRule.delayMinutes,
    confidence: attemptAwareRule.confidence,
    reason: attemptAwareRule.reason,
    source: attemptAwareRule.source,
  };
}
