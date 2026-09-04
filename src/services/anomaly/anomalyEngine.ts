import type { RecoveryCase } from '../recovery/types';
import type { PaymentFailureAnomaly, AnomalySeverity } from '../../domain/anomaly/types';
import type { FailureReason, PaymentMethod } from '../../domain/payments/types';
import { formatPaise } from '../../lib/formatters';

// ── Time-window configuration ─────────────────────────────────────────────────
//
// The dataset contains static historical payments spanning ~18 months.
// Windows are chosen to give a meaningful 30-day comparison period.
//
//   Current window:  [now - 30 days,  now]
//   Baseline window: [now - 120 days, now - 30 days]  (90-day lookback)
//
// Rate normalization: baseline is 3× longer than the current window, so the
// expected rate per 30-day period = baselineCount / 3.

export const ANOMALY_WINDOWS = {
  CURRENT_WINDOW_DAYS:  30,
  BASELINE_WINDOW_DAYS: 90,
  // Normalization factor = BASELINE / CURRENT = 3
  NORMALIZATION_FACTOR: 3,
} as const;

// ── Anomaly thresholds ────────────────────────────────────────────────────────

export const ANOMALY_THRESHOLDS = {
  // Spike ratio thresholds (observedCount / normalizedBaselineRate)
  SPIKE_CRITICAL: 3.0,  // ≥3× → CRITICAL
  SPIKE_HIGH:     2.0,  // ≥2× → HIGH
  SPIKE_MEDIUM:   1.5,  // ≥1.5× → MEDIUM; below → no anomaly

  // Minimum events in current window to avoid misleading alerts on tiny samples
  MIN_SAMPLE_COUNT: 3,

  // If affected revenue exceeds this, upgrade severity one level (MEDIUM→HIGH, HIGH→CRITICAL)
  REVENUE_UPGRADE_PAISE: 500_000,  // ₹5,000

  // Risk concentration: share of portfolio revenue in CRITICAL or HIGH-risk payments
  RISK_CONC_CRITICAL: 0.60,  // ≥60% → CRITICAL
  RISK_CONC_HIGH:     0.40,  // ≥40% → HIGH
  RISK_CONC_MEDIUM:   0.25,  // ≥25% → MEDIUM; below → no anomaly
  RISK_CONC_MIN_COUNT:   3,  // minimum active payments for the check to fire

  // Feed size cap
  MAX_ANOMALIES: 5,
} as const;

// ── Input ─────────────────────────────────────────────────────────────────────

export interface AnomalyEngineInput {
  cases: readonly RecoveryCase[];
  now?: string;  // injectable timestamp for determinism in tests
}

// ── Window helpers ────────────────────────────────────────────────────────────

function dateMinusDays(isoNow: string, days: number): string {
  return new Date(new Date(isoNow).getTime() - days * 86_400_000).toISOString();
}

function inWindow(failedAt: string, windowStart: string, windowEnd: string): boolean {
  return failedAt >= windowStart && failedAt < windowEnd;
}

// ── Anomaly score ─────────────────────────────────────────────────────────────
//
// score = min(100, ratioScore + revenueScore)
//   ratioScore   = min(60, round((ratio − 1) × 20))  [null ratio → 30]
//   revenueScore = min(40, round(affectedRevenue / 50_000))

function computeAnomalyScore(ratio: number | null, affectedRevenueInPaise: number): number {
  const ratioScore   = ratio != null ? Math.min(60, Math.round((ratio - 1) * 20)) : 30;
  const revenueScore = Math.min(40, Math.round(affectedRevenueInPaise / 50_000));
  return Math.min(100, ratioScore + revenueScore);
}

// ── Severity helpers ──────────────────────────────────────────────────────────

function severityFromRatio(ratio: number): AnomalySeverity {
  if (ratio >= ANOMALY_THRESHOLDS.SPIKE_CRITICAL) return 'CRITICAL';
  if (ratio >= ANOMALY_THRESHOLDS.SPIKE_HIGH)     return 'HIGH';
  return 'MEDIUM';
}

function upgradeIfHighRevenue(
  severity: AnomalySeverity,
  affectedRevenueInPaise: number,
): AnomalySeverity {
  if (affectedRevenueInPaise < ANOMALY_THRESHOLDS.REVENUE_UPGRADE_PAISE) return severity;
  if (severity === 'MEDIUM') return 'HIGH';
  if (severity === 'HIGH')   return 'CRITICAL';
  return severity;
}

// ── Ranking ───────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AnomalySeverity, number> = {
  CRITICAL: 0,
  HIGH:     1,
  MEDIUM:   2,
  LOW:      3,
};

