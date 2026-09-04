import type { PaymentId, FailureReason, PaymentMethod } from '../../domain/payments/types';
import type {
  CopilotIntent,
  CopilotLanguageModel,
  CopilotRequest,
  CopilotResponse,
  CopilotSource,
} from '../../domain/copilot/types';
import type { DashboardData } from '../../lib/dashboardData';
import type { RecoveryCase } from '../recovery/types';
import type { ExperimentResult } from '../../domain/experiment/types';
import type { CustomerRecoveryQueueItem } from '../../domain/customerRecovery/types';
import { buildRecoveryQueue } from '../queue/recoveryQueue';
import { formatAction, formatDelayMinutes, formatFailureReason, formatPaise, formatPaymentMethod, formatPercent, formatUtcDateTime } from '../../lib/formatters';
import { appearsToRequestExecution, resolveCopilotIntent } from './intentResolver';
import { buildRecoveryTimeline, summarizeRecoveryTimelineForCopilot } from '../timeline/recoveryTimeline';

export interface CopilotServiceOptions {
  languageModel?: CopilotLanguageModel;
}

type Aggregation<K extends string> = {
  key: K;
  count: number;
  revenueInPaise: number;
};

const GENERIC_SAFE_ANSWER =
  'I can answer questions about the current revenue-recovery portfolio, failed payments, recovery risk, forecasts, anomalies, experiments, and customer recovery intelligence.';

function source(type: CopilotSource['type'], label: string, id?: string): CopilotSource {
  return id ? { type, label, id } : { type, label };
}

function topByRevenue<K extends string>(
  cases: readonly RecoveryCase[],
  keyFor: (c: RecoveryCase) => K,
): Aggregation<K> | null {
  const map = new Map<K, Aggregation<K>>();
  for (const c of cases) {
    const key = keyFor(c);
    const current = map.get(key) ?? { key, count: 0, revenueInPaise: 0 };
    map.set(key, {
      key,
      count: current.count + 1,
      revenueInPaise: current.revenueInPaise + c.payment.amount,
    });
  }
  return [...map.values()].sort((a, b) => {
    const revenueDiff = b.revenueInPaise - a.revenueInPaise;
    if (revenueDiff !== 0) return revenueDiff;
    const countDiff = b.count - a.count;
    if (countDiff !== 0) return countDiff;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  })[0] ?? null;
}

