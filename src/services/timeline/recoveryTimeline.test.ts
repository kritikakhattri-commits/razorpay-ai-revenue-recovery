import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../domain/audit/types';
import type { FailedPayment } from '../../domain/payments/types';
import type { RecoveryRecommendation } from '../../domain/recovery/types';
import type { PolicyDecision } from '../../domain/policy/types';
import type { RecoveryExecutionResult, ExecutionStatus } from '../../domain/executor/types';
import type { RecoveryCase } from '../recovery/types';
import type { RecoveryScore } from '../../domain/recovery/recoveryScore';
import type { RevenueAtRiskScore } from '../../domain/recovery/revenueAtRisk';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import { runDashboard } from '../../lib/dashboardData';
import { formatDelayMinutes, formatPaise, formatPercent } from '../../lib/formatters';
import { runAllExperiments } from '../experiment/experimentEngine';
import { DEMO_EXPERIMENTS } from '../experiment/experimentRegistry';
import { buildRecoveryTimeline, summarizeRecoveryTimelineForCopilot, TIMELINE_EVENT_PRECEDENCE } from './recoveryTimeline';
import { answerCopilotQuestion } from '../copilot/copilotService';

const FAILED_AT = '2026-01-01T10:32:00.000Z';
const RECOMMENDED_AT = '2026-01-01T10:32:10.000Z';
const POLICY_AT = '2026-01-01T10:32:20.000Z';
const EXECUTED_AT = '2026-01-01T11:32:00.000Z';
const OUTCOME_AT = '2026-01-01T11:33:00.000Z';

function payment(overrides: Partial<FailedPayment> = {}): FailedPayment {
  return {
    paymentId: 'pay_timeline_001' as FailedPayment['paymentId'],
    customerId: 'cust_timeline_001' as FailedPayment['customerId'],
    customerName: 'Timeline Customer',
    amount: 499900,
    currency: 'INR',
    paymentMethod: 'UPI',
    failureReason: 'UPI_TIMEOUT',
    attemptCount: 1,
    previousSuccessfulPayments: 6,
    lastAttemptAt: FAILED_AT,
    failedAt: FAILED_AT,
    ...overrides,
  };
}

function audit(
  eventType: AuditEntry['eventType'],
  timestamp: string,
  index: number,
  metadata: Record<string, unknown> = {},
): AuditEntry {
  return {
    auditId: `audit_${index}`,
    paymentId: 'pay_timeline_001',
    eventType,
    timestamp,
    message: `${eventType} message`,
    metadata,
  };
}

