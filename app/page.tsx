import Link from 'next/link';
import { runDashboard } from '@/src/lib/dashboardData';
import { formatCompactPaise, formatDelayMinutes, formatPaise, formatPercent } from '@/src/lib/formatters';
import type { ExecutionStatus } from '@/src/domain/executor/types';
import type { RecoveryCase } from '@/src/services/recovery/types';
import type { RecoveryPriority } from '@/src/domain/recovery/recoveryScore';
import { buildRecoveryQueue } from '@/src/services/queue/recoveryQueue';
import { CasesTable, PRIORITY_BADGE } from './components/CasesTable';
import type { CaseRow } from './components/CasesTable';
import { RecoveryQueueSection, RISK_BADGE } from './components/RecoveryQueueSection';
import type { QueueRow, QueueSummaryProps } from './components/RecoveryQueueSection';
import type { QueueItem } from '@/src/services/queue/types';
import { RecoveryForecastSection } from './components/RecoveryForecastSection';
import { InsightsFeedSection } from './components/InsightsFeedSection';
import AnomalyAlertSection from './components/AnomalyAlertSection';
import { ExperimentsSection } from './components/ExperimentsSection';
import { CopilotPanel } from './components/CopilotPanel';
import { CustomerRecoverySection } from './components/CustomerRecoverySection';
import { StrategyPerformanceSection } from './components/StrategyPerformanceSection';
import { WhatIfSimulatorSection } from './components/WhatIfSimulatorSection';
import { RecoveryHealthSection } from './components/RecoveryHealthSection';

// ── Status display config ────────────────────────────────────────────────────

interface StatusConfig {
  label: string;
  dotClass: string;
  textClass: string;
  bgClass: string;
}

const STATUS_CONFIG: Record<ExecutionStatus, StatusConfig> = {
  RECOVERED: {
    label: 'Recovered',
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-700',
    bgClass: 'bg-emerald-50',
  },
  PENDING: {
    label: 'Pending',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-600',
    bgClass: 'bg-amber-50',
  },
  ESCALATED: {
    label: 'Escalated',
    dotClass: 'bg-orange-400',
    textClass: 'text-orange-600',
    bgClass: 'bg-orange-50',
  },
  FAILED: {
    label: 'Failed',
    dotClass: 'bg-red-400',
    textClass: 'text-red-600',
    bgClass: 'bg-red-50',
  },
  BLOCKED: {
    label: 'Blocked',
    dotClass: 'bg-neutral-400',
    textClass: 'text-neutral-500',
    bgClass: 'bg-neutral-100',
  },
};

// ── Label maps ───────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  RETRY_LATER: 'Retry later',
  SEND_PAYMENT_LINK: 'Payment link',
  UPDATE_PAYMENT_METHOD: 'Update method',
  ESCALATE: 'Escalate',
};

const FAILURE_LABELS: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'Insufficient balance',
  UPI_TIMEOUT: 'UPI timeout',
  BANK_SERVER_ERROR: 'Bank server error',
  EXPIRED_CARD: 'Expired card',
  AUTHENTICATION_FAILED: 'Authentication failed',
  CUSTOMER_ABANDONED: 'Checkout abandoned',
};

function labelAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function labelFailure(reason: string): string {
  return FAILURE_LABELS[reason] ?? reason;
}

// ── Confidence tier ──────────────────────────────────────────────────────────

function confidenceTier(confidence: number): {
  tier: string;
  tierClass: string;
  pct: string;
} {
  const pct = `${Math.round(confidence * 100)}%`;
  if (confidence >= 0.8) return { tier: 'High', tierClass: 'text-emerald-600', pct };
  if (confidence >= 0.6) return { tier: 'Medium', tierClass: 'text-amber-600', pct };
  return { tier: 'Low', tierClass: 'text-red-500', pct };
}

// ── Priority badge class lookup ───────────────────────────────────────────────

function priorityBadgeClass(priority: RecoveryPriority): string {
  return PRIORITY_BADGE[priority] ?? PRIORITY_BADGE['LOW'];
}

// ── Map queue item → serialisable queue row ──────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  UPI: 'UPI',
  CARD: 'Card',
  NETBANKING: 'Netbanking',
  WALLET: 'Wallet',
};

function labelMethod(method: string): string {
  return METHOD_LABELS[method] ?? method;
}

