import type { FailedPayment } from '../../domain/payments/types';
import type { BatchRecoveryResult, RecoveryCase } from './types';
import { buildRecoveryForecast, type ForecastInput } from '../forecast/recoveryForecast';

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
    const totalExpectedRecoverableRevenue = cases.reduce(
      (sum, c) => sum + c.recoveryScore.expectedRecoverableAmountInPaise,
      0,
    );

    let recoveredPaymentCount = 0;
    let failedRecoveryCount = 0;
    let pendingPaymentCount = 0;
    let escalatedPaymentCount = 0;
    let blockedPaymentCount = 0;
    let riskCriticalCount = 0;
    let riskHighCount = 0;
    let riskMediumCount = 0;
    let riskLowCount = 0;
    let totalRevenueUnrecoverableInPaise = 0;

    const forecastInputs: ForecastInput[] = [];

    for (const c of cases) {
      switch (c.executionResult.status) {
        case 'RECOVERED':   recoveredPaymentCount++;   break;
        case 'FAILED':      failedRecoveryCount++;     break;
        case 'PENDING':     pendingPaymentCount++;     break;
        case 'ESCALATED':   escalatedPaymentCount++;   break;
        case 'BLOCKED':     blockedPaymentCount++;     break;
      }

      switch (c.revenueAtRiskScore.level) {
        case 'CRITICAL': riskCriticalCount++; break;
        case 'HIGH':     riskHighCount++;     break;
        case 'MEDIUM':   riskMediumCount++;   break;
        case 'LOW':      riskLowCount++;      break;
      }

      totalRevenueUnrecoverableInPaise += c.revenueAtRiskScore.revenueAtRiskInPaise;

      forecastInputs.push({
        amountInPaise: c.payment.amount,
        expectedRecoverableAmountInPaise: c.recoveryScore.expectedRecoverableAmountInPaise,
        recoveryProbability: c.recoveryScore.recoveryProbability,
        executionStatus: c.executionResult.status,
        smartRetryDelayMinutes: c.smartRetryTiming?.delayMinutes ?? null,
      });
    }

    const forecast = buildRecoveryForecast(forecastInputs);

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
      totalExpectedRecoverableRevenue,
      totalRevenueUnrecoverableInPaise,
      riskCriticalCount,
      riskHighCount,
      riskMediumCount,
      riskLowCount,
      forecast,
    };
  }
}
