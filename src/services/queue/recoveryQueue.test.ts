import { describe, it, expect } from 'vitest';
import { buildRecoveryQueue } from './recoveryQueue';
import type { RecoveryCase } from '../recovery/types';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult } from '../../domain/executor/types';
import type { RecoveryScore } from '../../domain/recovery/recoveryScore';
import { computePaymentMethodSwitch } from '../../domain/recovery/paymentMethodSwitching';
import { calculateRevenueAtRisk } from '../../domain/recovery/revenueAtRisk';

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

const TS = '2025-06-01T12:00:00.000Z';

function makeScore(
  expectedRecoverableAmountInPaise: number,
  recoveryProbability: number,
  priority: RecoveryScore['priority'],
): RecoveryScore {
  return { expectedRecoverableAmountInPaise, recoveryProbability, priority };
}

function makeCase(
  id: string,
  amountInPaise: number,
  score: RecoveryScore,
  overrides: Partial<FailedPayment> = {},
): RecoveryCase {
  const payment: FailedPayment = {
    paymentId: id as FailedPayment['paymentId'],
    customerId: 'cust_001' as FailedPayment['customerId'],
    customerName: `Customer ${id}`,
    amount: amountInPaise,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 2,
    lastAttemptAt: TS,
    failedAt: TS,
    ...overrides,
  };
  const recommendation: RecoveryRecommendation = {
    diagnosis: 'Test diagnosis',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: score.recoveryProbability,
    reasoning: 'Test reasoning',
    maxAttempts: 2,
  };
  const policyDecision: PolicyDecision = {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'Approved for test',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: [],
  };
  const executionResult: RecoveryExecutionResult = {
    paymentId: payment.paymentId,
    action: 'RETRY_LATER',
    status: 'RECOVERED',
    executedAt: TS,
    recoveredAmount: amountInPaise,
    message: 'Test execution',
  };
  return {
    payment,
    recommendation,
    policyDecision,
    executionResult,
    auditEntries: [],
    recoveredAmount: amountInPaise,
    recoveryScore: score,
    smartRetryTiming: null,
    paymentMethodSwitch: computePaymentMethodSwitch({ payment }),
    revenueAtRiskScore: calculateRevenueAtRisk({
      amountInPaise,
      recoveryProbability: score.recoveryProbability,
      expectedRecoverableAmountInPaise: score.expectedRecoverableAmountInPaise,
      attemptCount: payment.attemptCount,
      previousSuccessfulPayments: payment.previousSuccessfulPayments,
      failedAt: payment.failedAt,
      now: TS,
    }),
  };
}

// ---------------------------------------------------------------------------
// Empty queue
// ---------------------------------------------------------------------------

