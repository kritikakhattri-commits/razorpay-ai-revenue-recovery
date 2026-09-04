export type RecoveryPriority = 'HIGH' | 'MEDIUM' | 'LOW';

// Shared recovery probability thresholds used for priority bucketing and forecast confidence.
export const RECOVERY_PROBABILITY_HIGH   = 0.70;
export const RECOVERY_PROBABILITY_MEDIUM = 0.40;

export interface RecoveryScore {
  recoveryProbability: number;
  expectedRecoverableAmountInPaise: number;
  priority: RecoveryPriority;
}

export interface RecoveryScoreInput {
  amountInPaise: number;
  recoveryProbability: number;
}

function validateInput({ amountInPaise, recoveryProbability }: RecoveryScoreInput): void {
  if (!Number.isInteger(amountInPaise)) {
    throw new Error(`amountInPaise must be a non-negative integer, got ${amountInPaise}`);
  }
  if (amountInPaise < 0) {
    throw new Error(`amountInPaise must be non-negative, got ${amountInPaise}`);
  }
  if (!Number.isFinite(recoveryProbability)) {
    throw new Error(`recoveryProbability must be finite, got ${recoveryProbability}`);
  }
  if (recoveryProbability < 0 || recoveryProbability > 1) {
    throw new Error(`recoveryProbability must be between 0 and 1 inclusive, got ${recoveryProbability}`);
  }
}

function determinePriority(probability: number): RecoveryPriority {
  if (probability >= RECOVERY_PROBABILITY_HIGH)   return 'HIGH';
  if (probability >= RECOVERY_PROBABILITY_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

export function calculateRecoveryScore(input: RecoveryScoreInput): RecoveryScore {
  validateInput(input);
  const { amountInPaise, recoveryProbability } = input;
  return {
    recoveryProbability,
    expectedRecoverableAmountInPaise: Math.round(amountInPaise * recoveryProbability),
    priority: determinePriority(recoveryProbability),
  };
}