function toQueueRow(item: QueueItem): QueueRow {
  const sw = item.paymentMethodSwitch;
  const methodSwitchLabel =
    sw.shouldSwitch && sw.recommendedMethod
      ? `${labelMethod(sw.currentMethod)} → ${labelMethod(sw.recommendedMethod)}`
      : null;

  return {
    paymentId: item.paymentId,
    queueRank: item.queueRank,
    customerName: item.customerName,
    amountFormatted: formatCompactPaise(item.amountInPaise),
    amountExactFormatted: formatPaise(item.amountInPaise),
    failureLabel: labelFailure(item.failureReason),
    paymentMethod: item.paymentMethod,
    recoveryProbabilityFormatted: `${Math.round(item.recoveryScore.recoveryProbability * 100)}%`,
    expectedRecoveryFormatted: formatCompactPaise(item.recoveryScore.expectedRecoverableAmountInPaise),
    expectedRecoveryExactFormatted: formatPaise(item.recoveryScore.expectedRecoverableAmountInPaise),
    priorityLabel: item.recoveryScore.priority,
    priorityBadgeClass: priorityBadgeClass(item.recoveryScore.priority),
    actionLabel: labelAction(item.recommendedAction),
    bestRetryDelayLabel: item.smartRetryTiming
      ? formatDelayMinutes(item.smartRetryTiming.delayMinutes)
      : null,
    timingConfidence: item.smartRetryTiming?.confidence ?? null,
    timingReason: item.smartRetryTiming?.reason ?? null,
    methodSwitchLabel,
    riskLevel: item.revenueAtRiskScore.level,
    riskScore: item.revenueAtRiskScore.score,
    riskLevelBadgeClass: RISK_BADGE[item.revenueAtRiskScore.level] ?? RISK_BADGE['LOW'],
    revenueAtRiskFormatted: formatCompactPaise(item.revenueAtRiskScore.revenueAtRiskInPaise),
    revenueAtRiskExactFormatted: formatPaise(item.revenueAtRiskScore.revenueAtRiskInPaise),
  };
}

// ── Map domain case → serialisable table row ─────────────────────────────────

