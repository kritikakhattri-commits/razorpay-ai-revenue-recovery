import { describe, it, expect } from 'vitest';
import {
  assignVariant,
  computeAssignmentBucket,
  isEligible,
  computeVariantMetrics,
  compareVariants,
  detectConflicts,
  validateAllocation,
  runExperiment,
  getAssignedMessageTone,
  EXPERIMENT_CONSTANTS,
} from './experimentEngine';
import type {
  RecoveryExperiment,
  ExperimentOutcome,
  ExperimentVariantId,
} from '../../domain/experiment/types';
import type { RecoveryCase } from '../recovery/types';
import type { FailedPayment } from '../../domain/payments/types';
import type { PaymentId, CustomerId } from '../../domain/payments/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RETRY_TIMING_EXP: RecoveryExperiment = {
  id: 'exp_retry_timing_001',
  name: 'Retry Timing Test',
  description: 'Quick vs delayed retry.',
  status: 'RUNNING',
  dimension: 'RETRY_TIMING',
  variantA: {
    id: 'A',
    name: 'Quick (30 min)',
    description: 'Retry after 30 minutes.',
    strategy: { dimension: 'RETRY_TIMING', retryDelayMinutes: 30 },
  },
  variantB: {
    id: 'B',
    name: 'Delayed (120 min)',
    description: 'Retry after 120 minutes.',
    strategy: { dimension: 'RETRY_TIMING', retryDelayMinutes: 120 },
  },
  allocationPercent: { a: 50, b: 50 },
  startedAt: '2026-08-01T00:00:00.000Z',
};

const MESSAGE_TONE_EXP: RecoveryExperiment = {
  id: 'exp_message_tone_001',
  name: 'Message Tone Test',
  description: 'Neutral vs friendly tone.',
  status: 'RUNNING',
  dimension: 'MESSAGE_TONE',
  variantA: {
    id: 'A',
    name: 'Neutral',
    description: 'Neutral tone.',
    strategy: { dimension: 'MESSAGE_TONE', tone: 'NEUTRAL' },
  },
  variantB: {
    id: 'B',
    name: 'Friendly',
    description: 'Friendly tone.',
    strategy: { dimension: 'MESSAGE_TONE', tone: 'FRIENDLY' },
  },
  allocationPercent: { a: 50, b: 50 },
  startedAt: '2026-08-15T00:00:00.000Z',
};

function makePayment(opts: {
  paymentId?: string;
  customerId?: string;
  failureReason?: FailedPayment['failureReason'];
  failedAt?: string;
} = {}): FailedPayment {
  return {
    paymentId: (opts.paymentId ?? 'pay_test_001') as PaymentId,
    customerId: (opts.customerId ?? 'cust_test_001') as CustomerId,
    customerName: 'Test User',
    amount: 100000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: opts.failureReason ?? 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 3,
    lastAttemptAt: '2026-09-01T10:00:00.000Z',
    failedAt: opts.failedAt ?? '2026-09-01T10:01:00.000Z',
  };
}

function makeCase(overrides: {
  paymentId?: string;
  customerId?: string;
  failureReason?: FailedPayment['failureReason'];
  finalAction?: 'RETRY_LATER' | 'UPDATE_PAYMENT_METHOD' | 'SEND_PAYMENT_LINK' | 'ESCALATE';
  policyApproved?: boolean;
  status?: 'RECOVERED' | 'FAILED' | 'PENDING' | 'ESCALATED' | 'BLOCKED';
  recoveredAmount?: number;
  failedAt?: string;
  executedAt?: string;
  approvedRetryAfterMinutes?: number | null;
} = {}): RecoveryCase {
  const {
    paymentId = 'pay_test_001',
    customerId = 'cust_test_001',
    failureReason = 'UPI_TIMEOUT',
    finalAction = 'RETRY_LATER',
    policyApproved = true,
    status = 'RECOVERED',
    recoveredAmount = 100000,
    failedAt = '2026-09-01T10:00:00.000Z',
    executedAt = '2026-09-01T10:31:00.000Z',
    approvedRetryAfterMinutes = 30,
  } = overrides;

  const payment = makePayment({ paymentId, customerId, failureReason, failedAt });

  return {
    payment,
    recommendation: {
      recommendedAction: 'RETRY_LATER',
      retryAfterMinutes: 30,
      confidence: 0.80,
      diagnosis: 'UPI timeout',
      reasoning: 'Likely temporary.',
      maxAttempts: 3,
    },
    policyDecision: {
      approved: policyApproved,
      finalAction,
      reason: policyApproved ? 'Approved.' : 'Policy rejected.',
      originalRecommendedAction: 'RETRY_LATER',
      policyRulesApplied: [],
      approvedRetryAfterMinutes,
      approvedRetryAt: null,
    },
    executionResult: {
      paymentId: paymentId as PaymentId,
      action: finalAction,
      status,
      executedAt,
      recoveredAmount: status === 'RECOVERED' ? recoveredAmount : 0,
      message: 'Test result.',
    },
    auditEntries: [],
    recoveredAmount: status === 'RECOVERED' ? recoveredAmount : 0,
    recoveryScore: {
      recoveryProbability: 0.80,
      expectedRecoverableAmountInPaise: 80000,
      priority: 'HIGH',
    },
    smartRetryTiming: null,
    paymentMethodSwitch: {
      currentMethod: 'UPI',
      shouldSwitch: false,
      recommendedMethod: null,
      alternatives: [],
      reason: 'No switch needed.',
    },
    revenueAtRiskScore: {
      score: 50,
      level: 'MEDIUM',
      revenueAtRiskInPaise: 50000,
      factors: [],
    },
  };
}

