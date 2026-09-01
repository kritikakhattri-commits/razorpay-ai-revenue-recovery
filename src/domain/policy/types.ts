import type { RecoveryAction } from '../recovery/types';

export interface PolicyDecision {
  approved: boolean;
  finalAction: RecoveryAction;
  reason: string;
  originalRecommendedAction: RecoveryAction;
  policyRulesApplied: string[];
}
