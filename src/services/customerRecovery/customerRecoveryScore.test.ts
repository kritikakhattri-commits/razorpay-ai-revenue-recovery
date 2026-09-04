import { describe, expect, it } from 'vitest';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryExecutionResult } from '../../domain/executor/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { RevenueAtRiskScore } from '../../domain/recovery/revenueAtRisk';
import { calculateRecoveryScore, type RecoveryScore } from '../../domain/recovery/recoveryScore';
import type { RecoveryCase } from '../recovery/types';
import { calculateCustomerRecoveryScore } from './customerRecoveryScore';

const TS = '2025-06-01T12:00:00.000Z';

function makeCase(input: {
  paymentId: string;
  amountInPaise: number;
  recoveryProbability: number;
  previousSuccessfulPayments?: number;
}): RecoveryCase {
  const payment: FailedPayment = {
    paymentId: input.paymentId as FailedPayment['paymentId'],
    customerId: 'cust_rounding' as FailedPayment['customerId'],
    customerName: 'Rounding Customer',
    amount: input.amountInPaise,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: input.previousSuccessfulPayments ?? 4,
    lastAttemptAt: TS,
    failedAt: TS,
  };
  const recoveryScore: RecoveryScore = calculateRecoveryScore({
    amountInPaise: input.amountInPaise,
    recoveryProbability: input.recoveryProbability,
  });
  const recommendation: RecoveryRecommendation = {
    diagnosis: 'Test diagnosis',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: input.recoveryProbability,
    reasoning: 'Test reasoning',
    maxAttempts: 2,
  };
  const policyDecision: PolicyDecision = {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'Approved',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: [],
  };
  const executionResult: RecoveryExecutionResult = {
    paymentId: payment.paymentId,
    action: 'RETRY_LATER',
    status: 'PENDING',
    executedAt: TS,
    recoveredAmount: 0,
    message: 'Pending',
  };
  const paymentMethodSwitch: PaymentMethodSwitchRecommendation = {
    currentMethod: payment.paymentMethod,
    shouldSwitch: false,
    recommendedMethod: null,
    alternatives: [],
    reason: 'Keep current method',
  };
  const revenueAtRiskScore: RevenueAtRiskScore = {
    score: 50,
    level: 'MEDIUM',
    revenueAtRiskInPaise: payment.amount - recoveryScore.expectedRecoverableAmountInPaise,
    factors: [],
  };

  return {
    payment,
    recommendation,
    policyDecision,
    executionResult,
    auditEntries: [],
    recoveredAmount: 0,
    recoveryScore,
    smartRetryTiming: null,
    paymentMethodSwitch,
    revenueAtRiskScore,
  };
}

describe('Customer Recovery integration with Feature 1 Recovery Score', () => {
  it('sums expected recoverable revenue from existing recovery scores', () => {
    const cases = [
      makeCase({ paymentId: 'pay_a', amountInPaise: 3, recoveryProbability: 0.5 }),
      makeCase({ paymentId: 'pay_b', amountInPaise: 5, recoveryProbability: 0.7 }),
    ];

    const score = calculateCustomerRecoveryScore(cases);

    expect(score?.expectedRecoverableRevenueInPaise).toBe(6);
  });

  it('uses rounded recovery score amounts for current recoverability instead of duplicating amount × probability', () => {
    const cases = [
      makeCase({ paymentId: 'pay_a', amountInPaise: 3, recoveryProbability: 0.5 }),
      makeCase({ paymentId: 'pay_b', amountInPaise: 5, recoveryProbability: 0.7 }),
    ];

    const score = calculateCustomerRecoveryScore(cases);

    expect(score?.factors).toContain('High recovery probability across active failures');
  });
});