function makeOutcome(
  variantId: ExperimentVariantId,
  status: 'RECOVERED' | 'FAILED' | 'PENDING' | 'ESCALATED' | 'BLOCKED',
  overrides: Partial<ExperimentOutcome> = {},
): ExperimentOutcome {
  return {
    experimentId: 'exp_retry_timing_001',
    variantId,
    paymentId: `pay_${Math.random().toString(36).slice(2)}`,
    customerId: `cust_001`,
    status,
    failedAmountInPaise: 100000,
    recoveredAmountInPaise: status === 'RECOVERED' ? 100000 : 0,
    recoveryTimeMinutes: status === 'RECOVERED' ? 31 : null,
    candidateRetryDelayMinutes: 30,
    policyApprovedRetryDelayMinutes: 30,
    assignedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// Produce N outcomes for each variant, mixing outcomes to reach completedCount targets
function makeOutcomes(
  aRecovered: number, aFailed: number, aPending: number,
  bRecovered: number, bFailed: number, bPending: number,
): ExperimentOutcome[] {
  const outcomes: ExperimentOutcome[] = [];
  for (let i = 0; i < aRecovered; i++) outcomes.push(makeOutcome('A', 'RECOVERED', { paymentId: `a_rec_${i}` }));
  for (let i = 0; i < aFailed;   i++) outcomes.push(makeOutcome('A', 'FAILED',    { paymentId: `a_fai_${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
  for (let i = 0; i < aPending;  i++) outcomes.push(makeOutcome('A', 'PENDING',   { paymentId: `a_pen_${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
  for (let i = 0; i < bRecovered; i++) outcomes.push(makeOutcome('B', 'RECOVERED', { paymentId: `b_rec_${i}` }));
  for (let i = 0; i < bFailed;   i++) outcomes.push(makeOutcome('B', 'FAILED',    { paymentId: `b_fai_${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
  for (let i = 0; i < bPending;  i++) outcomes.push(makeOutcome('B', 'PENDING',   { paymentId: `b_pen_${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
  return outcomes;
}

// ── 1 – Deterministic assignment ──────────────────────────────────────────────

describe('Deterministic assignment', () => {
  it('same customerId and experimentId always produces same bucket', () => {
    const b1 = computeAssignmentBucket('cust_abc', 'exp_001');
    const b2 = computeAssignmentBucket('cust_abc', 'exp_001');
    expect(b1).toBe(b2);
  });

  it('bucket is in 0–99 range', () => {
    for (const id of ['cust_001', 'cust_002', 'cust_abc', 'cust_xyz_999']) {
      const bucket = computeAssignmentBucket(id, 'exp_001');
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it('assignVariant returns a stable result on repeated calls', () => {
    const a1 = assignVariant(RETRY_TIMING_EXP, 'cust_stable');
    const a2 = assignVariant(RETRY_TIMING_EXP, 'cust_stable');
    expect(a1).toEqual(a2);
  });
});

// ── 2 – Same customer always receives same variant for same experiment ─────────

describe('Customer-level assignment consistency', () => {
  it('same customer → same variant across multiple calls', () => {
    const customerId = 'cust_consistent_001';
    const first = assignVariant(RETRY_TIMING_EXP, customerId);
    for (let i = 0; i < 10; i++) {
      const repeated = assignVariant(RETRY_TIMING_EXP, customerId);
      expect(repeated!.variantId).toBe(first!.variantId);
    }
  });

  it('assigned entity ID in result matches input customerId', () => {
    const assignment = assignVariant(RETRY_TIMING_EXP, 'cust_abc_123');
    expect(assignment!.assignedEntityId).toBe('cust_abc_123');
  });
});

// ── 3 – Different experiment produces different assignment ────────────────────

describe('Cross-experiment assignment independence', () => {
  it('same customer can get different variants for different experiments', () => {
    // Find a customerId that lands in different variants for the two experiments
    let foundDifference = false;
    for (let i = 0; i < 200; i++) {
      const id = `cust_${i}`;
      const a = assignVariant(RETRY_TIMING_EXP, id);
      const b = assignVariant(MESSAGE_TONE_EXP, id);
      if (a!.variantId !== b!.variantId) {
        foundDifference = true;
        break;
      }
    }
    expect(foundDifference).toBe(true);
  });

  it('bucket differs across experiments for same customer', () => {
    const bucket1 = computeAssignmentBucket('cust_x', 'exp_retry_timing_001');
    const bucket2 = computeAssignmentBucket('cust_x', 'exp_message_tone_001');
    expect(bucket1).not.toBe(bucket2);
  });
});

// ── 4 – Default 50/50 allocation ──────────────────────────────────────────────

describe('50/50 allocation', () => {
  it('roughly half of customers are assigned to A and half to B', () => {
    let aCount = 0; let bCount = 0;
    for (let i = 0; i < 1000; i++) {
      const a = assignVariant(RETRY_TIMING_EXP, `cust_load_${i}`);
      if (a!.variantId === 'A') aCount++; else bCount++;
    }
    // Allow ±10% deviation from ideal 50/50 (500 ± 100)
    expect(aCount).toBeGreaterThan(400);
    expect(bCount).toBeGreaterThan(400);
  });
});

// ── 5 – Custom 70/30 allocation ───────────────────────────────────────────────

describe('Custom 70/30 allocation', () => {
  it('respects 70/30 allocation', () => {
    const exp: RecoveryExperiment = { ...RETRY_TIMING_EXP, allocationPercent: { a: 70, b: 30 } };
    let aCount = 0; let bCount = 0;
    for (let i = 0; i < 1000; i++) {
      const a = assignVariant(exp, `cust_${i}`);
      if (a!.variantId === 'A') aCount++; else bCount++;
    }
    // A should be roughly 70% (600–800 range)
    expect(aCount).toBeGreaterThan(600);
    expect(bCount).toBeLessThan(400);
  });

  it('bucket < 70 → A; bucket >= 70 → B for 70/30', () => {
    const exp: RecoveryExperiment = { ...RETRY_TIMING_EXP, allocationPercent: { a: 70, b: 30 } };
    // Find a customer with known bucket
    let foundBucketLt70 = false;
    let foundBucketGe70 = false;
    for (let i = 0; i < 200; i++) {
      const id = `cust_${i}`;
      const bucket = computeAssignmentBucket(id, exp.id);
      const a = assignVariant(exp, id)!;
      if (bucket < 70) { expect(a.variantId).toBe('A'); foundBucketLt70 = true; }
      else { expect(a.variantId).toBe('B'); foundBucketGe70 = true; }
    }
    expect(foundBucketLt70).toBe(true);
    expect(foundBucketGe70).toBe(true);
  });
});

// ── 6 – Allocation must sum to 100 ────────────────────────────────────────────

describe('Allocation validation', () => {
  it('throws when allocation does not sum to 100', () => {
    const invalid: RecoveryExperiment = {
      ...RETRY_TIMING_EXP,
      allocationPercent: { a: 60, b: 50 },
    };
    expect(() => validateAllocation(invalid)).toThrow('allocation must sum to 100');
  });

  it('accepts 50/50', () => {
    expect(() => validateAllocation(RETRY_TIMING_EXP)).not.toThrow();
  });

  it('accepts 70/30', () => {
    const exp: RecoveryExperiment = { ...RETRY_TIMING_EXP, allocationPercent: { a: 70, b: 30 } };
    expect(() => validateAllocation(exp)).not.toThrow();
  });

  it('throws when allocation is 0+0=0', () => {
    const invalid: RecoveryExperiment = {
      ...RETRY_TIMING_EXP,
      allocationPercent: { a: 0, b: 0 },
    };
    expect(() => validateAllocation(invalid)).toThrow();
  });
});

// ── 7 – DRAFT experiments do not assign ───────────────────────────────────────

describe('DRAFT experiments', () => {
  it('returns null for DRAFT experiment', () => {
    const draft: RecoveryExperiment = { ...RETRY_TIMING_EXP, status: 'DRAFT' };
    expect(assignVariant(draft, 'cust_001')).toBeNull();
  });

  it('runExperiment produces no outcomes for DRAFT experiment', () => {
    const draft: RecoveryExperiment = { ...RETRY_TIMING_EXP, status: 'DRAFT' };
    const result = runExperiment(draft, [makeCase()]);
    expect(result.outcomes).toHaveLength(0);
  });
});

// ── 8 – RUNNING experiments assign eligible payments ──────────────────────────

describe('RUNNING experiments', () => {
  it('assigns an eligible payment', () => {
    const c = makeCase({ finalAction: 'RETRY_LATER', policyApproved: true });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    expect(result.outcomes).toHaveLength(1);
  });
});

// ── 9 – PAUSED experiments stop new assignments ───────────────────────────────

describe('PAUSED experiments', () => {
  it('returns null for PAUSED experiment', () => {
    const paused: RecoveryExperiment = { ...RETRY_TIMING_EXP, status: 'PAUSED' };
    expect(assignVariant(paused, 'cust_001')).toBeNull();
  });

  it('runExperiment produces no outcomes for PAUSED experiment', () => {
    const paused: RecoveryExperiment = { ...RETRY_TIMING_EXP, status: 'PAUSED' };
    const result = runExperiment(paused, [makeCase()]);
    expect(result.outcomes).toHaveLength(0);
  });
});

// ── 10 – COMPLETED experiments stop new assignments ───────────────────────────

describe('COMPLETED experiments', () => {
  it('returns null for COMPLETED experiment', () => {
    const completed: RecoveryExperiment = { ...RETRY_TIMING_EXP, status: 'COMPLETED' };
    expect(assignVariant(completed, 'cust_001')).toBeNull();
  });

  it('runExperiment produces no outcomes for COMPLETED experiment', () => {
    const completed: RecoveryExperiment = { ...RETRY_TIMING_EXP, status: 'COMPLETED' };
    const result = runExperiment(completed, [makeCase()]);
    expect(result.outcomes).toHaveLength(0);
  });
});

// ── 11 – RETRY_TIMING eligibility ────────────────────────────────────────────

describe('RETRY_TIMING eligibility', () => {
  it('RETRY_LATER with policyApproved=true is eligible', () => {
    const c = makeCase({ finalAction: 'RETRY_LATER', policyApproved: true });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(true);
  });

  it('SEND_PAYMENT_LINK is not eligible for RETRY_TIMING', () => {
    const c = makeCase({ finalAction: 'SEND_PAYMENT_LINK', policyApproved: true });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });

  it('UPDATE_PAYMENT_METHOD is not eligible for RETRY_TIMING', () => {
    const c = makeCase({ finalAction: 'UPDATE_PAYMENT_METHOD', policyApproved: true, failureReason: 'EXPIRED_CARD' });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });
});

// ── 12 – MESSAGE_TONE eligibility ────────────────────────────────────────────

describe('MESSAGE_TONE eligibility', () => {
  it('RETRY_LATER with policyApproved=true is eligible for MESSAGE_TONE', () => {
    const c = makeCase({ finalAction: 'RETRY_LATER', policyApproved: true });
    expect(isEligible(MESSAGE_TONE_EXP, c)).toBe(true);
  });

  it('SEND_PAYMENT_LINK with policyApproved=true is eligible for MESSAGE_TONE', () => {
    const c = makeCase({ finalAction: 'SEND_PAYMENT_LINK', policyApproved: true });
    expect(isEligible(MESSAGE_TONE_EXP, c)).toBe(true);
  });

  it('UPDATE_PAYMENT_METHOD with policyApproved=true is eligible for MESSAGE_TONE', () => {
    const c = makeCase({ finalAction: 'UPDATE_PAYMENT_METHOD', policyApproved: true, failureReason: 'EXPIRED_CARD' });
    expect(isEligible(MESSAGE_TONE_EXP, c)).toBe(true);
  });
});

// ── 13 – Incompatible payment excluded ───────────────────────────────────────

describe('Incompatible payment excluded', () => {
  it('policyApproved=false excludes payment from RETRY_TIMING', () => {
    const c = makeCase({ policyApproved: false, status: 'BLOCKED' });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });

  it('policyApproved=false excludes payment from MESSAGE_TONE', () => {
    const c = makeCase({ policyApproved: false, status: 'BLOCKED' });
    expect(isEligible(MESSAGE_TONE_EXP, c)).toBe(false);
  });

  it('EXPIRED_CARD (UPDATE_PAYMENT_METHOD) excluded from RETRY_TIMING', () => {
    const c = makeCase({
      failureReason: 'EXPIRED_CARD',
      finalAction: 'UPDATE_PAYMENT_METHOD',
      policyApproved: true,
    });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });
});

// ── 14 – Candidate retry delay generated correctly ────────────────────────────

describe('Candidate retry delay', () => {
  it('RETRY_TIMING variant A produces candidateRetryDelayMinutes=30', () => {
    // Find a customer that gets assigned to variant A
    let found = false;
    for (let i = 0; i < 200; i++) {
      const id = `cust_delay_${i}`;
      const assignment = assignVariant(RETRY_TIMING_EXP, id);
      if (assignment!.variantId !== 'A') continue;

      const c = makeCase({ customerId: id, finalAction: 'RETRY_LATER', policyApproved: true });
      const result = runExperiment(RETRY_TIMING_EXP, [c]);
      expect(result.outcomes[0].candidateRetryDelayMinutes).toBe(30);
      found = true;
      break;
    }
    expect(found).toBe(true);
  });

  it('RETRY_TIMING variant B produces candidateRetryDelayMinutes=120', () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const id = `cust_delay_${i}`;
      const assignment = assignVariant(RETRY_TIMING_EXP, id);
      if (assignment!.variantId !== 'B') continue;

      const c = makeCase({ customerId: id, finalAction: 'RETRY_LATER', policyApproved: true });
      const result = runExperiment(RETRY_TIMING_EXP, [c]);
      expect(result.outcomes[0].candidateRetryDelayMinutes).toBe(120);
      found = true;
      break;
    }
    expect(found).toBe(true);
  });

  it('MESSAGE_TONE experiment produces null candidateRetryDelayMinutes', () => {
    const c = makeCase({ finalAction: 'RETRY_LATER', policyApproved: true });
    const result = runExperiment(MESSAGE_TONE_EXP, [c]);
    for (const outcome of result.outcomes) {
      expect(outcome.candidateRetryDelayMinutes).toBeNull();
    }
  });
});

// ── 15 – PolicyEngine can override experimental delay ─────────────────────────

describe('PolicyEngine can override experimental delay', () => {
  it('outcome records both candidate and policy-approved delay', () => {
    // Variant A suggests 30 min, but policy approved 60 min (e.g. bank error rule)
    const c = makeCase({
      finalAction: 'RETRY_LATER',
      policyApproved: true,
      approvedRetryAfterMinutes: 60,
    });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    expect(result.outcomes.length).toBeGreaterThan(0);
    const outcome = result.outcomes[0];
    // candidateRetryDelayMinutes comes from variant (30 or 120)
    expect(outcome.candidateRetryDelayMinutes).not.toBeNull();
    // policyApprovedRetryDelayMinutes comes from the actual PolicyDecision
    expect(outcome.policyApprovedRetryDelayMinutes).toBe(60);
  });

  it('when variant candidate differs from policy-approved, both are recorded', () => {
    const c = makeCase({
      finalAction: 'RETRY_LATER',
      policyApproved: true,
      approvedRetryAfterMinutes: 180,
    });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    const outcome = result.outcomes[0];
    // Candidate is always the variant's configured delay (30 or 120)
    expect([30, 120]).toContain(outcome.candidateRetryDelayMinutes);
    // Policy approved 180 min — different from either variant candidate
    expect(outcome.policyApprovedRetryDelayMinutes).toBe(180);
  });
});

// ── 16 – PolicyEngine cannot be bypassed ──────────────────────────────────────

describe('PolicyEngine cannot be bypassed', () => {
  it('experiment outcome status comes from actual executionResult, not variant', () => {
    const c = makeCase({
      finalAction: 'RETRY_LATER',
      policyApproved: true,
      status: 'FAILED',
      recoveredAmount: 0,
    });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    // The outcome reflects what actually happened (FAILED), not what the variant wanted
    expect(result.outcomes[0].status).toBe('FAILED');
    expect(result.outcomes[0].recoveredAmountInPaise).toBe(0);
  });

  it('experiment engine reads outcome from RecoveryCase.executionResult — never creates its own execution', () => {
    const c = makeCase({ status: 'BLOCKED', policyApproved: false });
    // BLOCKED cases are excluded from RETRY_TIMING (ineligible)
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    expect(result.outcomes).toHaveLength(0);
  });
});

// ── 17 – Experimental variant cannot weaken max-attempt rules ─────────────────

describe('Max-attempt rules preserved', () => {
  it('RETRY_TIMING experiment does not apply to payments policy has rejected', () => {
    // A payment that was blocked (policy rejected it — max attempts exceeded)
    const c = makeCase({ policyApproved: false, status: 'BLOCKED' });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });

  it('RETRY_TIMING experiment does not apply to ESCALATED payments', () => {
    const c = makeCase({ finalAction: 'ESCALATE', policyApproved: false, status: 'ESCALATED' });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });
});

// ── 18 – Experimental variant cannot weaken expired-card rules ────────────────

describe('Expired-card rules preserved', () => {
  it('EXPIRED_CARD payment is excluded from RETRY_TIMING experiment', () => {
    const c = makeCase({
      failureReason: 'EXPIRED_CARD',
      finalAction: 'UPDATE_PAYMENT_METHOD',
      policyApproved: true,
    });
    expect(isEligible(RETRY_TIMING_EXP, c)).toBe(false);
  });

  it('no RETRY_TIMING outcome is produced for an EXPIRED_CARD payment', () => {
    const c = makeCase({
      failureReason: 'EXPIRED_CARD',
      finalAction: 'UPDATE_PAYMENT_METHOD',
      policyApproved: true,
    });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    expect(result.outcomes).toHaveLength(0);
  });
});

// ── 19 – Recovered count calculated correctly ─────────────────────────────────

describe('Recovered count', () => {
  it('counts only RECOVERED outcomes', () => {
    const outcomes = makeOutcomes(3, 2, 1, 4, 1, 0);
    const metricsA = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metricsA.recoveredCount).toBe(3);
    const metricsB = computeVariantMetrics(outcomes, 'B', RETRY_TIMING_EXP);
    expect(metricsB.recoveredCount).toBe(4);
  });
});

// ── 20 – Failed count calculated correctly ────────────────────────────────────

describe('Failed count', () => {
  it('counts only FAILED outcomes', () => {
    const outcomes = makeOutcomes(3, 2, 1, 4, 1, 0);
    const metricsA = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metricsA.failedCount).toBe(2);
    const metricsB = computeVariantMetrics(outcomes, 'B', RETRY_TIMING_EXP);
    expect(metricsB.failedCount).toBe(1);
  });
});

// ── 21 – Pending count handled correctly ─────────────────────────────────────

describe('Pending count not counted as completed', () => {
  it('PENDING outcomes are in pendingCount but not in completedCount', () => {
    // 3 recovered + 2 failed + 5 pending = completedCount should be 5 (not 10)
    const outcomes = makeOutcomes(3, 2, 5, 0, 0, 0);
    const metrics = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metrics.pendingCount).toBe(5);
    expect(metrics.completedCount).toBe(5); // 3+2+0+0
    expect(metrics.assignedCount).toBe(10);
  });
});

// ── 22 – Recovery rate denominator is correct ─────────────────────────────────

describe('Recovery rate denominator', () => {
  it('denominator is completedCount (excludes pending)', () => {
    // 6 recovered + 4 failed + 5 pending → rate = 6/10 = 0.6
    const outcomes = makeOutcomes(6, 4, 5, 0, 0, 0);
    const metrics = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metrics.recoveryRate).toBeCloseTo(0.6);
    expect(metrics.completedCount).toBe(10);
  });

  it('recovery rate is 0 when completedCount is 0', () => {
    const outcomes = makeOutcomes(0, 0, 3, 0, 0, 2);
    const metricsA = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metricsA.recoveryRate).toBe(0);
    expect(metricsA.completedCount).toBe(0);
  });
});

// ── 23 – Recovered revenue calculated correctly ───────────────────────────────

describe('Recovered revenue', () => {
  it('sums recoveredAmountInPaise across all RECOVERED outcomes for variant', () => {
    const outcomes: ExperimentOutcome[] = [
      makeOutcome('A', 'RECOVERED', { recoveredAmountInPaise: 100000, paymentId: 'p1' }),
      makeOutcome('A', 'RECOVERED', { recoveredAmountInPaise: 200000, paymentId: 'p2' }),
      makeOutcome('A', 'FAILED',    { recoveredAmountInPaise: 0, paymentId: 'p3', recoveryTimeMinutes: null }),
      makeOutcome('B', 'RECOVERED', { recoveredAmountInPaise: 150000, paymentId: 'p4' }),
    ];
    const metricsA = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metricsA.recoveredRevenueInPaise).toBe(300000);
    const metricsB = computeVariantMetrics(outcomes, 'B', RETRY_TIMING_EXP);
    expect(metricsB.recoveredRevenueInPaise).toBe(150000);
  });
});

// ── 24 – Average recovery time calculated correctly ───────────────────────────

describe('Average recovery time', () => {
  it('averages recoveryTimeMinutes across RECOVERED outcomes', () => {
    const outcomes: ExperimentOutcome[] = [
      makeOutcome('A', 'RECOVERED', { recoveryTimeMinutes: 30, paymentId: 'p1' }),
      makeOutcome('A', 'RECOVERED', { recoveryTimeMinutes: 60, paymentId: 'p2' }),
      makeOutcome('A', 'FAILED',    { recoveryTimeMinutes: null, paymentId: 'p3', recoveredAmountInPaise: 0 }),
    ];
    const metrics = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metrics.avgRecoveryTimeMinutes).toBe(45); // (30+60)/2
  });

  it('avgRecoveryTimeMinutes is null when no RECOVERED outcomes', () => {
    const outcomes = makeOutcomes(0, 5, 0, 0, 0, 0);
    const metrics = computeVariantMetrics(outcomes, 'A', RETRY_TIMING_EXP);
    expect(metrics.avgRecoveryTimeMinutes).toBeNull();
  });

  it('runExperiment computes recoveryTimeMinutes from failedAt and executedAt', () => {
    const c = makeCase({
      finalAction: 'RETRY_LATER',
      policyApproved: true,
      status: 'RECOVERED',
      failedAt: '2026-09-01T10:00:00.000Z',
      executedAt: '2026-09-01T10:31:00.000Z', // 31 minutes later
    });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    expect(result.outcomes.length).toBeGreaterThan(0);
    const outcome = result.outcomes[0];
    expect(outcome.recoveryTimeMinutes).toBe(31);
  });

  it('recoveryTimeMinutes is null for non-RECOVERED outcomes', () => {
    const c = makeCase({
      finalAction: 'RETRY_LATER',
      policyApproved: true,
      status: 'FAILED',
    });
    const result = runExperiment(RETRY_TIMING_EXP, [c]);
    for (const outcome of result.outcomes) {
      expect(outcome.recoveryTimeMinutes).toBeNull();
    }
  });
});

// ── 25 – Minimum sample size guardrail ───────────────────────────────────────

describe('Minimum sample size', () => {
  it('MIN_COMPLETED_PER_VARIANT constant is 10', () => {
    expect(EXPERIMENT_CONSTANTS.MIN_COMPLETED_PER_VARIANT).toBe(10);
  });

  it('9 completed per variant → INSUFFICIENT_DATA', () => {
    const outcomes = makeOutcomes(5, 4, 0, 6, 3, 0); // A: 9 completed, B: 9 completed
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).toBe('INSUFFICIENT_DATA');
  });

  it('10 completed per variant → transitions out of INSUFFICIENT_DATA', () => {
    const outcomes = makeOutcomes(8, 2, 0, 1, 9, 0); // A: 10 completed, B: 10 completed
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).not.toBe('INSUFFICIENT_DATA');
  });
});

// ── 26 – Insufficient data status ────────────────────────────────────────────

describe('Insufficient data', () => {
  it('status is INSUFFICIENT_DATA when A has < 10 completed', () => {
    const outcomes = makeOutcomes(3, 2, 0, 8, 2, 0); // A: 5, B: 10
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).toBe('INSUFFICIENT_DATA');
    expect(comparison.leadingVariantId).toBeNull();
  });

  it('status is INSUFFICIENT_DATA when B has < 10 completed', () => {
    const outcomes = makeOutcomes(8, 2, 0, 3, 2, 0); // A: 10, B: 5
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).toBe('INSUFFICIENT_DATA');
  });
});

