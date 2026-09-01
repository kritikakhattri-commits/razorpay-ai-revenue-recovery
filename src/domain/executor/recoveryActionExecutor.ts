import type { FailedPayment } from '../payments/types';
import type { PolicyDecision } from '../policy/types';
import type { RecoveryExecutionResult } from './types';

export interface RecoveryActionExecutor {
  execute(payment: FailedPayment, decision: PolicyDecision): RecoveryExecutionResult;
}
