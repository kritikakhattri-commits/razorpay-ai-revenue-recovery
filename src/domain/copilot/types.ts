import type { PaymentId } from '../payments/types';

export type CopilotIntent =
  | 'PORTFOLIO_SUMMARY'
  | 'TOP_OPPORTUNITIES'
  | 'REVENUE_AT_RISK'
  | 'RECOVERY_FORECAST'
  | 'FAILURE_ANALYSIS'
  | 'ANOMALIES'
  | 'PAYMENT_LOOKUP'
  | 'CUSTOMER_RECOVERY'
  | 'TOP_CUSTOMERS'
  | 'EXPERIMENT_STATUS'
  | 'RECOMMENDED_FOCUS'
  | 'STRATEGY_PERFORMANCE'
  | 'BEST_STRATEGY'
  | 'WHAT_IF_SIMULATION'
  | 'RECOVERY_HEALTH'
  | 'UNKNOWN';

export interface CopilotRequest {
  query: string;
  paymentId?: PaymentId;
}

export type CopilotSourceType =
  | 'RECOVERY_SCORE'
  | 'RISK_SCORE'
  | 'QUEUE'
  | 'FORECAST'
  | 'INSIGHT'
  | 'ANOMALY'
  | 'EXPERIMENT'
  | 'PAYMENT'
  | 'CUSTOMER'
  | 'TIMELINE'
  | 'POLICY'
  | 'STRATEGY_ANALYTICS'
  | 'SIMULATION'
  | 'HEALTH_SCORE';

export interface CopilotSource {
  type: CopilotSourceType;
  id?: string;
  label: string;
}

export interface CopilotResponse {
  intent: CopilotIntent;
  answer: string;
  sources: CopilotSource[];
  suggestedFollowUps: string[];
  requiresApproval: boolean;
}

export interface CopilotActionProposal {
  type: 'VIEW_QUEUE' | 'FILTER_PAYMENTS' | 'RUN_RECOVERY';
  paymentIds: PaymentId[];
  description: string;
  requiresApproval: true;
}

export interface ResolvedCopilotIntent {
  intent: CopilotIntent;
  paymentId?: PaymentId;
}

export interface CopilotLanguageModelInput {
  intent: CopilotIntent;
  deterministicAnswer: string;
  sources: CopilotSource[];
}

export interface CopilotLanguageModel {
  rephrase(input: CopilotLanguageModelInput): Promise<string>;
}
