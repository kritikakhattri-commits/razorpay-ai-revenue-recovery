'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RecoveryPriority } from '@/src/domain/recovery/recoveryScore';
import type { PaymentMethod } from '@/src/domain/payments/types';

export interface QueueRow {
  paymentId: string;
  queueRank: number;
  customerName: string;
  amountFormatted: string;
  amountExactFormatted: string;
  failureLabel: string;
  paymentMethod: PaymentMethod;
  recoveryProbabilityFormatted: string;
  expectedRecoveryFormatted: string;
  expectedRecoveryExactFormatted: string;
  priorityLabel: RecoveryPriority;
  priorityBadgeClass: string;
  actionLabel: string;
  bestRetryDelayLabel: string | null;
  timingConfidence: string | null;
  timingReason: string | null;
  methodSwitchLabel: string | null;
  riskLevel: string;
  riskScore: number;
  riskLevelBadgeClass: string;
  revenueAtRiskFormatted: string;
  revenueAtRiskExactFormatted: string;
}

export interface QueueSummaryProps {
  totalPayments: number;
  totalRevenueAtRiskFormatted: string;
  totalExpectedRecoveryFormatted: string;
  highPriorityCount: number;
  mediumPriorityCount: number;
  lowPriorityCount: number;
}

type PriorityFilter = 'ALL' | RecoveryPriority;
type MethodFilter  = 'ALL' | PaymentMethod;
type SortBy        = 'EXPECTED_RECOVERY' | 'RISK_SCORE';

const PRIORITY_FILTERS: { label: string; value: PriorityFilter }[] = [
  { label: 'All',    value: 'ALL'    },
  { label: 'High',   value: 'HIGH'   },
  { label: 'Medium', value: 'MEDIUM' },
  { label: 'Low',    value: 'LOW'    },
];

const METHOD_FILTERS: { label: string; value: MethodFilter }[] = [
  { label: 'All methods', value: 'ALL'        },
  { label: 'UPI',         value: 'UPI'        },
  { label: 'Card',        value: 'CARD'       },
  { label: 'Net Banking', value: 'NETBANKING' },
  { label: 'Wallet',      value: 'WALLET'     },
];

export const PRIORITY_BADGE: Record<RecoveryPriority, string> = {
  HIGH:   'bg-emerald-50 text-emerald-700 border border-emerald-100',
  MEDIUM: 'bg-amber-50 text-amber-700 border border-amber-100',
  LOW:    'bg-neutral-100 text-neutral-500 border border-neutral-200',
};

export const RISK_BADGE: Record<string, string> = {
  CRITICAL: 'bg-red-50 text-red-700 border border-red-200',
  HIGH:     'bg-orange-50 text-orange-700 border border-orange-200',
  MEDIUM:   'bg-amber-50 text-amber-700 border border-amber-100',
  LOW:      'bg-neutral-100 text-neutral-500 border border-neutral-200',
};

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-colors duration-120"
      style={{
        fontSize: '11px',
        fontWeight: active ? 600 : 400,
        color: active ? '#111111' : '#9CA3AF',
        padding: '4px 0',
        marginRight: 16,
        background: 'none',
        border: 'none',
        borderBottom: active ? '1.5px solid #111111' : '1.5px solid transparent',
        cursor: 'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {label}
    </button>
  );
}

