import { RECOVERY_PROBABILITY_HIGH, RECOVERY_PROBABILITY_MEDIUM } from './recoveryScore';

export type RevenueRiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RevenueAtRiskScore {
  score: number;
  level: RevenueRiskLevel;
  revenueAtRiskInPaise: number;
  factors: string[];
}

export interface RevenueAtRiskInput {
  amountInPaise: number;
  recoveryProbability: number;
  expectedRecoverableAmountInPaise: number;
  attemptCount: number;
  previousSuccessfulPayments: number;
  failedAt: string;
  now?: string;
}

// ── Weights (must sum to 100) ─────────────────────────────────────────────────

const WEIGHT_AMOUNT      = 40;
const WEIGHT_PERSISTENCE = 20;
const WEIGHT_UNCERTAINTY = 20;
const WEIGHT_HISTORY     = 10;
const WEIGHT_AGE         = 10;

// ── Risk level thresholds ─────────────────────────────────────────────────────

export const RISK_THRESHOLDS = {
  CRITICAL: 80,
  HIGH:     60,
  MEDIUM:   35,
} as const;

// ── Amount bands (paise) ──────────────────────────────────────────────────────

const AMOUNT_VERY_HIGH = 2_000_000; // > ₹20,000
const AMOUNT_HIGH      =   500_000; // ₹5,000–₹20,000
const AMOUNT_MODERATE  =   100_000; // ₹1,000–₹5,000
                                    // < ₹1,000 → small

// ── Age bands (minutes) ───────────────────────────────────────────────────────

const AGE_3_DAYS = 3 * 24 * 60;
const AGE_1_DAY  =     24 * 60;
const AGE_6H     =      6 * 60;
const AGE_1H     =          60;

// ── Component functions (return 0–1) ──────────────────────────────────────────

function amountComponent(paise: number): number {
  if (paise >= AMOUNT_VERY_HIGH) return 1.00;
  if (paise >= AMOUNT_HIGH)      return 0.70;
  if (paise >= AMOUNT_MODERATE)  return 0.40;
  return 0.15;
}

function persistenceComponent(attempts: number): number {
  if (attempts >= 4)   return 1.00;
  if (attempts === 3)  return 0.80;
  if (attempts === 2)  return 0.55;
  return 0.25;
}

function ageComponent(failedAt: string, now: string): number {
  const minutes = Math.max(
    0,
    (new Date(now).getTime() - new Date(failedAt).getTime()) / 60_000,
  );
  if (minutes >= AGE_3_DAYS) return 1.00;
  if (minutes >= AGE_1_DAY)  return 0.80;
  if (minutes >= AGE_6H)     return 0.60;
  if (minutes >= AGE_1H)     return 0.30;
  return 0.10;
}

function ageMinutesValue(failedAt: string, now: string): number {
  return Math.max(
    0,
    (new Date(now).getTime() - new Date(failedAt).getTime()) / 60_000,
  );
}

function historyComponent(prevSuccessful: number): number {
  if (prevSuccessful >= 5) return 1.00;
  if (prevSuccessful >= 1) return 0.60;
  return 0.25;
}

function determineLevel(score: number): RevenueRiskLevel {
  if (score >= RISK_THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (score >= RISK_THRESHOLDS.HIGH)     return 'HIGH';
  if (score >= RISK_THRESHOLDS.MEDIUM)   return 'MEDIUM';
  return 'LOW';
}

function buildFactors(input: RevenueAtRiskInput, now: string): string[] {
  const factors: string[] = [];

  // Amount impact
  if (input.amountInPaise >= AMOUNT_VERY_HIGH) {
    factors.push('Large failed payment amount');
  } else if (input.amountInPaise >= AMOUNT_HIGH) {
    factors.push('Moderately large failed payment amount');
  } else if (input.amountInPaise >= AMOUNT_MODERATE) {
    factors.push('Moderate failed payment amount');
  } else {
    factors.push('Small failed payment amount');
  }

  // Failure persistence
  if (input.attemptCount >= 2) {
    factors.push('Multiple recovery attempts already failed');
  }

  // Recovery uncertainty
  if (input.recoveryProbability < RECOVERY_PROBABILITY_MEDIUM) {
    factors.push('Low recovery probability increases financial exposure');
  } else if (input.recoveryProbability < RECOVERY_PROBABILITY_HIGH) {
    factors.push('Moderate recovery probability');
  } else {
    factors.push('High recovery probability limits financial exposure');
  }

  // Customer / value history
  if (input.previousSuccessfulPayments >= 5) {
    factors.push('Historically valuable customer');
  } else if (input.previousSuccessfulPayments >= 1) {
    factors.push('Prior payment history noted');
  }

  // Payment age / urgency
  const minutes = ageMinutesValue(input.failedAt, now);
  if (minutes >= AGE_3_DAYS) {
    factors.push('Payment unresolved for more than 3 days');
  } else if (minutes >= AGE_1_DAY) {
    factors.push('Payment unresolved for more than 24 hours');
  } else if (minutes >= AGE_6H) {
    factors.push('Payment unresolved for more than 6 hours');
  }

  return factors;
}

export function calculateRevenueAtRisk(input: RevenueAtRiskInput): RevenueAtRiskScore {
  const now = input.now ?? new Date().toISOString();

  const score = Math.round(
    WEIGHT_AMOUNT      * amountComponent(input.amountInPaise) +
    WEIGHT_PERSISTENCE * persistenceComponent(input.attemptCount) +
    WEIGHT_UNCERTAINTY * (1 - input.recoveryProbability) +
    WEIGHT_HISTORY     * historyComponent(input.previousSuccessfulPayments) +
    WEIGHT_AGE         * ageComponent(input.failedAt, now),
  );

  const revenueAtRiskInPaise = Math.max(
    0,
    input.amountInPaise - input.expectedRecoverableAmountInPaise,
  );

  return {
    score,
    level: determineLevel(score),
    revenueAtRiskInPaise,
    factors: buildFactors(input, now),
  };
}
