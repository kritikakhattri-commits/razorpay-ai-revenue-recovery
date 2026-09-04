import type { RecoveryAction } from '../recovery/types';
import type { FailureReason } from '../payments/types';
import type { SmartRetryTiming } from '../recovery/retryTiming';
import type { PaymentMethodSwitchRecommendation } from '../recovery/paymentMethodSwitching';
import type { RevenueRiskLevel } from '../recovery/revenueAtRisk';

export type RecoveryMessageChannel = 'SMS' | 'WHATSAPP' | 'EMAIL';

export type RecoveryMessageTone = 'NEUTRAL' | 'FRIENDLY' | 'URGENT';

export interface RecoveryMessageDraft {
  channel: RecoveryMessageChannel;
  tone: RecoveryMessageTone;
  subject?: string;
  body: string;
  paymentId: string;
  generatedFromAction: RecoveryAction;
  requiresPaymentLink: boolean;
  metadata: {
    retryTimingIncluded: boolean;
    paymentMethodSuggestionIncluded: boolean;
  };
}

export interface RecoveryMessageInput {
  paymentId: string;
  customerName: string;
  amountInPaise: number;
  failureReason: FailureReason;
  finalAction: RecoveryAction;
  policyApproved: boolean;
  smartRetryTiming: SmartRetryTiming | null;
  paymentMethodSwitch: PaymentMethodSwitchRecommendation;
  riskLevel: RevenueRiskLevel;
  tone?: RecoveryMessageTone;
}