function recoveryCase(overrides: {
  payment?: Partial<FailedPayment>;
  status?: ExecutionStatus;
  approved?: boolean;
  finalAction?: RecoveryRecommendation['recommendedAction'];
  smartRetryTiming?: SmartRetryTiming | null;
  paymentMethodSwitch?: PaymentMethodSwitchRecommendation;
  auditEntries?: AuditEntry[];
} = {}): RecoveryCase {
  const p = payment(overrides.payment);
  const action = overrides.finalAction ?? 'RETRY_LATER';
  const status = overrides.status ?? 'RECOVERED';
  const recommendation: RecoveryRecommendation = {
    diagnosis: 'Temporary UPI timeout',
    recommendedAction: action,
    retryAfterMinutes: action === 'RETRY_LATER' ? 30 : null,
    confidence: 0.84,
    reasoning: 'UPI timeout is usually transient.',
    maxAttempts: 3,
  };
  const smartRetryTiming = overrides.smartRetryTiming === undefined
    ? {
        recommendedRetryAt: '2026-01-01T11:02:00.000Z',
        delayMinutes: 30,
        confidence: 'MEDIUM',
        reason: 'UPI timeout is likely temporary; retry after 30 minutes.',
        source: 'FAILURE_REASON',
      } satisfies SmartRetryTiming
    : overrides.smartRetryTiming;
  const policyDecision: PolicyDecision = {
    approved: overrides.approved ?? true,
    finalAction: action,
    reason: 'Retry approved after deterministic policy checks.',
    originalRecommendedAction: action,
    policyRulesApplied: [],
    approvedRetryAfterMinutes: smartRetryTiming?.delayMinutes ?? null,
    approvedRetryAt: smartRetryTiming?.recommendedRetryAt ?? null,
  };
  const executionResult: RecoveryExecutionResult = {
    paymentId: p.paymentId,
    action,
    status,
    executedAt: EXECUTED_AT,
    recoveredAmount: status === 'RECOVERED' ? p.amount : 0,
    message: `${status} executor message`,
  };
  const recoveryScore: RecoveryScore = {
    recoveryProbability: recommendation.confidence,
    expectedRecoverableAmountInPaise: Math.round(p.amount * recommendation.confidence),
    priority: 'HIGH',
  };
  const revenueAtRiskScore: RevenueAtRiskScore = {
    score: 62,
    level: 'HIGH',
    revenueAtRiskInPaise: p.amount - recoveryScore.expectedRecoverableAmountInPaise,
    factors: ['Large failed payment amount', 'Prior payment history noted'],
  };
  const paymentMethodSwitch = overrides.paymentMethodSwitch ?? {
    currentMethod: p.paymentMethod,
    shouldSwitch: false,
    recommendedMethod: null,
    alternatives: [],
    reason: 'UPI timeout appears temporary. Retrying after the recommended delay is preferred over switching methods.',
  };
  const defaultAudits = [
    audit('PAYMENT_FAILED', RECOMMENDED_AT, 1),
    audit('RECOVERY_RECOMMENDED', RECOMMENDED_AT, 2),
    audit(policyDecision.approved ? 'POLICY_APPROVED' : 'POLICY_REJECTED', POLICY_AT, 3),
    ...(policyDecision.approved ? [audit('ACTION_EXECUTED', EXECUTED_AT, 4)] : []),
    audit(
      status === 'RECOVERED'
        ? 'PAYMENT_RECOVERED'
        : status === 'FAILED'
          ? 'RECOVERY_FAILED'
          : status === 'PENDING'
            ? 'RECOVERY_PENDING'
            : status === 'ESCALATED'
              ? 'ESCALATED'
              : 'ACTION_BLOCKED',
      OUTCOME_AT,
      5,
    ),
  ];
  return {
    payment: p,
    recommendation,
    policyDecision,
    executionResult,
    auditEntries: overrides.auditEntries ?? defaultAudits,
    recoveredAmount: executionResult.recoveredAmount,
    recoveryScore,
    smartRetryTiming,
    paymentMethodSwitch,
    revenueAtRiskScore,
  };
}

function types(c: RecoveryCase) {
  return buildRecoveryTimeline({ recoveryCase: c }).events.map((event) => event.type);
}