describe('empty queue', () => {
  const queue = buildRecoveryQueue([]);

  it('items array is empty', () => {
    expect(queue.items).toHaveLength(0);
  });

  it('totalPayments is 0', () => {
    expect(queue.summary.totalPayments).toBe(0);
  });

  it('totalRevenueAtRiskInPaise is 0', () => {
    expect(queue.summary.totalRevenueAtRiskInPaise).toBe(0);
  });

  it('totalExpectedRecoveryInPaise is 0', () => {
    expect(queue.summary.totalExpectedRecoveryInPaise).toBe(0);
  });

  it('all priority counts are 0', () => {
    expect(queue.summary.highPriorityCount).toBe(0);
    expect(queue.summary.mediumPriorityCount).toBe(0);
    expect(queue.summary.lowPriorityCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single payment
// ---------------------------------------------------------------------------

describe('single payment', () => {
  const score = makeScore(450000, 0.90, 'HIGH');
  const c = makeCase('pay_001', 500000, score);
  const queue = buildRecoveryQueue([c]);

  it('returns one item', () => {
    expect(queue.items).toHaveLength(1);
  });

  it('single item has rank 1', () => {
    expect(queue.items[0].queueRank).toBe(1);
  });

  it('item carries correct paymentId', () => {
    expect(queue.items[0].paymentId).toBe('pay_001');
  });

  it('item carries correct recoveryScore', () => {
    expect(queue.items[0].recoveryScore).toEqual(score);
  });

  it('summary.totalPayments is 1', () => {
    expect(queue.summary.totalPayments).toBe(1);
  });

  it('summary.totalRevenueAtRiskInPaise equals payment amount', () => {
    expect(queue.summary.totalRevenueAtRiskInPaise).toBe(500000);
  });

  it('summary.totalExpectedRecoveryInPaise equals score expected', () => {
    expect(queue.summary.totalExpectedRecoveryInPaise).toBe(450000);
  });

  it('highPriorityCount is 1', () => {
    expect(queue.summary.highPriorityCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Primary sort: highest expected recovery first
// ---------------------------------------------------------------------------

describe('primary sort — highest expected recoverable revenue first', () => {
  const cases = [
    makeCase('pay_A', 400000, makeScore(200000, 0.50, 'MEDIUM')),
    makeCase('pay_B', 500000, makeScore(450000, 0.90, 'HIGH')),
    makeCase('pay_C', 300000, makeScore(240000, 0.80, 'HIGH')),
    makeCase('pay_D', 200000, makeScore(60000, 0.30, 'LOW')),
  ];
  const queue = buildRecoveryQueue(cases);

  it('rank 1 is pay_B (highest expected ₹450,000)', () => {
    expect(queue.items[0].paymentId).toBe('pay_B');
    expect(queue.items[0].queueRank).toBe(1);
  });

  it('rank 2 is pay_C (₹240,000)', () => {
    expect(queue.items[1].paymentId).toBe('pay_C');
    expect(queue.items[1].queueRank).toBe(2);
  });

  it('rank 3 is pay_A (₹200,000)', () => {
    expect(queue.items[2].paymentId).toBe('pay_A');
    expect(queue.items[2].queueRank).toBe(3);
  });

  it('rank 4 is pay_D (lowest expected ₹60,000)', () => {
    expect(queue.items[3].paymentId).toBe('pay_D');
    expect(queue.items[3].queueRank).toBe(4);
  });

  it('expected recovery is in strictly descending order', () => {
    for (let i = 1; i < queue.items.length; i++) {
      expect(queue.items[i].recoveryScore.expectedRecoverableAmountInPaise).toBeLessThanOrEqual(
        queue.items[i - 1].recoveryScore.expectedRecoverableAmountInPaise,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Sorting is NOT by amount alone
// ---------------------------------------------------------------------------

describe('sort by expected recovery, not raw payment amount', () => {
  // pay_LARGE: ₹50,000 at 20% → expected ₹10,000
  // pay_SMALL: ₹20,000 at 80% → expected ₹16,000
  // pay_SMALL has lower failed amount but should rank first
  const cases = [
    makeCase('pay_LARGE', 5000000, makeScore(1000000, 0.20, 'LOW')),
    makeCase('pay_SMALL', 2000000, makeScore(1600000, 0.80, 'HIGH')),
  ];
  const queue = buildRecoveryQueue(cases);

  it('pay_SMALL (lower amount, higher probability) ranks first', () => {
    expect(queue.items[0].paymentId).toBe('pay_SMALL');
  });

  it('pay_LARGE (higher amount, lower probability) ranks second', () => {
    expect(queue.items[1].paymentId).toBe('pay_LARGE');
  });
});

// ---------------------------------------------------------------------------
// Sorting is NOT by probability alone
// ---------------------------------------------------------------------------

describe('sort by expected recovery, not probability alone', () => {
  // pay_HIGH_PROB: ₹10,000 at 90% → expected ₹9,000
  // pay_LOW_PROB: ₹100,000 at 50% → expected ₹50,000
  // pay_LOW_PROB has lower probability but higher expected recovery
  const cases = [
    makeCase('pay_HIGH_PROB', 1000000, makeScore(900000, 0.90, 'HIGH')),
    makeCase('pay_LOW_PROB', 10000000, makeScore(5000000, 0.50, 'MEDIUM')),
  ];
  const queue = buildRecoveryQueue(cases);

  it('pay_LOW_PROB (lower probability, higher expected) ranks first', () => {
    expect(queue.items[0].paymentId).toBe('pay_LOW_PROB');
  });
});

// ---------------------------------------------------------------------------
// Tie-breaking 1: same expected recoverable → higher probability first
// ---------------------------------------------------------------------------

describe('tie-breaking by recovery probability when expected recovery is equal', () => {
  // 9 paise × 1.00 = 9 paise expected
  // 10 paise × 0.90 = 9 paise expected (same, but 1.00 > 0.90)
  const cases = [
    makeCase('pay_low_prob', 10, makeScore(9, 0.90, 'HIGH')),
    makeCase('pay_high_prob', 9, makeScore(9, 1.00, 'HIGH')),
  ];
  const queue = buildRecoveryQueue(cases);

  it('higher probability ranks first when expected recovery is equal', () => {
    expect(queue.items[0].paymentId).toBe('pay_high_prob');
  });

  it('lower probability ranks second', () => {
    expect(queue.items[1].paymentId).toBe('pay_low_prob');
  });
});

// ---------------------------------------------------------------------------
// Tie-breaking 2: same expected recoverable, same probability → higher amount first
// ---------------------------------------------------------------------------

describe('tie-breaking by payment amount when expected recovery and probability are equal', () => {
  // 200 × 0.5 = 100,  199 × 0.5 = 99.5 → rounds to 100 (same expected!)
  const cases = [
    makeCase('pay_lower_amount', 199, makeScore(100, 0.5, 'MEDIUM')),
    makeCase('pay_higher_amount', 200, makeScore(100, 0.5, 'MEDIUM')),
  ];
  const queue = buildRecoveryQueue(cases);

  it('higher amount ranks first when expected and probability are tied', () => {
    expect(queue.items[0].paymentId).toBe('pay_higher_amount');
  });

  it('lower amount ranks second', () => {
    expect(queue.items[1].paymentId).toBe('pay_lower_amount');
  });
});

// ---------------------------------------------------------------------------
// Tie-breaking 3: everything equal → paymentId ASC (stable deterministic)
// ---------------------------------------------------------------------------

describe('deterministic final tie-breaking by paymentId ASC', () => {
  const score = makeScore(100, 0.5, 'MEDIUM');
  const cases = [
    makeCase('pay_zzz', 200, score),
    makeCase('pay_aaa', 200, score),
    makeCase('pay_mmm', 200, score),
  ];
  const queue = buildRecoveryQueue(cases);

  it('pay_aaa is first (alphabetically earliest)', () => {
    expect(queue.items[0].paymentId).toBe('pay_aaa');
  });

  it('pay_mmm is second', () => {
    expect(queue.items[1].paymentId).toBe('pay_mmm');
  });

  it('pay_zzz is last', () => {
    expect(queue.items[2].paymentId).toBe('pay_zzz');
  });
});

// ---------------------------------------------------------------------------
// Queue ranks are sequential and 1-based
// ---------------------------------------------------------------------------

describe('queue rank assignment', () => {
  const cases = [
    makeCase('pay_r1', 100000, makeScore(90000, 0.90, 'HIGH')),
    makeCase('pay_r2', 80000, makeScore(64000, 0.80, 'HIGH')),
    makeCase('pay_r3', 60000, makeScore(30000, 0.50, 'MEDIUM')),
  ];
  const queue = buildRecoveryQueue(cases);

  it('first item has rank 1', () => expect(queue.items[0].queueRank).toBe(1));
  it('second item has rank 2', () => expect(queue.items[1].queueRank).toBe(2));
  it('third item has rank 3', () => expect(queue.items[2].queueRank).toBe(3));

  it('ranks are sequential without gaps', () => {
    queue.items.forEach((item, i) => {
      expect(item.queueRank).toBe(i + 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Summary — total revenue at risk
// ---------------------------------------------------------------------------

describe('summary.totalRevenueAtRiskInPaise', () => {
  it('sums all payment amounts regardless of score', () => {
    const cases = [
      makeCase('pay_s1', 100000, makeScore(90000, 0.9, 'HIGH')),
      makeCase('pay_s2', 200000, makeScore(100000, 0.5, 'MEDIUM')),
      makeCase('pay_s3', 50000, makeScore(15000, 0.3, 'LOW')),
    ];
    const queue = buildRecoveryQueue(cases);
    expect(queue.summary.totalRevenueAtRiskInPaise).toBe(350000);
  });
});

// ---------------------------------------------------------------------------
// Summary — total expected recovery
// ---------------------------------------------------------------------------

describe('summary.totalExpectedRecoveryInPaise', () => {
  it('sums expectedRecoverableAmountInPaise from all items', () => {
    const cases = [
      makeCase('pay_e1', 100000, makeScore(90000, 0.9, 'HIGH')),
      makeCase('pay_e2', 200000, makeScore(100000, 0.5, 'MEDIUM')),
      makeCase('pay_e3', 50000, makeScore(15000, 0.3, 'LOW')),
    ];
    const queue = buildRecoveryQueue(cases);
    expect(queue.summary.totalExpectedRecoveryInPaise).toBe(205000);
  });

  it('is 0 when all probabilities are 0', () => {
    const cases = [
      makeCase('pay_z1', 100000, makeScore(0, 0, 'LOW')),
      makeCase('pay_z2', 200000, makeScore(0, 0, 'LOW')),
    ];
    const queue = buildRecoveryQueue(cases);
    expect(queue.summary.totalExpectedRecoveryInPaise).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Summary — priority counts
// ---------------------------------------------------------------------------

describe('summary priority counts', () => {
  it('correctly tallies HIGH, MEDIUM, and LOW counts', () => {
    const cases = [
      makeCase('pay_h1', 500000, makeScore(450000, 0.90, 'HIGH')),
      makeCase('pay_h2', 400000, makeScore(320000, 0.80, 'HIGH')),
      makeCase('pay_h3', 300000, makeScore(210000, 0.70, 'HIGH')),
      makeCase('pay_m1', 200000, makeScore(100000, 0.50, 'MEDIUM')),
      makeCase('pay_m2', 150000, makeScore(63000, 0.42, 'MEDIUM')),
      makeCase('pay_l1', 100000, makeScore(20000, 0.20, 'LOW')),
    ];
    const queue = buildRecoveryQueue(cases);

    expect(queue.summary.highPriorityCount).toBe(3);
    expect(queue.summary.mediumPriorityCount).toBe(2);
    expect(queue.summary.lowPriorityCount).toBe(1);
  });

  it('priority counts sum to totalPayments', () => {
    const cases = [
      makeCase('pay_c1', 500000, makeScore(400000, 0.80, 'HIGH')),
      makeCase('pay_c2', 300000, makeScore(150000, 0.50, 'MEDIUM')),
      makeCase('pay_c3', 100000, makeScore(10000, 0.10, 'LOW')),
    ];
    const queue = buildRecoveryQueue(cases);
    const countSum =
      queue.summary.highPriorityCount +
      queue.summary.mediumPriorityCount +
      queue.summary.lowPriorityCount;
    expect(countSum).toBe(queue.summary.totalPayments);
  });

  it('all HIGH when all probabilities are >= 0.70', () => {
    const cases = [
      makeCase('pay_ah1', 500000, makeScore(400000, 0.80, 'HIGH')),
      makeCase('pay_ah2', 300000, makeScore(240000, 0.80, 'HIGH')),
    ];
    const queue = buildRecoveryQueue(cases);
    expect(queue.summary.highPriorityCount).toBe(2);
    expect(queue.summary.mediumPriorityCount).toBe(0);
    expect(queue.summary.lowPriorityCount).toBe(0);
  });

  it('all LOW when all probabilities are < 0.40', () => {
    const cases = [
      makeCase('pay_al1', 500000, makeScore(100000, 0.20, 'LOW')),
      makeCase('pay_al2', 300000, makeScore(90000, 0.30, 'LOW')),
    ];
    const queue = buildRecoveryQueue(cases);
    expect(queue.summary.highPriorityCount).toBe(0);
    expect(queue.summary.mediumPriorityCount).toBe(0);
    expect(queue.summary.lowPriorityCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Input immutability
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('does not mutate the input cases array', () => {
    const cases = [
      makeCase('pay_imm_1', 100000, makeScore(90000, 0.90, 'HIGH')),
      makeCase('pay_imm_2', 200000, makeScore(100000, 0.50, 'MEDIUM')),
    ];
    const originalOrder = cases.map((c) => c.payment.paymentId);
    buildRecoveryQueue(cases);
    expect(cases.map((c) => c.payment.paymentId)).toEqual(originalOrder);
  });

  it('does not mutate individual RecoveryCase objects', () => {
    const cases = [
      makeCase('pay_imm_3', 100000, makeScore(90000, 0.90, 'HIGH')),
    ];
    const snapshot = JSON.stringify(cases[0]);
    buildRecoveryQueue(cases);
    expect(JSON.stringify(cases[0])).toBe(snapshot);
  });

  it('returned items array is independent of the input', () => {
    const cases = [
      makeCase('pay_imm_4', 100000, makeScore(90000, 0.90, 'HIGH')),
    ];
    const queue = buildRecoveryQueue(cases);
    (queue.items as unknown[]).push({});
    expect(buildRecoveryQueue(cases).items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical results on two consecutive calls with the same input', () => {
    const cases = [
      makeCase('pay_det_A', 500000, makeScore(450000, 0.90, 'HIGH')),
      makeCase('pay_det_B', 300000, makeScore(240000, 0.80, 'HIGH')),
      makeCase('pay_det_C', 400000, makeScore(200000, 0.50, 'MEDIUM')),
    ];

    const first = buildRecoveryQueue(cases);
    const second = buildRecoveryQueue(cases);

    expect(first.items.map((i) => i.paymentId)).toEqual(second.items.map((i) => i.paymentId));
    expect(first.items.map((i) => i.queueRank)).toEqual(second.items.map((i) => i.queueRank));
    expect(first.summary).toEqual(second.summary);
  });

  it('input order does not affect output order', () => {
    const score = (expected: number, prob: number, priority: RecoveryScore['priority']) =>
      makeScore(expected, prob, priority);

    const cases1 = [
      makeCase('pay_ord_A', 500000, score(450000, 0.90, 'HIGH')),
      makeCase('pay_ord_B', 300000, score(240000, 0.80, 'HIGH')),
      makeCase('pay_ord_C', 400000, score(200000, 0.50, 'MEDIUM')),
    ];
    const cases2 = [
      makeCase('pay_ord_C', 400000, score(200000, 0.50, 'MEDIUM')),
      makeCase('pay_ord_A', 500000, score(450000, 0.90, 'HIGH')),
      makeCase('pay_ord_B', 300000, score(240000, 0.80, 'HIGH')),
    ];

    const q1 = buildRecoveryQueue(cases1);
    const q2 = buildRecoveryQueue(cases2);

    expect(q1.items.map((i) => i.paymentId)).toEqual(q2.items.map((i) => i.paymentId));
  });
});

// ---------------------------------------------------------------------------
// QueueItem fields
// ---------------------------------------------------------------------------

describe('queue item field mapping', () => {
  it('paymentId, customerId, customerName, amounts, failureReason, paymentMethod are correctly projected', () => {
    const score = makeScore(400000, 0.80, 'HIGH');
    const c = makeCase('pay_field_test', 500000, score, {
      customerId: 'cust_xyz' as FailedPayment['customerId'],
      customerName: 'Test Customer',
      failureReason: 'EXPIRED_CARD',
      paymentMethod: 'CARD',
    });
    const queue = buildRecoveryQueue([c]);
    const item = queue.items[0];

    expect(item.paymentId).toBe('pay_field_test');
    expect(item.customerId).toBe('cust_xyz');
    expect(item.customerName).toBe('Test Customer');
    expect(item.amountInPaise).toBe(500000);
    expect(item.failureReason).toBe('EXPIRED_CARD');
    expect(item.paymentMethod).toBe('CARD');
    expect(item.recoveryScore).toEqual(score);
  });

  it('recommendedAction is projected from recommendation', () => {
    const c = makeCase('pay_action_test', 100000, makeScore(80000, 0.80, 'HIGH'));
    const queue = buildRecoveryQueue([c]);
    expect(queue.items[0].recommendedAction).toBe('RETRY_LATER');
  });
});