export function RecoveryQueueSection({
  rows,
  summary,
}: {
  rows: QueueRow[];
  summary: QueueSummaryProps;
}) {
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [methodFilter,   setMethodFilter]   = useState<MethodFilter>('ALL');
  const [sortBy,         setSortBy]         = useState<SortBy>('EXPECTED_RECOVERY');

  const filtered = rows.filter((r) => {
    if (priorityFilter !== 'ALL' && r.priorityLabel !== priorityFilter) return false;
    if (methodFilter   !== 'ALL' && r.paymentMethod  !== methodFilter)  return false;
    return true;
  });

  const visible =
    sortBy === 'RISK_SCORE'
      ? [...filtered].sort((a, b) => b.riskScore - a.riskScore)
      : filtered;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      {/* Header */}
      <div className="flex items-start justify-between py-5">
        <div>
          <p
            className="uppercase text-neutral-400 font-medium"
            style={{ fontSize: '10px', letterSpacing: '0.3em' }}
          >
            Recovery Queue
          </p>
          <div className="flex items-baseline gap-6 mt-3">
            <MetaStat label="FAILED"            value={summary.totalRevenueAtRiskFormatted} />
            <MetaStat label="EXPECTED RECOVERY" value={summary.totalExpectedRecoveryFormatted} color="#059669" />
            <MetaStat label="QUEUED"            value={String(summary.totalPayments)} />
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-neutral-400 shrink-0">
          <span>
            <span className="font-semibold text-emerald-700">{summary.highPriorityCount}</span> high
          </span>
          <span>
            <span className="font-semibold text-amber-600">{summary.mediumPriorityCount}</span> medium
          </span>
          <span>
            <span className="font-semibold text-neutral-400">{summary.lowPriorityCount}</span> low
          </span>
        </div>
      </div>

      {/* Filter bar */}
      <div
        className="flex items-center flex-wrap gap-0 py-3"
        style={{ borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3' }}
      >
        {PRIORITY_FILTERS.map((f) => (
          <FilterPill
            key={f.value}
            label={f.label}
            active={priorityFilter === f.value}
            onClick={() => setPriorityFilter(f.value)}
          />
        ))}

        <span style={{ width: 1, height: 16, background: '#E5E5E3', margin: '0 16px 0 4px' }} />

        {METHOD_FILTERS.map((f) => (
          <FilterPill
            key={f.value}
            label={f.label}
            active={methodFilter === f.value}
            onClick={() => setMethodFilter(f.value)}
          />
        ))}

        <div className="ml-auto flex items-center gap-0">
          <span className="text-[10px] text-neutral-300 mr-3 uppercase tracking-wide">Sort</span>
          <FilterPill
            label="Expected Recovery"
            active={sortBy === 'EXPECTED_RECOVERY'}
            onClick={() => setSortBy('EXPECTED_RECOVERY')}
          />
          <FilterPill
            label="Risk Score"
            active={sortBy === 'RISK_SCORE'}
            onClick={() => setSortBy('RISK_SCORE')}
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['#', 'Customer', 'Failed', 'Failure', 'Prob.', 'Expected Recovery', 'Priority', 'Risk', 'Action', 'Best Retry', 'Method', 'Timeline', 'Messages'].map((col) => (
                <th
                  key={col}
                  scope="col"
                  style={{
                    padding: '10px 20px 10px 0',
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
            {visible.length === 0 ? (
              <tr>
                <td colSpan={13} style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14 }}>
                  No payments match the current filters.
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr
                  key={row.paymentId}
                  className="trow-hover"
                  style={{ borderBottom: '1px solid #F2F2F0' }}
                >
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#CCCCCC' }}>
                      {String(row.queueRank).padStart(2, '0')}
                    </span>
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    <Link
                      href={`/payments/${row.paymentId}`}
                      className="text-neutral-900 hover:text-neutral-500 transition-colors duration-100"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      {row.customerName}
                    </Link>
                  </td>
                  <td
                    style={{ padding: '14px 20px 14px 0', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#444', whiteSpace: 'nowrap' }}
                    title={`Exact: ${row.amountExactFormatted}`}
                  >
                    {row.amountFormatted}
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap' }}>
                    {row.failureLabel}
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap', tabularNums: true } as React.CSSProperties}>
                    {row.recoveryProbabilityFormatted}
                  </td>
                  <td
                    style={{ padding: '14px 20px 14px 0', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: '#111', whiteSpace: 'nowrap' }}
                    title={`Exact: ${row.expectedRecoveryExactFormatted}`}
                  >
                    {row.expectedRecoveryFormatted}
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 dashboard-status-transition ${PRIORITY_BADGE[row.priorityLabel]}`}
                      style={{ borderRadius: 2, letterSpacing: '0.05em' }}>
                      {row.priorityLabel}
                    </span>
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    <div className="flex flex-col gap-0.5">
                      <span className={`inline-block text-[10px] font-bold px-2 py-0.5 dashboard-status-transition ${row.riskLevelBadgeClass}`}
                        style={{ borderRadius: 2, letterSpacing: '0.05em' }}>
                        {row.riskLevel}
                      </span>
                      <span style={{ fontSize: 10, color: '#BBBBBB' }}>{row.riskScore}/100</span>
                    </div>
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap' }}>
                    {row.actionLabel}
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    {row.bestRetryDelayLabel ? (
                      <div title={row.timingReason ?? undefined}>
                        <p style={{ fontSize: 12, fontWeight: 500, color: '#333' }}>{row.bestRetryDelayLabel}</p>
                        <p style={{ fontSize: 10, color: '#BBBBBB' }}>{row.timingConfidence}</p>
                      </div>
                    ) : (
                      <span style={{ color: '#DDDDDD' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    {row.methodSwitchLabel ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-violet-700 bg-violet-50 border border-violet-100 px-2 py-0.5"
                        style={{ borderRadius: 2 }}>
                        {row.methodSwitchLabel}
                      </span>
                    ) : (
                      <span style={{ color: '#DDDDDD' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                    <Link
                      href={`/payments/${row.paymentId}#timeline`}
                      className="text-neutral-400 hover:text-neutral-900 transition-colors duration-100"
                      style={{ fontSize: 11 }}
                    >
                      View →
                    </Link>
                  </td>
                  <td style={{ padding: '14px 0 14px 0', whiteSpace: 'nowrap' }}>
                    <Link
                      href={`/payments/${row.paymentId}#messages`}
                      className="text-neutral-400 hover:text-neutral-900 transition-colors duration-100"
                      style={{ fontSize: 11 }}
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetaStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div>
      <p style={{ fontSize: '9px', color: '#BBBBBB', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 2 }}>
        {label}
      </p>
      <p style={{ fontSize: 20, fontWeight: 300, color: color ?? '#111111', fontFamily: 'inherit' }}>
        {value}
      </p>
    </div>
  );
}
