import type { FailedPayment, FailureReason } from '../payments/types';
import type { PolicyDecision } from '../policy/types';
import type { RecoveryActionExecutor } from './recoveryActionExecutor';
import type { ExecutionStatus, RecoveryExecutionResult } from './types';

// FNV-1a 32-bit — fast, well-distributed, and fully deterministic for equal inputs.
function fnv1a32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

// Produces a score in [0, 100) that is stable for any given payment identity.
// Exported so tests can locate paymentIds that produce known score ranges.
export function computeSimulationScore(payment: FailedPayment): number {
  return fnv1a32(`${payment.paymentId}:${payment.failureReason}:${payment.amount}`);
}

// score < threshold → RECOVERED; threshold reflects the recovery likelihood noted in the spec.
const RETRY_RECOVERY_THRESHOLD: Record<FailureReason, number> = {
  UPI_TIMEOUT: 75,           // high
  BANK_SERVER_ERROR: 70,     // high
  INSUFFICIENT_BALANCE: 45,  // medium
  AUTHENTICATION_FAILED: 50, // medium
  CUSTOMER_ABANDONED: 40,    // medium
  EXPIRED_CARD: 0,           // must not auto-recover without method update
};

const PAYMENT_LINK_RECOVERY_THRESHOLD: Record<FailureReason, number> = {
  AUTHENTICATION_FAILED: 55, // medium
  CUSTOMER_ABANDONED: 50,    // medium
  INSUFFICIENT_BALANCE: 35,  // lower — balance issue persists without account top-up
  EXPIRED_CARD: 0,           // must not recover without method update
  UPI_TIMEOUT: 65,           // medium-high
  BANK_SERVER_ERROR: 60,     // medium
};

type SimulationOutcome = { status: ExecutionStatus; message: string };

function simulateRetry(payment: FailedPayment): SimulationOutcome {
  const score = computeSimulationScore(payment);
  if (score < RETRY_RECOVERY_THRESHOLD[payment.failureReason]) {
    return {
      status: 'RECOVERED',
      message: `Retry succeeded for ${payment.paymentId}. The ${payment.failureReason} failure was transient.`,
    };
  }
  return {
    status: 'FAILED',
    message: `Retry failed for ${payment.paymentId}. The ${payment.failureReason} failure persists.`,
  };
}

function simulatePaymentLink(payment: FailedPayment): SimulationOutcome {
  const score = computeSimulationScore(payment);
  if (score < PAYMENT_LINK_RECOVERY_THRESHOLD[payment.failureReason]) {
    return {
      status: 'RECOVERED',
      message: `Customer completed payment via payment link for ${payment.paymentId}.`,
    };
  }
  return {
    status: 'PENDING',
    message: `Payment link sent for ${payment.paymentId}. Awaiting customer action.`,
  };
}

export class SimulatedRecoveryActionExecutor implements RecoveryActionExecutor {
  // clock is injectable so tests can verify determinism of all result fields, not just status.
  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  execute(payment: FailedPayment, decision: PolicyDecision): RecoveryExecutionResult {
    const executedAt = this.clock();

    if (!decision.approved) {
      const status: ExecutionStatus =
        decision.finalAction === 'ESCALATE' ? 'ESCALATED' : 'BLOCKED';
      return {
        paymentId: payment.paymentId,
        action: decision.finalAction,
        status,
        executedAt,
        recoveredAmount: 0,
        message: `Action blocked by policy: ${decision.reason}`,
      };
    }

    const { finalAction } = decision;

    switch (finalAction) {
      case 'ESCALATE':
        return {
          paymentId: payment.paymentId,
          action: finalAction,
          status: 'ESCALATED',
          executedAt,
          recoveredAmount: 0,
          message: `Payment ${payment.paymentId} escalated for manual review. Reason: ${decision.reason}`,
        };

      case 'UPDATE_PAYMENT_METHOD':
        return {
          paymentId: payment.paymentId,
          action: finalAction,
          status: 'PENDING',
          executedAt,
          recoveredAmount: 0,
          message: `Customer action required: update payment method for ${payment.paymentId}. The ${payment.failureReason} failure cannot be resolved automatically.`,
        };

      case 'SEND_PAYMENT_LINK': {
        const { status, message } = simulatePaymentLink(payment);
        return {
          paymentId: payment.paymentId,
          action: finalAction,
          status,
          executedAt,
          recoveredAmount: status === 'RECOVERED' ? payment.amount : 0,
          message,
        };
      }

      case 'RETRY_LATER': {
        const { status, message } = simulateRetry(payment);
        return {
          paymentId: payment.paymentId,
          action: finalAction,
          status,
          executedAt,
          recoveredAmount: status === 'RECOVERED' ? payment.amount : 0,
          message,
        };
      }

      default: {
        const _: never = finalAction;
        throw new Error(`Unhandled recovery action: ${String(_)}`);
      }
    }
  }
}
