import type { PaymentId } from '../payments/types';
import type { RecoveryAction } from '../recovery/types';

export type ExecutionStatus = 'RECOVERED' | 'FAILED' | 'PENDING' | 'ESCALATED' | 'BLOCKED';

export interface RecoveryExecutionResult {
  paymentId: PaymentId;
  action: RecoveryAction;
  status: ExecutionStatus;
  executedAt: string;
  recoveredAmount: number;
  message: string;
}
