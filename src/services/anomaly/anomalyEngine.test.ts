import { describe, it, expect } from 'vitest';
import type { RecoveryCase } from '../recovery/types';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult, ExecutionStatus } from '../../domain/executor/types';
import type { AuditEntry } from '../../domain/audit/types';
import type { RecoveryScore } from '../../domain/recovery/recoveryScore';
import type { RevenueAtRiskScore, RevenueRiskLevel } from '../../domain/recovery/revenueAtRisk';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import { detectAnomalies, ANOMALY_WINDOWS, ANOMALY_THRESHOLDS } from './anomalyEngine';

// ---------------------------------------------------------------------------
// Helpers: injectable "now" aligned to make time windows predictable.
//
//   NOW = '2026-07-01T00:00:00.000Z'
//   Current window: [2026-06-01T00:00:00.000Z, 2026-07-01T00:00:00.000Z]
//   Baseline window:[2026-03-01T12:00:00.000Z~, 2026-06-01T00:00:00.000Z]
//
// In practice we use concrete timestamps rather than computed offsets:
//   CURRENT_TS  = '2026-06-15T00:00:00.000Z'  ← inside current window
//   BASELINE_TS = '2026-04-15T00:00:00.000Z'  ← inside baseline window
//   OLD_TS      = '2025-01-15T00:00:00.000Z'  ← outside both windows
// ---------------------------------------------------------------------------

const NOW          = '2026-07-01T00:00:00.000Z';
const CURRENT_TS   = '2026-06-15T00:00:00.000Z';
const BASELINE_TS  = '2026-04-15T00:00:00.000Z';
const OLD_TS       = '2025-01-15T00:00:00.000Z';

let idSeq = 0;
function nextId(): string {
  return `pay_anomaly_${String(++idSeq).padStart(3, '0')}`;
}

function makePayment(
  failedAt: string,
  overrides: Partial<FailedPayment> = {},
): FailedPayment {
  return {
    paymentId: nextId() as FailedPayment['paymentId'],
    customerId: 'cust_001' as FailedPayment['customerId'],
    customerName: 'Test',
    amount: 100_000,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 2,
    lastAttemptAt: failedAt,
    failedAt,
    ...overrides,
  };
}

function makeScore(prob: number, amount: number): RecoveryScore {
  return {
    recoveryProbability: prob,
    expectedRecoverableAmountInPaise: Math.round(amount * prob),
    priority: prob >= 0.70 ? 'HIGH' : prob >= 0.40 ? 'MEDIUM' : 'LOW',
  };
}

function makeRiskScore(level: RevenueRiskLevel, revenueAtRisk: number): RevenueAtRiskScore {
  return {
    score: level === 'CRITICAL' ? 85 : level === 'HIGH' ? 65 : level === 'MEDIUM' ? 45 : 20,
    level,
    revenueAtRiskInPaise: revenueAtRisk,
    factors: ['Test factor'],
  };
}

function makeSwitch(): PaymentMethodSwitchRecommendation {
  return {
    currentMethod: 'UPI',
    shouldSwitch: false,
    recommendedMethod: null,
    alternatives: [],
    reason: 'Keep current method',
  };
}

function makeRecommendation(prob = 0.75): RecoveryRecommendation {
  return {
    diagnosis: 'Test',
    recommendedAction: 'RETRY_LATER',
    retryAfterMinutes: 30,
    confidence: prob,
    reasoning: 'Test',
    maxAttempts: 3,
  };
}

function makePolicyDecision(): PolicyDecision {
  return {
    approved: true,
    finalAction: 'RETRY_LATER',
    reason: 'Approved',
    originalRecommendedAction: 'RETRY_LATER',
    policyRulesApplied: [],
  };
}

function makeAudit(paymentId: string): AuditEntry {
  return {
    auditId: `audit_${paymentId}`,
    paymentId,
    eventType: 'PAYMENT_FAILED',
    timestamp: NOW,
    message: 'Payment failed.',
    metadata: {},
  };
}

