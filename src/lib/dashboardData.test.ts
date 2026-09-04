import { describe, expect, it } from 'vitest';
import { buildRecoveryQueue } from '../services/queue/recoveryQueue';
import { getRecoveryCaseByPaymentId, runDashboard } from './dashboardData';

describe('dashboard Recovery Score consistency', () => {
  it('dashboard expected recoverable total equals the sum of row-level recovery scores', () => {
    const dashboard = runDashboard();
    const rowTotal = dashboard.batch.cases.reduce(
      (sum, c) => sum + c.recoveryScore.expectedRecoverableAmountInPaise,
      0,
    );

    expect(dashboard.batch.totalExpectedRecoverableRevenue).toBe(rowTotal);
  });

  it('Recovery Queue summary equals the same row-level recovery score total', () => {
    const dashboard = runDashboard();
    const queue = buildRecoveryQueue(dashboard.batch.cases);
    const rowTotal = queue.items.reduce(
      (sum, item) => sum + item.recoveryScore.expectedRecoverableAmountInPaise,
      0,
    );

    expect(queue.summary.totalExpectedRecoveryInPaise).toBe(rowTotal);
    expect(queue.summary.totalExpectedRecoveryInPaise).toBe(
      dashboard.batch.totalExpectedRecoverableRevenue,
    );
  });

  it('forecast expected recovery uses recovery score expected amounts for active non-blocked payments', () => {
    const dashboard = runDashboard();
    const expectedForecastTotal = dashboard.batch.cases
      .filter((c) => c.executionResult.status !== 'RECOVERED')
      .filter((c) => c.executionResult.status !== 'BLOCKED')
      .reduce((sum, c) => sum + c.recoveryScore.expectedRecoverableAmountInPaise, 0);

    expect(dashboard.batch.forecast.expectedRecoveredRevenueInPaise).toBe(expectedForecastTotal);
  });

  it('payment detail lookup returns the same recovery score as the dashboard row', () => {
    const dashboard = runDashboard();
    const dashboardCase = dashboard.batch.cases[0];
    expect(dashboardCase).toBeDefined();

    const detailCase = getRecoveryCaseByPaymentId(dashboardCase.payment.paymentId);

    expect(detailCase?.recoveryScore).toEqual(dashboardCase.recoveryScore);
  });
});