describe('Recovery timeline assembler', () => {
  it('generates the payment-failed event from payment data', () => {
    const c = recoveryCase();
    const event = buildRecoveryTimeline({ recoveryCase: c }).events[0];
    expect(event.type).toBe('PAYMENT_FAILED');
    expect(event.timestamp).toBe(c.payment.failedAt);
    expect(event.summary).toContain(formatPaise(c.payment.amount));
  });

  it('generates recommendation, Revenue Recovery Score, and Revenue Risk Score events', () => {
    const eventTypes = types(recoveryCase());
    expect(eventTypes).toContain('RECOVERY_RECOMMENDATION');
    expect(eventTypes).toContain('RECOVERY_SCORE');
    expect(eventTypes).toContain('RISK_SCORE');
  });

  it('uses existing Revenue Recovery Score values', () => {
    const c = recoveryCase();
    const event = buildRecoveryTimeline({ recoveryCase: c }).events.find((e) => e.type === 'RECOVERY_SCORE')!;
    expect(event.summary).toContain(formatPaise(c.recoveryScore.expectedRecoverableAmountInPaise));
    expect(event.details?.recoveryProbability).toBe(formatPercent(c.recoveryScore.recoveryProbability));
  });

  it('uses existing RevenueAtRiskScore values and factors', () => {
    const c = recoveryCase();
    const event = buildRecoveryTimeline({ recoveryCase: c }).events.find((e) => e.type === 'RISK_SCORE')!;
    expect(event.summary).toContain(String(c.revenueAtRiskScore.score));
    expect(event.details?.revenueAtRisk).toBe(formatPaise(c.revenueAtRiskScore.revenueAtRiskInPaise));
    expect(event.details?.factors).toContain(c.revenueAtRiskScore.factors[0]);
  });

  it('generates Smart Retry when relevant and omits it when absent', () => {
    expect(types(recoveryCase())).toContain('SMART_RETRY');
    expect(types(recoveryCase({ smartRetryTiming: null }))).not.toContain('SMART_RETRY');
  });

  it('uses existing Smart Retry values', () => {
    const c = recoveryCase();
    const event = buildRecoveryTimeline({ recoveryCase: c }).events.find((e) => e.type === 'SMART_RETRY')!;
    expect(event.summary).toContain(formatDelayMinutes(c.smartRetryTiming!.delayMinutes));
    expect(event.details?.reason).toBe(c.smartRetryTiming!.reason);
  });

  it('generates payment-method switch event only when switching is recommended', () => {
    const withSwitch = recoveryCase({
      paymentMethodSwitch: {
        currentMethod: 'CARD',
        shouldSwitch: true,
        recommendedMethod: 'UPI',
        alternatives: [{ method: 'UPI', score: 0.9, reason: 'UPI bypasses card expiry.' }],
        reason: 'The current card is expired and cannot be retried.',
      },
    });
    expect(types(withSwitch)).toContain('PAYMENT_METHOD_RECOMMENDATION');
    expect(types(recoveryCase())).not.toContain('PAYMENT_METHOD_RECOMMENDATION');
  });

  it('generates experiment assignment when the payment is assigned', () => {
    const c = recoveryCase();
    const experiments = runAllExperiments(DEMO_EXPERIMENTS, [c], '2026-01-01T12:00:00.000Z');
    const timeline = buildRecoveryTimeline({ recoveryCase: c, experimentResults: experiments });
    expect(timeline.events.map((e) => e.type)).toContain('EXPERIMENT_ASSIGNMENT');
  });

  it('generates policy decision and separates recommendation vs approved value', () => {
    const c = recoveryCase();
    const event = buildRecoveryTimeline({ recoveryCase: c }).events.find((e) => e.type === 'POLICY_DECISION')!;
    expect(event.details?.recommendedAction).toBe('Retry Later');
    expect(event.details?.approvedAction).toBe('Retry Later');
    expect(event.details?.recommendedDelay).toBe('30 min');
    expect(event.details?.approvedDelay).toBe('30 min');
  });

  it('generates recovery-message draft event without labeling it as sent', () => {
    const event = buildRecoveryTimeline({ recoveryCase: recoveryCase() }).events.find((e) => e.type === 'RECOVERY_MESSAGE')!;
    expect(event.summary).toContain('draft');
    expect(event.details?.status).toBe('Draft only');
    expect(event.summary.toLowerCase()).not.toContain('sent');
  });

  it('creates action-executed only when an audit execution exists', () => {
    expect(types(recoveryCase())).toContain('ACTION_EXECUTED');
    const c = recoveryCase({ status: 'ESCALATED', approved: false });
    expect(types(c)).not.toContain('ACTION_EXECUTED');
  });

  it('supports recovered, failed, pending, escalated, and blocked outcomes', () => {
    expect(buildRecoveryTimeline({ recoveryCase: recoveryCase({ status: 'RECOVERED' }) }).events.at(-1)?.title).toBe('Payment Recovered');
    expect(buildRecoveryTimeline({ recoveryCase: recoveryCase({ status: 'FAILED' }) }).events.at(-1)?.title).toBe('Recovery Failed');
    expect(buildRecoveryTimeline({ recoveryCase: recoveryCase({ status: 'PENDING' }) }).events.at(-1)?.title).toBe('Recovery Pending');
    expect(buildRecoveryTimeline({ recoveryCase: recoveryCase({ status: 'ESCALATED', approved: false }) }).events.at(-1)?.title).toBe('Escalated');
    expect(buildRecoveryTimeline({ recoveryCase: recoveryCase({ status: 'BLOCKED', approved: false, finalAction: 'UPDATE_PAYMENT_METHOD' }) }).events.at(-1)?.title).toBe('Action Blocked');
  });

  it('sorts chronologically with deterministic same-timestamp precedence', () => {
    const sameTime = '2026-01-01T10:32:00.000Z';
    const c = recoveryCase({
      auditEntries: [
        audit('ACTION_EXECUTED', sameTime, 4),
        audit('POLICY_APPROVED', sameTime, 3),
        audit('RECOVERY_RECOMMENDED', sameTime, 2),
        audit('PAYMENT_RECOVERED', sameTime, 5),
      ],
    });
    const events = buildRecoveryTimeline({ recoveryCase: c }).events;
    const ranks = events.map((event) => TIMELINE_EVENT_PRECEDENCE[event.type]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('uses deterministic event IDs', () => {
    const c = recoveryCase();
    const first = buildRecoveryTimeline({ recoveryCase: c }).events.map((e) => e.id);
    const second = buildRecoveryTimeline({ recoveryCase: c }).events.map((e) => e.id);
    expect(first).toEqual(second);
    expect(first[0]).toBe(`${c.payment.paymentId}:PAYMENT_FAILED`);
  });

  it('does not mutate input data or audit records', () => {
    const c = recoveryCase();
    const before = JSON.stringify(c);
    buildRecoveryTimeline({ recoveryCase: c });
    expect(JSON.stringify(c)).toBe(before);
  });

  it('handles empty optional feature data and partial timelines safely', () => {
    const c = recoveryCase({ smartRetryTiming: null, auditEntries: [] });
    const timeline = buildRecoveryTimeline({ recoveryCase: c, experimentResults: [], messageDrafts: [] });
    expect(timeline.events.map((event) => event.type)).toContain('PAYMENT_FAILED');
    expect(timeline.events.map((event) => event.type)).toContain('RECOVERY_RECOMMENDATION');
    expect(timeline.events.map((event) => event.type)).not.toContain('RECOVERY_MESSAGE');
  });

  it('supports multiple recorded recovery attempts from audit history', () => {
    const c = recoveryCase({
      auditEntries: [
        audit('RECOVERY_RECOMMENDED', RECOMMENDED_AT, 2),
        audit('POLICY_APPROVED', POLICY_AT, 3),
        audit('ACTION_EXECUTED', EXECUTED_AT, 4),
        audit('RECOVERY_FAILED', OUTCOME_AT, 5),
        audit('RECOVERY_RECOMMENDED', '2026-01-01T11:34:00.000Z', 6),
        audit('ACTION_EXECUTED', '2026-01-01T12:34:00.000Z', 7),
        audit('PAYMENT_RECOVERED', '2026-01-01T12:35:00.000Z', 8),
      ],
    });
    const events = buildRecoveryTimeline({ recoveryCase: c }).events;
    expect(events.filter((event) => event.type === 'RECOVERY_RECOMMENDATION')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'ACTION_EXECUTED')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'OUTCOME')).toHaveLength(2);
  });

  it('reuses audit timestamps for recorded events and marks kinds correctly', () => {
    const c = recoveryCase();
    const timeline = buildRecoveryTimeline({ recoveryCase: c });
    expect(timeline.events.find((e) => e.type === 'POLICY_DECISION')?.timestamp).toBe(POLICY_AT);
    expect(timeline.events.find((e) => e.type === 'ACTION_EXECUTED')?.timestamp).toBe(EXECUTED_AT);
    expect(timeline.events.find((e) => e.type === 'POLICY_DECISION')?.kind).toBe('RECORDED');
    expect(timeline.events.find((e) => e.type === 'RECOVERY_SCORE')?.kind).toBe('DERIVED');
  });

  it('matches existing dashboard feature values for a real payment', () => {
    const data = runDashboard();
    const c = data.batch.cases[0];
    const timeline = buildRecoveryTimeline({ recoveryCase: c, experimentResults: data.experimentResults });
    expect(timeline.summary.expectedRecoveryFormatted).toBe(formatPaise(c.recoveryScore.expectedRecoverableAmountInPaise));
    expect(timeline.summary.revenueAtRiskFormatted).toBe(formatPaise(c.revenueAtRiskScore.revenueAtRiskInPaise));
  });

  it('summarizes timeline for Copilot and Copilot consumes that summary', async () => {
    const data = runDashboard();
    const c = data.batch.cases[0];
    const timeline = buildRecoveryTimeline({ recoveryCase: c, experimentResults: data.experimentResults });
    const summary = summarizeRecoveryTimelineForCopilot(timeline);
    expect(summary).toContain('Payment Failed');

    const response = await answerCopilotQuestion(
      { query: `What happened to ${c.payment.paymentId}?` },
      data,
    );
    expect(response.answer).toContain('Timeline summary');
    expect(response.answer).toContain('Payment Failed');
    expect(response.sources.map((s) => s.type)).toContain('TIMELINE');
  });

  it('handles missing payment lookup safely through Copilot', async () => {
    const response = await answerCopilotQuestion(
      { query: 'What happened to this payment?', paymentId: 'pay_missing' as FailedPayment['paymentId'] },
      runDashboard(),
    );
    expect(response.answer).toContain('could not find payment');
  });
});
