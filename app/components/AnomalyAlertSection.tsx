import type { PaymentFailureAnomaly } from '../../src/domain/anomaly/types';

interface Props {
  anomalies: PaymentFailureAnomaly[];
}

const SEVERITY_LEFT_BORDER: Record<string, string> = {
  CRITICAL: '#DC2626',
  HIGH:     '#EA580C',
  MEDIUM:   '#D97706',
  LOW:      '#3B82F6',
};

const SEVERITY_TEXT: Record<string, string> = {
  CRITICAL: '#DC2626',
  HIGH:     '#EA580C',
  MEDIUM:   '#D97706',
  LOW:      '#3B82F6',
};

const TYPE_LABELS: Record<string, string> = {
  FAILURE_VOLUME_SPIKE:  'Volume Spike',
  FAILURE_REASON_SPIKE:  'Reason Spike',
  PAYMENT_METHOD_SPIKE:  'Method Spike',
  REVENUE_SPIKE:         'Revenue Spike',
  RISK_CONCENTRATION:    'Risk Concentration',
};

function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function AnomalyAlertSection({ anomalies }: Props) {
  if (anomalies.length === 0) {
    return (
      <div style={{ borderTop: '1px solid #E5E5E3', padding: '20px 0' }}>
        <div className="flex items-center gap-3">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <p className="text-sm text-neutral-500">
            No unusual anomalies detected in the current window.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      <div className="flex items-baseline gap-3 py-5">
        <p
          className="uppercase font-medium text-neutral-400"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Anomaly Alerts
        </p>
        <span className="text-xs text-neutral-400">
          {anomalies.length} detected
        </span>
      </div>

      <div className="space-y-0">
        {anomalies.map((anomaly) => {
          const borderColor = SEVERITY_LEFT_BORDER[anomaly.severity] ?? '#9CA3AF';
          const textColor   = SEVERITY_TEXT[anomaly.severity] ?? '#6B7280';
          return (
            <div
              key={anomaly.id}
              className="flex items-start justify-between gap-6 py-4"
              style={{
                borderBottom: '1px solid #F0F0EE',
                paddingLeft: 12,
                borderLeft: `2px solid ${borderColor}`,
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span
                    className="text-[10px] font-bold uppercase tracking-widest"
                    style={{ color: textColor }}
                  >
                    {anomaly.severity}
                  </span>
                  <span className="text-[10px] text-neutral-400 uppercase tracking-wide">
                    {TYPE_LABELS[anomaly.type] ?? anomaly.type}
                  </span>
                </div>
                <p className="text-sm font-medium text-neutral-900 leading-snug mb-0.5">
                  {anomaly.title}
                </p>
                <p className="text-sm text-neutral-500 leading-relaxed">{anomaly.message}</p>
              </div>
              <div className="shrink-0 text-right min-w-[80px]">
                <p className="text-sm font-semibold text-neutral-900 tabular-nums">
                  {formatPaise(anomaly.affectedRevenueInPaise)}
                </p>
                <p className="text-[11px] text-neutral-400 mt-0.5">affected</p>
                {anomaly.ratioToBaseline !== null && (
                  <p className="text-[11px] text-neutral-400 mt-0.5">
                    {anomaly.ratioToBaseline.toFixed(1)}× baseline
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
