import type { ExecutionStatus } from '../../domain/executor/types';
import { RECOVERY_PROBABILITY_HIGH, RECOVERY_PROBABILITY_MEDIUM } from '../../domain/recovery/recoveryScore';

export type ForecastConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ForecastByHorizon {
  next24HoursInPaise: number;
  next3DaysInPaise: number;
  beyond3DaysInPaise: number;
}

export interface RecoveryForecast {
  totalFailedRevenueInPaise: number;
  expectedRecoveredRevenueInPaise: number;
  expectedUnrecoveredRevenueInPaise: number;
  expectedRecoveryRate: number;
  highConfidenceRecoveryInPaise: number;
  mediumConfidenceRecoveryInPaise: number;
  lowConfidenceRecoveryInPaise: number;
  forecastConfidence: ForecastConfidence;
  byHorizon: ForecastByHorizon;
}

export interface ForecastInput {
  amountInPaise: number;
  expectedRecoverableAmountInPaise: number;
  recoveryProbability: number;
  executionStatus: ExecutionStatus;
  smartRetryDelayMinutes: number | null;
}

// ── Inclusion semantics ───────────────────────────────────────────────────────
//
// RECOVERED  → excluded: revenue is already secured; counted in actual recovery,
//              not in the forward-looking forecast.
// BLOCKED    → included in totalFailedRevenue with 0 expected recovery; policy
//              blocked the action and no automatic recovery will happen.
// PENDING    → included: recovery action underway, outcome still open.
// FAILED     → included: execution failed but the revenue opportunity persists.
// ESCALATED  → included: under manual review; expected recovery is still possible.
//
// ── Time horizon bucketing (uses smartRetryDelayMinutes) ─────────────────────
//
// next24Hours  → delayMinutes ≤ 1440  (1 day)
// next3Days    → 1440 < delayMinutes ≤ 4320  (3 days)
// beyond3Days  → delayMinutes > 4320 OR null (no scheduled retry)
//
// ── Confidence buckets ───────────────────────────────────────────────────────
//
// HIGH    → recoveryProbability ≥ 0.70
// MEDIUM  → 0.40 ≤ recoveryProbability < 0.70
// LOW     → recoveryProbability < 0.40
//
// ── Overall forecast confidence ──────────────────────────────────────────────
//
// HIGH    → highConfidenceRecovery > 50% of expectedRecoveredRevenue
// MEDIUM  → high + medium > 50% of expectedRecoveredRevenue
// LOW     → otherwise (low-confidence majority or empty dataset)

const HORIZON_24H  = 1440;
const HORIZON_3D   = 4320;

const CONFIDENCE_MAJORITY_THRESHOLD = 0.50;

function horizon(delayMinutes: number | null): keyof ForecastByHorizon {
  if (delayMinutes === null || delayMinutes > HORIZON_3D) return 'beyond3DaysInPaise';
  if (delayMinutes > HORIZON_24H)                        return 'next3DaysInPaise';
  return 'next24HoursInPaise';
}

function overallConfidence(
  high: number,
  medium: number,
  total: number,
): ForecastConfidence {
  if (total === 0) return 'LOW';
  if (high > CONFIDENCE_MAJORITY_THRESHOLD * total)          return 'HIGH';
  if (high + medium > CONFIDENCE_MAJORITY_THRESHOLD * total) return 'MEDIUM';
  return 'LOW';
}

export function buildRecoveryForecast(inputs: readonly ForecastInput[]): RecoveryForecast {
  let totalFailedRevenueInPaise       = 0;
  let expectedRecoveredRevenueInPaise = 0;
  let highConfidenceRecoveryInPaise   = 0;
  let mediumConfidenceRecoveryInPaise = 0;
  let lowConfidenceRecoveryInPaise    = 0;

  const byHorizon: ForecastByHorizon = {
    next24HoursInPaise: 0,
    next3DaysInPaise:   0,
    beyond3DaysInPaise: 0,
  };

  for (const input of inputs) {
    if (input.executionStatus === 'RECOVERED') {
      // Excluded: already secured revenue, tracked separately as actual recovery.
      continue;
    }

    totalFailedRevenueInPaise += input.amountInPaise;

    if (input.executionStatus === 'BLOCKED') {
      // Blocked payments contribute to failed revenue with zero expected recovery.
      continue;
    }

    // PENDING / FAILED (execution) / ESCALATED — expected recovery is still possible.
    const expected = input.expectedRecoverableAmountInPaise;
    expectedRecoveredRevenueInPaise += expected;

    // Confidence bucket
    if (input.recoveryProbability >= RECOVERY_PROBABILITY_HIGH) {
      highConfidenceRecoveryInPaise += expected;
    } else if (input.recoveryProbability >= RECOVERY_PROBABILITY_MEDIUM) {
      mediumConfidenceRecoveryInPaise += expected;
    } else {
      lowConfidenceRecoveryInPaise += expected;
    }

    // Time horizon
    byHorizon[horizon(input.smartRetryDelayMinutes)] += expected;
  }

  const expectedUnrecoveredRevenueInPaise = Math.max(
    0,
    totalFailedRevenueInPaise - expectedRecoveredRevenueInPaise,
  );

  const expectedRecoveryRate =
    totalFailedRevenueInPaise === 0
      ? 0
      : expectedRecoveredRevenueInPaise / totalFailedRevenueInPaise;

  const forecastConfidence = overallConfidence(
    highConfidenceRecoveryInPaise,
    mediumConfidenceRecoveryInPaise,
    expectedRecoveredRevenueInPaise,
  );

  return {
    totalFailedRevenueInPaise,
    expectedRecoveredRevenueInPaise,
    expectedUnrecoveredRevenueInPaise,
    expectedRecoveryRate,
    highConfidenceRecoveryInPaise,
    mediumConfidenceRecoveryInPaise,
    lowConfidenceRecoveryInPaise,
    forecastConfidence,
    byHorizon,
  };
}