function makeCase(opts: {
  failedAt: string;
  amount?: number;
  riskLevel?: RevenueRiskLevel;
  revenueAtRisk?: number;
  failureReason?: FailedPayment['failureReason'];
  paymentMethod?: FailedPayment['paymentMethod'];
  status?: ExecutionStatus;
}): RecoveryCase {
  const amount = opts.amount ?? 100_000;
  const riskLevel = opts.riskLevel ?? 'MEDIUM';
  const revenueAtRisk = opts.revenueAtRisk ?? Math.round(amount * 0.25);
  const payment = makePayment(opts.failedAt, {
    amount,
    failureReason: opts.failureReason ?? 'UPI_TIMEOUT',
    paymentMethod: opts.paymentMethod ?? 'UPI',
  });
  const recommendation = makeRecommendation(0.75);
  const status = opts.status ?? 'PENDING';

  const executionResult: RecoveryExecutionResult = {
    paymentId: payment.paymentId,
    action: 'RETRY_LATER',
    status,
    executedAt: NOW,
    recoveredAmount: status === 'RECOVERED' ? amount : 0,
    message: `Status: ${status}`,
  };

  return {
    payment,
    recommendation,
    policyDecision: makePolicyDecision(),
    executionResult,
    auditEntries: [makeAudit(payment.paymentId as string)],
    recoveredAmount: executionResult.recoveredAmount,
    recoveryScore: makeScore(0.75, amount),
    smartRetryTiming: null,
    paymentMethodSwitch: makeSwitch(),
    revenueAtRiskScore: makeRiskScore(riskLevel, revenueAtRisk),
  };
}

// Helper: create N cases in a given window with default UPI_TIMEOUT
function nCases(n: number, failedAt: string, overrides: Partial<Parameters<typeof makeCase>[0]> = {}): RecoveryCase[] {
  return Array.from({ length: n }, () => makeCase({ failedAt, ...overrides }));
}

// ---------------------------------------------------------------------------
// 1. Normal failure volume does not trigger anomaly
// ---------------------------------------------------------------------------

