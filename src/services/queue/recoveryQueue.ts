import type { RecoveryCase } from '../recovery/types';
import type { QueueItem, QueueSummary, RecoveryQueue } from './types';

type UnrankedItem = Omit<QueueItem, 'queueRank'>;

function toUnrankedItem(c: RecoveryCase): UnrankedItem {
  return {
    paymentId: c.payment.paymentId,
    customerId: c.payment.customerId,
    customerName: c.payment.customerName,
    amountInPaise: c.payment.amount,
    failureReason: c.payment.failureReason,
    paymentMethod: c.payment.paymentMethod,
    recommendedAction: c.recommendation.recommendedAction,
    recoveryScore: c.recoveryScore,
    smartRetryTiming: c.smartRetryTiming,
    paymentMethodSwitch: c.paymentMethodSwitch,
    revenueAtRiskScore: c.revenueAtRiskScore,
  };
}

// Descending by expected recoverable revenue.
// Ties broken by: probability DESC → amount DESC → paymentId ASC (stable).
function compareItems(a: UnrankedItem, b: UnrankedItem): number {
  const expectedDiff =
    b.recoveryScore.expectedRecoverableAmountInPaise -
    a.recoveryScore.expectedRecoverableAmountInPaise;
  if (expectedDiff !== 0) return expectedDiff;

  const probDiff = b.recoveryScore.recoveryProbability - a.recoveryScore.recoveryProbability;
  if (probDiff !== 0) return probDiff;

  const amountDiff = b.amountInPaise - a.amountInPaise;
  if (amountDiff !== 0) return amountDiff;

  if (a.paymentId < b.paymentId) return -1;
  if (a.paymentId > b.paymentId) return 1;
  return 0;
}

export function buildRecoveryQueue(cases: readonly RecoveryCase[]): RecoveryQueue {
  const sorted = cases.map(toUnrankedItem).sort(compareItems);

  let highPriorityCount = 0;
  let mediumPriorityCount = 0;
  let lowPriorityCount = 0;
  let totalRevenueAtRiskInPaise = 0;
  let totalExpectedRecoveryInPaise = 0;

  const items: QueueItem[] = sorted.map((item, index) => {
    totalRevenueAtRiskInPaise += item.amountInPaise;
    totalExpectedRecoveryInPaise += item.recoveryScore.expectedRecoverableAmountInPaise;
    switch (item.recoveryScore.priority) {
      case 'HIGH': highPriorityCount++; break;
      case 'MEDIUM': mediumPriorityCount++; break;
      case 'LOW': lowPriorityCount++; break;
    }
    return { ...item, queueRank: index + 1 };
  });

  const summary: QueueSummary = {
    totalPayments: items.length,
    totalRevenueAtRiskInPaise,
    totalExpectedRecoveryInPaise,
    highPriorityCount,
    mediumPriorityCount,
    lowPriorityCount,
  };

  return { items, summary };
}