function toCaseRow(c: RecoveryCase): CaseRow {
  const status = STATUS_CONFIG[c.executionResult.status];
  const conf = confidenceTier(c.recommendation.confidence);
  const { recoveryScore } = c;
  return {
    paymentId: c.payment.paymentId,
    customerName: c.payment.customerName,
    amountFormatted: formatPaise(c.payment.amount),
    failureLabel: labelFailure(c.payment.failureReason),
    actionLabel: labelAction(c.recommendation.recommendedAction),
    confidenceTier: conf.tier,
    confidenceTierClass: conf.tierClass,
    confidencePct: conf.pct,
    statusLabel: status.label,
    statusDotClass: status.dotClass,
    statusTextClass: status.textClass,
    statusBgClass: status.bgClass,
    recoveryProbabilityFormatted: `${Math.round(recoveryScore.recoveryProbability * 100)}%`,
    expectedRecoveryFormatted: formatCompactPaise(recoveryScore.expectedRecoverableAmountInPaise),
    expectedRecoveryExactFormatted: formatPaise(recoveryScore.expectedRecoverableAmountInPaise),
    priorityLabel: recoveryScore.priority,
    priorityBadgeClass: priorityBadgeClass(recoveryScore.priority),
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { batch: result, insights, insightSummary, anomalies, experimentResults, customerRecovery, strategyAnalytics, presetSimulations, recoveryHealth } = runDashboard();
  const {
    cases,
    totalPayments,
    totalRevenueAtRisk,
    totalRecoveredRevenue,
    recoveryRate,
    recoveredPaymentCount,
    failedRecoveryCount,
    pendingPaymentCount,
    escalatedPaymentCount,
    blockedPaymentCount,
    totalExpectedRecoverableRevenue,
    totalRevenueUnrecoverableInPaise,
    riskCriticalCount,
    riskHighCount,
    riskMediumCount,
    riskLowCount,
    forecast,
  } = result;

  const escalatedCases = cases
    .filter((c) => c.executionResult.status === 'ESCALATED')
    .slice(0, 5);

  const tableRows: CaseRow[] = cases.map(toCaseRow);
  const recoveryPct = Math.min(recoveryRate * 100, 100);

  const queue = buildRecoveryQueue(cases);
  const queueRows: QueueRow[] = queue.items.map(toQueueRow);
  const queueSummary: QueueSummaryProps = {
    totalPayments: queue.summary.totalPayments,
    totalRevenueAtRiskFormatted: formatCompactPaise(queue.summary.totalRevenueAtRiskInPaise),
    totalExpectedRecoveryFormatted: formatCompactPaise(queue.summary.totalExpectedRecoveryInPaise),
    highPriorityCount: queue.summary.highPriorityCount,
    mediumPriorityCount: queue.summary.mediumPriorityCount,
    lowPriorityCount: queue.summary.lowPriorityCount,
  };

  return (
    <main className="max-w-[1400px] mx-auto px-6 py-10 space-y-8">

      {/* ── Recovery Health Score (executive summary) ──────────────────────── */}
      <section aria-label="Recovery Health Score" id="recovery-health">
        <RecoveryHealthSection executiveSummary={recoveryHealth} />
      </section>

      {/* ── KPI hierarchy ─────────────────────────────────────────────────── */}
      <section aria-label="Key metrics">
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}
        >
          {/* Hero: Revenue Recovered */}
          <div className="bg-white border border-neutral-200 rounded-xl p-8 dashboard-card-hover">
            <p className="text-sm font-medium text-neutral-500">Revenue Recovered</p>
            <p className="mt-3 text-5xl font-semibold tracking-tight text-emerald-700 leading-none tabular-nums dashboard-value-enter">
              {formatCompactPaise(totalRecoveredRevenue)}
            </p>
            <p className="mt-4 text-sm text-neutral-400">
              {recoveredPaymentCount} payment{recoveredPaymentCount !== 1 ? 's' : ''}{' '}
              successfully recovered
            </p>
          </div>

          {/* Recovery Rate */}
          <div className="bg-white border border-neutral-200 rounded-xl p-6 flex flex-col dashboard-card-hover">
            <p className="text-sm text-neutral-500">Recovery Rate</p>
            <p className="mt-auto pt-4 text-3xl font-semibold text-neutral-900 leading-none tabular-nums dashboard-value-enter">
              {formatPercent(recoveryRate)}
            </p>
          </div>

          {/* Failed Revenue */}
          <div className="bg-white border border-neutral-200 rounded-xl p-6 flex flex-col dashboard-card-hover">
            <p className="text-sm text-neutral-500">Failed Revenue</p>
            <p className="mt-auto pt-4 text-3xl font-semibold text-neutral-900 leading-none tabular-nums dashboard-value-enter">
              {formatCompactPaise(totalRevenueAtRisk)}
            </p>
          </div>

          {/* Payments Analyzed */}
          <div className="bg-white border border-neutral-200 rounded-xl p-6 flex flex-col dashboard-card-hover">
            <p className="text-sm text-neutral-500">Payments Analyzed</p>
            <p className="mt-auto pt-4 text-3xl font-semibold text-neutral-900 leading-none tabular-nums dashboard-value-enter">
              {totalPayments}
            </p>
          </div>
        </div>

        {/* Secondary KPI row: Revenue At Risk + Expected Recovery */}
        <div className="mt-4 grid gap-4" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div className="bg-white border border-neutral-200 rounded-xl p-6 dashboard-card-hover">
            <p className="text-sm font-medium text-neutral-500">Revenue at Risk</p>
            <p className="mt-2 text-3xl font-semibold text-red-700 leading-none tabular-nums dashboard-value-enter">
              {formatCompactPaise(totalRevenueUnrecoverableInPaise)}
            </p>
            <p className="mt-2 text-xs text-neutral-400">
              Estimated unrecovered value across active failed payments
            </p>
          </div>
          <div className="bg-white border border-neutral-200 rounded-xl p-6 dashboard-card-hover">
            <p className="text-sm font-medium text-neutral-500">Expected Recovery</p>
            <p className="mt-2 text-3xl font-semibold text-neutral-900 leading-none tabular-nums dashboard-value-enter">
              {formatCompactPaise(totalExpectedRecoverableRevenue)}
            </p>
            <p className="mt-2 text-xs text-neutral-400">
              Based on recovery probability across all analyzed payments
            </p>
          </div>
          {/* Risk Distribution */}
          <div className="bg-white border border-neutral-200 rounded-xl p-6 dashboard-card-hover">
            <p className="text-sm font-medium text-neutral-500 mb-3">Risk Distribution</p>
            <div className="space-y-1.5">
              <RiskDistRow level="CRITICAL" count={riskCriticalCount} colorClass="text-red-700" />
              <RiskDistRow level="HIGH"     count={riskHighCount}     colorClass="text-orange-600" />
              <RiskDistRow level="MEDIUM"   count={riskMediumCount}   colorClass="text-amber-600" />
              <RiskDistRow level="LOW"      count={riskLowCount}      colorClass="text-neutral-400" />
            </div>
          </div>
        </div>
      </section>

      {/* ── Anomaly Alerts ────────────────────────────────────────────────── */}
      <section aria-label="Anomaly alerts" id="anomalies">
        <AnomalyAlertSection anomalies={anomalies} />
      </section>

      {/* ── AI Revenue Recovery Copilot ───────────────────────────────────── */}
      <section aria-label="AI Revenue Recovery Copilot" id="copilot">
        <CopilotPanel />
      </section>

      {/* ── Recovery Performance + Agent ──────────────────────────────────── */}
      <section
        aria-label="Performance overview"
        className="grid gap-4"
        style={{ gridTemplateColumns: '3fr 2fr' }}
      >
        {/* Recovery Performance */}
        <div className="bg-white border border-neutral-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-neutral-900">Recovery Performance</h2>

          <div className="mt-6 space-y-5">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-neutral-500">Revenue at risk</span>
                <span className="text-sm font-medium text-neutral-700 tabular-nums">
                  {formatPaise(totalRevenueAtRisk)}
                </span>
              </div>
              <div className="h-1.5 bg-neutral-100 rounded-full">
                <div className="h-1.5 bg-neutral-300 rounded-full w-full" />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-neutral-500">Revenue recovered</span>
                <span className="text-sm font-medium text-emerald-700 tabular-nums">
                  {formatPaise(totalRecoveredRevenue)}
                </span>
              </div>
              <div
                className="h-1.5 bg-neutral-100 rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={recoveryPct}
                aria-valuemax={100}
                aria-label="Revenue recovered progress"
              >
                <div
                  className="h-1.5 bg-emerald-500 rounded-full"
                  style={{ width: `${recoveryPct}%` }}
                />
              </div>
            </div>
          </div>

          <div className="mt-8 pt-5 border-t border-neutral-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-neutral-500">Recovery progress</span>
              <span className="text-sm font-semibold text-neutral-900">
                {formatPercent(recoveryRate)}
              </span>
            </div>
            <div
              className="h-2 bg-neutral-100 rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={recoveryPct}
              aria-valuemax={100}
              aria-label="Overall recovery progress"
            >
              <div
                className="h-2 bg-emerald-500 rounded-full"
                style={{ width: `${recoveryPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Recovery Agent */}
        <div className="bg-white border border-neutral-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-neutral-900">Recovery Agent</h2>
          <p className="mt-1 text-sm text-neutral-500">Autonomous recovery system</p>

          <div className="mt-6 space-y-3">
            <AgentStat label="Analyzed" count={totalPayments} />
            <div className="h-px bg-neutral-100" />
            <AgentStat
              label="Recovered"
              count={recoveredPaymentCount}
              valueClass="text-emerald-700"
            />
            <AgentStat
              label="Pending"
              count={pendingPaymentCount}
              valueClass="text-amber-600"
            />
            <AgentStat
              label="Escalated"
              count={escalatedPaymentCount}
              valueClass="text-orange-600"
            />
            <AgentStat
              label="Failed"
              count={failedRecoveryCount}
              valueClass="text-red-600"
            />
            {blockedPaymentCount > 0 && (
              <AgentStat
                label="Blocked"
                count={blockedPaymentCount}
                valueClass="text-neutral-500"
              />
            )}
          </div>
        </div>
      </section>

      {/* ── Needs Attention ────────────────────────────────────────────────── */}
      {escalatedCases.length > 0 && (
        <section aria-label="Needs attention">
          <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-100 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-neutral-900">Needs Attention</h2>
                <p className="mt-0.5 text-sm text-neutral-500">
                  {escalatedPaymentCount} escalated case
                  {escalatedPaymentCount !== 1 ? 's' : ''} require review
                </p>
              </div>
              <span className="text-xs font-medium text-orange-600 bg-orange-50 border border-orange-100 px-2.5 py-1 rounded-full">
                {escalatedPaymentCount} escalated
              </span>
            </div>

            <div>
              {escalatedCases.map((c) => (
                <Link
                  key={c.payment.paymentId}
                  href={`/payments/${c.payment.paymentId}`}
                  className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition-colors duration-100 group"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-900 group-hover:text-neutral-700">
                      {c.payment.customerName}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {labelFailure(c.payment.failureReason)}
                    </p>
                  </div>

                  <div className="flex items-center gap-8 shrink-0 ml-8">
                    <div className="text-right">
                      <p className="text-sm font-semibold text-neutral-900 tabular-nums">
                        {formatCompactPaise(c.payment.amount)}
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-400">
                        {c.policyDecision.reason}
                      </p>
                    </div>
                    <span className="text-neutral-300 text-sm">→</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Recovery Forecast ─────────────────────────────────────────────── */}
      <section aria-label="Recovery forecast" id="forecast">
        <RecoveryForecastSection
          forecast={forecast}
          totalFailedRevenueFormatted={formatCompactPaise(forecast.totalFailedRevenueInPaise)}
          expectedRecoveredFormatted={formatCompactPaise(forecast.expectedRecoveredRevenueInPaise)}
          expectedUnrecoveredFormatted={formatCompactPaise(forecast.expectedUnrecoveredRevenueInPaise)}
          expectedRecoveryRateFormatted={formatPercent(forecast.expectedRecoveryRate)}
          highConfidenceFormatted={formatCompactPaise(forecast.highConfidenceRecoveryInPaise)}
          mediumConfidenceFormatted={formatCompactPaise(forecast.mediumConfidenceRecoveryInPaise)}
          lowConfidenceFormatted={formatCompactPaise(forecast.lowConfidenceRecoveryInPaise)}
          next24HFormatted={formatCompactPaise(forecast.byHorizon.next24HoursInPaise)}
          next3DaysFormatted={formatCompactPaise(forecast.byHorizon.next3DaysInPaise)}
          beyond3DaysFormatted={formatCompactPaise(forecast.byHorizon.beyond3DaysInPaise)}
        />
      </section>

      {/* ── AI Revenue Insights ───────────────────────────────────────────── */}
      <section aria-label="AI Revenue Insights" id="insights">
        <InsightsFeedSection
          insights={insights}
          summary={insightSummary}
          queueHref="#queue"
        />
      </section>

      {/* ── Recovery Strategy Experiments ─────────────────────────────────── */}
      <section aria-label="Recovery experiments" id="experiments">
        <ExperimentsSection results={experimentResults} />
      </section>

      {/* ── Customer Recovery Intelligence ────────────────────────────────── */}
      <section aria-label="Customer Recovery Intelligence" id="customers">
        <CustomerRecoverySection customers={customerRecovery.customers} />
      </section>

      {/* ── Strategy Performance Analytics ────────────────────────────────── */}
      <section aria-label="Strategy Performance Analytics" id="strategy-performance">
        <StrategyPerformanceSection analytics={strategyAnalytics} />
      </section>

      {/* ── What-If Recovery Simulator ────────────────────────────────────── */}
      <section aria-label="What-If Recovery Simulator" id="simulator">
        <WhatIfSimulatorSection presetSimulations={presetSimulations} />
      </section>

      {/* ── Recovery Queue ─────────────────────────────────────────────────── */}
      <section aria-label="Recovery queue" id="queue">
        <RecoveryQueueSection rows={queueRows} summary={queueSummary} />
      </section>

      {/* ── Recovery Cases table ───────────────────────────────────────────── */}
      <section aria-label="Recovery cases" id="cases">
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-neutral-100">
            <h2 className="text-base font-semibold text-neutral-900">Recovery Cases</h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              {totalPayments} payments analyzed · click a row to view details
            </p>
          </div>
          <div className="overflow-x-auto">
            <CasesTable rows={tableRows} />
          </div>
        </div>
      </section>
    </main>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function AgentStat({
  label,
  count,
  valueClass = 'text-neutral-900',
}: {
  label: string;
  count: number;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-neutral-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${valueClass}`}>{count}</span>
    </div>
  );
}

function RiskDistRow({
  level,
  count,
  colorClass,
}: {
  level: string;
  count: number;
  colorClass: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-xs font-medium ${colorClass}`}>{level}</span>
      <span className={`text-sm font-semibold tabular-nums ${colorClass}`}>{count}</span>
    </div>
  );
}
