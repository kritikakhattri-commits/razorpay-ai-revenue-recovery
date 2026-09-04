'use client';

import { useRouter } from 'next/navigation';

export interface CaseRow {
  paymentId: string;
  customerName: string;
  amountFormatted: string;
  failureLabel: string;
  actionLabel: string;
  confidenceTier: string;
  confidenceTierClass: string;
  confidencePct: string;
  statusLabel: string;
  statusDotClass: string;
  statusTextClass: string;
  statusBgClass: string;
  recoveryProbabilityFormatted: string;
  expectedRecoveryFormatted: string;
  expectedRecoveryExactFormatted: string;
  priorityLabel: string;
  priorityBadgeClass: string;
}

const COLUMNS = [
  'Customer',
  'Amount',
  'Failure',
  'AI Action',
  'AI Confidence',
  'Recovery Opp.',
  'Status',
];

const PRIORITY_BADGE: Record<string, string> = {
  HIGH:   'bg-emerald-50 text-emerald-700 border border-emerald-100',
  MEDIUM: 'bg-amber-50 text-amber-700 border border-amber-100',
  LOW:    'bg-neutral-100 text-neutral-500 border border-neutral-200',
};

export function CasesTable({ rows }: { rows: CaseRow[] }) {
  const router = useRouter();

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
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
          {rows.map((row) => (
            <tr
              key={row.paymentId}
              className="trow-hover"
              style={{
                borderBottom: '1px solid #F2F2F0',
                cursor: 'pointer',
              }}
              onClick={() => router.push(`/payments/${row.paymentId}`)}
            >
              <td style={{ padding: '14px 20px 14px 0', fontSize: 13, fontWeight: 500, color: '#111', whiteSpace: 'nowrap' }}>
                {row.customerName}
              </td>
              <td style={{ padding: '14px 20px 14px 0', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#444', whiteSpace: 'nowrap' }}>
                {row.amountFormatted}
              </td>
              <td style={{ padding: '14px 20px 14px 0', fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap' }}>
                {row.failureLabel}
              </td>
              <td style={{ padding: '14px 20px 14px 0', fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap' }}>
                {row.actionLabel}
              </td>
              <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                <span className={`text-xs font-medium ${row.confidenceTierClass}`}>
                  {row.confidenceTier}
                </span>
                <span style={{ color: '#D4D4D4', margin: '0 4px', fontSize: 10 }}>·</span>
                <span style={{ fontSize: 11, color: '#9CA3AF' }}>{row.confidencePct}</span>
              </td>
              <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block text-[10px] font-bold px-1.5 py-0.5 dashboard-status-transition ${row.priorityBadgeClass}`}
                      style={{ borderRadius: 2 }}
                    >
                      {row.priorityLabel}
                    </span>
                    <span style={{ fontSize: 11, color: '#9CA3AF' }}>
                      {row.recoveryProbabilityFormatted}
                    </span>
                  </div>
                  <span
                    style={{ fontSize: 11, color: '#9CA3AF', fontFamily: 'var(--font-mono)' }}
                    title={`Exact: ${row.expectedRecoveryExactFormatted}`}
                  >
                    {row.expectedRecoveryFormatted}
                  </span>
                </div>
              </td>
              <td style={{ padding: '14px 0 14px 0' }}>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 dashboard-status-transition ${row.statusBgClass} ${row.statusTextClass}`}
                  style={{ borderRadius: 2 }}
                >
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${row.statusDotClass}`} />
                  {row.statusLabel}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { PRIORITY_BADGE };
