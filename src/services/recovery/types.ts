import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult } from '../../domain/executor/types';
import type { AuditEntry } from '../../domain/audit/types';

export interface RecoveryCase {
  payment: FailedPayment;
  recommendation: RecoveryRecommendation;
  policyDecision: PolicyDecision;
  executionResult: RecoveryExecutionResult;
  auditEntries: AuditEntry[];
  recoveredAmount: number;
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
}
