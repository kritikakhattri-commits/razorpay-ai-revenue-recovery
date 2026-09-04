import type { ExperimentResult, ExperimentComparison, VariantMetrics } from '@/src/domain/experiment/types';
import { EXPERIMENT_CONSTANTS } from '@/src/services/experiment/experimentEngine';
import { formatPercent, formatPaise } from '@/src/lib/formatters';

const COMPARISON_LABEL: Record<ExperimentComparison['status'], string> = {
  INSUFFICIENT_DATA:   'Collecting data',
  NO_CLEAR_DIFFERENCE: 'No clear difference',
  A_LEADING:           'A leading',
  B_LEADING:           'B leading',
};

const STATUS_COLOR: Record<string, string> = {
  RUNNING:   '#059669',
  PAUSED:    '#D97706',
  DRAFT:     '#9CA3AF',
  COMPLETED: '#2563EB',
};

function VariantBlock({
  metrics,
  isLeading,
  letter,
}: {
  metrics: VariantMetrics;
  isLeading: boolean;
  letter: string;
}) {
  const progress = Math.min(metrics.completedCount / EXPERIMENT_CONSTANTS.MIN_COMPLETED_PER_VARIANT, 1);
  const progressPct = Math.round(progress * 100);

  return (
    <div
      style={{
        flex: 1,
        padding: '16px',
        background: isLeading ? '#F0FDF4' : '#FAFAFA',
        border: `1px solid ${isLeading ? '#BBF7D0' : '#EBEBEB'}`,
        borderRadius: 3,
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: '#9CA3AF', textTransform: 'uppercase' }}>
          Variant {letter}
        </span>
        {isLeading && (
          <span style={{ fontSize: 9, fontWeight: 700, color: '#059669', letterSpacing: '0.1em' }}>LEADING</span>
        )}
      </div>
      <p style={{ fontSize: 11, color: '#777', marginBottom: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {metrics.variantName}
      </p>

      <p style={{ fontSize: 24, fontWeight: 300, color: '#111', marginBottom: 2 }}>
        {metrics.completedCount > 0 ? formatPercent(metrics.recoveryRate) : '—'}
      </p>
      <p style={{ fontSize: 10, color: '#9CA3AF', marginBottom: 12 }}>Recovery rate</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Row label="Recovered" value={metrics.recoveredCount > 0 ? formatPaise(metrics.recoveredRevenueInPaise) : '—'} />
        <Row label="Assigned" value={String(metrics.assignedCount)} />
        <Row label="Completed" value={`${metrics.completedCount}/${EXPERIMENT_CONSTANTS.MIN_COMPLETED_PER_VARIANT}`} />
      </div>

      {/* Sample progress */}
      <div style={{ marginTop: 12 }}>
        <div style={{ height: 2, background: '#E5E5E3', borderRadius: 1, overflow: 'hidden' }}>
          <div
            style={{
              width: `${progressPct}%`,
              height: '100%',
              background: progress >= 1 ? '#059669' : '#D97706',
              borderRadius: 1,
            }}
          />
        </div>
        <p style={{ fontSize: 9, color: '#CCCCCC', marginTop: 4 }}>Sample {progressPct}%</p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ fontSize: 10, color: '#9CA3AF' }}>{label}</span>
      <span style={{ fontSize: 10, color: '#555' }}>{value}</span>
    </div>
  );
}

function ExperimentCard({ result }: { result: ExperimentResult }) {
  const { experiment, comparison } = result;
  const statusColor = STATUS_COLOR[experiment.status] ?? '#9CA3AF';
  const compLabel   = COMPARISON_LABEL[comparison.status];
  const aLeading    = comparison.leadingVariantId === 'A';
  const bLeading    = comparison.leadingVariantId === 'B';

  const rateDiffDisplay =
    comparison.status !== 'INSUFFICIENT_DATA' && comparison.status !== 'NO_CLEAR_DIFFERENCE'
      ? `${comparison.recoveryRateDifference > 0 ? '+' : ''}${Math.round(comparison.recoveryRateDifference * 100)}pp`
      : null;

  return (
    <div style={{ borderTop: '1px solid #F2F2F0', paddingTop: 20, paddingBottom: 20 }}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <p style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{experiment.name}</p>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: statusColor, flexShrink: 0 }}>
          {experiment.status}
        </span>
      </div>
      <p style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 16 }}>{experiment.description}</p>

      <div className="flex gap-3 mb-4">
        <VariantBlock metrics={comparison.variantA} isLeading={aLeading} letter="A" />
        <VariantBlock metrics={comparison.variantB} isLeading={bLeading} letter="B" />
      </div>

      <div className="flex items-center justify-between">
        <span style={{ fontSize: 11, color: '#9CA3AF' }}>{compLabel}</span>
        {rateDiffDisplay && (
          <span style={{ fontSize: 11, color: '#555' }}>
            A vs B: <strong>{rateDiffDisplay}</strong>
          </span>
        )}
        {comparison.status === 'INSUFFICIENT_DATA' && (
          <span style={{ fontSize: 10, color: '#CCCCCC' }}>
            Need {EXPERIMENT_CONSTANTS.MIN_COMPLETED_PER_VARIANT}+ per variant
          </span>
        )}
      </div>
    </div>
  );
}

export interface ExperimentsSectionProps {
  results: ExperimentResult[];
}

export function ExperimentsSection({ results }: ExperimentsSectionProps) {
  if (results.length === 0) return null;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      <div className="py-5">
        <p
          className="uppercase text-neutral-400 font-medium"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Recovery Experiments
        </p>
        <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
          A/B tests comparing retry timing and message tone.
        </p>
      </div>

      <div
        className="grid gap-6"
        style={{ gridTemplateColumns: `repeat(${Math.min(results.length, 2)}, minmax(0, 1fr))` }}
      >
        {results.map((r) => (
          <ExperimentCard key={r.experiment.id} result={r} />
        ))}
      </div>
    </div>
  );
}
