import Link from 'next/link';
import { getCustomerRecoveryDetailByCustomerId } from '@/src/lib/dashboardData';
import type { RecoveryPriority } from '@/src/domain/recovery/recoveryScore';
import { formatFailureReason, formatPaise, formatPaymentMethod, formatPercent } from '@/src/lib/formatters';
import { SEGMENT_BADGE, segmentLabel } from '@/app/components/CustomerRecoverySection';

interface Props {
  params: Promise<{ customerId: string }>;
}

const PRIORITY_BADGE: Record<RecoveryPriority, string> = {
  HIGH: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  MEDIUM: 'bg-amber-50 text-amber-700 border border-amber-100',
  LOW: 'bg-neutral-100 text-neutral-500 border border-neutral-200',
};

export default async function CustomerDetailPage({ params }: Props) {
  const { customerId } = await params;
  const detail = getCustomerRecoveryDetailByCustomerId(customerId);

  return (
    <main className="max-w-[1100px] mx-auto px-6 py-10">
      <Link href="/#customers" className="text-sm font-medium text-neutral-500 hover:text-neutral-900 transition-colors duration-150">
        Back to dashboard
      </Link>

      {!detail ? (
        <div className="mt-8 border-t border-neutral-100 pt-6">
          <p className="text-sm text-neutral-500">Customer not found.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <section className="bg-white border border-neutral-200 rounded-xl p-6 dashboard-section-appear">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Customer Recovery Intelligence</p>
                <h1 className="mt-2 text-2xl font-semibold text-neutral-900">{detail.score.customerName}</h1>
                <p className="mt-1 font-mono text-sm text-neutral-400">{detail.score.customerId}</p>
              </div>
              <span className={`rounded px-2.5 py-1 text-xs font-semibold dashboard-status-transition ${SEGMENT_BADGE[detail.score.segment]}`}>
                {segmentLabel(detail.score.segment)}
              </span>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-5 md:grid-cols-4">
              <Metric label="Customer Recovery Score" value={`${detail.score.score} / 100`} />
              <Metric label="Previous Payments" value={String(detail.score.successfulPaymentCount)} />
              <Metric
                label="Historical Success Rate"
                value={detail.score.historicalSuccessRate === null ? 'Not available' : formatPercent(detail.score.historicalSuccessRate)}
              />
              <Metric
                label="Preferred Method"
                value={
                  detail.score.preferredSuccessfulPaymentMethod
                    ? formatPaymentMethod(detail.score.preferredSuccessfulPaymentMethod)
                    : 'Not available'
                }
              />
              <Metric label="Best Payment Window" value={detail.score.preferredSuccessfulPaymentWindow ?? 'Not available'} />
              <Metric label="Active Failed Revenue" value={formatPaise(detail.score.activeFailedRevenueInPaise)} />
              <Metric label="Expected Recovery" value={formatPaise(detail.score.expectedRecoverableRevenueInPaise)} />
              <Metric label="Revenue At Risk" value={formatPaise(detail.score.revenueAtRiskInPaise)} />
            </div>

            <div className="mt-6 border-t border-neutral-100 pt-4">
              <p className="text-sm font-medium text-neutral-900">Why</p>
              <ul className="mt-2 space-y-1">
                {detail.score.factors.map((factor) => (
                  <li key={factor} className="text-sm text-neutral-600">{factor}</li>
                ))}
              </ul>
            </div>
          </section>

          <section className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-100">
              <h2 className="text-base font-semibold text-neutral-900">Active Failed Payments</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-100">
                    {['Payment', 'Failed Amount', 'Method', 'Failure', 'Recovery Probability', 'Expected Recovery', 'Recovery Priority', 'Outcome'].map((col) => (
                      <th key={col} className="px-6 py-3 text-left text-xs font-medium text-neutral-400 whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.cases.map((recoveryCase) => (
                    <tr key={recoveryCase.payment.paymentId} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 transition-colors duration-150">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Link
                          href={`/payments/${recoveryCase.payment.paymentId}`}
                          className="font-mono text-xs font-medium text-neutral-900 hover:text-neutral-600 transition-colors duration-150"
                        >
                          {recoveryCase.payment.paymentId}
                        </Link>
                      </td>
                      <td className="px-6 py-4 font-mono tabular-nums text-neutral-700 whitespace-nowrap">
                        {formatPaise(recoveryCase.payment.amount)}
                      </td>
                      <td className="px-6 py-4 text-neutral-600 whitespace-nowrap">
                        {formatPaymentMethod(recoveryCase.payment.paymentMethod)}
                      </td>
                      <td className="px-6 py-4 text-neutral-600 whitespace-nowrap">
                        {formatFailureReason(recoveryCase.payment.failureReason)}
                      </td>
                      <td className="px-6 py-4 tabular-nums text-neutral-700 whitespace-nowrap">
                        {Math.round(recoveryCase.recoveryScore.recoveryProbability * 100)}%
                      </td>
                      <td className="px-6 py-4 font-mono tabular-nums text-neutral-900 font-semibold whitespace-nowrap">
                        {formatPaise(recoveryCase.recoveryScore.expectedRecoverableAmountInPaise)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold dashboard-status-transition ${PRIORITY_BADGE[recoveryCase.recoveryScore.priority]}`}>
                          {recoveryCase.recoveryScore.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-neutral-600 whitespace-nowrap">
                        {recoveryCase.executionResult.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-neutral-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-neutral-900 tabular-nums">{value}</p>
    </div>
  );
}
