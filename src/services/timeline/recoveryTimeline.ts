import type { AuditEntry, AuditEventType } from '../../domain/audit/types';
import type { RecoveryMessageDraft } from '../../domain/messaging/types';
import type { PaymentId } from '../../domain/payments/types';
import type { RecoveryTimelineEvent, RecoveryTimelineEventStatus, RecoveryTimelineEventType, RecoveryTimelineReadModel } from '../../domain/timeline/types';
import type { ExperimentResult, ExperimentVariantStrategy } from '../../domain/experiment/types';
import type { CustomerRecoveryScore } from '../../domain/customerRecovery/types';
import type { RecoveryCase } from '../recovery/types';
import { generateRecoveryMessages } from '../messaging/recoveryMessageGenerator';
import { getAssignedMessageTone } from '../experiment/experimentEngine';
import { DEMO_EXPERIMENTS } from '../experiment/experimentRegistry';
import {
  formatAction,
  formatDelayMinutes,
  formatFailureReason,
  formatPaise,
  formatPaymentMethod,
  formatPercent,
  formatUtcDateTime,
} from '../../lib/formatters';

export const TIMELINE_EVENT_PRECEDENCE: Record<RecoveryTimelineEventType, number> = {
  PAYMENT_FAILED: 0,
  RECOVERY_RECOMMENDATION: 1,
  RECOVERY_SCORE: 2,
  RISK_SCORE: 3,
  CUSTOMER_RECOVERY_CONTEXT: 4,
  SMART_RETRY: 5,
  PAYMENT_METHOD_RECOMMENDATION: 6,
  EXPERIMENT_ASSIGNMENT: 7,
  POLICY_DECISION: 8,
  RECOVERY_MESSAGE: 9,
  ACTION_EXECUTED: 10,
  OUTCOME: 11,
};

const FAILURE_DESCRIPTION: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'Payment could not complete because the customer account had insufficient funds.',
  UPI_TIMEOUT: 'Payment timed out before completion.',
  BANK_SERVER_ERROR: 'The issuing bank or payment channel returned a temporary server error.',
  EXPIRED_CARD: 'The card on file is expired and cannot be charged.',
  AUTHENTICATION_FAILED: 'Customer authentication did not complete successfully.',
  CUSTOMER_ABANDONED: 'The customer left the payment flow before completion.',
};

function auditsOf(c: RecoveryCase, eventTypes: readonly AuditEventType[]): AuditEntry[] {
  return c.auditEntries.filter((entry) => eventTypes.includes(entry.eventType));
}

function eventId(paymentId: string, type: RecoveryTimelineEventType, suffix?: string | number): string {
  return suffix === undefined ? `${paymentId}:${type}` : `${paymentId}:${type}:${suffix}`;
}

function statusForOutcome(eventType: AuditEventType): RecoveryTimelineEventStatus {
  switch (eventType) {
    case 'PAYMENT_RECOVERED':
      return 'SUCCESS';
    case 'RECOVERY_FAILED':
    case 'ESCALATED':
      return 'WARNING';
    case 'ACTION_BLOCKED':
      return 'BLOCKED';
    case 'RECOVERY_PENDING':
      return 'INFO';
    default:
      return 'INFO';
  }
}

