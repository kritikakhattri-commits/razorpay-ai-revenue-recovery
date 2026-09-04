import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryActionExecutor } from '../../domain/executor/recoveryActionExecutor';
import type { ExecutionStatus, RecoveryExecutionResult } from '../../domain/executor/types';
import type { AuditStore } from '../../domain/audit/types';
import type { AuditLogger } from '../audit/auditLogger';
import type { RecoveryCase } from './types';
import { calculateRecoveryScore } from '../../domain/recovery/recoveryScore';
import {
  computeSmartRetryTiming,
  type SmartRetryTiming,
} from '../../domain/recovery/retryTiming';
import { computePaymentMethodSwitch } from '../../domain/recovery/paymentMethodSwitching';
import { calculateRevenueAtRisk } from '../../domain/recovery/revenueAtRisk';

export interface RecoveryOrchestratorDeps {
  decisionEngine: (payment: FailedPayment) => RecoveryRecommendation;
  policyEngine: (
    payment: FailedPayment,
    recommendation: RecoveryRecommendation,
    smartRetryTiming?: SmartRetryTiming | null,
  ) => PolicyDecision;
  executor: RecoveryActionExecutor;
  auditLogger: AuditLogger;
  auditStore: AuditStore;
  clock?: () => string;
}

export class RecoveryOrchestrator {
  private readonly clock: () => string;

  constructor(private readonly deps: RecoveryOrchestratorDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  recover(payment: FailedPayment): RecoveryCase {
    const { decisionEngine, policyEngine, executor, auditLogger, auditStore } = this.deps;

    // A. Log PAYMENT_FAILED
    auditLogger.logPaymentFailed(payment);

    // B. Generate RecoveryRecommendation
    const recommendation = decisionEngine(payment);

    // B2. Enrich retry recommendations with deterministic smart timing.
    const smartRetryTiming = computeSmartRetryTiming({ payment, recommendation });

    // B3. Compute deterministic payment method switch recommendation.
    const paymentMethodSwitch = computePaymentMethodSwitch({ payment });
    const policyRecommendation: RecoveryRecommendation = smartRetryTiming
      ? { ...recommendation, retryAfterMinutes: smartRetryTiming.delayMinutes }
      : recommendation;

    // C. Log RECOVERY_RECOMMENDED
    auditLogger.logRecoveryRecommendation(payment, recommendation, smartRetryTiming, paymentMethodSwitch);

    // D. Evaluate recommendation with PolicyEngine — never bypassed
    const policyDecision = policyEngine(payment, policyRecommendation, smartRetryTiming);

    // E. Log POLICY_APPROVED or POLICY_REJECTED
    auditLogger.logPolicyDecision(payment, policyDecision);

    // F+G. Executor is invoked ONLY for approved decisions.
    //      Rejected decisions are resolved here at the service layer so that no
    //      rejected action can ever reach a real executor implementation.
    let executionResult: RecoveryExecutionResult;

    if (policyDecision.approved) {
      executionResult = executor.execute(payment, policyDecision);
      // G. Log ACTION_EXECUTED immediately after execution
      auditLogger.logActionExecuted(executionResult);
    } else {
      const status: ExecutionStatus =
        policyDecision.finalAction === 'ESCALATE' ? 'ESCALATED' : 'BLOCKED';
      executionResult = {
        paymentId: payment.paymentId,
        action: policyDecision.finalAction,
        status,
        executedAt: this.clock(),
        recoveredAmount: 0,
        message: `Recovery action not executed: policy rejected with reason: ${policyDecision.reason}`,
      };
    }

    // H. Log the final outcome event
    auditLogger.logFinalOutcome(executionResult);

    // I. Retrieve the complete audit timeline for this payment
    const auditEntries = [...auditStore.getByPaymentId(payment.paymentId)];

    // J. Calculate the recovery score for analytics and prioritisation (does not affect policy)
    const recoveryScore = calculateRecoveryScore({
      amountInPaise: payment.amount,
      recoveryProbability: recommendation.confidence,
    });

    // L. Calculate the revenue-at-risk score (analytics only; does not affect policy)
    const revenueAtRiskScore = calculateRevenueAtRisk({
      amountInPaise: payment.amount,
      recoveryProbability: recommendation.confidence,
      expectedRecoverableAmountInPaise: recoveryScore.expectedRecoverableAmountInPaise,
      attemptCount: payment.attemptCount,
      previousSuccessfulPayments: payment.previousSuccessfulPayments,
      failedAt: payment.failedAt,
      now: this.clock(),
    });

    // K. Return the complete RecoveryCase
    return {
      payment,
      recommendation,
      policyDecision,
      executionResult,
      auditEntries,
      recoveredAmount: executionResult.recoveredAmount,
      recoveryScore,
      smartRetryTiming,
      paymentMethodSwitch,
      revenueAtRiskScore,
    };
  }
}