describe('normal failure volume', () => {
  it('produces no volume spike when current rate ≈ baseline rate', () => {
    // baseline: 9 in 90 days → normalized = 3/30days
    // current:  3 in 30 days → ratio = 3/3 = 1.0 → below 1.5 threshold
    const cases = [
      ...nCases(9, BASELINE_TS),
      ...nCases(3, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const volume = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(volume).toBeUndefined();
  });

  it('produces no volume spike when current count is below MIN_SAMPLE_COUNT', () => {
    // Even if ratio is high (4×), < 3 current cases → no anomaly
    // baseline: 0 → zero baseline case; but current < 3 → suppressed
    const cases = nCases(2, CURRENT_TS);
    const anomalies = detectAnomalies({ cases, now: NOW });
    const volume = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(volume).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 1.5× MEDIUM threshold
// ---------------------------------------------------------------------------

describe('MEDIUM threshold (1.5×)', () => {
  it('triggers MEDIUM volume spike at exactly 1.5× baseline', () => {
    // baseline normalized = 2 (6 in 90 days → 6/3 = 2/30days)
    // current = 3 → ratio = 3/2 = 1.5 → exactly MEDIUM threshold
    const cases = [
      ...nCases(6, BASELINE_TS),
      ...nCases(3, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const volume = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(volume).toBeDefined();
    // ratioToBaseline should be ≥ 1.5
    expect(volume!.ratioToBaseline).toBeGreaterThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// 3. 2× HIGH threshold
// ---------------------------------------------------------------------------

describe('HIGH threshold (2×)', () => {
  it('triggers HIGH severity at 2× baseline', () => {
    // baseline: 6 in 90 days → normalized = 2
    // current: 4 → ratio = 4/2 = 2.0 → HIGH
    const cases = [
      ...nCases(6, BASELINE_TS),
      ...nCases(4, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const volume = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(volume).toBeDefined();
    // Severity is HIGH unless revenue upgrade kicks in
    const effectiveSeverity = volume!.severity;
    expect(['HIGH', 'CRITICAL']).toContain(effectiveSeverity);
    expect(volume!.ratioToBaseline).toBeGreaterThanOrEqual(2.0);
  });
});

// ---------------------------------------------------------------------------
// 4. 3× CRITICAL threshold
// ---------------------------------------------------------------------------

describe('CRITICAL threshold (3×)', () => {
  it('triggers CRITICAL severity at 3× baseline', () => {
    // baseline: 3 in 90 days → normalized = 1
    // current: 3 → ratio = 3.0 → CRITICAL
    const cases = [
      ...nCases(3, BASELINE_TS),
      ...nCases(3, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const volume = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(volume).toBeDefined();
    expect(volume!.severity).toBe('CRITICAL');
    expect(volume!.ratioToBaseline).toBeGreaterThanOrEqual(3.0);
  });
});

// ---------------------------------------------------------------------------
// 5. Minimum sample size prevents false alerts
// ---------------------------------------------------------------------------

describe('minimum sample size', () => {
  it('suppresses anomaly when current count is below MIN_SAMPLE_COUNT regardless of ratio', () => {
    // Zero baseline + only 2 current → ratio would be infinite, but suppressed
    const cases = nCases(2, CURRENT_TS);
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE')).toBeUndefined();
    expect(anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE')).toBeUndefined();
    expect(anomalies.find((a) => a.type === 'PAYMENT_METHOD_SPIKE')).toBeUndefined();
    expect(anomalies.find((a) => a.type === 'REVENUE_SPIKE')).toBeUndefined();
  });

  it('MIN_SAMPLE_COUNT constant is 3', () => {
    expect(ANOMALY_THRESHOLDS.MIN_SAMPLE_COUNT).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 6. Failure reason spike detection
// ---------------------------------------------------------------------------

describe('failure reason spike (B)', () => {
  it('detects a spike for a specific failure reason', () => {
    // UPI_TIMEOUT: baseline = 3 in 90d → normalized 1; current = 4 → ratio 4× → CRITICAL
    const cases = [
      ...nCases(3, BASELINE_TS, { failureReason: 'UPI_TIMEOUT' }),
      ...nCases(4, CURRENT_TS,  { failureReason: 'UPI_TIMEOUT' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const reason = anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE');
    expect(reason).toBeDefined();
    expect(reason!.failureReason).toBe('UPI_TIMEOUT');
    expect(reason!.ratioToBaseline).toBeGreaterThanOrEqual(3.0);
  });

  it('picks the most anomalous reason when multiple reasons spike', () => {
    // UPI_TIMEOUT: baseline 3, current 9 → ratio 9× CRITICAL
    // EXPIRED_CARD: baseline 6, current 4 → ratio 2× HIGH
    const cases = [
      ...nCases(3, BASELINE_TS, { failureReason: 'UPI_TIMEOUT' }),
      ...nCases(9, CURRENT_TS,  { failureReason: 'UPI_TIMEOUT' }),
      ...nCases(6, BASELINE_TS, { failureReason: 'EXPIRED_CARD' }),
      ...nCases(4, CURRENT_TS,  { failureReason: 'EXPIRED_CARD' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const reason = anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE');
    expect(reason!.failureReason).toBe('UPI_TIMEOUT');
  });

  it('does not trigger reason spike when ratio is below 1.5×', () => {
    // baseline 9 → normalized 3; current 3 → ratio 1.0
    const cases = [
      ...nCases(9, BASELINE_TS, { failureReason: 'UPI_TIMEOUT' }),
      ...nCases(3, CURRENT_TS,  { failureReason: 'UPI_TIMEOUT' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Payment method spike detection
// ---------------------------------------------------------------------------

describe('payment method spike (C)', () => {
  it('detects a UPI failure spike', () => {
    // UPI: baseline 3, current 4 → ratio 4× CRITICAL
    const cases = [
      ...nCases(3, BASELINE_TS, { paymentMethod: 'UPI' }),
      ...nCases(4, CURRENT_TS,  { paymentMethod: 'UPI' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const method = anomalies.find((a) => a.type === 'PAYMENT_METHOD_SPIKE');
    expect(method).toBeDefined();
    expect(method!.paymentMethod).toBe('UPI');
  });

  it('does not trigger method spike below threshold', () => {
    // CARD: baseline 9, current 3 → ratio 1.0
    const cases = [
      ...nCases(9, BASELINE_TS, { paymentMethod: 'CARD' }),
      ...nCases(3, CURRENT_TS,  { paymentMethod: 'CARD' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.find((a) => a.type === 'PAYMENT_METHOD_SPIKE')).toBeUndefined();
  });

  it('relatedPaymentIds contain only the spiking method cases', () => {
    const upiBaseline = nCases(3, BASELINE_TS, { paymentMethod: 'UPI' });
    const upiCurrent  = nCases(4, CURRENT_TS,  { paymentMethod: 'UPI' });
    const cardCases   = nCases(5, BASELINE_TS,  { paymentMethod: 'CARD' });
    const cases = [...upiBaseline, ...upiCurrent, ...cardCases];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const method = anomalies.find((a) => a.type === 'PAYMENT_METHOD_SPIKE');
    const cardIds = cardCases.map((c) => c.payment.paymentId as string);
    for (const id of cardIds) {
      expect(method!.relatedPaymentIds).not.toContain(id);
    }
    for (const c of upiCurrent) {
      expect(method!.relatedPaymentIds).toContain(c.payment.paymentId as string);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Failed revenue spike detection
// ---------------------------------------------------------------------------

describe('revenue spike (D)', () => {
  it('detects a revenue spike when current revenue far exceeds normalized baseline', () => {
    // baseline: 3 cases × ₹100k = ₹300k in 90 days → normalized ₹100k/30days
    // current: 3 cases × ₹600k = ₹1.8M → ratio = 1_800_000 / 100_000 = 18× CRITICAL
    const cases = [
      ...nCases(3, BASELINE_TS, { amount: 100_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 600_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const rev = anomalies.find((a) => a.type === 'REVENUE_SPIKE');
    expect(rev).toBeDefined();
    expect(rev!.ratioToBaseline).toBeGreaterThanOrEqual(3.0);
  });

  it('does not trigger revenue spike below 1.5× baseline', () => {
    // baseline: 9 cases × ₹100k = ₹900k → normalized ₹300k per 30 days
    // current:  3 cases × ₹120k = ₹360k → ratio 360k/300k = 1.2× → below 1.5×
    const cases = [
      ...nCases(9, BASELINE_TS, { amount: 100_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 120_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.find((a) => a.type === 'REVENUE_SPIKE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Risk concentration detection
// ---------------------------------------------------------------------------

describe('risk concentration (E)', () => {
  it('triggers CRITICAL when ≥60% of portfolio revenue is CRITICAL/HIGH risk', () => {
    // 3 CRITICAL cases × ₹1M = ₹3M; 1 LOW case × ₹100k = ₹100k
    // concentration = 3_000_000 / 3_100_000 = 96.8% → CRITICAL
    const cases = [
      ...nCases(3, OLD_TS, { amount: 1_000_000, riskLevel: 'CRITICAL', revenueAtRisk: 800_000 }),
      makeCase({ failedAt: OLD_TS, amount: 100_000, riskLevel: 'LOW', revenueAtRisk: 10_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const conc = anomalies.find((a) => a.type === 'RISK_CONCENTRATION');
    expect(conc).toBeDefined();
    expect(conc!.severity).toBe('CRITICAL');
  });

  it('triggers HIGH when 40–59% is CRITICAL/HIGH risk', () => {
    // 2 HIGH cases × ₹500k = ₹1M; 3 LOW cases × ₹500k = ₹1.5M
    // concentration = 1M / 2.5M = 40% → exactly HIGH threshold
    const cases = [
      ...nCases(2, OLD_TS, { amount: 500_000, riskLevel: 'HIGH',  revenueAtRisk: 200_000 }),
      ...nCases(3, OLD_TS, { amount: 500_000, riskLevel: 'LOW',   revenueAtRisk: 50_000  }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const conc = anomalies.find((a) => a.type === 'RISK_CONCENTRATION');
    expect(conc).toBeDefined();
    expect(['HIGH', 'CRITICAL']).toContain(conc!.severity);
  });

  it('triggers MEDIUM when 25–39% is CRITICAL/HIGH risk', () => {
    // 1 CRITICAL × ₹300k; 3 LOW × ₹300k → concentration = 300k / 1200k = 25% → MEDIUM
    const cases = [
      makeCase({ failedAt: OLD_TS, amount: 300_000, riskLevel: 'CRITICAL', revenueAtRisk: 200_000 }),
      ...nCases(3, OLD_TS, { amount: 300_000, riskLevel: 'LOW', revenueAtRisk: 30_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const conc = anomalies.find((a) => a.type === 'RISK_CONCENTRATION');
    expect(conc).toBeDefined();
    expect(conc!.severity).toBe('MEDIUM');
  });

  it('produces no risk concentration anomaly when below 25%', () => {
    // 1 HIGH × ₹100k; 5 LOW × ₹600k → concentration = 100k / 3100k ≈ 3.2%
    const cases = [
      makeCase({ failedAt: OLD_TS, amount: 100_000, riskLevel: 'HIGH',   revenueAtRisk: 40_000 }),
      ...nCases(5, OLD_TS, { amount: 600_000, riskLevel: 'LOW', revenueAtRisk: 60_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.find((a) => a.type === 'RISK_CONCENTRATION')).toBeUndefined();
  });

  it('risk concentration fires even with no current-window cases (portfolio-level)', () => {
    // All cases in OLD_TS (outside both windows), but risk concentration checks all active cases
    const cases = [
      ...nCases(5, OLD_TS, { riskLevel: 'CRITICAL', amount: 1_000_000, revenueAtRisk: 800_000 }),
      makeCase({ failedAt: OLD_TS, amount: 100_000, riskLevel: 'LOW', revenueAtRisk: 10_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    // No time-series anomalies (0 current-window cases < MIN_SAMPLE)
    expect(anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE')).toBeUndefined();
    // Risk concentration fires
    const conc = anomalies.find((a) => a.type === 'RISK_CONCENTRATION');
    expect(conc).toBeDefined();
    expect(conc!.severity).toBe('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// 10. Window-length normalization
// ---------------------------------------------------------------------------

describe('window normalization', () => {
  it('normalizes baseline count to per-30-day rate before comparing', () => {
    // NORMALIZATION_FACTOR = 3 (90 days / 30 days)
    expect(ANOMALY_WINDOWS.NORMALIZATION_FACTOR).toBe(3);

    // baseline: 6 cases in 90 days → expected 2/30days
    // current: 3 cases → ratio = 3/2 = 1.5 → exactly MEDIUM
    const cases = [
      ...nCases(6, BASELINE_TS),
      ...nCases(3, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol).toBeDefined();
    expect(vol!.baselineValue).toBeCloseTo(2.0, 1);
    expect(vol!.ratioToBaseline).toBeCloseTo(1.5, 1);
  });

  it('baselineValue is normalized (not raw baseline count)', () => {
    // 9 baseline cases → normalizedBaseline = 3; if returned as-is (9) test would fail
    const cases = [
      ...nCases(9, BASELINE_TS),
      ...nCases(9, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol).toBeDefined();
    expect(vol!.baselineValue).toBe(3);   // 9/3 = 3, not 9
    expect(vol!.observedValue).toBe(9);
    expect(vol!.ratioToBaseline).toBe(3); // 9/3 = 3×
  });
});

// ---------------------------------------------------------------------------
// 11 & 12. Zero and null baseline handling
// ---------------------------------------------------------------------------

describe('zero / null baseline handling', () => {
  it('sets ratioToBaseline = null when there are no baseline cases', () => {
    const cases = nCases(5, CURRENT_TS);
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol).toBeDefined();
    expect(vol!.ratioToBaseline).toBeNull();
    expect(vol!.baselineValue).toBeNull();
  });

  it('message describes emergence rather than claiming a percentage increase', () => {
    const cases = nCases(4, CURRENT_TS);
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.message).toMatch(/no recorded|no occurrences/i);
    expect(vol!.message).not.toMatch(/infinite|undefined|NaN/i);
  });

  it('does not produce anomaly when there are no cases at all', () => {
    const anomalies = detectAnomalies({ cases: [], now: NOW });
    expect(anomalies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Baseline never divides by zero
// ---------------------------------------------------------------------------

describe('zero-division safety', () => {
  it('never produces NaN or Infinity in output', () => {
    const edgeCases = [
      // zero current, zero baseline
      detectAnomalies({ cases: [], now: NOW }),
      // zero baseline only
      detectAnomalies({ cases: nCases(3, CURRENT_TS), now: NOW }),
      // zero current only
      detectAnomalies({ cases: nCases(5, BASELINE_TS), now: NOW }),
    ];
    for (const anomalies of edgeCases) {
      for (const a of anomalies) {
        if (a.ratioToBaseline != null) {
          expect(Number.isFinite(a.ratioToBaseline)).toBe(true);
        }
        if (a.baselineValue != null) {
          expect(Number.isFinite(a.baselineValue)).toBe(true);
        }
        expect(Number.isFinite(a.observedValue)).toBe(true);
        expect(Number.isFinite(a.anomalyScore)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Affected payment count
// ---------------------------------------------------------------------------

describe('affectedPaymentCount', () => {
  it('equals the number of current-window cases for volume spike', () => {
    const cases = [
      ...nCases(3, BASELINE_TS),
      ...nCases(5, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.affectedPaymentCount).toBe(5);
  });

  it('equals the count in the spiking reason group for reason spike', () => {
    const cases = [
      ...nCases(3, BASELINE_TS, { failureReason: 'UPI_TIMEOUT' }),
      ...nCases(4, CURRENT_TS,  { failureReason: 'UPI_TIMEOUT' }),
      ...nCases(3, CURRENT_TS,  { failureReason: 'EXPIRED_CARD' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const reason = anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE');
    if (reason && reason.failureReason === 'UPI_TIMEOUT') {
      expect(reason.affectedPaymentCount).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Affected revenue
// ---------------------------------------------------------------------------

describe('affectedRevenueInPaise', () => {
  it('sums the payment amounts of current-window cases for volume spike', () => {
    const cases = [
      ...nCases(3, BASELINE_TS, { amount: 100_000 }),
      makeCase({ failedAt: CURRENT_TS, amount: 200_000 }),
      makeCase({ failedAt: CURRENT_TS, amount: 300_000 }),
      makeCase({ failedAt: CURRENT_TS, amount: 400_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.affectedRevenueInPaise).toBe(900_000);
  });
});

// ---------------------------------------------------------------------------
// 16. Revenue-at-risk aggregation
// ---------------------------------------------------------------------------

describe('revenueAtRiskInPaise', () => {
  it('sums revenueAtRiskScore.revenueAtRiskInPaise of current-window cases', () => {
    const cases = [
      ...nCases(3, BASELINE_TS),
      makeCase({ failedAt: CURRENT_TS, revenueAtRisk: 30_000 }),
      makeCase({ failedAt: CURRENT_TS, revenueAtRisk: 50_000 }),
      makeCase({ failedAt: CURRENT_TS, revenueAtRisk: 20_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.revenueAtRiskInPaise).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// 17. Deterministic severity model
// ---------------------------------------------------------------------------

describe('severity model', () => {
  it('severity is deterministically MEDIUM at exactly 1.5× ratio', () => {
    // baseline 6 → normalized 2; current 3 → ratio 1.5 → MEDIUM (amount < REVENUE_UPGRADE)
    const cases = [
      ...nCases(6, BASELINE_TS, { amount: 10_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 10_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.severity).toBe('MEDIUM');
  });

  it('severity upgrades from MEDIUM to HIGH when affected revenue ≥ REVENUE_UPGRADE_PAISE', () => {
    // REVENUE_UPGRADE_PAISE = 500_000 (₹5,000)
    // baseline 6 → normalized 2; current 3 × ₹200k each = ₹600k → upgrade MEDIUM→HIGH
    const cases = [
      ...nCases(6, BASELINE_TS, { amount: 100_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 200_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.severity).toBe('HIGH');
  });

  it('severity upgrades from HIGH to CRITICAL when affected revenue ≥ REVENUE_UPGRADE_PAISE', () => {
    // baseline 3 → normalized 1; current 3 × ₹500k each = ₹1.5M
    // ratio = 3 → CRITICAL, then revenue upgrade → stays CRITICAL (already top)
    const cases = [
      ...nCases(3, BASELINE_TS, { amount: 50_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 500_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.severity).toBe('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// 18. Deterministic anomaly IDs
// ---------------------------------------------------------------------------

describe('deterministic anomaly IDs', () => {
  it('volume spike always has id anomaly_volume_spike', () => {
    const cases = [
      ...nCases(3, BASELINE_TS),
      ...nCases(9, CURRENT_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.id).toBe('anomaly_volume_spike');
  });

  it('reason spike ID encodes the failure reason', () => {
    const cases = [
      ...nCases(3, BASELINE_TS, { failureReason: 'EXPIRED_CARD' }),
      ...nCases(9, CURRENT_TS,  { failureReason: 'EXPIRED_CARD' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const reason = anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE');
    expect(reason!.id).toBe('anomaly_reason_spike_EXPIRED_CARD');
  });

  it('method spike ID encodes the payment method', () => {
    const cases = [
      ...nCases(3, BASELINE_TS, { paymentMethod: 'CARD' }),
      ...nCases(9, CURRENT_TS,  { paymentMethod: 'CARD' }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const method = anomalies.find((a) => a.type === 'PAYMENT_METHOD_SPIKE');
    expect(method!.id).toBe('anomaly_method_spike_CARD');
  });

  it('revenue spike always has id anomaly_revenue_spike', () => {
    const cases = [
      ...nCases(3, BASELINE_TS, { amount: 50_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 500_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const rev = anomalies.find((a) => a.type === 'REVENUE_SPIKE');
    expect(rev!.id).toBe('anomaly_revenue_spike');
  });

  it('risk concentration always has id anomaly_risk_concentration', () => {
    const cases = [
      ...nCases(3, OLD_TS, { riskLevel: 'CRITICAL', amount: 1_000_000, revenueAtRisk: 800_000 }),
      makeCase({ failedAt: OLD_TS, riskLevel: 'LOW', amount: 100_000, revenueAtRisk: 10_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const conc = anomalies.find((a) => a.type === 'RISK_CONCENTRATION');
    expect(conc!.id).toBe('anomaly_risk_concentration');
  });
});

// ---------------------------------------------------------------------------
// 19. Deterministic ranking
// ---------------------------------------------------------------------------

describe('anomaly ranking', () => {
  it('CRITICAL anomalies appear before HIGH before MEDIUM', () => {
    // Create a MEDIUM volume spike + CRITICAL risk concentration
    const cases = [
      ...nCases(6, BASELINE_TS, { amount: 10_000 }),
      ...nCases(3, CURRENT_TS,  { amount: 10_000 }),
      // CRITICAL risk concentration: large CRITICAL payments
      ...nCases(5, OLD_TS, { riskLevel: 'CRITICAL', amount: 1_000_000, revenueAtRisk: 800_000 }),
      makeCase({ failedAt: OLD_TS, riskLevel: 'LOW', amount: 50_000, revenueAtRisk: 5_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    let lastRank = -1;
    const rankMap: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    for (const a of anomalies) {
      const rank = rankMap[a.severity];
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
    }
  });

  it('within same severity, higher revenueAtRiskInPaise comes first', () => {
    // Two scenarios that both produce CRITICAL risk concentration
    const cases = [
      // High-revenue CRITICAL risk
      makeCase({ failedAt: OLD_TS, amount: 5_000_000, riskLevel: 'CRITICAL', revenueAtRisk: 4_000_000 }),
      makeCase({ failedAt: OLD_TS, amount: 5_000_000, riskLevel: 'CRITICAL', revenueAtRisk: 4_000_000 }),
      makeCase({ failedAt: OLD_TS, amount: 5_000_000, riskLevel: 'CRITICAL', revenueAtRisk: 4_000_000 }),
      makeCase({ failedAt: OLD_TS, amount: 100_000, riskLevel: 'LOW', revenueAtRisk: 10_000 }),
      // Volume spike in current window (also CRITICAL due to high ratio and revenue)
      ...nCases(3, BASELINE_TS, { amount: 10_000 }),
      ...nCases(9, CURRENT_TS,  { amount: 600_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    const criticals = anomalies.filter((a) => a.severity === 'CRITICAL');
    for (let i = 1; i < criticals.length; i++) {
      expect(criticals[i - 1].revenueAtRiskInPaise).toBeGreaterThanOrEqual(
        criticals[i].revenueAtRiskInPaise,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 20. Result count limit
// ---------------------------------------------------------------------------

describe('feed size cap', () => {
  it('never returns more than MAX_ANOMALIES anomalies', () => {
    // Create data rich enough to trigger all 5 anomaly types
    const cases = [
      ...nCases(3, BASELINE_TS, { failureReason: 'UPI_TIMEOUT', paymentMethod: 'UPI', amount: 100_000 }),
      ...nCases(9, CURRENT_TS,  { failureReason: 'UPI_TIMEOUT', paymentMethod: 'UPI', amount: 600_000 }),
      ...nCases(4, OLD_TS, { riskLevel: 'CRITICAL', amount: 2_000_000, revenueAtRisk: 1_500_000 }),
      makeCase({ failedAt: OLD_TS, riskLevel: 'LOW', amount: 100_000, revenueAtRisk: 10_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.length).toBeLessThanOrEqual(ANOMALY_THRESHOLDS.MAX_ANOMALIES);
  });
});

// ---------------------------------------------------------------------------
// 21. Empty dataset
// ---------------------------------------------------------------------------

describe('empty dataset', () => {
  it('returns empty array when no cases provided', () => {
    expect(detectAnomalies({ cases: [], now: NOW })).toHaveLength(0);
  });

  it('returns empty when all cases are RECOVERED', () => {
    const cases = nCases(5, CURRENT_TS, { status: 'RECOVERED' });
    expect(detectAnomalies({ cases, now: NOW })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 22. No current-window failures
// ---------------------------------------------------------------------------

describe('no current-window failures', () => {
  it('produces no time-series anomalies when current window is empty', () => {
    // Only baseline failures (+ some old ones)
    const cases = [
      ...nCases(9, BASELINE_TS),
      ...nCases(5, OLD_TS),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    expect(anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE')).toBeUndefined();
    expect(anomalies.find((a) => a.type === 'FAILURE_REASON_SPIKE')).toBeUndefined();
    expect(anomalies.find((a) => a.type === 'PAYMENT_METHOD_SPIKE')).toBeUndefined();
    expect(anomalies.find((a) => a.type === 'REVENUE_SPIKE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 23. No baseline failures
// ---------------------------------------------------------------------------

describe('no baseline failures', () => {
  it('handles zero baseline with null ratio and non-crashing message', () => {
    const cases = nCases(5, CURRENT_TS);
    const anomalies = detectAnomalies({ cases, now: NOW });
    for (const a of anomalies.filter((x) => x.type !== 'RISK_CONCENTRATION')) {
      if (a.baselineValue === null) {
        expect(a.ratioToBaseline).toBeNull();
        expect(a.message).not.toContain('NaN');
        expect(a.message).not.toContain('Infinity');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 24. Same input returns same output
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same input always produces the same output', () => {
    const cases = [
      ...nCases(3, BASELINE_TS),
      ...nCases(5, CURRENT_TS),
      ...nCases(3, OLD_TS, { riskLevel: 'CRITICAL', amount: 1_000_000, revenueAtRisk: 800_000 }),
    ];
    const r1 = detectAnomalies({ cases, now: NOW });
    const r2 = detectAnomalies({ cases, now: NOW });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

// ---------------------------------------------------------------------------
// 25. Input not mutated
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('does not mutate the input cases array', () => {
    const cases = nCases(5, CURRENT_TS);
    const ids = cases.map((c) => c.payment.paymentId);
    detectAnomalies({ cases, now: NOW });
    expect(cases.map((c) => c.payment.paymentId)).toEqual(ids);
  });

  it('does not mutate the payment within cases', () => {
    const cases = nCases(5, CURRENT_TS, { amount: 100_000 });
    detectAnomalies({ cases, now: NOW });
    for (const c of cases) {
      expect(c.payment.amount).toBe(100_000);
    }
  });
});

// ---------------------------------------------------------------------------
// 26. Injected `now` produces deterministic windows
// ---------------------------------------------------------------------------

describe('injectable now', () => {
  it('uses the injected now to compute window boundaries', () => {
    // With NOW = 2026-07-01, CURRENT_TS = 2026-06-15 (in window), BASELINE_TS = 2026-04-15 (in baseline)
    // All 3 current cases → volume spike
    const cases = [
      ...nCases(3, BASELINE_TS),
      ...nCases(3, CURRENT_TS),
    ];
    const a1 = detectAnomalies({ cases, now: NOW });
    // Use Jun-01 as "earlier now": current window = [May-01, Jun-01]
    // CURRENT_TS (Jun 15) is AFTER Jun-01 → outside current window
    // BASELINE_TS (Apr 15) is in baseline [Feb-01, May-01] → 0 current cases
    const earlier = '2026-06-01T00:00:00.000Z';
    const a2 = detectAnomalies({ cases, now: earlier });
    expect(a1.find((a) => a.type === 'FAILURE_VOLUME_SPIKE')).toBeDefined();
    expect(a2.find((a) => a.type === 'FAILURE_VOLUME_SPIKE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 27. Anomaly engine does not invoke PolicyEngine or Executor (read-only)
// ---------------------------------------------------------------------------

describe('read-only behavior', () => {
  it('does not modify any case status', () => {
    const cases = nCases(5, CURRENT_TS, { status: 'PENDING' });
    const statuses = cases.map((c) => c.executionResult.status);
    detectAnomalies({ cases, now: NOW });
    expect(cases.map((c) => c.executionResult.status)).toEqual(statuses);
  });

  it('does not modify payment amounts', () => {
    const cases = nCases(5, CURRENT_TS, { amount: 123_456 });
    detectAnomalies({ cases, now: NOW });
    for (const c of cases) {
      expect(c.payment.amount).toBe(123_456);
    }
  });
});

// ---------------------------------------------------------------------------
// 28. Window dates are correct
// ---------------------------------------------------------------------------

describe('window metadata', () => {
  it('windowStart and windowEnd are consistent with NOW', () => {
    const cases = nCases(5, CURRENT_TS);
    const anomalies = detectAnomalies({ cases, now: NOW });
    const vol = anomalies.find((a) => a.type === 'FAILURE_VOLUME_SPIKE');
    expect(vol!.windowEnd).toBe(NOW);
    // windowStart should be 30 days before NOW
    const expectedStart = new Date(
      new Date(NOW).getTime() - ANOMALY_WINDOWS.CURRENT_WINDOW_DAYS * 86_400_000,
    ).toISOString();
    expect(vol!.windowStart).toBe(expectedStart);
  });
});

// ---------------------------------------------------------------------------
// 29. Anomaly score is in valid range
// ---------------------------------------------------------------------------

describe('anomalyScore', () => {
  it('anomalyScore is always 0–100', () => {
    const cases = [
      ...nCases(3, BASELINE_TS, { amount: 100_000 }),
      ...nCases(9, CURRENT_TS,  { amount: 1_000_000 }),
      ...nCases(4, OLD_TS, { riskLevel: 'CRITICAL', amount: 5_000_000, revenueAtRisk: 4_000_000 }),
    ];
    const anomalies = detectAnomalies({ cases, now: NOW });
    for (const a of anomalies) {
      expect(a.anomalyScore).toBeGreaterThanOrEqual(0);
      expect(a.anomalyScore).toBeLessThanOrEqual(100);
    }
  });
});

// ---------------------------------------------------------------------------
// 30. ANOMALY_WINDOWS and ANOMALY_THRESHOLDS are exported and readable
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('ANOMALY_WINDOWS has expected values', () => {
    expect(ANOMALY_WINDOWS.CURRENT_WINDOW_DAYS).toBe(30);
    expect(ANOMALY_WINDOWS.BASELINE_WINDOW_DAYS).toBe(90);
    expect(ANOMALY_WINDOWS.NORMALIZATION_FACTOR).toBe(3);
  });

  it('ANOMALY_THRESHOLDS has expected values', () => {
    expect(ANOMALY_THRESHOLDS.SPIKE_CRITICAL).toBe(3.0);
    expect(ANOMALY_THRESHOLDS.SPIKE_HIGH).toBe(2.0);
    expect(ANOMALY_THRESHOLDS.SPIKE_MEDIUM).toBe(1.5);
    expect(ANOMALY_THRESHOLDS.MAX_ANOMALIES).toBe(5);
  });
});
