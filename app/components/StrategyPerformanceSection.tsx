'use client';

import type { StrategyAnalyticsResult, RecoveryStrategyMetrics, CustomerSegmentPerformance } from '@/src/domain/strategyAnalytics/types';
import { formatPaise, formatPercent, formatDelayMinutes } from '@/src/lib/formatters';

const FAILURE_LABELS: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'Insufficient Balance',
  UPI_TIMEOUT:          'UPI Timeout',
  BANK_SERVER_ERROR:    'Bank Server Error',
  EXPIRED_CARD:         'Expired Card',
  AUTHENTICATION_FAILED:'Auth Failed',
  CUSTOMER_ABANDONED:   'Abandoned',
};

const SEGMENT_LABELS: Record<string, string> = {
  HIGH_RECOVERY_POTENTIAL:  'High Potential',
  MEDIUM_RECOVERY_POTENTIAL:'Medium Potential',
  LOW_RECOVERY_POTENTIAL:   'Low Potential',
  INSUFFICIENT_HISTORY:     'Insufficient History',
};

const SEGMENT_COLOR: Record<string, string> = {
  HIGH_RECOVERY_POTENTIAL:  '#059669',
  MEDIUM_RECOVERY_POTENTIAL:'#D97706',
  LOW_RECOVERY_POTENTIAL:   '#DC2626',
  INSUFFICIENT_HISTORY:     '#9CA3AF',
};

