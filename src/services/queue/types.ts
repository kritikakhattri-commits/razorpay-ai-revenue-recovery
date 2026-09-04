import type { PaymentId, CustomerId, PaymentMethod, FailureReason } from '../../domain/payments/types';
import type { RecoveryAction } from '../../domain/recovery/types';
import type { RecoveryScore } from '../../domain/recovery/recoveryScore';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { RevenueAtRiskScore } from '../../domain/recovery/revenueAtRisk';

export interface QueueItem {
  queueRank: number;
  paymentId: PaymentId;
  customerId: CustomerId;
  customerName: string;
  amountInPaise: number;
  failureReason: FailureReason;
  paymentMethod: PaymentMethod;
  recommendedAction: RecoveryAction;
  recoveryScore: RecoveryScore;
  smartRetryTiming: SmartRetryTiming | null;
  paymentMethodSwitch: PaymentMethodSwitchRecommendation;
  revenueAtRiskScore: RevenueAtRiskScore;
}

export interface QueueSummary {
  totalPayments: number;
  totalRevenueAtRiskInPaise: number;
  totalExpectedRecoveryInPaise: number;
  highPriorityCount: number;
  mediumPriorityCount: number;
  lowPriorityCount: number;
}

export interface RecoveryQueue {
  items: QueueItem[];
  summary: QueueSummary;
}
