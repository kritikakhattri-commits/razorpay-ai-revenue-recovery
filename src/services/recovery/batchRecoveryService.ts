import type { FailedPayment } from '../../domain/payments/types';
import type { BatchRecoveryResult, RecoveryCase } from './types';

export interface RecoveryProcessor {
  recover(payment: FailedPayment): RecoveryCase;
}

export class BatchRecoveryService {
  constructor(private readonly orchestrator: RecoveryProcessor) {}

  process(payments: readonly FailedPayment[]): BatchRecoveryResult {
    const cases: RecoveryCase[] = payments.map((payment) => this.orchestrator.recover(payment));

    const totalPayments = cases.length;
    const totalRevenueAtRisk = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalRecoveredRevenue = cases.reduce((sum, c) => sum + c.recoveredAmount, 0);
    const recoveryRate = totalRevenueAtRisk === 0 ? 0 : totalRecoveredRevenue / totalRevenueAtRisk;

    let recoveredPaymentCount = 0;
    let failedRecoveryCount = 0;
    let pendingPaymentCount = 0;
    let escalatedPaymentCount = 0;
    let blockedPaymentCount = 0;

    for (const c of cases) {
      switch (c.executionResult.status) {
        case 'RECOVERED':
          recoveredPaymentCount++;
          break;
        case 'FAILED':
          failedRecoveryCount++;
          break;
        case 'PENDING':
          pendingPaymentCount++;
          break;
        case 'ESCALATED':
          escalatedPaymentCount++;
          break;
        case 'BLOCKED':
          blockedPaymentCount++;
          break;
      }
    }

    return {
      cases,
      totalPayments,
      totalRevenueAtRisk,
      totalRecoveredRevenue,
      recoveryRate,
      recoveredPaymentCount,
      failedRecoveryCount,
      pendingPaymentCount,
      escalatedPaymentCount,
      blockedPaymentCount,
    };
  }
}