function labelFailure(reason: string): string {
  return FAILURE_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

function RecoveryRateBar({ rate }: { rate: number | null }) {
  if (rate === null) return <span style={{ fontSize: 12, color: '#CCCCCC' }}>—</span>;
  const pct = Math.round(rate * 100);
  const barColor = pct >= 60 ? '#059669' : pct >= 40 ? '#D97706' : '#DC2626';
  return (
    <div className="flex items-center gap-3">
      <div style={{ width: 64, height: 2, background: '#EBEBEB', borderRadius: 1, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 1 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 500, color: '#333' }}>{pct}%</span>
    </div>
  );
}

function StatusLabel({ status }: { status: string }) {
  if (status === 'LEADING') {
    return <span style={{ fontSize: 10, color: '#059669', fontWeight: 700, letterSpacing: '0.05em' }}>★ LEADING</span>;
  }
  if (status === 'OBSERVED') {
    return <span style={{ fontSize: 10, color: '#9CA3AF' }}>Observed</span>;
  }
  return <span style={{ fontSize: 10, color: '#CCCCCC' }}>Insufficient data</span>;
}

function StrategyTable({ metrics }: { metrics: readonly RecoveryStrategyMetrics[] }) {
  if (metrics.length === 0) {
    return <p style={{ fontSize: 13, color: '#9CA3AF', padding: '16px 0' }}>No strategy data available yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Strategy', 'Attempts', 'Completed', 'Recovery Rate', 'Revenue Recovered', 'Avg Time', 'Status'].map((col) => (
              <th
                key={col}
                style={{
                  padding: '8px 20px 8px 0',
                  textAlign: 'left',
                  fontSize: '9px',
                  fontWeight: 500,
                  color: '#AEAEAE',
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  borderBottom: '1px solid #E5E5E3',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr
              key={`${m.strategyKey.type}-${m.label}`}
              className="trow-hover"
              style={{ borderBottom: '1px solid #F2F2F0' }}
            >
              <td style={{ padding: '12px 20px 12px 0', fontSize: 13, fontWeight: 500, color: '#111', whiteSpace: 'nowrap' }}>
                {m.label}
              </td>
              <td style={{ padding: '12px 20px 12px 0', fontSize: 12, color: '#6B7280', textAlign: 'right' }}>
                {m.totalAttempts}
              </td>
              <td style={{ padding: '12px 20px 12px 0', fontSize: 12, color: '#6B7280', textAlign: 'right' }}>
                {m.completedAttempts}
              </td>
              <td style={{ padding: '12px 20px 12px 0' }}>
                <RecoveryRateBar rate={m.recoveryRate} />
              </td>
              <td style={{ padding: '12px 20px 12px 0', fontSize: 12, color: '#444', textAlign: 'right' }}>
                {m.recoveredRevenueInPaise > 0 ? formatPaise(m.recoveredRevenueInPaise) : '—'}
              </td>
              <td style={{ padding: '12px 20px 12px 0', fontSize: 12, color: '#6B7280', textAlign: 'right' }}>
                {m.averageRecoveryTimeMinutes !== null ? formatDelayMinutes(m.averageRecoveryTimeMinutes) : '—'}
              </td>
              <td style={{ padding: '12px 0 12px 0' }}>
                <StatusLabel status={m.performanceStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailureReasonBreakdown({ analytics }: { analytics: StrategyAnalyticsResult }) {
  const entries = analytics.failureReasonPerformance.filter((f) => f.totalAttempts > 0);
  if (entries.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 24, paddingBottom: 24 }}>
      <p
        className="uppercase text-neutral-400 font-medium mb-5"
        style={{ fontSize: '9px', letterSpacing: '0.28em' }}
      >
        By Failure Reason
      </p>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {entries.map((f) => (
          <div key={f.failureReason} style={{ paddingLeft: 12, borderLeft: '2px solid #E5E5E3' }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: '#333', marginBottom: 6 }}>
              {labelFailure(f.failureReason)}
            </p>
            <RecoveryRateBar rate={f.recoveryRate} />
            <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
              {f.completedAttempts} completed
              {f.bestStrategy && (
                <> · Best: <span style={{ color: '#555' }}>{f.bestStrategy.label}</span></>
              )}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PaymentMethodBreakdown({ analytics }: { analytics: StrategyAnalyticsResult }) {
  const entries = analytics.paymentMethodPerformance.filter((p) => p.totalAttempts > 0);
  if (entries.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 24, paddingBottom: 24 }}>
      <p
        className="uppercase text-neutral-400 font-medium mb-5"
        style={{ fontSize: '9px', letterSpacing: '0.28em' }}
      >
        By Payment Method
      </p>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {entries.map((p) => (
          <div key={p.paymentMethod} style={{ paddingLeft: 12, borderLeft: '2px solid #E5E5E3' }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 6 }}>{p.paymentMethod}</p>
            <RecoveryRateBar rate={p.recoveryRate} />
            <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
              {formatPaise(p.recoveredRevenueInPaise)} recovered
              {p.averageRecoveryTimeMinutes !== null && (
                <> · {formatDelayMinutes(p.averageRecoveryTimeMinutes)} avg</>
              )}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomerSegmentBreakdown({ segments }: { segments: readonly CustomerSegmentPerformance[] }) {
  const active = segments.filter((s) => s.totalAttempts > 0);
  if (active.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 24, paddingBottom: 24 }}>
      <p
        className="uppercase text-neutral-400 font-medium mb-1"
        style={{ fontSize: '9px', letterSpacing: '0.28em' }}
      >
        By Customer Segment
      </p>
      <p style={{ fontSize: 11, color: '#CCCCCC', marginBottom: 20 }}>
        Observed outcomes. Does not imply causal validation.
      </p>
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {active.map((s) => (
          <div key={s.segment} style={{ paddingLeft: 12, borderLeft: `2px solid ${SEGMENT_COLOR[s.segment] ?? '#E5E5E3'}` }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: SEGMENT_COLOR[s.segment] ?? '#333', marginBottom: 6 }}>
              {SEGMENT_LABELS[s.segment] ?? s.segment}
            </p>
            <RecoveryRateBar rate={s.recoveryRate} />
            <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
              {s.completedAttempts} completed
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExperimentPerformanceSection({ analytics }: { analytics: StrategyAnalyticsResult }) {
  if (analytics.experimentPerformance.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 24 }}>
      <p
        className="uppercase text-neutral-400 font-medium mb-1"
        style={{ fontSize: '9px', letterSpacing: '0.28em' }}
      >
        Experiment-Derived Performance
      </p>
      <p style={{ fontSize: 11, color: '#CCCCCC', marginBottom: 20 }}>
        Source: A/B experiment outcomes.
      </p>
      <div className="space-y-4">
        {analytics.experimentPerformance.map((exp) => (
          <div key={exp.experimentId} style={{ border: '1px solid #EBEBEB', padding: 16, borderRadius: 4 }}>
            <div className="flex items-center justify-between mb-4">
              <p style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>{exp.experimentName}</p>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: '#2563EB', background: '#EFF6FF', border: '1px solid #DBEAFE',
                padding: '2px 8px', borderRadius: 2,
              }}>
                {exp.dimension}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: exp.variantAId, name: exp.variantAName, rate: exp.variantARecoveryRate, count: exp.variantACompletedCount },
                { id: exp.variantBId, name: exp.variantBName, rate: exp.variantBRecoveryRate, count: exp.variantBCompletedCount },
              ].map((v) => {
                const isLeading = exp.leadingVariantId === v.id;
                return (
                  <div
                    key={v.id}
                    style={{
                      padding: 12,
                      background: isLeading ? '#F0FDF4' : '#FAFAFA',
                      border: `1px solid ${isLeading ? '#BBF7D0' : '#EBEBEB'}`,
                      borderRadius: 3,
                    }}
                  >
                    <p style={{ fontSize: 11, fontWeight: 500, color: '#555', marginBottom: 4 }}>{v.name}</p>
                    <p style={{ fontSize: 18, fontWeight: 300, color: '#111' }}>{formatPercent(v.rate)}</p>
                    <p style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>{v.count} completed</p>
                    {isLeading && <p style={{ fontSize: 10, color: '#059669', fontWeight: 700, marginTop: 2 }}>★ Leading</p>}
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: 10, color: '#CCCCCC', marginTop: 8 }}>
              {exp.comparisonStatus.replace(/_/g, ' ')}
            </p>
          </div>
        ))}
      </div>

      {analytics.messageToneAnalytics && (
        <div style={{ marginTop: 16, border: '1px solid #DBEAFE', padding: 16, borderRadius: 4, background: '#EFF6FF' }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#1D4ED8', marginBottom: 4 }}>
            Message Tone (Experiment-Derived)
          </p>
          <p style={{ fontSize: 11, color: '#3B82F6', marginBottom: 12 }}>{analytics.messageToneAnalytics.note}</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: analytics.messageToneAnalytics.neutralName, rate: analytics.messageToneAnalytics.neutralRecoveryRate, count: analytics.messageToneAnalytics.neutralCompletedCount, isLeading: analytics.messageToneAnalytics.leadingTone === 'NEUTRAL' },
              { name: analytics.messageToneAnalytics.friendlyName, rate: analytics.messageToneAnalytics.friendlyRecoveryRate, count: analytics.messageToneAnalytics.friendlyCompletedCount, isLeading: analytics.messageToneAnalytics.leadingTone === 'FRIENDLY' },
            ].map((v) => (
              <div key={v.name} style={{ padding: 10, background: 'white', border: `1px solid ${v.isLeading ? '#BBF7D0' : '#E5E5E3'}`, borderRadius: 3 }}>
                <p style={{ fontSize: 11, fontWeight: 500, color: '#555' }}>{v.name}</p>
                <p style={{ fontSize: 16, fontWeight: 300, color: '#111' }}>{formatPercent(v.rate)}</p>
                <p style={{ fontSize: 10, color: '#9CA3AF' }}>{v.count} completed</p>
                {v.isLeading && <p style={{ fontSize: 10, color: '#059669', fontWeight: 700 }}>★ Leading</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface StrategyPerformanceSectionProps {
  analytics: StrategyAnalyticsResult;
}

export function StrategyPerformanceSection({ analytics }: StrategyPerformanceSectionProps) {
  const { portfolioSummary, strategyMetrics } = analytics;
  const hasAnyData = strategyMetrics.length > 0;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      {/* Header */}
      <div className="py-5">
        <p
          className="uppercase text-neutral-400 font-medium"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Strategy Performance
        </p>
        <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
          Observed execution outcomes only.
        </p>
      </div>

      {/* Best strategy highlight */}
      {hasAnyData && portfolioSummary.bestRecoveryRateStrategy && (
        <div
          className="flex items-baseline gap-6 py-6"
          style={{ borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3' }}
        >
          <div>
            <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 4 }}>
              Best Observed Strategy
            </p>
            <p style={{ fontSize: 22, fontWeight: 300, color: '#111' }}>
              {portfolioSummary.bestRecoveryRateStrategy.label}
            </p>
            {portfolioSummary.bestRecoveryRateStrategy.recoveryRate !== null && (
              <p style={{ fontSize: 13, color: '#059669', fontWeight: 500, marginTop: 2 }}>
                {formatPercent(portfolioSummary.bestRecoveryRateStrategy.recoveryRate)} recovery
              </p>
            )}
            {portfolioSummary.bestRecoveryRateStrategy.completedAttempts < 5 && (
              <p style={{ fontSize: 10, color: '#D97706', marginTop: 4, fontWeight: 500 }}>
                LIMITED SAMPLE — {portfolioSummary.bestRecoveryRateStrategy.completedAttempts} attempts
              </p>
            )}
          </div>
          {portfolioSummary.portfolioRecoveryRate !== null && (
            <div style={{ borderLeft: '1px solid #E5E5E3', paddingLeft: 24 }}>
              <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 4 }}>
                Portfolio Rate
              </p>
              <p style={{ fontSize: 22, fontWeight: 300, color: '#111' }}>
                {formatPercent(portfolioSummary.portfolioRecoveryRate)}
              </p>
              <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                {portfolioSummary.totalCompletedAttempts} completed
              </p>
            </div>
          )}
        </div>
      )}

      {/* All strategies */}
      <div className="py-6">
        <p
          className="uppercase text-neutral-400 font-medium mb-4"
          style={{ fontSize: '9px', letterSpacing: '0.28em' }}
        >
          All Strategies
        </p>
        {hasAnyData ? (
          <StrategyTable metrics={strategyMetrics} />
        ) : (
          <p style={{ fontSize: 13, color: '#9CA3AF' }}>
            Not enough completed recovery attempts to compare strategies.
          </p>
        )}
      </div>

      <FailureReasonBreakdown analytics={analytics} />
      <PaymentMethodBreakdown analytics={analytics} />
      <CustomerSegmentBreakdown segments={analytics.customerSegmentPerformance} />
      <ExperimentPerformanceSection analytics={analytics} />
    </div>
  );
}
