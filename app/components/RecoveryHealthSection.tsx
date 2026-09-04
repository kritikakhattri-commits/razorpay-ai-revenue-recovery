'use client';

import type { RecoveryExecutiveSummary } from '@/src/domain/recoveryHealth/types';
import type { RecoveryHealthComponent, RecoveryHealthStatus } from '@/src/domain/recoveryHealth/types';
import { formatCompactPaise, formatPaise, formatPercent } from '@/src/lib/formatters';

// ── Status palette ────────────────────────────────────────────────────────────

interface StatusStyle {
  bg: string;
  border: string;
  text: string;
  badge: string;
  bar: string;
  accent: string;
}

const STATUS_STYLES: Record<RecoveryHealthStatus, StatusStyle> = {
  EXCELLENT: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    text: 'text-emerald-700',
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    bar: 'bg-emerald-500',
    accent: '#059669',
  },
  HEALTHY: {
    bg: 'bg-teal-50',
    border: 'border-teal-200',
    text: 'text-teal-700',
    badge: 'bg-teal-100 text-teal-800 border-teal-200',
    bar: 'bg-teal-500',
    accent: '#0D9488',
  },
  WATCH: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    text: 'text-amber-700',
    badge: 'bg-amber-100 text-amber-800 border-amber-200',
    bar: 'bg-amber-400',
    accent: '#D97706',
  },
  AT_RISK: {
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    text: 'text-orange-700',
    badge: 'bg-orange-100 text-orange-800 border-orange-200',
    bar: 'bg-orange-500',
    accent: '#EA580C',
  },
  CRITICAL: {
    bg: 'bg-red-50',
    border: 'border-red-200',
    text: 'text-red-700',
    badge: 'bg-red-100 text-red-800 border-red-200',
    bar: 'bg-red-500',
    accent: '#DC2626',
  },
};

// ── Metallic recovery loop visual ─────────────────────────────────────────────

function RecoveryLoopVisual({ size = 200 }: { size?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.06))',
      }}
    >
      <svg viewBox="0 0 200 200" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="rh-mg1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor="#D4D4D0" />
            <stop offset="25%"  stopColor="#ABABAB" />
            <stop offset="50%"  stopColor="#ECECEA" />
            <stop offset="75%"  stopColor="#B8B8B6" />
            <stop offset="100%" stopColor="#D0D0CD" />
          </linearGradient>
          <linearGradient id="rh-mg2" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#C0C0BC" />
            <stop offset="40%"  stopColor="#F0F0EC" />
            <stop offset="70%"  stopColor="#ACACAA" />
            <stop offset="100%" stopColor="#D8D8D4" />
          </linearGradient>
          <linearGradient id="rh-mg3" x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%"   stopColor="#E0E0DC" />
            <stop offset="50%"  stopColor="#9C9C9A" />
            <stop offset="100%" stopColor="#E0E0DC" />
          </linearGradient>
        </defs>
        <ellipse cx="100" cy="100" rx="84" ry="42"
          fill="none" stroke="url(#rh-mg1)" strokeWidth="17"
          className="rl-spin1"
        />
        <ellipse cx="100" cy="100" rx="46" ry="82"
          fill="none" stroke="url(#rh-mg2)" strokeWidth="14"
          className="rl-spin2"
          style={{ transform: 'rotate(22deg)' }}
        />
        <circle cx="100" cy="100" r="6" fill="url(#rh-mg3)" className="rl-pulse" />
      </svg>
    </div>
  );
}

// ── Component bar row ─────────────────────────────────────────────────────────