function sortEvents(events: readonly RecoveryTimelineEvent[]): RecoveryTimelineEvent[] {
  return [...events].sort((a, b) => {
    const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (timeDiff !== 0) return timeDiff;
    const precedenceDiff = TIMELINE_EVENT_PRECEDENCE[a.type] - TIMELINE_EVENT_PRECEDENCE[b.type];
    if (precedenceDiff !== 0) return precedenceDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function strategySummary(strategy: ExperimentVariantStrategy): string {
  switch (strategy.dimension) {
    case 'RETRY_TIMING':
      return `${formatDelayMinutes(strategy.retryDelayMinutes)} retry candidate`;
    case 'MESSAGE_TONE':
      return `${strategy.tone} recovery message tone`;
    default: {
      const _exhaustive: never = strategy;
      return String(_exhaustive);
    }
  }
}

function buildPaymentFailedEvent(c: RecoveryCase): RecoveryTimelineEvent {
  const { payment } = c;
  return {
    id: eventId(payment.paymentId, 'PAYMENT_FAILED'),
    paymentId: payment.paymentId,
    type: 'PAYMENT_FAILED',
    status: 'WARNING',
    kind: 'RECORDED',
    timestamp: payment.failedAt,
    title: 'Payment Failed',
    summary: `${formatPaise(payment.amount)} via ${formatPaymentMethod(payment.paymentMethod)}`,
    details: {
      amount: formatPaise(payment.amount),
      paymentMethod: formatPaymentMethod(payment.paymentMethod),
      failure: FAILURE_DESCRIPTION[payment.failureReason] ?? formatFailureReason(payment.failureReason),
      attempts: payment.attemptCount,
    },
    source: 'PAYMENT',
  };
}

function buildRecommendationEvent(c: RecoveryCase, audit: AuditEntry | undefined, index: number): RecoveryTimelineEvent {
  const { payment, recommendation } = c;
  return {
    id: eventId(payment.paymentId, 'RECOVERY_RECOMMENDATION', audit?.auditId ?? index),
    paymentId: payment.paymentId,
    type: 'RECOVERY_RECOMMENDATION',
    status: 'INFO',
    kind: audit ? 'RECORDED' : 'DERIVED',
    timestamp: audit?.timestamp ?? payment.failedAt,
    title: 'Recovery Recommendation',
    summary: `${formatAction(recommendation.recommendedAction)} with ${formatPercent(recommendation.confidence)} confidence`,
    details: {
      action: formatAction(recommendation.recommendedAction),
      confidence: formatPercent(recommendation.confidence),
      diagnosis: recommendation.diagnosis,
      reason: recommendation.reasoning,
      retryAfter: recommendation.retryAfterMinutes === null ? null : formatDelayMinutes(recommendation.retryAfterMinutes),
      maxAttempts: recommendation.maxAttempts,
    },
    source: audit ? 'AUDIT' : 'RECOMMENDATION',
  };
}

function buildRecoveryScoreEvent(c: RecoveryCase, timestamp: string): RecoveryTimelineEvent {
  const { payment, recoveryScore } = c;
  return {
    id: eventId(payment.paymentId, 'RECOVERY_SCORE'),
    paymentId: payment.paymentId,
    type: 'RECOVERY_SCORE',
    status: 'INFO',
    kind: 'DERIVED',
    timestamp,
    title: 'Revenue Recovery Score',
    summary: `${formatPaise(recoveryScore.expectedRecoverableAmountInPaise)} expected recovery · ${recoveryScore.priority} priority`,
    details: {
      recoveryProbability: formatPercent(recoveryScore.recoveryProbability),
      expectedRecovery: formatPaise(recoveryScore.expectedRecoverableAmountInPaise),
      priority: recoveryScore.priority,
    },
    source: 'RECOVERY_SCORE',
  };
}

function buildRiskScoreEvent(c: RecoveryCase, timestamp: string): RecoveryTimelineEvent {
  const { payment, revenueAtRiskScore } = c;
  return {
    id: eventId(payment.paymentId, 'RISK_SCORE'),
    paymentId: payment.paymentId,
    type: 'RISK_SCORE',
    status: revenueAtRiskScore.level === 'CRITICAL' || revenueAtRiskScore.level === 'HIGH' ? 'WARNING' : 'INFO',
    kind: 'DERIVED',
    timestamp,
    title: 'Revenue Risk Score',
    summary: `${revenueAtRiskScore.score} / 100 · ${revenueAtRiskScore.level} risk`,
    details: {
      score: revenueAtRiskScore.score,
      level: revenueAtRiskScore.level,
      revenueAtRisk: formatPaise(revenueAtRiskScore.revenueAtRiskInPaise),
      factors: revenueAtRiskScore.factors.join('; '),
    },
    source: 'RISK_SCORE',
  };
}

function buildSmartRetryEvent(c: RecoveryCase, timestamp: string): RecoveryTimelineEvent | null {
  const timing = c.smartRetryTiming;
  if (!timing) return null;
  return {
    id: eventId(c.payment.paymentId, 'SMART_RETRY'),
    paymentId: c.payment.paymentId,
    type: 'SMART_RETRY',
    status: 'INFO',
    kind: 'DERIVED',
    timestamp,
    title: 'Smart Retry Timing',
    summary: `Retry at ${formatUtcDateTime(timing.recommendedRetryAt)} UTC after ${formatDelayMinutes(timing.delayMinutes)}`,
    details: {
      recommendedRetryAt: `${formatUtcDateTime(timing.recommendedRetryAt)} UTC`,
      delay: formatDelayMinutes(timing.delayMinutes),
      confidence: timing.confidence,
      reason: timing.reason,
      source: timing.source.replace(/_/g, ' '),
    },
    source: 'SMART_RETRY',
  };
}

function buildCustomerRecoveryEvent(
  c: RecoveryCase,
  score: CustomerRecoveryScore | undefined,
  timestamp: string,
): RecoveryTimelineEvent | null {
  if (!score) return null;
  return {
    id: eventId(c.payment.paymentId, 'CUSTOMER_RECOVERY_CONTEXT'),
    paymentId: c.payment.paymentId,
    type: 'CUSTOMER_RECOVERY_CONTEXT',
    status: score.segment === 'LOW_RECOVERY_POTENTIAL' ? 'WARNING' : 'INFO',
    kind: 'DERIVED',
    timestamp,
    title: 'Customer Recovery Context',
    summary: `Customer score ${score.score} / 100 · ${score.segment.replace(/_/g, ' ')}`,
    details: {
      customerId: score.customerId,
      successfulPayments: score.successfulPaymentCount,
      historicalSuccessRate:
        score.historicalSuccessRate === null ? null : formatPercent(score.historicalSuccessRate),
      expectedRecovery: formatPaise(score.expectedRecoverableRevenueInPaise),
      revenueAtRisk: formatPaise(score.revenueAtRiskInPaise),
    },
    source: 'CUSTOMER_RECOVERY',
  };
}

function buildPaymentMethodEvent(c: RecoveryCase, timestamp: string): RecoveryTimelineEvent | null {
  const rec = c.paymentMethodSwitch;
  if (!rec.shouldSwitch || !rec.recommendedMethod) return null;
  return {
    id: eventId(c.payment.paymentId, 'PAYMENT_METHOD_RECOMMENDATION'),
    paymentId: c.payment.paymentId,
    type: 'PAYMENT_METHOD_RECOMMENDATION',
    status: 'INFO',
    kind: 'DERIVED',
    timestamp,
    title: 'Payment Method Recommendation',
    summary: `Switch from ${formatPaymentMethod(rec.currentMethod)} to ${formatPaymentMethod(rec.recommendedMethod)}`,
    details: {
      currentMethod: formatPaymentMethod(rec.currentMethod),
      recommendedMethod: formatPaymentMethod(rec.recommendedMethod),
      reason: rec.reason,
      alternatives: rec.alternatives.map((alt) => `${formatPaymentMethod(alt.method)} ${formatPercent(alt.score)}`).join('; '),
    },
    source: 'PAYMENT_METHOD',
  };
}

function buildExperimentEvents(
  c: RecoveryCase,
  experimentResults: readonly ExperimentResult[],
): RecoveryTimelineEvent[] {
  const events: RecoveryTimelineEvent[] = [];
  for (const result of experimentResults) {
    const outcome = result.outcomes.find((o) => o.paymentId === c.payment.paymentId);
    if (!outcome) continue;
    const variant = outcome.variantId === 'A' ? result.experiment.variantA : result.experiment.variantB;
    events.push({
      id: eventId(c.payment.paymentId, 'EXPERIMENT_ASSIGNMENT', `${result.experiment.id}:${outcome.variantId}`),
      paymentId: c.payment.paymentId,
      type: 'EXPERIMENT_ASSIGNMENT',
      status: 'INFO',
      kind: 'DERIVED',
      timestamp: outcome.assignedAt,
      title: 'Recovery Experiment',
      summary: `${result.experiment.name} · Variant ${outcome.variantId}`,
      details: {
        experiment: result.experiment.name,
        variant: `Variant ${outcome.variantId}`,
        variantName: variant.name,
        strategy: strategySummary(variant.strategy),
        candidateRetryDelay:
          outcome.candidateRetryDelayMinutes === null
            ? null
            : formatDelayMinutes(outcome.candidateRetryDelayMinutes),
        policyApprovedRetryDelay:
          outcome.policyApprovedRetryDelayMinutes === null
            ? null
            : formatDelayMinutes(outcome.policyApprovedRetryDelayMinutes),
      },
      source: 'EXPERIMENT',
    });
  }
  return events;
}

function buildPolicyEvent(c: RecoveryCase, audit: AuditEntry, index: number): RecoveryTimelineEvent {
  const decision = c.policyDecision;
  return {
    id: eventId(c.payment.paymentId, 'POLICY_DECISION', audit.auditId || index),
    paymentId: c.payment.paymentId,
    type: 'POLICY_DECISION',
    status: decision.approved ? 'SUCCESS' : 'BLOCKED',
    kind: 'RECORDED',
    timestamp: audit.timestamp,
    title: decision.approved ? 'Policy Approved' : 'Policy Blocked',
    summary: `${formatAction(decision.originalRecommendedAction)} → ${formatAction(decision.finalAction)}`,
    details: {
      recommendedAction: formatAction(decision.originalRecommendedAction),
      approvedAction: formatAction(decision.finalAction),
      recommendedDelay:
        c.recommendation.retryAfterMinutes === null ? null : formatDelayMinutes(c.recommendation.retryAfterMinutes),
      approvedDelay:
        decision.approvedRetryAfterMinutes == null ? null : formatDelayMinutes(decision.approvedRetryAfterMinutes),
      approvedRetryAt:
        decision.approvedRetryAt == null ? null : `${formatUtcDateTime(decision.approvedRetryAt)} UTC`,
      reason: decision.reason,
      rules: decision.policyRulesApplied.join(', ') || null,
    },
    source: 'AUDIT',
  };
}

function buildMessageEvent(c: RecoveryCase, draft: RecoveryMessageDraft, timestamp: string): RecoveryTimelineEvent {
  return {
    id: eventId(c.payment.paymentId, 'RECOVERY_MESSAGE', draft.channel),
    paymentId: c.payment.paymentId,
    type: 'RECOVERY_MESSAGE',
    status: 'INFO',
    kind: 'DERIVED',
    timestamp,
    title: 'Recovery Message Prepared',
    summary: `${draft.channel} draft · ${draft.tone} tone`,
    details: {
      channel: draft.channel,
      tone: draft.tone,
      status: 'Draft only',
      generatedFromAction: formatAction(draft.generatedFromAction),
      requiresPaymentLink: draft.requiresPaymentLink,
    },
    source: 'MESSAGE',
  };
}

function buildActionEvent(c: RecoveryCase, audit: AuditEntry, index: number): RecoveryTimelineEvent {
  return {
    id: eventId(c.payment.paymentId, 'ACTION_EXECUTED', audit.auditId || index),
    paymentId: c.payment.paymentId,
    type: 'ACTION_EXECUTED',
    status: 'INFO',
    kind: 'RECORDED',
    timestamp: audit.timestamp,
    title: 'Recovery Action Executed',
    summary: `${formatAction(c.executionResult.action)} executed`,
    details: {
      action: formatAction(c.executionResult.action),
      status: c.executionResult.status,
      executorMessage: c.executionResult.message,
    },
    source: 'AUDIT',
  };
}

function buildOutcomeEvent(c: RecoveryCase, audit: AuditEntry, index: number): RecoveryTimelineEvent {
  const status = c.executionResult.status;
  const title = status === 'RECOVERED'
    ? 'Payment Recovered'
    : status === 'FAILED'
      ? 'Recovery Failed'
      : status === 'PENDING'
        ? 'Recovery Pending'
        : status === 'ESCALATED'
          ? 'Escalated'
          : 'Action Blocked';

  return {
    id: eventId(c.payment.paymentId, 'OUTCOME', audit.auditId || index),
    paymentId: c.payment.paymentId,
    type: 'OUTCOME',
    status: statusForOutcome(audit.eventType),
    kind: 'RECORDED',
    timestamp: audit.timestamp,
    title,
    summary: audit.message,
    details: {
      outcome: status,
      recoveredAmount: formatPaise(c.executionResult.recoveredAmount),
      action: formatAction(c.executionResult.action),
    },
    source: 'AUDIT',
  };
}

function buildSummary(c: RecoveryCase) {
  return {
    paymentId: c.payment.paymentId,
    failedAmountFormatted: formatPaise(c.payment.amount),
    expectedRecoveryFormatted: formatPaise(c.recoveryScore.expectedRecoverableAmountInPaise),
    revenueAtRiskFormatted: formatPaise(c.revenueAtRiskScore.revenueAtRiskInPaise),
    recoveryPriority: c.recoveryScore.priority,
    riskLevel: c.revenueAtRiskScore.level,
    currentStrategy: formatAction(c.policyDecision.finalAction),
    currentOutcome: c.executionResult.status,
  };
}

export interface TimelineAssemblerInput {
  recoveryCase: RecoveryCase;
  experimentResults?: readonly ExperimentResult[];
  messageDrafts?: readonly RecoveryMessageDraft[];
  customerRecoveryScore?: CustomerRecoveryScore;
}

export function buildRecoveryTimeline({
  recoveryCase,
  experimentResults = [],
  messageDrafts,
  customerRecoveryScore,
}: TimelineAssemblerInput): RecoveryTimelineReadModel {
  const events: RecoveryTimelineEvent[] = [buildPaymentFailedEvent(recoveryCase)];

  const recommendationAudits = auditsOf(recoveryCase, ['RECOVERY_RECOMMENDED']);
  const recommendationTimestamp = recommendationAudits[0]?.timestamp ?? recoveryCase.payment.failedAt;
  if (recommendationAudits.length > 0) {
    recommendationAudits.forEach((audit, index) => events.push(buildRecommendationEvent(recoveryCase, audit, index + 1)));
  } else {
    events.push(buildRecommendationEvent(recoveryCase, undefined, 1));
  }

  // Derived intelligence is anchored to the recommendation timestamp because it is computed
  // from the recommendation/payment read model and has no independent recorded timestamp.
  events.push(buildRecoveryScoreEvent(recoveryCase, recommendationTimestamp));
  events.push(buildRiskScoreEvent(recoveryCase, recommendationTimestamp));

  const customerRecovery = buildCustomerRecoveryEvent(
    recoveryCase,
    customerRecoveryScore,
    recommendationTimestamp,
  );
  if (customerRecovery) events.push(customerRecovery);

  const smartRetry = buildSmartRetryEvent(recoveryCase, recommendationTimestamp);
  if (smartRetry) events.push(smartRetry);

  const method = buildPaymentMethodEvent(recoveryCase, recommendationTimestamp);
  if (method) events.push(method);

  events.push(...buildExperimentEvents(recoveryCase, experimentResults));

  const policyAudits = auditsOf(recoveryCase, ['POLICY_APPROVED', 'POLICY_REJECTED']);
  const policyTimestamp = policyAudits[0]?.timestamp ?? recommendationTimestamp;
  policyAudits.forEach((audit, index) => events.push(buildPolicyEvent(recoveryCase, audit, index + 1)));

  const drafts =
    messageDrafts ??
    (generateRecoveryMessages({
      paymentId: recoveryCase.payment.paymentId,
      customerName: recoveryCase.payment.customerName,
      amountInPaise: recoveryCase.payment.amount,
      failureReason: recoveryCase.payment.failureReason,
      finalAction: recoveryCase.policyDecision.finalAction,
      policyApproved: recoveryCase.policyDecision.approved,
      smartRetryTiming: recoveryCase.smartRetryTiming,
      paymentMethodSwitch: recoveryCase.paymentMethodSwitch,
      riskLevel: recoveryCase.revenueAtRiskScore.level,
      tone: getAssignedMessageTone(DEMO_EXPERIMENTS, recoveryCase.payment.customerId),
    }) ?? []);

  const messageTimestamp = policyTimestamp;
  const firstDraft = drafts[0];
  if (firstDraft) events.push(buildMessageEvent(recoveryCase, firstDraft, messageTimestamp));

  auditsOf(recoveryCase, ['ACTION_EXECUTED']).forEach((audit, index) =>
    events.push(buildActionEvent(recoveryCase, audit, index + 1)),
  );

  auditsOf(recoveryCase, ['PAYMENT_RECOVERED', 'RECOVERY_FAILED', 'RECOVERY_PENDING', 'ESCALATED', 'ACTION_BLOCKED'])
    .forEach((audit, index) => events.push(buildOutcomeEvent(recoveryCase, audit, index + 1)));

  return {
    paymentId: recoveryCase.payment.paymentId,
    summary: buildSummary(recoveryCase),
    events: sortEvents(events),
  };
}

export function getRecoveryTimelineByPaymentId(
  paymentId: PaymentId,
  cases: readonly RecoveryCase[],
  experimentResults: readonly ExperimentResult[] = [],
): RecoveryTimelineReadModel | null {
  const recoveryCase = cases.find((c) => c.payment.paymentId === paymentId);
  if (!recoveryCase) return null;
  return buildRecoveryTimeline({ recoveryCase, experimentResults });
}

export function summarizeRecoveryTimelineForCopilot(timeline: RecoveryTimelineReadModel): string {
  return timeline.events
    .filter((event) =>
      event.type === 'PAYMENT_FAILED' ||
      event.type === 'RECOVERY_RECOMMENDATION' ||
      event.type === 'CUSTOMER_RECOVERY_CONTEXT' ||
      event.type === 'SMART_RETRY' ||
      event.type === 'PAYMENT_METHOD_RECOMMENDATION' ||
      event.type === 'EXPERIMENT_ASSIGNMENT' ||
      event.type === 'POLICY_DECISION' ||
      event.type === 'ACTION_EXECUTED' ||
      event.type === 'OUTCOME',
    )
    .map((event) => `${event.title}: ${event.summary}`)
    .join('\n');
}
