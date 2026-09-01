import type { FailedPayment, FailureReason } from '../payments/types';
import type { RecoveryAction, RecoveryRecommendation } from './types';

type FailureRule = {
  action: RecoveryAction;
  retryAfterMinutes: number | null;
  baseConfidence: number;
  maxAttempts: number;
  diagnosis: string;
};

const FAILURE_RULES: Record<FailureReason, FailureRule> = {
  UPI_TIMEOUT: {
    action: 'RETRY_LATER',
    retryAfterMinutes: 30,
    baseConfidence: 0.80,
    maxAttempts: 3,
    diagnosis:
      'UPI timeout is a transient network failure. The payment gateway did not respond in time.',
  },
  BANK_SERVER_ERROR: {
    action: 'RETRY_LATER',
    retryAfterMinutes: 60,
    baseConfidence: 0.75,
    maxAttempts: 2,
    diagnosis:
      'Bank server returned an error. The failure is on the issuing bank side and is likely temporary.',
  },
  INSUFFICIENT_BALANCE: {
    action: 'RETRY_LATER',
    retryAfterMinutes: 360,
    baseConfidence: 0.60,
    maxAttempts: 2,
    diagnosis:
      'Customer had insufficient balance at time of payment. Recovery depends on the customer funding their account.',
  },
  EXPIRED_CARD: {
    action: 'UPDATE_PAYMENT_METHOD',
    retryAfterMinutes: null,
    baseConfidence: 0.88,
    maxAttempts: 1,
    diagnosis:
      'Card has expired. The customer must update their payment method before recovery is possible.',
  },
  AUTHENTICATION_FAILED: {
    action: 'SEND_PAYMENT_LINK',
    retryAfterMinutes: null,
    baseConfidence: 0.62,
    maxAttempts: 1,
    diagnosis:
      'Authentication failed during payment. A fresh payment link bypasses the stale authentication session.',
  },
  CUSTOMER_ABANDONED: {
    action: 'SEND_PAYMENT_LINK',
    retryAfterMinutes: null,
    baseConfidence: 0.55,
    maxAttempts: 2,
    diagnosis:
      'Customer left the payment flow before completing. A payment link re-engages the customer.',
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Each prior successful payment modestly increases recovery confidence, capped to avoid
// history alone pushing confidence to 1. Repeated failures without recovery reduce it.
function computeConfidence(base: number, payment: FailedPayment): number {
  const historyBoost = Math.min(payment.previousSuccessfulPayments * 0.02, 0.15);
  const attemptPenalty = Math.max(0, payment.attemptCount - 1) * 0.15;
  return clamp(base + historyBoost - attemptPenalty, 0, 1);
}

function buildReasoning(payment: FailedPayment): string {
  const parts: string[] = [];

  switch (payment.failureReason) {
    case 'UPI_TIMEOUT':
      parts.push('UPI timeout is likely temporary.');
      break;
    case 'BANK_SERVER_ERROR':
      parts.push('Bank server error is likely transient.');
      break;
    case 'INSUFFICIENT_BALANCE':
      parts.push('Customer balance was insufficient; retry after the expected funding window.');
      break;
    case 'EXPIRED_CARD':
      parts.push('Card expiry is a hard blocker; retry is not viable until the method is updated.');
      break;
    case 'AUTHENTICATION_FAILED':
      parts.push('Authentication failure may stem from a stale session; a fresh link resolves this.');
      break;
    case 'CUSTOMER_ABANDONED':
      parts.push('Customer left without completing; a payment link re-initiates the flow.');
      break;
  }

  if (payment.previousSuccessfulPayments > 0) {
    const count = payment.previousSuccessfulPayments;
    parts.push(
      `Customer has ${count} prior successful payment${count === 1 ? '' : 's'}, increasing recovery confidence.`,
    );
  } else {
    parts.push('No prior successful payments on record; confidence is not boosted by history.');
  }

  if (payment.attemptCount > 1) {
    parts.push(`${payment.attemptCount} failed attempts reduce recovery confidence.`);
  }

  return parts.join(' ');
}

export function computeRecoveryRecommendation(payment: FailedPayment): RecoveryRecommendation {
  const rule = FAILURE_RULES[payment.failureReason];
  const confidence = computeConfidence(rule.baseConfidence, payment);

  return {
    diagnosis: rule.diagnosis,
    recommendedAction: rule.action,
    retryAfterMinutes: rule.retryAfterMinutes,
    confidence,
    reasoning: buildReasoning(payment),
    maxAttempts: rule.maxAttempts,
  };
}
