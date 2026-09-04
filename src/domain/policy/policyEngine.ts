import type { FailedPayment } from '../payments/types';
import type { RecoveryAction, RecoveryRecommendation } from '../recovery/types';
import type { SmartRetryTiming } from '../recovery/retryTiming';
import type { PolicyDecision } from './types';

const MIN_CONFIDENCE = 0.60;
const MAX_AUTO_RETRY_ATTEMPTS = 2;
const MIN_RETRY_DELAY_MINUTES = 30;
const MIN_BANK_ERROR_RETRY_DELAY_MINUTES = 60;

function decide(
  approved: boolean,
  finalAction: RecoveryAction,
  reason: string,
  originalRecommendedAction: RecoveryAction,
  policyRulesApplied: string[],
  timing?: Pick<PolicyDecision, 'approvedRetryAfterMinutes' | 'approvedRetryAt'>,
): PolicyDecision {
  return {
    approved,
    finalAction,
    reason,
    originalRecommendedAction,
    policyRulesApplied,
    ...timing,
  };
}

/**
 * Deterministic safety layer between AI recommendations and execution.
 * Never calls AI models, never executes financial actions, never mutates inputs.
 */
export function evaluatePolicy(
  payment: FailedPayment,
  recommendation: RecoveryRecommendation,
  smartRetryTiming?: SmartRetryTiming | null,
): PolicyDecision {
  const { recommendedAction, confidence, retryAfterMinutes } = recommendation;
  const { failureReason, attemptCount } = payment;
  const rules: string[] = [];

  // RULE 3 — LOW_CONFIDENCE_ESCALATION
  // Applies to all actions. Check first so unsafe recommendations are always caught.
  if (confidence < MIN_CONFIDENCE) {
    rules.push('LOW_CONFIDENCE_ESCALATION');
    return decide(
      false,
      'ESCALATE',
      `Confidence ${confidence.toFixed(2)} is below the minimum threshold of ${MIN_CONFIDENCE}. Manual review required.`,
      recommendedAction,
      rules,
    );
  }

  if (recommendedAction === 'RETRY_LATER') {
    // RULE 6 — MISSING_RETRY_DELAY
    // Invalid state: RETRY_LATER without a delay cannot be scheduled safely.
    if (retryAfterMinutes === null) {
      rules.push('MISSING_RETRY_DELAY');
      return decide(
        false,
        'ESCALATE',
        'RETRY_LATER recommendation is missing a required retryAfterMinutes value. Cannot schedule a retry without a delay.',
        recommendedAction,
        rules,
      );
    }

    // RULE 2 — EXPIRED_CARD_NO_RETRY
    // Hard blocker: retrying an expired card will always fail. Override to UPDATE_PAYMENT_METHOD.
    if (failureReason === 'EXPIRED_CARD') {
      rules.push('EXPIRED_CARD_NO_RETRY');
      return decide(
        false,
        'UPDATE_PAYMENT_METHOD',
        'An expired card cannot be retried. The customer must update their payment method before recovery is possible.',
        recommendedAction,
        rules,
      );
    }

    // RULE 1 — MAX_RETRY_ATTEMPTS
    // Hard limit: do not schedule automatic retries beyond the allowed attempt ceiling.
    if (attemptCount >= MAX_AUTO_RETRY_ATTEMPTS) {
      rules.push('MAX_RETRY_ATTEMPTS');
      return decide(
        false,
        'ESCALATE',
        `Payment has been attempted ${attemptCount} time(s). Automatic retry ceiling of ${MAX_AUTO_RETRY_ATTEMPTS} reached. Escalating to manual review.`,
        recommendedAction,
        rules,
      );
    }

    // RULE 4 — MINIMUM_RETRY_DELAY
    // Reject rather than silently normalise: changing financial retry parameters without
    // explicit approval is less safe than escalating for human review.
    if (retryAfterMinutes < MIN_RETRY_DELAY_MINUTES) {
      rules.push('MINIMUM_RETRY_DELAY');
      return decide(
        false,
        'ESCALATE',
        `Retry delay of ${retryAfterMinutes} minute(s) is below the minimum allowed delay of ${MIN_RETRY_DELAY_MINUTES} minutes. Escalating rather than executing an unsafe retry schedule.`,
        recommendedAction,
        rules,
      );
    }

    // RULE 5 — BANK_ERROR_RETRY_DELAY
    // Bank server errors require a longer cool-down to avoid hammering a degraded issuer.
    if (
      failureReason === 'BANK_SERVER_ERROR' &&
      retryAfterMinutes < MIN_BANK_ERROR_RETRY_DELAY_MINUTES
    ) {
      rules.push('BANK_ERROR_RETRY_DELAY');
      return decide(
        false,
        'ESCALATE',
        `Bank server errors require a minimum retry delay of ${MIN_BANK_ERROR_RETRY_DELAY_MINUTES} minutes. Proposed delay of ${retryAfterMinutes} minute(s) is too short.`,
        recommendedAction,
        rules,
      );
    }

    return decide(
      true,
      'RETRY_LATER',
      `Retry approved. Confidence ${confidence.toFixed(2)} meets threshold. Retry scheduled after ${retryAfterMinutes} minute(s) with ${attemptCount} prior attempt(s).`,
      recommendedAction,
      rules,
      {
        approvedRetryAfterMinutes: retryAfterMinutes,
        approvedRetryAt: smartRetryTiming?.recommendedRetryAt ?? null,
      },
    );
  }

  // RULE 7 — NON_RETRY_RECOVERY_ACTIONS
  // SEND_PAYMENT_LINK and UPDATE_PAYMENT_METHOD are approved when confidence >= MIN_CONFIDENCE
  // and no other hard rule has blocked them (already verified above).
  if (
    recommendedAction === 'SEND_PAYMENT_LINK' ||
    recommendedAction === 'UPDATE_PAYMENT_METHOD'
  ) {
    return decide(
      true,
      recommendedAction,
      `${recommendedAction} approved. Confidence ${confidence.toFixed(2)} meets minimum threshold of ${MIN_CONFIDENCE}.`,
      recommendedAction,
      rules,
    );
  }

  // ESCALATE recommendations are passed through unchanged.
  return decide(
    true,
    'ESCALATE',
    'Recommendation was already ESCALATE; passed through by policy engine.',
    recommendedAction,
    rules,
  );
}