function rankAnomalies(anomalies: PaymentFailureAnomaly[]): PaymentFailureAnomaly[] {
  return [...anomalies].sort((a, b) => {
    const sr = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sr !== 0) return sr;
    const rar = b.revenueAtRiskInPaise - a.revenueAtRiskInPaise;
    if (rar !== 0) return rar;
    const rev = b.affectedRevenueInPaise - a.affectedRevenueInPaise;
    if (rev !== 0) return rev;
    const ra = a.ratioToBaseline ?? 0;
    const rb = b.ratioToBaseline ?? 0;
    if (rb !== ra) return rb - ra;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── A: Failure Volume Spike ───────────────────────────────────────────────────

function detectVolumeSpike(
  currentCases: readonly RecoveryCase[],
  baselineCases: readonly RecoveryCase[],
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  const currentCount = currentCases.length;
  if (currentCount < ANOMALY_THRESHOLDS.MIN_SAMPLE_COUNT) return null;

  const baselineCount = baselineCases.length;
  const affectedRevenue = currentCases.reduce((s, c) => s + c.payment.amount, 0);
  const revenueAtRisk = currentCases.reduce(
    (s, c) => s + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const ids = currentCases.map((c) => c.payment.paymentId as string);

  if (baselineCount === 0) {
    return {
      id: 'anomaly_volume_spike',
      type: 'FAILURE_VOLUME_SPIKE',
      severity: upgradeIfHighRevenue('MEDIUM', affectedRevenue),
      title: 'Payment failure volume spike',
      message: `${currentCount} payment failure${currentCount !== 1 ? 's' : ''} appeared in the current 30-day window after no recorded failures in the baseline period.`,
      observedValue: currentCount,
      baselineValue: null,
      ratioToBaseline: null,
      anomalyScore: computeAnomalyScore(null, affectedRevenue),
      affectedPaymentCount: currentCount,
      affectedRevenueInPaise: affectedRevenue,
      revenueAtRiskInPaise: revenueAtRisk,
      windowStart,
      windowEnd,
      relatedPaymentIds: ids,
    };
  }

  const normalizedBaseline = baselineCount / ANOMALY_WINDOWS.NORMALIZATION_FACTOR;
  const ratio = currentCount / normalizedBaseline;

  if (ratio < ANOMALY_THRESHOLDS.SPIKE_MEDIUM) return null;

  const severity = upgradeIfHighRevenue(severityFromRatio(ratio), affectedRevenue);

  return {
    id: 'anomaly_volume_spike',
    type: 'FAILURE_VOLUME_SPIKE',
    severity,
    title: 'Payment failure volume spike',
    message: `Payment failure volume is ${ratio.toFixed(1)}× above the recent baseline. ${currentCount} failure${currentCount !== 1 ? 's' : ''} in the last 30 days versus ${normalizedBaseline.toFixed(1)} expected from the baseline period.`,
    observedValue: currentCount,
    baselineValue: Math.round(normalizedBaseline * 10) / 10,
    ratioToBaseline: Math.round(ratio * 10) / 10,
    anomalyScore: computeAnomalyScore(ratio, affectedRevenue),
    affectedPaymentCount: currentCount,
    affectedRevenueInPaise: affectedRevenue,
    revenueAtRiskInPaise: revenueAtRisk,
    windowStart,
    windowEnd,
    relatedPaymentIds: ids,
  };
}

// ── B: Failure Reason Spike ───────────────────────────────────────────────────

function scoreReason(
  current: readonly RecoveryCase[],
  baseline: readonly RecoveryCase[],
  reason: FailureReason,
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  const currentCount = current.length;
  if (currentCount < ANOMALY_THRESHOLDS.MIN_SAMPLE_COUNT) return null;

  const baselineCount = baseline.length;
  const affectedRevenue = current.reduce((s, c) => s + c.payment.amount, 0);
  const revenueAtRisk = current.reduce(
    (s, c) => s + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const ids = current.map((c) => c.payment.paymentId as string);
  const label = reason.replace(/_/g, ' ');

  if (baselineCount === 0) {
    return {
      id: `anomaly_reason_spike_${reason}`,
      type: 'FAILURE_REASON_SPIKE',
      severity: upgradeIfHighRevenue('MEDIUM', affectedRevenue),
      title: `${label} spike`,
      message: `${label} appeared ${currentCount} time${currentCount !== 1 ? 's' : ''} in the current window after no occurrences in the baseline period.`,
      observedValue: currentCount,
      baselineValue: null,
      ratioToBaseline: null,
      anomalyScore: computeAnomalyScore(null, affectedRevenue),
      affectedPaymentCount: currentCount,
      affectedRevenueInPaise: affectedRevenue,
      revenueAtRiskInPaise: revenueAtRisk,
      failureReason: reason,
      windowStart,
      windowEnd,
      relatedPaymentIds: ids,
    };
  }

  const normalizedBaseline = baselineCount / ANOMALY_WINDOWS.NORMALIZATION_FACTOR;
  const ratio = currentCount / normalizedBaseline;
  if (ratio < ANOMALY_THRESHOLDS.SPIKE_MEDIUM) return null;

  const severity = upgradeIfHighRevenue(severityFromRatio(ratio), affectedRevenue);

  return {
    id: `anomaly_reason_spike_${reason}`,
    type: 'FAILURE_REASON_SPIKE',
    severity,
    title: `${label} spike`,
    message: `${label} failures are ${ratio.toFixed(1)}× above the recent baseline (${currentCount} current vs ${normalizedBaseline.toFixed(1)} expected).`,
    observedValue: currentCount,
    baselineValue: Math.round(normalizedBaseline * 10) / 10,
    ratioToBaseline: Math.round(ratio * 10) / 10,
    anomalyScore: computeAnomalyScore(ratio, affectedRevenue),
    affectedPaymentCount: currentCount,
    affectedRevenueInPaise: affectedRevenue,
    revenueAtRiskInPaise: revenueAtRisk,
    failureReason: reason,
    windowStart,
    windowEnd,
    relatedPaymentIds: ids,
  };
}

function detectReasonSpike(
  currentCases: readonly RecoveryCase[],
  baselineCases: readonly RecoveryCase[],
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  const reasons = new Set<FailureReason>([
    ...currentCases.map((c) => c.payment.failureReason),
    ...baselineCases.map((c) => c.payment.failureReason),
  ]);

  let top: PaymentFailureAnomaly | null = null;
  for (const reason of reasons) {
    const anomaly = scoreReason(
      currentCases.filter((c) => c.payment.failureReason === reason),
      baselineCases.filter((c) => c.payment.failureReason === reason),
      reason,
      windowStart,
      windowEnd,
    );
    if (!anomaly) continue;
    if (
      !top ||
      SEVERITY_RANK[anomaly.severity] < SEVERITY_RANK[top.severity] ||
      (SEVERITY_RANK[anomaly.severity] === SEVERITY_RANK[top.severity] &&
        anomaly.anomalyScore > top.anomalyScore)
    ) {
      top = anomaly;
    }
  }
  return top;
}

// ── C: Payment Method Spike ───────────────────────────────────────────────────

function scoreMethod(
  current: readonly RecoveryCase[],
  baseline: readonly RecoveryCase[],
  method: PaymentMethod,
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  const currentCount = current.length;
  if (currentCount < ANOMALY_THRESHOLDS.MIN_SAMPLE_COUNT) return null;

  const baselineCount = baseline.length;
  const affectedRevenue = current.reduce((s, c) => s + c.payment.amount, 0);
  const revenueAtRisk = current.reduce(
    (s, c) => s + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const ids = current.map((c) => c.payment.paymentId as string);

  if (baselineCount === 0) {
    return {
      id: `anomaly_method_spike_${method}`,
      type: 'PAYMENT_METHOD_SPIKE',
      severity: upgradeIfHighRevenue('MEDIUM', affectedRevenue),
      title: `${method} failure spike`,
      message: `${method} failures appeared ${currentCount} time${currentCount !== 1 ? 's' : ''} in the current window after no occurrences in the baseline period.`,
      observedValue: currentCount,
      baselineValue: null,
      ratioToBaseline: null,
      anomalyScore: computeAnomalyScore(null, affectedRevenue),
      affectedPaymentCount: currentCount,
      affectedRevenueInPaise: affectedRevenue,
      revenueAtRiskInPaise: revenueAtRisk,
      paymentMethod: method,
      windowStart,
      windowEnd,
      relatedPaymentIds: ids,
    };
  }

  const normalizedBaseline = baselineCount / ANOMALY_WINDOWS.NORMALIZATION_FACTOR;
  const ratio = currentCount / normalizedBaseline;
  if (ratio < ANOMALY_THRESHOLDS.SPIKE_MEDIUM) return null;

  const severity = upgradeIfHighRevenue(severityFromRatio(ratio), affectedRevenue);

  return {
    id: `anomaly_method_spike_${method}`,
    type: 'PAYMENT_METHOD_SPIKE',
    severity,
    title: `${method} failure spike`,
    message: `${method} failures are ${ratio.toFixed(1)}× above the recent baseline (${currentCount} current vs ${normalizedBaseline.toFixed(1)} expected).`,
    observedValue: currentCount,
    baselineValue: Math.round(normalizedBaseline * 10) / 10,
    ratioToBaseline: Math.round(ratio * 10) / 10,
    anomalyScore: computeAnomalyScore(ratio, affectedRevenue),
    affectedPaymentCount: currentCount,
    affectedRevenueInPaise: affectedRevenue,
    revenueAtRiskInPaise: revenueAtRisk,
    paymentMethod: method,
    windowStart,
    windowEnd,
    relatedPaymentIds: ids,
  };
}

function detectMethodSpike(
  currentCases: readonly RecoveryCase[],
  baselineCases: readonly RecoveryCase[],
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  const methods = new Set<PaymentMethod>([
    ...currentCases.map((c) => c.payment.paymentMethod),
    ...baselineCases.map((c) => c.payment.paymentMethod),
  ]);

  let top: PaymentFailureAnomaly | null = null;
  for (const method of methods) {
    const anomaly = scoreMethod(
      currentCases.filter((c) => c.payment.paymentMethod === method),
      baselineCases.filter((c) => c.payment.paymentMethod === method),
      method,
      windowStart,
      windowEnd,
    );
    if (!anomaly) continue;
    if (
      !top ||
      SEVERITY_RANK[anomaly.severity] < SEVERITY_RANK[top.severity] ||
      (SEVERITY_RANK[anomaly.severity] === SEVERITY_RANK[top.severity] &&
        anomaly.anomalyScore > top.anomalyScore)
    ) {
      top = anomaly;
    }
  }
  return top;
}

// ── D: Revenue Spike ──────────────────────────────────────────────────────────

function detectRevenueSpike(
  currentCases: readonly RecoveryCase[],
  baselineCases: readonly RecoveryCase[],
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  if (currentCases.length < ANOMALY_THRESHOLDS.MIN_SAMPLE_COUNT) return null;

  const currentRevenue = currentCases.reduce((s, c) => s + c.payment.amount, 0);
  const baselineRevenue = baselineCases.reduce((s, c) => s + c.payment.amount, 0);
  const revenueAtRisk = currentCases.reduce(
    (s, c) => s + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const ids = currentCases.map((c) => c.payment.paymentId as string);

  if (baselineRevenue === 0) {
    return {
      id: 'anomaly_revenue_spike',
      type: 'REVENUE_SPIKE',
      severity: upgradeIfHighRevenue('MEDIUM', currentRevenue),
      title: 'Failed revenue spike',
      message: `${formatPaise(currentRevenue)} in failed revenue appeared in the current window after no recorded revenue failures in the baseline period.`,
      observedValue: currentRevenue,
      baselineValue: null,
      ratioToBaseline: null,
      anomalyScore: computeAnomalyScore(null, currentRevenue),
      affectedPaymentCount: currentCases.length,
      affectedRevenueInPaise: currentRevenue,
      revenueAtRiskInPaise: revenueAtRisk,
      windowStart,
      windowEnd,
      relatedPaymentIds: ids,
    };
  }

  const normalizedBaselineRevenue = baselineRevenue / ANOMALY_WINDOWS.NORMALIZATION_FACTOR;
  const ratio = currentRevenue / normalizedBaselineRevenue;
  if (ratio < ANOMALY_THRESHOLDS.SPIKE_MEDIUM) return null;

  const severity = upgradeIfHighRevenue(severityFromRatio(ratio), currentRevenue);

  return {
    id: 'anomaly_revenue_spike',
    type: 'REVENUE_SPIKE',
    severity,
    title: 'Failed revenue spike',
    message: `Failed revenue is ${ratio.toFixed(1)}× above the recent baseline. ${formatPaise(currentRevenue)} in the last 30 days versus ${formatPaise(Math.round(normalizedBaselineRevenue))} expected from the baseline period.`,
    observedValue: currentRevenue,
    baselineValue: Math.round(normalizedBaselineRevenue),
    ratioToBaseline: Math.round(ratio * 10) / 10,
    anomalyScore: computeAnomalyScore(ratio, currentRevenue),
    affectedPaymentCount: currentCases.length,
    affectedRevenueInPaise: currentRevenue,
    revenueAtRiskInPaise: revenueAtRisk,
    windowStart,
    windowEnd,
    relatedPaymentIds: ids,
  };
}

// ── E: Risk Concentration ─────────────────────────────────────────────────────
//
// Portfolio-level alert: no baseline comparison needed.
// Fires when CRITICAL + HIGH risk payments represent an unusual share of
// the total active failed-revenue portfolio.

function detectRiskConcentration(
  activeCases: readonly RecoveryCase[],
  windowStart: string,
  windowEnd: string,
): PaymentFailureAnomaly | null {
  if (activeCases.length < ANOMALY_THRESHOLDS.RISK_CONC_MIN_COUNT) return null;

  const criticalHighCases = activeCases.filter(
    (c) =>
      c.revenueAtRiskScore.level === 'CRITICAL' ||
      c.revenueAtRiskScore.level === 'HIGH',
  );

  const totalRevenue = activeCases.reduce((s, c) => s + c.payment.amount, 0);
  const criticalHighRevenue = criticalHighCases.reduce((s, c) => s + c.payment.amount, 0);

  if (totalRevenue === 0) return null;

  const concentrationPct = criticalHighRevenue / totalRevenue;

  let severity: AnomalySeverity;
  if (concentrationPct >= ANOMALY_THRESHOLDS.RISK_CONC_CRITICAL)    severity = 'CRITICAL';
  else if (concentrationPct >= ANOMALY_THRESHOLDS.RISK_CONC_HIGH)   severity = 'HIGH';
  else if (concentrationPct >= ANOMALY_THRESHOLDS.RISK_CONC_MEDIUM) severity = 'MEDIUM';
  else return null;

  const totalRevenueAtRisk = criticalHighCases.reduce(
    (s, c) => s + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const n = criticalHighCases.length;
  const pctDisplay = `${Math.round(concentrationPct * 100)}%`;

  const concScore    = Math.round(concentrationPct * 60);
  const revenueScore = Math.min(40, Math.round(criticalHighRevenue / 50_000));
  const anomalyScore = Math.min(100, concScore + revenueScore);

  return {
    id: 'anomaly_risk_concentration',
    type: 'RISK_CONCENTRATION',
    severity,
    title: 'High-risk revenue concentration',
    message: `${pctDisplay} of active failed revenue is concentrated in ${n} CRITICAL or HIGH-risk payment${n !== 1 ? 's' : ''}, representing ${formatPaise(criticalHighRevenue)} with ${formatPaise(totalRevenueAtRisk)} at risk.`,
    observedValue: Math.round(concentrationPct * 100),
    baselineValue: null,
    ratioToBaseline: null,
    anomalyScore,
    affectedPaymentCount: n,
    affectedRevenueInPaise: criticalHighRevenue,
    revenueAtRiskInPaise: totalRevenueAtRisk,
    windowStart,
    windowEnd,
    relatedPaymentIds: criticalHighCases.map((c) => c.payment.paymentId as string),
  };
}

// ── Main Engine ───────────────────────────────────────────────────────────────

export function detectAnomalies(input: AnomalyEngineInput): PaymentFailureAnomaly[] {
  const now = input.now ?? new Date().toISOString();

  const currentWindowEnd   = now;
  const currentWindowStart = dateMinusDays(now, ANOMALY_WINDOWS.CURRENT_WINDOW_DAYS);
  const baselineWindowEnd  = currentWindowStart;
  const baselineWindowStart = dateMinusDays(
    now,
    ANOMALY_WINDOWS.CURRENT_WINDOW_DAYS + ANOMALY_WINDOWS.BASELINE_WINDOW_DAYS,
  );

  // Active cases = non-RECOVERED (recovered revenue is already secured)
  const activeCases = input.cases.filter((c) => c.executionResult.status !== 'RECOVERED');

  // Bucket by time window
  const currentCases = activeCases.filter((c) =>
    inWindow(c.payment.failedAt, currentWindowStart, currentWindowEnd),
  );
  const baselineCases = activeCases.filter((c) =>
    inWindow(c.payment.failedAt, baselineWindowStart, baselineWindowEnd),
  );

  const candidates: Array<PaymentFailureAnomaly | null> = [
    detectVolumeSpike(currentCases, baselineCases, currentWindowStart, currentWindowEnd),
    detectReasonSpike(currentCases, baselineCases, currentWindowStart, currentWindowEnd),
    detectMethodSpike(currentCases, baselineCases, currentWindowStart, currentWindowEnd),
    detectRevenueSpike(currentCases, baselineCases, currentWindowStart, currentWindowEnd),
    detectRiskConcentration(activeCases, currentWindowStart, currentWindowEnd),
  ];

  const anomalies = candidates.filter((a): a is PaymentFailureAnomaly => a !== null);
  return rankAnomalies(anomalies).slice(0, ANOMALY_THRESHOLDS.MAX_ANOMALIES);
}
