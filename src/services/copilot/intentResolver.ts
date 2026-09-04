import type { PaymentId } from '../../domain/payments/types';
import type { CopilotIntent, ResolvedCopilotIntent } from '../../domain/copilot/types';

const PAYMENT_ID_CANDIDATE = /\b(?:pay|PAY)_[A-Za-z0-9]+\b/g;

const INTENT_KEYWORDS: ReadonlyArray<{
  intent: Exclude<CopilotIntent, 'PAYMENT_LOOKUP' | 'UNKNOWN'>;
  phrases: readonly string[];
}> = [
  {
    intent: 'RECOVERY_HEALTH',
    phrases: [
      'recovery health',
      'health score',
      'health of recovery',
      'how healthy',
      'executive summary',
      'overall status',
      'overall health',
      'what is hurting',
      'improve the score',
      'improve recovery health',
      'why is the score',
      'why is recovery health',
      'recovery health score',
      'is recovery healthy',
    ],
  },
  {
    intent: 'WHAT_IF_SIMULATION',
    phrases: [
      'what if',
      'what if we',
      'what if i',
      'simulate',
      'simulation',
      'hypothetical',
      'what would happen if',
      'if we prioritize',
      'if we retry',
      'if we target',
      'if we focus',
      'compare scenarios',
      'scenario comparison',
      'preset scenario',
      'top 10 queue scenario',
      'high confidence scenario',
      'critical risk scenario',
      'best observed scenario',
      'upi timeout scenario',
    ],
  },
  {
    intent: 'BEST_STRATEGY',
    phrases: [
      'best strategy for',
      'what is the best strategy',
      'optimal strategy',
      'best strategy for upi',
      'best strategy for card',
      'best strategy for expired',
      'best for timeout',
      'which strategy for',
    ],
  },
  {
    intent: 'STRATEGY_PERFORMANCE',
    phrases: [
      'strategy performance',
      'which strategy works best',
      'best recovery strategy',
      'strategy analytics',
      'how do strategies compare',
      'strategy comparison',
      'which payment method switch',
      'retry strategy',
      'method switching',
      'recovery strategies',
      'leading strategy',
      'highest recovery rate strategy',
      'most revenue recovered strategy',
    ],
  },
  {
    intent: 'ANOMALIES',
    phrases: ['anomaly', 'anomalies', 'unusual', 'spike', 'above baseline', 'failure spike'],
  },
  {
    intent: 'TOP_CUSTOMERS',
    phrases: [
      'top customers',
      'highest recovery potential',
      'most recoverable revenue',
      'customer recovery potential',
      'customers have the highest',
    ],
  },
  {
    intent: 'CUSTOMER_RECOVERY',
    phrases: [
      'customer recovery',
      'customer score',
      'customer profile',
      'recovery profile',
      "customer's score",
    ],
  },
  {
    intent: 'EXPERIMENT_STATUS',
    phrases: ['experiment', 'a/b', 'ab test', 'a b test', 'variant', 'leading'],
  },
  {
    intent: 'RECOVERY_FORECAST',
    phrases: ['forecast', 'next 24', '24 hours', 'next three days', 'next 3 days', 'recover in'],
  },
  {
    intent: 'REVENUE_AT_RISK',
    phrases: ['revenue at risk', 'at risk', 'risk', 'critical risk', 'high risk'],
  },
  {
    intent: 'TOP_OPPORTUNITIES',
    phrases: [
      'biggest opportunity',
      'biggest opportunities',
      'top opportunity',
      'top opportunities',
      'top recovery opportunity',
      'top recovery opportunities',
      'highest recovery',
      'best recovery',
      'recovery queue',
    ],
  },
  {
    intent: 'FAILURE_ANALYSIS',
    phrases: [
      'failure reason',
      'failure reasons',
      'payment method',
      'payment methods',
      'failing the most',
      'underperforming',
      'what is going wrong',
      "what's going wrong",
      'why are payments failing',
    ],
  },
  {
    intent: 'RECOMMENDED_FOCUS',
    phrases: ['focus', 'prioritize', 'what should i do', 'what should we do', 'recommended focus'],
  },
  {
    intent: 'PORTFOLIO_SUMMARY',
    phrases: ['summary', 'overview', 'portfolio', 'how are we doing'],
  },
];

function normalize(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPaymentId(
  query: string,
  knownPaymentIds: readonly PaymentId[],
  fallbackPaymentId?: PaymentId,
): PaymentId | undefined {
  if (fallbackPaymentId) return fallbackPaymentId;

  const byLower = new Map(knownPaymentIds.map((id) => [String(id).toLowerCase(), id]));
  const candidates = query.match(PAYMENT_ID_CANDIDATE) ?? [];
  for (const candidate of candidates) {
    const found = byLower.get(candidate.toLowerCase());
    if (found) return found;
  }

  const lowered = query.toLowerCase();
  return knownPaymentIds.find((id) => lowered.includes(String(id).toLowerCase()));
}

export function resolveCopilotIntent(
  query: string,
  knownPaymentIds: readonly PaymentId[],
  fallbackPaymentId?: PaymentId,
): ResolvedCopilotIntent {
  const paymentId = extractPaymentId(query, knownPaymentIds, fallbackPaymentId);
  if (paymentId) return { intent: 'PAYMENT_LOOKUP', paymentId };

  const normalized = normalize(query);
  for (const group of INTENT_KEYWORDS) {
    if (group.phrases.some((phrase) => normalized.includes(normalize(phrase)))) {
      return { intent: group.intent };
    }
  }

  return { intent: 'UNKNOWN' };
}

export function appearsToRequestExecution(query: string): boolean {
  const normalized = normalize(query);
  const executionTerms = [
    'ignore policy',
    'bypass policy',
    'skip policy',
    'retry every payment',
    'run recovery',
    'execute recovery',
    'charge now',
    'refund now',
    'approve all',
  ];
  return executionTerms.some((term) => normalized.includes(term));
}