function numbered(lines: readonly string[]): string {
  return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

function uniqueSources(sources: readonly CopilotSource[]): CopilotSource[] {
  const seen = new Set<string>();
  const result: CopilotSource[] = [];
  for (const s of sources) {
    const key = `${s.type}:${s.id ?? ''}:${s.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }
  return result;
}

function followUps(intent: CopilotIntent, paymentId?: PaymentId): string[] {
  if (paymentId) {
    return [
      `Why is ${paymentId} high risk?`,
      `When should ${paymentId} be retried?`,
      `Why is this payment method recommended for ${paymentId}?`,
      `What does PolicyEngine allow for ${paymentId}?`,
    ];
  }

  const byIntent: Record<CopilotIntent, string[]> = {
    PORTFOLIO_SUMMARY: [
      'Show my top recovery opportunities',
      'How much revenue is at risk?',
      'What will recover in the next 24 hours?',
    ],
    TOP_OPPORTUNITIES: [
      'Why is the top payment ranked highest?',
      'Show critical-risk payments',
      'What should I focus on?',
    ],
    REVENUE_AT_RISK: [
      'Show critical-risk payments',
      'What should I focus on?',
      'Are there any anomalies?',
    ],
    RECOVERY_FORECAST: [
      'Show my top recovery opportunities',
      'How much is forecast beyond 3 days?',
      'What should I focus on?',
    ],
    FAILURE_ANALYSIS: [
      'Which payment method is failing the most?',
      'Are there any anomalies?',
      'Show my top recovery opportunities',
    ],
    ANOMALIES: [
      'What should I focus on?',
      'Which payment method is failing the most?',
      'Show critical-risk payments',
    ],
    EXPERIMENT_STATUS: [
      'Which experiment is leading?',
      'Show my top recovery opportunities',
      'What should I focus on?',
    ],
    PAYMENT_LOOKUP: [
      'Why is this payment high risk?',
      'When should this payment be retried?',
      'What does PolicyEngine allow?',
    ],
    CUSTOMER_RECOVERY: [
      'Which customers have the highest recovery potential?',
      'Which customer has the most recoverable revenue?',
      'Show my top recovery opportunities',
    ],
    TOP_CUSTOMERS: [
      'Which customer has the most recoverable revenue?',
      'Why is this customer score low?',
      'Show my top recovery opportunities',
    ],
    RECOMMENDED_FOCUS: [
      'Show my top recovery opportunities',
      'How much revenue is at risk?',
      'Are there any anomalies?',
    ],
    STRATEGY_PERFORMANCE: [
      'Which strategy works best for UPI timeouts?',
      'Which payment method switch recovers the most revenue?',
      'How do high recovery potential customers perform?',
    ],
    BEST_STRATEGY: [
      'How do strategies compare overall?',
      'Which payment method switch recovers the most revenue?',
      'Show my top recovery opportunities',
    ],
    RECOVERY_HEALTH: [
      'What is hurting the recovery health score?',
      'What can improve the recovery health score?',
      'Show the strongest and weakest components',
      'Show my top recovery opportunities',
    ],
    WHAT_IF_SIMULATION: [
      'What if we target the top 10 queue items?',
      'What if we prioritize all critical-risk payments?',
      'Compare all simulation scenarios',
      'Which scenario has the highest estimated recovery?',
    ],
    UNKNOWN: [
      'What should I focus on?',
      'Show my top recovery opportunities',
      'How much revenue is at risk?',
    ],
  };
  return byIntent[intent].slice(0, 4);
}

function findCustomerFromQuery(
  query: string,
  customers: readonly CustomerRecoveryQueueItem[],
): CustomerRecoveryQueueItem | null {
  const normalized = query.toLowerCase();
  return customers.find(
    (customer) =>
      normalized.includes(customer.customerName.toLowerCase()) ||
      normalized.includes(String(customer.customerId).toLowerCase()),
  ) ?? null;
}

function customerRecoveryAnswer(customer: CustomerRecoveryQueueItem): string {
  return [
    `${customer.customerName} has a Customer Recovery Score of ${customer.score}/100 and is classified as ${customer.segment.replace(/_/g, ' ')}.`,
    ``,
    `Active failed revenue: ${formatPaise(customer.activeFailedRevenueInPaise)}`,
    `Expected recovery: ${formatPaise(customer.expectedRecoverableRevenueInPaise)}`,
    `Revenue at risk: ${formatPaise(customer.revenueAtRiskInPaise)}`,
    `Previous successful payments: ${customer.successfulPaymentCount}`,
    `Historical success rate: ${customer.historicalSuccessRate === null ? 'not available from current data' : formatPercent(customer.historicalSuccessRate)}`,
    `Preferred successful method: ${customer.preferredSuccessfulPaymentMethod ? formatPaymentMethod(customer.preferredSuccessfulPaymentMethod) : 'not available from current data'}`,
    `Preferred payment window: ${customer.preferredSuccessfulPaymentWindow ?? 'not available from current data'}`,
    `Why:\n${customer.factors.map((f) => `- ${f}`).join('\n')}`,
  ].join('\n');
}

function topCustomers(data: DashboardData): CopilotResponse {
  const customers = data.customerRecovery.customers.slice(0, 5);
  const answer = customers.length === 0
    ? 'There are no customers with active failed-payment recovery data.'
    : [
        `Top customers by expected recoverable revenue:`,
        ``,
        ...customers.map((customer) =>
          `#${customer.rank} ${customer.customerName}: score ${customer.score}/100, ${customer.segment.replace(/_/g, ' ')}, ${formatPaise(customer.expectedRecoverableRevenueInPaise)} expected recovery from ${formatPaise(customer.activeFailedRevenueInPaise)} active failed revenue.`,
        ),
      ].join('\n');
  return {
    intent: 'TOP_CUSTOMERS',
    answer,
    sources: [source('CUSTOMER', 'Customer Recovery Intelligence')],
    suggestedFollowUps: followUps('TOP_CUSTOMERS'),
    requiresApproval: false,
  };
}

function customerRecovery(data: DashboardData, query: string): CopilotResponse {
  const customer = findCustomerFromQuery(query, data.customerRecovery.customers)
    ?? data.customerRecovery.customers[0]
    ?? null;
  if (!customer) {
    return {
      intent: 'CUSTOMER_RECOVERY',
      answer: 'I could not find customer recovery data in the current portfolio.',
      sources: [source('CUSTOMER', 'Customer Recovery Intelligence')],
      suggestedFollowUps: followUps('CUSTOMER_RECOVERY'),
      requiresApproval: false,
    };
  }
  return {
    intent: 'CUSTOMER_RECOVERY',
    answer: customerRecoveryAnswer(customer),
    sources: [source('CUSTOMER', 'Customer Recovery Intelligence', String(customer.customerId))],
    suggestedFollowUps: followUps('CUSTOMER_RECOVERY'),
    requiresApproval: false,
  };
}

function portfolioSummary(data: DashboardData): CopilotResponse {
  const { batch, insights } = data;
  const topInsight = insights[0]?.message;
  const answer = [
    `Current portfolio summary:`,
    ``,
    `Failed revenue: ${formatPaise(batch.totalRevenueAtRisk)}`,
    `Recovered revenue: ${formatPaise(batch.totalRecoveredRevenue)}`,
    `Expected recoverable revenue: ${formatPaise(batch.totalExpectedRecoverableRevenue)}`,
    `Revenue still at risk: ${formatPaise(batch.totalRevenueUnrecoverableInPaise)}`,
    `Current recovery rate: ${formatPercent(batch.recoveryRate)}`,
    `Forecast recovery rate: ${formatPercent(batch.forecast.expectedRecoveryRate)}`,
    topInsight ? `Top insight: ${topInsight}` : null,
  ].filter((line): line is string => line !== null).join('\n');

  return {
    intent: 'PORTFOLIO_SUMMARY',
    answer,
    sources: uniqueSources([
      source('RECOVERY_SCORE', 'Revenue Recovery Score'),
      source('RISK_SCORE', 'Revenue Risk Score'),
      source('FORECAST', 'Revenue Recovery Forecast'),
      source('INSIGHT', 'Revenue Insights Feed'),
    ]),
    suggestedFollowUps: followUps('PORTFOLIO_SUMMARY'),
    requiresApproval: false,
  };
}

