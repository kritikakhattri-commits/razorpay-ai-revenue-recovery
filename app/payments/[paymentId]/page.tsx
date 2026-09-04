import { getCustomerRecoveryScoreForPaymentId, getRecoveryCaseByPaymentId } from '@/src/lib/dashboardData';
import { formatDelayMinutes, formatPaise, formatUtcDateTime } from '@/src/lib/formatters';
import type { RecoveryPriority } from '@/src/domain/recovery/recoveryScore';
import { generateRecoveryMessages } from '@/src/services/messaging/recoveryMessageGenerator';
import { RecoveryMessagesSection } from '@/app/components/RecoveryMessagesSection';
import { getAssignedMessageTone } from '@/src/services/experiment/experimentEngine';
import { DEMO_EXPERIMENTS } from '@/src/services/experiment/experimentRegistry';
import { CopilotPanel } from '@/app/components/CopilotPanel';
import { runAllExperiments } from '@/src/services/experiment/experimentEngine';
import { buildRecoveryTimeline } from '@/src/services/timeline/recoveryTimeline';
import { RecoveryTimelineSection } from '@/app/components/RecoveryTimelineSection';
import { CustomerRecoveryProfileCard } from '@/app/components/CustomerRecoverySection';

interface Props {
  params: Promise<{ paymentId: string }>;
}

const PRIORITY_BADGE: Record<RecoveryPriority, string> = {
  HIGH: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  MEDIUM: 'bg-amber-50 text-amber-700 border border-amber-100',
  LOW: 'bg-neutral-100 text-neutral-500 border border-neutral-200',
};

