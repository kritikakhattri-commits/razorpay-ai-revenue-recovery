export type RecoveryTimelineEventType =
  | 'PAYMENT_FAILED'
  | 'RECOVERY_RECOMMENDATION'
  | 'RECOVERY_SCORE'
  | 'RISK_SCORE'
  | 'CUSTOMER_RECOVERY_CONTEXT'
  | 'SMART_RETRY'
  | 'PAYMENT_METHOD_RECOMMENDATION'
  | 'EXPERIMENT_ASSIGNMENT'
  | 'POLICY_DECISION'
  | 'RECOVERY_MESSAGE'
  | 'ACTION_EXECUTED'
  | 'OUTCOME';

export type RecoveryTimelineEventStatus =
  | 'INFO'
  | 'SUCCESS'
  | 'WARNING'
  | 'BLOCKED';

export type RecoveryTimelineEventKind = 'RECORDED' | 'DERIVED';

export type RecoveryTimelineSource =
  | 'PAYMENT'
  | 'RECOMMENDATION'
  | 'RECOVERY_SCORE'
  | 'RISK_SCORE'
  | 'CUSTOMER_RECOVERY'
  | 'SMART_RETRY'
  | 'PAYMENT_METHOD'
  | 'EXPERIMENT'
  | 'POLICY'
  | 'MESSAGE'
  | 'EXECUTOR'
  | 'AUDIT'
  | 'OUTCOME';

export type RecoveryTimelineDetails = Record<string, string | number | boolean | null>;

export interface RecoveryTimelineEvent {
  id: string;
  paymentId: string;
  type: RecoveryTimelineEventType;
  status: RecoveryTimelineEventStatus;
  kind: RecoveryTimelineEventKind;
  timestamp: string;
  title: string;
  summary: string;
  details?: RecoveryTimelineDetails;
  source: RecoveryTimelineSource;
}

export interface PaymentIntelligenceSummary {
  paymentId: string;
  failedAmountFormatted: string;
  expectedRecoveryFormatted: string;
  revenueAtRiskFormatted: string;
  recoveryPriority: string;
  riskLevel: string;
  currentStrategy: string;
  currentOutcome: string;
}

export interface RecoveryTimelineReadModel {
  paymentId: string;
  summary: PaymentIntelligenceSummary;
  events: RecoveryTimelineEvent[];
}
