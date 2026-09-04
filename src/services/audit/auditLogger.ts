import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { PolicyDecision } from '../../domain/policy/types';
import type { ExecutionStatus, RecoveryExecutionResult } from '../../domain/executor/types';
import type { AuditEntry, AuditEventType, AuditStore } from '../../domain/audit/types';

// Divides paise by 100 and formats as a rupee string with 2 decimal places and comma separators.
// e.g. 5000 → "50.00", 250050 → "2,500.50"
function formatPaiseAsRupees(paise: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

export function makeCounterIdGenerator(prefix = 'audit'): () => string {
  let count = 0;
  return () => `${prefix}_${++count}`;
}

const OUTCOME_EVENT: Record<ExecutionStatus, AuditEventType> = {
  RECOVERED: 'PAYMENT_RECOVERED',
  FAILED: 'RECOVERY_FAILED',
  PENDING: 'RECOVERY_PENDING',
  ESCALATED: 'ESCALATED',
  BLOCKED: 'ACTION_BLOCKED',
};

export class AuditLogger {
  constructor(
    private readonly store: AuditStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly idGenerator: () => string = makeCounterIdGenerator(),
  ) {}

  logPaymentFailed(payment: FailedPayment): void {
    this.append({
      paymentId: payment.paymentId,
      eventType: 'PAYMENT_FAILED',
      message: `Payment failed with ${payment.failureReason}.`,
      metadata: {
        failureReason: payment.failureReason,
        paymentMethod: payment.paymentMethod,
        attemptCount: payment.attemptCount,
        amount: payment.amount,
      },
    });
  }

  logRecoveryRecommendation(
    payment: FailedPayment,
    recommendation: RecoveryRecommendation,
    smartRetryTiming?: SmartRetryTiming | null,
    paymentMethodSwitch?: PaymentMethodSwitchRecommendation | null,
  ): void {
    this.append({
      paymentId: payment.paymentId,
      eventType: 'RECOVERY_RECOMMENDED',
      message: `Recovery engine recommended ${recommendation.recommendedAction} with confidence ${recommendation.confidence.toFixed(2)}.`,
      metadata: {
        recommendedAction: recommendation.recommendedAction,
        confidence: recommendation.confidence,
        retryAfterMinutes: recommendation.retryAfterMinutes,
        maxAttempts: recommendation.maxAttempts,
        smartRetryTiming: smartRetryTiming
          ? {
              recommendedRetryAt: smartRetryTiming.recommendedRetryAt,
              delayMinutes: smartRetryTiming.delayMinutes,
              confidence: smartRetryTiming.confidence,
              reason: smartRetryTiming.reason,
              source: smartRetryTiming.source,
            }
          : null,
        paymentMethodSwitch: paymentMethodSwitch
          ? {
              currentMethod: paymentMethodSwitch.currentMethod,
              shouldSwitch: paymentMethodSwitch.shouldSwitch,
              recommendedMethod: paymentMethodSwitch.recommendedMethod,
              alternativeCount: paymentMethodSwitch.alternatives.length,
              reason: paymentMethodSwitch.reason,
            }
          : null,
      },
    });
  }

  logPolicyDecision(payment: FailedPayment, decision: PolicyDecision): void {
    const { approved } = decision;
    this.append({
      paymentId: payment.paymentId,
      eventType: approved ? 'POLICY_APPROVED' : 'POLICY_REJECTED',
      message: approved
        ? `Policy approved ${decision.finalAction}.`
        : `Policy rejected ${decision.originalRecommendedAction} and escalated the case.`,
      metadata: {
        finalAction: decision.finalAction,
        originalRecommendedAction: decision.originalRecommendedAction,
        policyRulesApplied: decision.policyRulesApplied,
        approvedRetryAfterMinutes: decision.approvedRetryAfterMinutes ?? null,
        approvedRetryAt: decision.approvedRetryAt ?? null,
        ...(approved ? {} : { reason: decision.reason }),
      },
    });
  }

  logActionExecuted(result: RecoveryExecutionResult): void {
    this.append({
      paymentId: result.paymentId,
      eventType: 'ACTION_EXECUTED',
      message: `${result.action} action executed for payment ${result.paymentId}.`,
      metadata: {
        action: result.action,
        status: result.status,
      },
    });
  }

  logFinalOutcome(result: RecoveryExecutionResult): void {
    this.append({
      paymentId: result.paymentId,
      eventType: OUTCOME_EVENT[result.status],
      message: this.buildFinalOutcomeMessage(result),
      metadata: this.buildFinalOutcomeMetadata(result),
    });
  }

  private buildFinalOutcomeMessage(result: RecoveryExecutionResult): string {
    switch (result.status) {
      case 'RECOVERED':
        return `Recovery action completed successfully. ₹${formatPaiseAsRupees(result.recoveredAmount)} recovered.`;
      case 'FAILED':
        return 'Recovery action failed. Payment could not be recovered.';
      case 'PENDING':
        return 'Recovery action pending. Awaiting customer or external action.';
      case 'ESCALATED':
        return 'Payment escalated for manual review.';
      case 'BLOCKED':
        return 'Recovery action blocked by policy.';
      default: {
        const _exhaustive: never = result.status;
        throw new Error(`Unhandled execution status: ${String(_exhaustive)}`);
      }
    }
  }

  private buildFinalOutcomeMetadata(result: RecoveryExecutionResult): Record<string, unknown> {
    const base: Record<string, unknown> = {
      status: result.status,
      action: result.action,
    };
    if (result.status === 'RECOVERED') {
      base['recoveredAmount'] = result.recoveredAmount;
    }
    return base;
  }

  private append(partial: Omit<AuditEntry, 'auditId' | 'timestamp'>): void {
    this.store.append({
      auditId: this.idGenerator(),
      timestamp: this.clock(),
      ...partial,
    });
  }
}