export default async function PaymentDetailPage({ params }: Props) {
  const { paymentId } = await params;
  const recoveryCase = getRecoveryCaseByPaymentId(paymentId);
  const customerRecoveryScore = getCustomerRecoveryScoreForPaymentId(paymentId);

  const messageDrafts = recoveryCase
    ? (generateRecoveryMessages({
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
      }) ?? [])
    : [];
  const experimentResults = recoveryCase ? runAllExperiments(DEMO_EXPERIMENTS, [recoveryCase]) : [];
  const timeline = recoveryCase
    ? buildRecoveryTimeline({
        recoveryCase,
        experimentResults,
        messageDrafts,
        customerRecoveryScore: customerRecoveryScore ?? undefined,
      })
    : null;

  return (
    <main className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="max-w-lg">
        <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Payment ID</p>
        <p className="mt-1.5 font-mono text-sm text-neutral-900 break-all">{paymentId}</p>

        {recoveryCase ? (
          <>
            {/* ── Payment Details ────────────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100 space-y-3">
              <h2 className="text-base font-semibold text-neutral-900">Payment Details</h2>
              <DetailRow label="Customer" value={recoveryCase.payment.customerName} />
              <DetailRow label="Amount" value={formatPaise(recoveryCase.payment.amount)} mono />
              <DetailRow label="Failure" value={recoveryCase.payment.failureReason.replace(/_/g, ' ')} />
              <DetailRow label="Method" value={recoveryCase.payment.paymentMethod} />
              <DetailRow label="Attempts" value={String(recoveryCase.payment.attemptCount)} />
            </div>

            {timeline && (
              <div className="mt-8">
                <RecoveryTimelineSection timeline={timeline} />
              </div>
            )}

            {customerRecoveryScore && (
              <div className="mt-8">
                <CustomerRecoveryProfileCard score={customerRecoveryScore} />
              </div>
            )}

            {/* ── Recovery Opportunity ────────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100 dashboard-section-appear">
              <h2 className="text-base font-semibold text-neutral-900">Recovery Opportunity</h2>
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-neutral-500">Recovery Probability</span>
                  <span className="text-sm font-semibold text-neutral-900 tabular-nums">
                    {Math.round(recoveryCase.recoveryScore.recoveryProbability * 100)}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-neutral-500">Expected Recovery</span>
                  <span className="text-sm font-semibold text-neutral-900 tabular-nums font-mono">
                    {formatPaise(recoveryCase.recoveryScore.expectedRecoverableAmountInPaise)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-neutral-500">Recovery Priority</span>
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded dashboard-status-transition ${PRIORITY_BADGE[recoveryCase.recoveryScore.priority]}`}
                  >
                    {recoveryCase.recoveryScore.priority}
                  </span>
                </div>
              </div>
            </div>

            {/* ── Payment Copilot ─────────────────────────────────────────────── */}
            <div className="mt-8">
              <CopilotPanel
                paymentId={paymentId}
                compact
                starterQuestions={[
                  'Why is this payment high risk?',
                  'When should we retry this?',
                  'Why is this payment method recommended?',
                  'What does PolicyEngine allow?',
                ]}
              />
            </div>

            {/* ── AI Recommendation ──────────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100">
              <h2 className="text-base font-semibold text-neutral-900">AI Recommendation</h2>
              <div className="mt-4 space-y-3">
                <DetailRow label="Action" value={recoveryCase.recommendation.recommendedAction.replace(/_/g, ' ')} />
                <DetailRow label="Confidence" value={`${Math.round(recoveryCase.recommendation.confidence * 100)}%`} />
                <div>
                  <p className="text-sm text-neutral-500">Reasoning</p>
                  <p className="mt-1 text-sm text-neutral-700">{recoveryCase.recommendation.reasoning}</p>
                </div>
              </div>
            </div>

            {/* ── Smart Retry Timing ────────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100">
              <h2 className="text-base font-semibold text-neutral-900">Smart Retry Timing</h2>
              {recoveryCase.smartRetryTiming ? (
                <div className="mt-4 space-y-3">
                  <DetailRow
                    label="Recommended Retry"
                    value={`${formatUtcDateTime(recoveryCase.smartRetryTiming.recommendedRetryAt)} UTC`}
                  />
                  <DetailRow
                    label="Delay"
                    value={formatDelayMinutes(recoveryCase.smartRetryTiming.delayMinutes)}
                  />
                  <DetailRow
                    label="Timing Confidence"
                    value={recoveryCase.smartRetryTiming.confidence}
                  />
                  <DetailRow
                    label="Source"
                    value={recoveryCase.smartRetryTiming.source.replace(/_/g, ' ')}
                  />
                  <div>
                    <p className="text-sm text-neutral-500">Reason</p>
                    <p className="mt-1 text-sm text-neutral-700">
                      {recoveryCase.smartRetryTiming.reason}
                    </p>
                  </div>
                  <div className="pt-3 border-t border-neutral-100 space-y-3">
                    <DetailRow
                      label="Recommended by timing engine"
                      value={formatDelayMinutes(recoveryCase.smartRetryTiming.delayMinutes)}
                    />
                    <DetailRow
                      label="Approved by policy"
                      value={
                        recoveryCase.policyDecision.approvedRetryAfterMinutes != null
                          ? formatDelayMinutes(recoveryCase.policyDecision.approvedRetryAfterMinutes)
                          : 'Not approved'
                      }
                    />
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-neutral-500">
                  No retry timing is recommended for this recovery action.
                </p>
              )}
            </div>

            {/* ── Revenue Risk ───────────────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100">
              <h2 className="text-base font-semibold text-neutral-900">Revenue Risk</h2>
              {(() => {
                const risk = recoveryCase.revenueAtRiskScore;
                const riskColor =
                  risk.level === 'CRITICAL' ? 'text-red-700' :
                  risk.level === 'HIGH'     ? 'text-orange-600' :
                  risk.level === 'MEDIUM'   ? 'text-amber-600' :
                                              'text-neutral-500';
                return (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-neutral-500">Revenue Risk Score</span>
                      <span className={`text-sm font-semibold tabular-nums ${riskColor}`}>
                        {risk.score} / 100
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-neutral-500">Risk Level</span>
                      <span className={`text-sm font-semibold ${riskColor}`}>{risk.level}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-neutral-500">Revenue at Risk</span>
                      <span className="text-sm font-semibold text-neutral-900 tabular-nums font-mono">
                        {formatPaise(risk.revenueAtRiskInPaise)}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm text-neutral-500">Why</p>
                      <ul className="mt-1 space-y-0.5">
                        {risk.factors.map((f) => (
                          <li key={f} className="text-sm text-neutral-700 flex items-start gap-1.5">
                            <span className="text-neutral-300 mt-0.5">•</span>
                            {f}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── Payment Method Recommendation ──────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100">
              <h2 className="text-base font-semibold text-neutral-900">Payment Method Recommendation</h2>
              {(() => {
                const sw = recoveryCase.paymentMethodSwitch;
                if (sw.shouldSwitch && sw.recommendedMethod) {
                  return (
                    <div className="mt-4 space-y-3">
                      <DetailRow label="Current Method" value={sw.currentMethod} />
                      <DetailRow label="Recommended Method" value={sw.recommendedMethod} />
                      <div>
                        <p className="text-sm text-neutral-500">Why</p>
                        <p className="mt-1 text-sm text-neutral-700">{sw.reason}</p>
                      </div>
                      {sw.alternatives.length > 1 && (
                        <div>
                          <p className="text-sm text-neutral-500">Other Options</p>
                          <ul className="mt-1 space-y-1">
                            {sw.alternatives.slice(1).map((alt) => (
                              <li key={alt.method} className="flex items-center gap-2">
                                <span className="text-xs font-medium text-neutral-700 bg-neutral-100 px-2 py-0.5 rounded">
                                  {alt.method}
                                </span>
                                <span className="text-xs text-neutral-500">
                                  suitability {Math.round(alt.score * 100)}%
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div className="mt-4 space-y-3">
                    <DetailRow label="Payment Method" value="Keep current method" />
                    <div>
                      <p className="text-sm text-neutral-500">Reason</p>
                      <p className="mt-1 text-sm text-neutral-700">{sw.reason}</p>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── Recovery Messages ──────────────────────────────────────────── */}
            <div id="messages">
              <RecoveryMessagesSection drafts={messageDrafts} />
            </div>

            {/* ── Policy Decision ────────────────────────────────────────────── */}
            <div className="mt-8 pt-6 border-t border-neutral-100">
              <h2 className="text-base font-semibold text-neutral-900">Policy Decision</h2>
              <div className="mt-4 space-y-3">
                <DetailRow
                  label="Decision"
                  value={recoveryCase.policyDecision.approved ? 'Approved' : 'Rejected'}
                />
                <DetailRow label="Final Action" value={recoveryCase.policyDecision.finalAction.replace(/_/g, ' ')} />
                <DetailRow label="Reason" value={recoveryCase.policyDecision.reason} />
              </div>
            </div>
          </>
        ) : (
          <div className="mt-8 pt-6 border-t border-neutral-100">
            <p className="text-sm text-neutral-500">Payment not found.</p>
          </div>
        )}
      </div>
    </main>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-neutral-500">{label}</span>
      <span className={`text-sm text-neutral-900 ${mono ? 'font-mono tabular-nums' : ''}`}>
        {value}
      </span>
    </div>
  );
}
