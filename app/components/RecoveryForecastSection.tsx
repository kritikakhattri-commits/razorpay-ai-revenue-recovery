import type { RecoveryForecast, ForecastConfidence } from '@/src/services/forecast/recoveryForecast';

export interface ForecastSectionProps {
  forecast: RecoveryForecast;
  totalFailedRevenueFormatted: string;
  expectedRecoveredFormatted: string;
  expectedUnrecoveredFormatted: string;
  expectedRecoveryRateFormatted: string;
  highConfidenceFormatted: string;
  mediumConfidenceFormatted: string;
  lowConfidenceFormatted: string;
  next24HFormatted: string;
  next3DaysFormatted: string;
  beyond3DaysFormatted: string;
}

const CONFIDENCE_COLOR: Record<ForecastConfidence, string> = {
  HIGH:   '#059669',
  MEDIUM: '#D97706',
  LOW:    '#6B7280',
};

export function RecoveryForecastSection({
  forecast,
  totalFailedRevenueFormatted,
  expectedRecoveredFormatted,
  expectedUnrecoveredFormatted,
  expectedRecoveryRateFormatted,
  highConfidenceFormatted,
  mediumConfidenceFormatted,
  lowConfidenceFormatted,
  next24HFormatted,
  next3DaysFormatted,
  beyond3DaysFormatted,
}: ForecastSectionProps) {
  const confidenceColor = CONFIDENCE_COLOR[forecast.forecastConfidence];

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      {/* Header row */}
      <div className="flex items-baseline justify-between py-5">
        <p
          className="uppercase text-neutral-400 font-medium"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Recovery Forecast
        </p>
        <span
          className="text-[10px] font-bold uppercase tracking-widest"
          style={{ color: confidenceColor }}
        >
          {forecast.forecastConfidence} confidence
        </span>
      </div>

      {/* 4-metric summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4" style={{ borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3' }}>
        <ForecastMetric label="Failed Revenue" value={totalFailedRevenueFormatted} />
        <ForecastMetric label="Expected Recovery" value={expectedRecoveredFormatted} color="#059669" />
        <ForecastMetric label="Expected Unrecovered" value={expectedUnrecoveredFormatted} color="#DC2626" />
        <ForecastMetric label="Forecast Rate" value={expectedRecoveryRateFormatted} last />
      </div>

      {/* Horizon + confidence breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 py-6">
        <div style={{ paddingRight: 40 }}>
          <p
            className="uppercase text-neutral-400 font-medium mb-4"
            style={{ fontSize: '9px', letterSpacing: '0.3em' }}
          >
            By Horizon
          </p>
          <FRow label="Next 24 hours" value={next24HFormatted} />
          <FRow label="Next 3 days"   value={next3DaysFormatted} />
          <FRow label="Beyond 3 days" value={beyond3DaysFormatted} />
        </div>
        <div style={{ borderLeft: '1px solid #E5E5E3', paddingLeft: 40 }}>
          <p
            className="uppercase text-neutral-400 font-medium mb-4"
            style={{ fontSize: '9px', letterSpacing: '0.3em' }}
          >
            By Probability
          </p>
          <FRow label="High probability"   value={highConfidenceFormatted} />
          <FRow label="Medium probability" value={mediumConfidenceFormatted} />
          <FRow label="Low probability"    value={lowConfidenceFormatted} />
        </div>
      </div>
    </div>
  );
}

function ForecastMetric({
  label,
  value,
  color,
  last = false,
}: {
  label: string;
  value: string;
  color?: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: '20px 24px',
        borderRight: last ? 'none' : '1px solid #E5E5E3',
      }}
    >
      <p
        className="uppercase text-neutral-400 font-medium mb-1"
        style={{ fontSize: '9px', letterSpacing: '0.28em' }}
      >
        {label}
      </p>
      <p
        className="font-light tabular-nums leading-none"
        style={{ fontSize: 28, color: color ?? '#111111' }}
      >
        {value}
      </p>
    </div>
  );
}

function FRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-center justify-between py-2.5"
      style={{ borderBottom: '1px solid #F2F2F0' }}
    >
      <span className="text-sm text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-900 tabular-nums font-mono">{value}</span>
    </div>
  );
}
