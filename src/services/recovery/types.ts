import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult } from '../../domain/executor/types';
import type { AuditEntry } from '../../domain/audit/types';
import type { RecoveryScore } from '../../domain/recovery/recoveryScore';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { RevenueAtRiskScore } from '../../domain/recovery/revenueAtRisk';
import type { RecoveryForecast } from '../forecast/recoveryForecast';

export interface RecoveryCase {
  payment: FailedPayment;
  recommendation: RecoveryRecommendation;
  policyDecision: PolicyDecision;
  executionResult: RecoveryExecutionResult;
  auditEntries: AuditEntry[];
  recoveredAmount: number;
  recoveryScore: RecoveryScore;
  smartRetryTiming: SmartRetryTiming | null;
  paymentMethodSwitch: PaymentMethodSwitchRecommendation;
  revenueAtRiskScore: RevenueAtRiskScore;
}

export interface BatchRecoveryResult {
  cases: RecoveryCase[];
  totalPayments: number;
  totalRevenueAtRisk: number;
  totalRecoveredRevenue: number;
  recoveryRate: number;
  recoveredPaymentCount: number;
  failedRecoveryCount: number;
  pendingPaymentCount: number;
  escalatedPaymentCount: number;
  blockedPaymentCount: number;
  totalExpectedRecoverableRevenue: number;
  totalRevenueUnrecoverableInPaise: number;
  riskCriticalCount: number;
  riskHighCount: number;
  riskMediumCount: number;
  riskLowCount: number;
  forecast: RecoveryForecast;
}
