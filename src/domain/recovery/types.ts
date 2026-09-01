export type RecoveryAction =
  | 'RETRY_LATER'
  | 'SEND_PAYMENT_LINK'
  | 'UPDATE_PAYMENT_METHOD'
  | 'ESCALATE';

export interface RecoveryRecommendation {
  diagnosis: string;
  recommendedAction: RecoveryAction;
  retryAfterMinutes: number | null;
  confidence: number;
  reasoning: string;
  maxAttempts: number;
}