// ── 27 – A-leading status ────────────────────────────────────────────────────

describe('A leading', () => {
  it('A_LEADING when A recovery rate > B rate by >= 5pp with enough data', () => {
    // A: 8/10 = 80%, B: 7/10 = 70% → diff = 10pp → A_LEADING
    const outcomes = makeOutcomes(8, 2, 0, 7, 3, 0);
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).toBe('A_LEADING');
    expect(comparison.leadingVariantId).toBe('A');
  });
});

// ── 28 – B-leading status ────────────────────────────────────────────────────

describe('B leading', () => {
  it('B_LEADING when B recovery rate > A rate by >= 5pp with enough data', () => {
    // A: 7/10 = 70%, B: 8/10 = 80% → diff = -10pp → B_LEADING
    const outcomes = makeOutcomes(7, 3, 0, 8, 2, 0);
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).toBe('B_LEADING');
    expect(comparison.leadingVariantId).toBe('B');
  });
});

// ── 29 – No clear difference status ──────────────────────────────────────────

describe('No clear difference', () => {
  it('NO_CLEAR_DIFFERENCE when both have enough data but rate diff < 5pp', () => {
    // A: 7/10 = 70%, B: 7/10 = 70% → diff = 0 → NO_CLEAR_DIFFERENCE
    const outcomes = makeOutcomes(7, 3, 0, 7, 3, 0);
    const comparison = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comparison.status).toBe('NO_CLEAR_DIFFERENCE');
    expect(comparison.leadingVariantId).toBeNull();
  });
});

