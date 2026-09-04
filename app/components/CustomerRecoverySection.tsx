import Link from 'next/link';
import type { CustomerRecoveryQueueItem, CustomerRecoveryScore } from '@/src/domain/customerRecovery/types';
import { formatCompactPaise, formatPaise, formatPercent, formatPaymentMethod } from '@/src/lib/formatters';

const SEGMENT_BADGE: Record<string, string> = {
  HIGH_RECOVERY_POTENTIAL:  'bg-emerald-50 text-emerald-700 border border-emerald-100',
  MEDIUM_RECOVERY_POTENTIAL:'bg-amber-50 text-amber-700 border border-amber-100',
  LOW_RECOVERY_POTENTIAL:   'bg-red-50 text-red-700 border border-red-100',
  INSUFFICIENT_HISTORY:     'bg-neutral-100 text-neutral-500 border border-neutral-200',
};

const SEGMENT_SHORT: Record<string, string> = {
  HIGH_RECOVERY_POTENTIAL:  'High',
  MEDIUM_RECOVERY_POTENTIAL:'Medium',
  LOW_RECOVERY_POTENTIAL:   'Low',
  INSUFFICIENT_HISTORY:     'Insufficient',
};

function segmentLabel(segment: string): string {
  return segment.replace(/_/g, ' ');
}

export function CustomerRecoverySection({
  customers,
}: {
  customers: CustomerRecoveryQueueItem[];
}) {
  if (customers.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      <div className="py-5">
        <p
          className="uppercase text-neutral-400 font-medium"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Customer Intelligence
        </p>
        <p className="text-xs text-neutral-400 mt-1">
          Ranked by expected recoverable revenue
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['#', 'Customer', 'Score', 'Segment', 'Failed', 'Expected Recovery', 'Preferred Method'].map((col) => (
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
            {customers.slice(0, 8).map((customer) => (
              <tr
                key={customer.customerId}
                className="trow-hover"
                style={{ borderBottom: '1px solid #F2F2F0' }}
              >
                <td style={{ padding: '14px 20px 14px 0', fontSize: 11, fontWeight: 600, color: '#CCCCCC' }}>
                  {String(customer.rank).padStart(2, '0')}
                </td>
                <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                  <Link
                    href={`/customers/${customer.customerId}`}
                    className="hover:text-neutral-500 transition-colors duration-150"
                    style={{ fontSize: 13, fontWeight: 500, color: '#111' }}
                  >
                    {customer.customerName}
                  </Link>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#CCCCCC', marginTop: 2 }}>
                    {customer.customerId}
                  </p>
                </td>
                <td style={{ padding: '14px 20px 14px 0', fontSize: 14, fontWeight: 600, color: '#111' }}>
                  {customer.score}
                  <span style={{ fontSize: 10, color: '#CCCCCC' }}>/100</span>
                </td>
                <td style={{ padding: '14px 20px 14px 0', whiteSpace: 'nowrap' }}>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 dashboard-status-transition ${SEGMENT_BADGE[customer.segment]}`}
                    style={{ borderRadius: 2, letterSpacing: '0.04em' }}
                  >
                    {SEGMENT_SHORT[customer.segment] ?? segmentLabel(customer.segment)}
                  </span>
                </td>
                <td
                  style={{ padding: '14px 20px 14px 0', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#444', whiteSpace: 'nowrap' }}
                  title={`Exact: ${formatPaise(customer.activeFailedRevenueInPaise)}`}
                >
                  {formatCompactPaise(customer.activeFailedRevenueInPaise)}
                </td>
                <td
                  style={{ padding: '14px 20px 14px 0', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: '#111', whiteSpace: 'nowrap' }}
                  title={`Exact: ${formatPaise(customer.expectedRecoverableRevenueInPaise)}`}
                >
                  {formatCompactPaise(customer.expectedRecoverableRevenueInPaise)}
                </td>
                <td style={{ padding: '14px 0 14px 0', fontSize: 12, color: '#6B7280', whiteSpace: 'nowrap' }}>
                  {customer.preferredSuccessfulPaymentMethod
                    ? formatPaymentMethod(customer.preferredSuccessfulPaymentMethod)
                    : 'Not available'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CustomerRecoveryProfileCard({
  score,
}: {
  score: CustomerRecoveryScore;
}) {
  return (
    <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 24, paddingBottom: 24 }}>
      <p
        className="uppercase text-neutral-400 font-medium mb-5"
        style={{ fontSize: '10px', letterSpacing: '0.3em' }}
      >
        Customer Recovery Profile
      </p>
      <div className="space-y-3">
        <ProfileRow label="Recovery Score" value={`${score.score} / 100`} />
        <ProfileRow label="Segment" value={segmentLabel(score.segment)} />
        <ProfileRow label="Previous Successes" value={String(score.successfulPaymentCount)} />
        <ProfileRow
          label="Historical Success Rate"
          value={score.historicalSuccessRate === null ? 'Not available' : formatPercent(score.historicalSuccessRate)}
        />
        <ProfileRow
          label="Preferred Method"
          value={score.preferredSuccessfulPaymentMethod
            ? formatPaymentMethod(score.preferredSuccessfulPaymentMethod)
            : 'Not available'}
        />
      </div>
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-2.5"
      style={{ borderBottom: '1px solid #F2F2F0' }}
    >
      <span className="text-sm text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-900 text-right">{value}</span>
    </div>
  );
}

export { SEGMENT_BADGE, segmentLabel };