function topOpportunities(data: DashboardData): CopilotResponse {
  const queue = buildRecoveryQueue(data.batch.cases);
  const top = queue.items.slice(0, 5);
  const answer = top.length === 0
    ? 'There are no recovery opportunities in the current portfolio.'
    : [
        `The biggest current recovery opportunity is ${top[0].paymentId}.`,
        ``,
        ...top.map((item) =>
          `#${item.queueRank} ${item.paymentId}: ${formatPaise(item.amountInPaise)} failed, ${formatPercent(item.recoveryScore.recoveryProbability)} recovery probability, ${formatPaise(item.recoveryScore.expectedRecoverableAmountInPaise)} expected recovery, ${item.recoveryScore.priority} priority, recommended action ${formatAction(item.recommendedAction)}.`,
        ),
      ].join('\n');

  return {
    intent: 'TOP_OPPORTUNITIES',
    answer,
    sources: [source('QUEUE', 'Recovery Queue')],
    suggestedFollowUps: followUps('TOP_OPPORTUNITIES'),
    requiresApproval: false,
  };
}

function revenueAtRisk(data: DashboardData): CopilotResponse {
  const highRiskCases = data.batch.cases.filter(
    (c) => c.revenueAtRiskScore.level === 'CRITICAL' || c.revenueAtRiskScore.level === 'HIGH',
  );
  const highRiskRevenue = highRiskCases.reduce(
    (sum, c) => sum + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const critical = highRiskCases.filter((c) => c.revenueAtRiskScore.level === 'CRITICAL');
  const topFactors = [...new Set(highRiskCases.flatMap((c) => c.revenueAtRiskScore.factors))].slice(0, 4);

  return {
    intent: 'REVENUE_AT_RISK',
    answer: [
      `${formatPaise(highRiskRevenue)} is currently at risk across HIGH and CRITICAL-risk payments.`,
      `${critical.length} payment${critical.length !== 1 ? 's are' : ' is'} classified as CRITICAL risk.`,
      `Risk distribution: ${data.batch.riskCriticalCount} critical, ${data.batch.riskHighCount} high, ${data.batch.riskMediumCount} medium, ${data.batch.riskLowCount} low.`,
      topFactors.length > 0 ? `Top deterministic risk factors:\n${topFactors.map((f) => `- ${f}`).join('\n')}` : null,
    ].filter((line): line is string => line !== null).join('\n\n'),
    sources: [source('RISK_SCORE', 'Revenue Risk Score')],
    suggestedFollowUps: followUps('REVENUE_AT_RISK'),
    requiresApproval: false,
  };
}

function recoveryForecast(data: DashboardData): CopilotResponse {
  const forecast = data.batch.forecast;
  return {
    intent: 'RECOVERY_FORECAST',
    answer: [
      `${formatPaise(forecast.expectedRecoveredRevenueInPaise)} is expected to recover from the current failed-payment portfolio.`,
      ``,
      `${formatPaise(forecast.byHorizon.next24HoursInPaise)} is forecast within the next 24 hours.`,
      `${formatPaise(forecast.byHorizon.next3DaysInPaise)} is forecast in the next 3 days.`,
      `${formatPaise(forecast.byHorizon.beyond3DaysInPaise)} is forecast beyond 3 days.`,
      `Expected unrecovered revenue: ${formatPaise(forecast.expectedUnrecoveredRevenueInPaise)}.`,
      `Forecast confidence: ${forecast.forecastConfidence}.`,
    ].join('\n'),
    sources: [source('FORECAST', 'Revenue Recovery Forecast')],
    suggestedFollowUps: followUps('RECOVERY_FORECAST'),
    requiresApproval: false,
  };
}

function failureAnalysis(data: DashboardData): CopilotResponse {
  const active = data.batch.cases.filter((c) => c.executionResult.status !== 'RECOVERED');
  const reason = topByRevenue<FailureReason>(active, (c) => c.payment.failureReason);
  const method = topByRevenue<PaymentMethod>(active, (c) => c.payment.paymentMethod);
  const insightLines = data.insights
    .filter((i) => i.type === 'TREND' || i.type === 'RISK')
    .slice(0, 3)
    .map((i) => i.message);
  const anomaly = data.anomalies[0];

  return {
    intent: 'FAILURE_ANALYSIS',
    answer: [
      active.length === 0
        ? 'There are no active failed payments to analyze.'
        : 'The most important current failure signals are:',
      reason
        ? `Largest failure reason by failed revenue: ${formatFailureReason(reason.key)} across ${reason.count} payment${reason.count !== 1 ? 's' : ''}, representing ${formatPaise(reason.revenueInPaise)}.`
        : null,
      method
        ? `Payment method with the most failed revenue: ${formatPaymentMethod(method.key)} across ${method.count} payment${method.count !== 1 ? 's' : ''}, representing ${formatPaise(method.revenueInPaise)}.`
        : null,
      ...insightLines,
      anomaly ? `Top anomaly signal: ${anomaly.message}` : null,
    ].filter((line): line is string => line !== null).join('\n'),
    sources: uniqueSources([
      source('PAYMENT', 'Failed Payment Portfolio'),
      source('INSIGHT', 'Revenue Insights Feed'),
      source('ANOMALY', 'Anomaly Detection'),
    ]),
    suggestedFollowUps: followUps('FAILURE_ANALYSIS'),
    requiresApproval: false,
  };
}

function anomalies(data: DashboardData): CopilotResponse {
  const answer = data.anomalies.length === 0
    ? 'No significant payment failure anomalies are currently detected.'
    : [
        `Yes. ${data.anomalies[0].message}`,
        ``,
        ...data.anomalies.slice(0, 3).map((a) =>
          `${a.title}: ${a.affectedPaymentCount} payment${a.affectedPaymentCount !== 1 ? 's' : ''}, ${formatPaise(a.affectedRevenueInPaise)} affected revenue, ${formatPaise(a.revenueAtRiskInPaise)} at risk.`,
        ),
      ].join('\n');
  return {
    intent: 'ANOMALIES',
    answer,
    sources: [source('ANOMALY', 'Anomaly Detection')],
    suggestedFollowUps: followUps('ANOMALIES'),
    requiresApproval: false,
  };
}

function experimentStatus(data: DashboardData): CopilotResponse {
  const running = data.experimentResults.filter((r) => r.experiment.status === 'RUNNING');
  const leading = running.find(
    (r) => r.comparison.status === 'A_LEADING' || r.comparison.status === 'B_LEADING',
  );
  let answer: string;
  if (leading && leading.comparison.leadingVariantId) {
    const variant =
      leading.comparison.leadingVariantId === 'A'
        ? leading.comparison.variantA
        : leading.comparison.variantB;
    answer = `Experiment ${leading.experiment.name} has Variant ${variant.variantId} leading: ${variant.variantName}, with ${formatPercent(variant.recoveryRate)} recovery rate across ${variant.completedCount} completed payments.`;
  } else if (running.length > 0) {
    answer = running
      .map((r) => {
        if (r.comparison.status === 'INSUFFICIENT_DATA') {
          return `${r.experiment.name} is still collecting enough completed payments for a directional comparison.`;
        }
        return `${r.experiment.name} has no clear leading variant yet.`;
      })
      .join('\n');
  } else {
    answer = 'There are no running recovery experiments right now.';
  }
  return {
    intent: 'EXPERIMENT_STATUS',
    answer,
    sources: running.map((r) => source('EXPERIMENT', r.experiment.name, r.experiment.id)),
    suggestedFollowUps: followUps('EXPERIMENT_STATUS'),
    requiresApproval: false,
  };
}

function recommendedFocus(data: DashboardData): CopilotResponse {
  const queue = buildRecoveryQueue(data.batch.cases);
  const highRiskCases = data.batch.cases.filter(
    (c) => c.revenueAtRiskScore.level === 'CRITICAL' || c.revenueAtRiskScore.level === 'HIGH',
  );
  const highRiskRevenue = highRiskCases.reduce(
    (sum, c) => sum + c.revenueAtRiskScore.revenueAtRiskInPaise,
    0,
  );
  const topFiveExpected = queue.items
    .slice(0, 5)
    .reduce((sum, item) => sum + item.recoveryScore.expectedRecoverableAmountInPaise, 0);
  const focusLines = [
    `${highRiskCases.length} HIGH/CRITICAL-risk payment${highRiskCases.length !== 1 ? 's' : ''} representing ${formatPaise(highRiskRevenue)} at risk.`,
    `The top ${Math.min(5, queue.items.length)} recovery opportunities represent ${formatPaise(topFiveExpected)} expected recovery.`,
    data.anomalies[0] ? data.anomalies[0].message : null,
    `${formatPaise(data.batch.forecast.byHorizon.next24HoursInPaise)} is forecast to recover within the next 24 hours.`,
    data.experimentResults.some((r) => r.comparison.leadingVariantId)
      ? 'At least one experiment has a guardrail-approved leading variant.'
      : null,
  ].filter((line): line is string => line !== null);

  return {
    intent: 'RECOMMENDED_FOCUS',
    answer: `Focus on these areas first:\n\n${numbered(focusLines)}`,
    sources: uniqueSources([
      source('RISK_SCORE', 'Revenue Risk Score'),
      source('QUEUE', 'Recovery Queue'),
      source('ANOMALY', 'Anomaly Detection'),
      source('FORECAST', 'Revenue Recovery Forecast'),
      source('EXPERIMENT', 'Recovery Strategy Experiments'),
    ]),
    suggestedFollowUps: followUps('RECOMMENDED_FOCUS'),
    requiresApproval: false,
  };
}

function paymentLookup(data: DashboardData, paymentId: PaymentId): CopilotResponse {
  const recoveryCase = data.batch.cases.find((c) => c.payment.paymentId === paymentId);
  if (!recoveryCase) {
    return {
      intent: 'PAYMENT_LOOKUP',
      answer: `I could not find payment ${paymentId} in the current failed-payment portfolio.`,
      sources: [source('PAYMENT', 'Failed Payment Portfolio')],
      suggestedFollowUps: followUps('PAYMENT_LOOKUP'),
      requiresApproval: false,
    };
  }

  const { payment, recoveryScore, revenueAtRiskScore, smartRetryTiming, paymentMethodSwitch, policyDecision } = recoveryCase;
  const timeline = buildRecoveryTimeline({
    recoveryCase,
    experimentResults: data.experimentResults,
  });
  const timingLines = smartRetryTiming
    ? [
        `Best retry time: ${formatUtcDateTime(smartRetryTiming.recommendedRetryAt)} UTC`,
        `Retry delay: ${formatDelayMinutes(smartRetryTiming.delayMinutes)} (${smartRetryTiming.confidence} confidence)`,
        `Retry reason: ${smartRetryTiming.reason}`,
      ]
    : ['Best retry time: no retry timing is recommended for this action.'];
  const methodLine = paymentMethodSwitch.shouldSwitch && paymentMethodSwitch.recommendedMethod
    ? `Payment method recommendation: switch from ${formatPaymentMethod(paymentMethodSwitch.currentMethod)} to ${formatPaymentMethod(paymentMethodSwitch.recommendedMethod)}. ${paymentMethodSwitch.reason}`
    : `Payment method recommendation: keep ${formatPaymentMethod(paymentMethodSwitch.currentMethod)}. ${paymentMethodSwitch.reason}`;

  return {
    intent: 'PAYMENT_LOOKUP',
    answer: [
      `${payment.paymentId} is ${revenueAtRiskScore.level} risk with recommended action ${formatAction(recoveryCase.recommendation.recommendedAction)}.`,
      ``,
      `Failed amount: ${formatPaise(payment.amount)}`,
      `Payment method: ${formatPaymentMethod(payment.paymentMethod)}`,
      `Failure reason: ${formatFailureReason(payment.failureReason)}`,
      `Recovery probability: ${formatPercent(recoveryScore.recoveryProbability)}`,
      `Expected recovery: ${formatPaise(recoveryScore.expectedRecoverableAmountInPaise)}`,
      `Revenue at risk: ${formatPaise(revenueAtRiskScore.revenueAtRiskInPaise)}`,
      `Risk factors:\n${revenueAtRiskScore.factors.map((f) => `- ${f}`).join('\n')}`,
      ...timingLines,
      methodLine,
      `PolicyEngine decision: ${policyDecision.approved ? 'approved' : 'rejected'} ${formatAction(policyDecision.finalAction)}. ${policyDecision.reason}`,
      `Current outcome: ${recoveryCase.executionResult.status}.`,
      ``,
      `Timeline summary:\n${summarizeRecoveryTimelineForCopilot(timeline)}`,
    ].join('\n'),
    sources: uniqueSources([
      source('PAYMENT', 'Payment Detail', String(payment.paymentId)),
      source('TIMELINE', 'Recovery Timeline', String(payment.paymentId)),
      source('RECOVERY_SCORE', 'Revenue Recovery Score', String(payment.paymentId)),
      source('RISK_SCORE', 'Revenue Risk Score', String(payment.paymentId)),
      source('POLICY', 'PolicyEngine', String(payment.paymentId)),
    ]),
    suggestedFollowUps: followUps('PAYMENT_LOOKUP', paymentId),
    requiresApproval: false,
  };
}

// ── Feature 14: Strategy Performance handlers ─────────────────────────────────

function strategyPerformance(data: DashboardData): CopilotResponse {
  const { portfolioSummary, strategyMetrics } = data.strategyAnalytics;
  const { bestRecoveryRateStrategy, highestRevenueStrategy } = portfolioSummary;
  const observed = strategyMetrics.filter((m) => m.performanceStatus !== 'INSUFFICIENT_DATA');

  if (observed.length === 0) {
    return {
      intent: 'STRATEGY_PERFORMANCE',
      answer: 'There are not enough completed recovery attempts to compare strategies reliably.',
      sources: [source('STRATEGY_ANALYTICS', 'Recovery Strategy Performance Analytics')],
      suggestedFollowUps: followUps('STRATEGY_PERFORMANCE'),
      requiresApproval: false,
    };
  }

  const lines: string[] = [
    `Recovery strategy performance summary (observed data only):`,
    ``,
  ];

  for (const m of observed.slice(0, 5)) {
    const rate = m.recoveryRate !== null ? formatPercent(m.recoveryRate) : 'n/a';
    const revenue = formatPaise(m.recoveredRevenueInPaise);
    const time = m.averageRecoveryTimeMinutes !== null
      ? ` avg ${formatDelayMinutes(m.averageRecoveryTimeMinutes)}`
      : '';
    const badge = m.performanceStatus === 'LEADING' ? ' ★ LEADING' : '';
    lines.push(`${m.label}${badge}: ${rate} recovery rate, ${revenue} recovered${time} (${m.completedAttempts} completed)`);
  }

  if (bestRecoveryRateStrategy) {
    lines.push(``, `Best recovery rate: ${bestRecoveryRateStrategy.label} at ${bestRecoveryRateStrategy.recoveryRate !== null ? formatPercent(bestRecoveryRateStrategy.recoveryRate) : 'n/a'}.`);
  }
  if (highestRevenueStrategy && highestRevenueStrategy.label !== bestRecoveryRateStrategy?.label) {
    lines.push(`Most revenue recovered: ${highestRevenueStrategy.label} — ${formatPaise(highestRevenueStrategy.recoveredRevenueInPaise)}.`);
  }

  return {
    intent: 'STRATEGY_PERFORMANCE',
    answer: lines.join('\n'),
    sources: [source('STRATEGY_ANALYTICS', 'Recovery Strategy Performance Analytics')],
    suggestedFollowUps: followUps('STRATEGY_PERFORMANCE'),
    requiresApproval: false,
  };
}

function bestStrategy(data: DashboardData, query: string): CopilotResponse {
  const { portfolioSummary, failureReasonPerformance, paymentMethodPerformance } = data.strategyAnalytics;

  // Check if the question mentions a failure reason
  const failureReasonMatch = failureReasonPerformance.find((f) =>
    query.toLowerCase().includes(f.failureReason.toLowerCase().replace(/_/g, ' ')) ||
    query.toLowerCase().includes(f.failureReason.toLowerCase()),
  );

  if (failureReasonMatch) {
    const best = failureReasonMatch.bestStrategy;
    const answer = best
      ? `For ${failureReasonMatch.failureReason.replace(/_/g, ' ')} failures, the best observed strategy is ${best.label} with a ${best.recoveryRate !== null ? formatPercent(best.recoveryRate) : 'n/a'} recovery rate across ${best.completedAttempts} completed attempts, recovering ${formatPaise(best.recoveredRevenueInPaise)}.`
      : `There are not enough completed attempts for ${failureReasonMatch.failureReason.replace(/_/g, ' ')} failures to identify a best strategy reliably.`;
    return {
      intent: 'BEST_STRATEGY',
      answer,
      sources: [source('STRATEGY_ANALYTICS', 'Recovery Strategy Performance Analytics')],
      suggestedFollowUps: followUps('BEST_STRATEGY'),
      requiresApproval: false,
    };
  }

  // Check if the question mentions a payment method
  const methodMatch = paymentMethodPerformance.find((p) =>
    query.toLowerCase().includes(p.paymentMethod.toLowerCase()),
  );

  if (methodMatch) {
    const best = methodMatch.bestStrategy;
    const rate = methodMatch.recoveryRate !== null ? formatPercent(methodMatch.recoveryRate) : 'n/a';
    const answer = best
      ? `For ${methodMatch.paymentMethod} failures, the best observed strategy is ${best.label} with ${best.recoveryRate !== null ? formatPercent(best.recoveryRate) : 'n/a'} recovery rate. Overall ${methodMatch.paymentMethod} recovery rate: ${rate} across ${methodMatch.completedAttempts} completed attempts, recovering ${formatPaise(methodMatch.recoveredRevenueInPaise)}.`
      : `${methodMatch.paymentMethod} failures have ${rate} overall recovery rate, but no individual strategy has enough completed attempts to declare a best strategy.`;
    return {
      intent: 'BEST_STRATEGY',
      answer,
      sources: [source('STRATEGY_ANALYTICS', 'Recovery Strategy Performance Analytics')],
      suggestedFollowUps: followUps('BEST_STRATEGY'),
      requiresApproval: false,
    };
  }

  // Overall best strategy
  const best = portfolioSummary.bestRecoveryRateStrategy;
  if (!best) {
    return {
      intent: 'BEST_STRATEGY',
      answer: 'There are not enough completed recovery attempts to identify a best strategy reliably.',
      sources: [source('STRATEGY_ANALYTICS', 'Recovery Strategy Performance Analytics')],
      suggestedFollowUps: followUps('BEST_STRATEGY'),
      requiresApproval: false,
    };
  }

  const rate = best.recoveryRate !== null ? formatPercent(best.recoveryRate) : 'n/a';
  const answer = [
    `Among strategies with sufficient completed attempts, ${best.label} currently has the highest observed recovery rate at ${rate}.`,
    ``,
    `It recovered ${formatPaise(best.recoveredRevenueInPaise)} across ${best.completedAttempts} completed attempts.`,
    best.averageRecoveryTimeMinutes !== null
      ? `Average recovery time: ${formatDelayMinutes(best.averageRecoveryTimeMinutes)}.`
      : null,
  ].filter((l): l is string => l !== null).join('\n');

  return {
    intent: 'BEST_STRATEGY',
    answer,
    sources: [source('STRATEGY_ANALYTICS', 'Recovery Strategy Performance Analytics')],
    suggestedFollowUps: followUps('BEST_STRATEGY'),
    requiresApproval: false,
  };
}

// ── Feature 16: Recovery Health handler ──────────────────────────────────────

function recoveryHealth(data: DashboardData): CopilotResponse {
  const { health } = data.recoveryHealth;
  const summary = data.recoveryHealth;
  const strongest = health.strongestComponent;
  const weakest   = health.weakestComponent;

  const lines: string[] = [
    `Recovery Health is ${health.score}/100, classified as ${health.status}.`,
    '',
    health.executiveSummary,
    '',
    `Component breakdown:`,
    ...health.components.map((c) => `  ${c.label}: ${c.score}/100`),
    '',
    `Strongest area: ${strongest.label} (${strongest.score}/100)`,
    `Weakest area: ${weakest.label} (${weakest.score}/100)`,
  ];

  if (health.mainConcern) {
    lines.push('', `Main concern: ${health.mainConcern}`);
  }

  if (health.mainOpportunity) {
    lines.push('', `Main opportunity: ${health.mainOpportunity}`);
  }

  if (summary.bestObservedStrategy) {
    lines.push('', `Best observed strategy: ${summary.bestObservedStrategy}`);
  }

  return {
    intent: 'RECOVERY_HEALTH',
    answer: lines.join('\n'),
    sources: [source('HEALTH_SCORE', 'Recovery Health Score')],
    suggestedFollowUps: followUps('RECOVERY_HEALTH'),
    requiresApproval: false,
  };
}

// ── Feature 15: What-If Simulation handler ────────────────────────────────────

function whatIfSimulation(data: DashboardData, query: string): CopilotResponse {
  const { presetSimulations } = data;
  const q = query.toLowerCase();

  if (presetSimulations.length === 0) {
    return {
      intent: 'WHAT_IF_SIMULATION',
      answer: 'No simulation data is available. Run the dashboard to compute preset simulations.',
      sources: [source('SIMULATION', 'What-If Recovery Simulator')],
      suggestedFollowUps: followUps('WHAT_IF_SIMULATION'),
      requiresApproval: false,
    };
  }

  // Match query to a preset scenario by keywords.
  let selected = presetSimulations.find((r) => {
    if (q.includes('high confidence') || q.includes('high-confidence')) return r.scenarioId === 'preset_high_confidence';
    if (q.includes('critical') && q.includes('risk')) return r.scenarioId === 'preset_critical_risk';
    if (q.includes('top') && (q.includes('queue') || q.includes('10') || q.includes('ten'))) return r.scenarioId === 'preset_top_queue';
    if (q.includes('upi') && (q.includes('timeout') || q.includes('60'))) return r.scenarioId === 'preset_upi_timeout_60min';
    if (q.includes('best observed') || q.includes('best strategy')) return r.scenarioId === 'preset_best_observed';
    return false;
  });

  // If "compare" in query, compare all presets and highlight best.
  if (
    !selected &&
    (q.includes('compare') || q.includes('comparison') || q.includes('which scenario') || q.includes('best scenario'))
  ) {
    const withData = presetSimulations.filter((r) => r.eligiblePaymentCount > 0);
    const byRevenue = [...withData].sort(
      (a, b) => b.estimatedRecoverableRevenueInPaise - a.estimatedRecoverableRevenueInPaise,
    );
    const best = byRevenue[0] ?? null;
    const lines = [
      'Scenario comparison (estimated, simulation only):',
      '',
      ...presetSimulations.map(
        (r) =>
          `${r.scenarioName}: ${r.eligiblePaymentCount} payments, ` +
          `${formatPaise(r.estimatedRecoverableRevenueInPaise)} estimated recovery ` +
          `(${formatPercent(r.estimatedRecoveryRate)} rate)`,
      ),
      '',
      best ? `Highest estimated recovery: ${best.scenarioName} — ${formatPaise(best.estimatedRecoverableRevenueInPaise)}.` : 'No scenario has data.',
      '',
      'SIMULATION — No recovery actions were executed.',
    ];
    return {
      intent: 'WHAT_IF_SIMULATION',
      answer: lines.join('\n'),
      sources: [source('SIMULATION', 'What-If Recovery Simulator')],
      suggestedFollowUps: followUps('WHAT_IF_SIMULATION'),
      requiresApproval: false,
    };
  }

  // Default: return the best scenario by estimated recovery.
  if (!selected) {
    selected = [...presetSimulations].sort(
      (a, b) => b.estimatedRecoverableRevenueInPaise - a.estimatedRecoverableRevenueInPaise,
    )[0] ?? presetSimulations[0] ?? null;
  }

  if (!selected) {
    return {
      intent: 'WHAT_IF_SIMULATION',
      answer: 'No simulation data is available.',
      sources: [source('SIMULATION', 'What-If Recovery Simulator')],
      suggestedFollowUps: followUps('WHAT_IF_SIMULATION'),
      requiresApproval: false,
    };
  }

  const r = selected;
  const delta = r.scenarioDeltaInPaise;
  const deltaLine = delta > 0
    ? `Estimated uplift vs. current baseline: +${formatPaise(delta)}.`
    : delta < 0
      ? `Estimated difference vs. current baseline: ${formatPaise(delta)}.`
      : 'Matches current baseline estimate.';

  const answer = [
    `WHAT-IF SIMULATION: ${r.scenarioName}`,
    '',
    r.scenarioDescription,
    '',
    `Eligible payments: ${r.eligiblePaymentCount}`,
    `Targeted failed revenue: ${formatPaise(r.targetedFailedRevenueInPaise)}`,
    `Estimated recoverable revenue: ${formatPaise(r.estimatedRecoverableRevenueInPaise)}`,
    `Estimated recovery rate: ${formatPercent(r.estimatedRecoveryRate)}`,
    `Remaining revenue at risk: ${formatPaise(r.estimatedRevenueAtRiskInPaise)}`,
    '',
    `Policy impact — Approved: ${r.policyApprovedCount} | Modified: ${r.policyModifiedCount} | Blocked: ${r.policyBlockedCount}`,
    '',
    deltaLine,
    '',
    'SIMULATION — No recovery actions were executed.',
  ].join('\n');

  return {
    intent: 'WHAT_IF_SIMULATION',
    answer,
    sources: [source('SIMULATION', `What-If Simulator: ${r.scenarioName}`, r.scenarioId)],
    suggestedFollowUps: followUps('WHAT_IF_SIMULATION'),
    requiresApproval: false,
  };
}

function unknownResponse(): CopilotResponse {
  return {
    intent: 'UNKNOWN',
    answer: GENERIC_SAFE_ANSWER,
    sources: [],
    suggestedFollowUps: followUps('UNKNOWN'),
    requiresApproval: false,
  };
}

function safetyResponse(): CopilotResponse {
  return {
    intent: 'UNKNOWN',
    answer:
      'I can analyze and recommend recovery actions, but executable actions must still pass through operator approval, the PolicyEngine, the RecoveryExecutor, and audit logging.',
    sources: [source('POLICY', 'PolicyEngine Safety Boundary')],
    suggestedFollowUps: followUps('UNKNOWN'),
    requiresApproval: true,
  };
}

function composeDeterministicResponse(
  request: CopilotRequest,
  data: DashboardData,
): CopilotResponse {
  if (appearsToRequestExecution(request.query)) return safetyResponse();

  const knownPaymentIds = data.batch.cases.map((c) => c.payment.paymentId);
  const resolved = resolveCopilotIntent(request.query, knownPaymentIds, request.paymentId);

  switch (resolved.intent) {
    case 'PAYMENT_LOOKUP':
      return paymentLookup(data, resolved.paymentId ?? request.paymentId ?? ('' as PaymentId));
    case 'CUSTOMER_RECOVERY':
      return customerRecovery(data, request.query);
    case 'TOP_CUSTOMERS':
      return topCustomers(data);
    case 'PORTFOLIO_SUMMARY':
      return portfolioSummary(data);
    case 'TOP_OPPORTUNITIES':
      return topOpportunities(data);
    case 'REVENUE_AT_RISK':
      return revenueAtRisk(data);
    case 'RECOVERY_FORECAST':
      return recoveryForecast(data);
    case 'FAILURE_ANALYSIS':
      return failureAnalysis(data);
    case 'ANOMALIES':
      return anomalies(data);
    case 'EXPERIMENT_STATUS':
      return experimentStatus(data);
    case 'RECOMMENDED_FOCUS':
      return recommendedFocus(data);
    case 'STRATEGY_PERFORMANCE':
      return strategyPerformance(data);
    case 'BEST_STRATEGY':
      return bestStrategy(data, request.query);
    case 'RECOVERY_HEALTH':
      return recoveryHealth(data);
    case 'WHAT_IF_SIMULATION':
      return whatIfSimulation(data, request.query);
    case 'UNKNOWN':
      return unknownResponse();
    default: {
      const _exhaustive: never = resolved.intent;
      return _exhaustive;
    }
  }
}

function responseWithAnswer(response: CopilotResponse, answer: string): CopilotResponse {
  return { ...response, answer };
}

export async function answerCopilotQuestion(
  request: CopilotRequest,
  data: DashboardData,
  options: CopilotServiceOptions = {},
): Promise<CopilotResponse> {
  if (request.query.trim().length === 0) {
    return {
      ...unknownResponse(),
      answer: 'Ask a question about the current revenue-recovery portfolio.',
    };
  }

  const deterministic = composeDeterministicResponse(request, data);
  if (!options.languageModel) return deterministic;

  try {
    const answer = await options.languageModel.rephrase({
      intent: deterministic.intent,
      deterministicAnswer: deterministic.answer,
      sources: deterministic.sources,
    });
    if (answer.trim().length === 0) return deterministic;
    return responseWithAnswer(deterministic, answer);
  } catch {
    return deterministic;
  }
}

export function summarizeExperimentsForCopilot(results: readonly ExperimentResult[]): string[] {
  return results.map((r) => `${r.experiment.id}:${r.comparison.status}`);
}