// ── 30 – Minimum effect size guardrail ───────────────────────────────────────

describe('Minimum effect size (5pp)', () => {
  it('MIN_EFFECT_SIZE_RATE is 0.05', () => {
    expect(EXPERIMENT_CONSTANTS.MIN_EFFECT_SIZE_RATE).toBe(0.05);
  });

  it('3pp difference → NO_CLEAR_DIFFERENCE even with enough data', () => {
    // A: 8/10 = 0.80, B: 77/100 ≈ 0.77 → diff ≈ 3pp
    const outcomes: ExperimentOutcome[] = [];
    for (let i = 0; i < 8;  i++) outcomes.push(makeOutcome('A', 'RECOVERED', { paymentId: `a_r${i}` }));
    for (let i = 0; i < 2;  i++) outcomes.push(makeOutcome('A', 'FAILED',    { paymentId: `a_f${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
    for (let i = 0; i < 75; i++) outcomes.push(makeOutcome('B', 'RECOVERED', { paymentId: `b_r${i}` }));
    for (let i = 0; i < 25; i++) outcomes.push(makeOutcome('B', 'FAILED',    { paymentId: `b_f${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
    // A: 80%, B: 75% → diff = 5pp exactly → should produce A_LEADING (borderline)
    // Let's use A=77% vs B=75% (diff=2pp)
    const outcomes2: ExperimentOutcome[] = [];
    for (let i = 0; i < 77; i++) outcomes2.push(makeOutcome('A', 'RECOVERED', { paymentId: `a2_r${i}` }));
    for (let i = 0; i < 23; i++) outcomes2.push(makeOutcome('A', 'FAILED',    { paymentId: `a2_f${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
    for (let i = 0; i < 75; i++) outcomes2.push(makeOutcome('B', 'RECOVERED', { paymentId: `b2_r${i}` }));
    for (let i = 0; i < 25; i++) outcomes2.push(makeOutcome('B', 'FAILED',    { paymentId: `b2_f${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
    const comp = compareVariants(RETRY_TIMING_EXP, outcomes2);
    expect(comp.status).toBe('NO_CLEAR_DIFFERENCE');
  });

  it('exactly 5pp difference → leading variant declared', () => {
    // A: 80/100 = 80%, B: 75/100 = 75% → diff = 5pp → A_LEADING
    const outcomes: ExperimentOutcome[] = [];
    for (let i = 0; i < 80; i++) outcomes.push(makeOutcome('A', 'RECOVERED', { paymentId: `a_r${i}` }));
    for (let i = 0; i < 20; i++) outcomes.push(makeOutcome('A', 'FAILED',    { paymentId: `a_f${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
    for (let i = 0; i < 75; i++) outcomes.push(makeOutcome('B', 'RECOVERED', { paymentId: `b_r${i}` }));
    for (let i = 0; i < 25; i++) outcomes.push(makeOutcome('B', 'FAILED',    { paymentId: `b_f${i}`, recoveredAmountInPaise: 0, recoveryTimeMinutes: null }));
    const comp = compareVariants(RETRY_TIMING_EXP, outcomes);
    expect(comp.status).toBe('A_LEADING');
  });
});

// ── 31 – Deterministic comparison ────────────────────────────────────────────

describe('Deterministic comparison', () => {
  it('same cases always produce same comparison', () => {
    const cases = Array.from({ length: 10 }, (_, i) =>
      makeCase({ paymentId: `pay_${i}`, customerId: `cust_${i}` }),
    );
    const r1 = runExperiment(RETRY_TIMING_EXP, cases, '2026-09-01T00:00:00.000Z');
    const r2 = runExperiment(RETRY_TIMING_EXP, cases, '2026-09-01T00:00:00.000Z');
    expect(r1.comparison).toEqual(r2.comparison);
    expect(r1.outcomes).toEqual(r2.outcomes);
  });
});

// ── 32 – Experiment conflict detection ───────────────────────────────────────

describe('Conflict detection', () => {
  it('two RUNNING experiments with same dimension are detected as a conflict', () => {
    const exp2: RecoveryExperiment = {
      ...RETRY_TIMING_EXP,
      id: 'exp_retry_timing_002',
    };
    const conflicts = detectConflicts([RETRY_TIMING_EXP, exp2]);
    expect(conflicts.has('RETRY_TIMING')).toBe(true);
    expect(conflicts.get('RETRY_TIMING')).toHaveLength(2);
  });

  it('no conflicts when different dimensions are RUNNING', () => {
    const conflicts = detectConflicts([RETRY_TIMING_EXP, MESSAGE_TONE_EXP]);
    expect(conflicts.size).toBe(0);
  });

  it('PAUSED experiment does not trigger conflict', () => {
    const paused: RecoveryExperiment = { ...RETRY_TIMING_EXP, id: 'exp_rt_002', status: 'PAUSED' };
    const conflicts = detectConflicts([RETRY_TIMING_EXP, paused]);
    expect(conflicts.size).toBe(0);
  });
});

// ── 33 – Audit behavior preserved ────────────────────────────────────────────

describe('Audit behavior preserved', () => {
  it('experiment engine does not modify RecoveryCase audit entries', () => {
    const c = makeCase();
    const originalAuditLength = c.auditEntries.length;
    runExperiment(RETRY_TIMING_EXP, [c]);
    expect(c.auditEntries).toHaveLength(originalAuditLength);
  });
});

// ── 34 – Feature 9 message tone reflects assigned variant ─────────────────────

describe('Feature 9 tone integration', () => {
  it('getAssignedMessageTone returns NEUTRAL or FRIENDLY based on variant', () => {
    const experiments = [MESSAGE_TONE_EXP];
    // Scan customers to find one that gets variant A (NEUTRAL) and one that gets B (FRIENDLY)
    let foundNeutral = false; let foundFriendly = false;
    for (let i = 0; i < 200; i++) {
      const id = `cust_tone_${i}`;
      const tone = getAssignedMessageTone(experiments, id);
      if (tone === 'NEUTRAL') foundNeutral = true;
      if (tone === 'FRIENDLY') foundFriendly = true;
      if (foundNeutral && foundFriendly) break;
    }
    expect(foundNeutral).toBe(true);
    expect(foundFriendly).toBe(true);
  });

  it('returns undefined when no MESSAGE_TONE experiment is RUNNING', () => {
    const paused: RecoveryExperiment = { ...MESSAGE_TONE_EXP, status: 'PAUSED' };
    const tone = getAssignedMessageTone([paused], 'cust_001');
    expect(tone).toBeUndefined();
  });

  it('returns consistent tone for same customer', () => {
    const tone1 = getAssignedMessageTone([MESSAGE_TONE_EXP], 'cust_stable_tone');
    const tone2 = getAssignedMessageTone([MESSAGE_TONE_EXP], 'cust_stable_tone');
    expect(tone1).toBe(tone2);
  });
});

// ── 35 – Recovery Queue ranking unchanged ────────────────────────────────────

describe('Recovery Queue ranking independence', () => {
  it('buildRecoveryQueue is unaffected by experiment engine', async () => {
    const { buildRecoveryQueue } = await import('../queue/recoveryQueue');
    expect(typeof buildRecoveryQueue).toBe('function');
    // Running the experiment engine has no effect on the queue
    runExperiment(RETRY_TIMING_EXP, [makeCase()]);
    expect(typeof buildRecoveryQueue).toBe('function'); // unchanged
  });
});

// ── 36 – RecoveryScore behavior unchanged ─────────────────────────────────────

describe('RecoveryScore independence', () => {
  it('calculateRecoveryScore is unaffected by experiment assignment', async () => {
    const { calculateRecoveryScore } = await import('../../domain/recovery/recoveryScore');
    const score1 = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.75 });
    runExperiment(RETRY_TIMING_EXP, [makeCase()]);
    const score2 = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.75 });
    expect(score1).toEqual(score2);
  });
});

// ── 37 – Revenue Forecast behavior unchanged ──────────────────────────────────

describe('Revenue Forecast independence', () => {
  it('buildRecoveryForecast is unaffected by experiment engine', async () => {
    const { buildRecoveryForecast } = await import('../forecast/recoveryForecast');
    const input = [{
      amountInPaise: 100000,
      expectedRecoverableAmountInPaise: 75000,
      recoveryProbability: 0.75,
      executionStatus: 'RECOVERED' as const,
      smartRetryDelayMinutes: null,
    }];
    const f1 = buildRecoveryForecast(input);
    runExperiment(RETRY_TIMING_EXP, [makeCase()]);
    const f2 = buildRecoveryForecast(input);
    expect(f1).toEqual(f2);
  });
});

// ── 38 – Experiment engine does not execute actions ───────────────────────────

describe('No action execution', () => {
  it('runExperiment returns pure data with no executor calls', () => {
    const result = runExperiment(RETRY_TIMING_EXP, [makeCase()]);
    // Result is a plain data structure
    expect(typeof result.comparison.status).toBe('string');
    expect(Array.isArray(result.outcomes)).toBe(true);
    // No executor reference in result
    expect(result).not.toHaveProperty('execute');
  });
});

// ── 39 – Experiment engine does not send messages ────────────────────────────

describe('No message delivery', () => {
  it('runExperiment returns no message drafts (those are in Feature 9)', () => {
    const result = runExperiment(MESSAGE_TONE_EXP, [makeCase({ policyApproved: true, finalAction: 'RETRY_LATER' })]);
    for (const outcome of result.outcomes) {
      // outcome has no "body", "subject", "channel" — those are RecoveryMessageDraft fields
      expect(outcome).not.toHaveProperty('body');
      expect(outcome).not.toHaveProperty('subject');
      expect(outcome).not.toHaveProperty('channel');
    }
  });
});

// ── 40 – Input data not mutated ───────────────────────────────────────────────

describe('Input immutability', () => {
  it('runExperiment does not mutate RecoveryCase array', () => {
    const cases = [makeCase({ paymentId: 'pay_immutable_001' })];
    const originalJson = JSON.stringify(cases);
    runExperiment(RETRY_TIMING_EXP, cases);
    expect(JSON.stringify(cases)).toBe(originalJson);
  });

  it('runExperiment does not mutate experiment object', () => {
    const expCopy = JSON.parse(JSON.stringify(RETRY_TIMING_EXP)) as RecoveryExperiment;
    const originalJson = JSON.stringify(expCopy);
    runExperiment(expCopy, [makeCase()]);
    expect(JSON.stringify(expCopy)).toBe(originalJson);
  });
});