function ComponentRow({
  component,
  isStrongest,
  isWeakest,
}: {
  component: RecoveryHealthComponent;
  isStrongest: boolean;
  isWeakest: boolean;
}) {
  const barColor =
    component.score >= 75 ? 'bg-emerald-500'
    : component.score >= 55 ? 'bg-amber-400'
    : component.score >= 35 ? 'bg-orange-500'
    : 'bg-red-500';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-600">{component.label}</span>
          {isStrongest && (
            <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
              Strongest
            </span>
          )}
          {isWeakest && (
            <span className="text-[10px] font-medium text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full">
              Weakest
            </span>
          )}
        </div>
        <span className="text-xs font-semibold tabular-nums text-neutral-800">{component.score}</span>
      </div>
      <div className="h-px bg-neutral-100 rounded-full overflow-hidden">
        <div
          className={`h-px rounded-full ${barColor} dashboard-progress-fill`}
          style={{ width: `${component.score}%` }}
        />
      </div>
      <p className="text-xs text-neutral-400 leading-snug">{component.reason}</p>
    </div>
  );
}

// ── KPI cell ──────────────────────────────────────────────────────────────────

function KpiCell({
  label,
  value,
  exactValue,
  valueClass = 'text-neutral-900',
  sub,
}: {
  label: string;
  value: string;
  exactValue?: string;
  valueClass?: string;
  sub?: string;
}) {
  return (
    <div style={{ borderTop: '1px solid #EBEBEB', paddingTop: '16px' }}>
      <p className="text-[10px] text-neutral-400 uppercase tracking-widest mb-1">{label}</p>
      <p
        className={`text-xl font-semibold tabular-nums ${valueClass}`}
        title={exactValue ? `Exact: ${exactValue}` : undefined}
      >
        {value}
      </p>
      {sub && <p className="text-[11px] text-neutral-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface RecoveryHealthSectionProps {
  executiveSummary: RecoveryExecutiveSummary;
  variant?: 'summary' | 'detailed';
}

export function RecoveryHealthSection({
  executiveSummary,
  variant = 'detailed',
}: RecoveryHealthSectionProps) {
  const { health } = executiveSummary;
  const style = STATUS_STYLES[health.status];
  const isSummary = variant === 'summary';
  const statusLabel = health.status.replace('_', ' ');

  return (
    <div className="dashboard-section-appear">
      {/* Hero zone */}
      <div
        className="flex items-start justify-between gap-8"
        style={{ minHeight: isSummary ? 'auto' : '55vh', alignItems: 'center' }}
      >
        {/* Left: score + copy */}
        <div className="flex-1 max-w-[540px] py-12">
          {/* Eyebrow */}
          <p
            className="text-neutral-400 uppercase font-medium mb-6"
            style={{ fontSize: '10px', letterSpacing: '0.35em' }}
          >
            AI Revenue Intelligence
          </p>

          {/* Score display */}
          <div className="flex items-baseline gap-4 mb-2">
            <span
              className={`font-thin tabular-nums leading-none ${style.text}`}
              style={{ fontSize: isSummary ? 72 : 96 }}
            >
              {health.score}
            </span>
            <span className="text-neutral-300 text-2xl font-light">/100</span>
          </div>

          <p
            className="text-neutral-400 uppercase font-medium mb-1"
            style={{ fontSize: '10px', letterSpacing: '0.3em' }}
          >
            Recovery Health
          </p>

          <div className="flex items-center gap-2 mb-6">
            <span
              className={`inline-block text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 border dashboard-status-transition ${style.badge}`}
              style={{ borderRadius: 2 }}
            >
              {statusLabel}
            </span>
          </div>

          {/* Executive summary */}
          {health.executiveSummary && (
            <p className="text-[15px] text-neutral-500 leading-relaxed max-w-[440px] mb-8">
              {health.executiveSummary}
            </p>
          )}

          {/* Concern / Opportunity inline */}
          {!isSummary && (health.mainConcern || health.mainOpportunity) && (
            <div className="flex gap-4 flex-wrap">
              {health.mainConcern && (
                <div
                  className="flex-1 min-w-[200px]"
                  style={{ borderLeft: '2px solid #DC2626', paddingLeft: 12 }}
                >
                  <p className="text-[9px] font-bold uppercase tracking-widest text-red-600 mb-1">
                    Main Concern
                  </p>
                  <p className="text-sm text-neutral-600 leading-snug">{health.mainConcern}</p>
                </div>
              )}
              {health.mainOpportunity && (
                <div
                  className="flex-1 min-w-[200px]"
                  style={{ borderLeft: '2px solid #059669', paddingLeft: 12 }}
                >
                  <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-600 mb-1">
                    Main Opportunity
                  </p>
                  <p className="text-sm text-neutral-600 leading-snug">{health.mainOpportunity}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: abstract metallic visual */}
        {!isSummary && (
          <div className="hidden lg:flex items-center justify-center" style={{ padding: '40px 0' }}>
            <RecoveryLoopVisual size={220} />
          </div>
        )}
      </div>

      {/* ── Metric rail ── */}
      {!isSummary && (
        <div style={{ borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3', padding: '0' }}>
          <div className="grid grid-cols-2 sm:grid-cols-4">
            <MetricCell
              label="Revenue Recovered"
              value={formatCompactPaise(executiveSummary.actualRecoveredRevenueInPaise)}
              exactValue={formatPaise(executiveSummary.actualRecoveredRevenueInPaise)}
              color="#059669"
            />
            <MetricCell
              label="Recovery Rate"
              value={executiveSummary.actualRecoveryRate !== null
                ? formatPercent(executiveSummary.actualRecoveryRate)
                : '—'}
            />
            <MetricCell
              label="Revenue at Risk"
              value={formatCompactPaise(executiveSummary.revenueAtRiskInPaise)}
              exactValue={formatPaise(executiveSummary.revenueAtRiskInPaise)}
              color="#DC2626"
            />
            <MetricCell
              label="Forecasted Recovery"
              value={formatCompactPaise(executiveSummary.forecastedRecoveryInPaise)}
              exactValue={formatPaise(executiveSummary.forecastedRecoveryInPaise)}
              last
            />
          </div>
        </div>
      )}

      {/* ── Component breakdown (detailed) ── */}
      {!isSummary && (
        <div className="py-10">
          <p
            className="text-neutral-400 uppercase mb-6"
            style={{ fontSize: '10px', letterSpacing: '0.28em' }}
          >
            Health Component Breakdown
          </p>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {health.components.map((c) => (
              <ComponentRow
                key={c.key}
                component={c}
                isStrongest={c.key === health.strongestComponent.key}
                isWeakest={c.key === health.weakestComponent.key}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Portfolio KPIs (detailed) ── */}
      {!isSummary && (
        <div className="grid gap-6 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 pb-10">
          <KpiCell
            label="Forecast Recovery Rate"
            value={executiveSummary.forecastRecoveryRate !== null
              ? formatPercent(executiveSummary.forecastRecoveryRate)
              : '—'}
            sub="Forward-looking"
          />
          <KpiCell
            label="Critical-Risk Payments"
            value={String(executiveSummary.criticalRiskPaymentCount)}
            valueClass={executiveSummary.criticalRiskPaymentCount > 0 ? 'text-red-700' : 'text-neutral-900'}
          />
          <KpiCell
            label="Active Anomalies"
            value={String(executiveSummary.activeAnomalyCount)}
            valueClass={executiveSummary.activeAnomalyCount > 0 ? 'text-amber-700' : 'text-neutral-900'}
          />
          {executiveSummary.bestObservedStrategy && (
            <KpiCell
              label="Best Observed Strategy"
              value={executiveSummary.bestObservedStrategy}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Metric rail cell ─────────────────────────────────────────────────────────

function MetricCell({
  label,
  value,
  exactValue,
  color,
  last = false,
}: {
  label: string;
  value: string;
  exactValue?: string;
  color?: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: '24px 32px',
        borderRight: last ? 'none' : '1px solid #E5E5E3',
      }}
      title={exactValue ? `Exact: ${exactValue}` : undefined}
    >
      <p
        className="uppercase font-medium text-neutral-400 mb-2"
        style={{ fontSize: '9px', letterSpacing: '0.3em' }}
      >
        {label}
      </p>
      <p
        className="font-light tabular-nums leading-none"
        style={{ fontSize: 36, color: color ?? '#111111' }}
      >
        {value}
      </p>
    </div>
  );
}
