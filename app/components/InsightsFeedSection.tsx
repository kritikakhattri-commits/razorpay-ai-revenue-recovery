import Link from 'next/link';
import type { RevenueInsight, RevenueInsightType, RevenueInsightSeverity } from '@/src/domain/insights/types';

const TYPE_LABELS: Record<RevenueInsightType, string> = {
  OPPORTUNITY: 'Opportunity',
  RISK:        'Risk',
  TREND:       'Trend',
  FORECAST:    'Forecast',
  ACTION:      'Action',
};

const TYPE_COLOR: Record<RevenueInsightType, string> = {
  OPPORTUNITY: '#059669',
  RISK:        '#DC2626',
  TREND:       '#2563EB',
  FORECAST:    '#7C3AED',
  ACTION:      '#D97706',
};

const SEVERITY_DOT: Record<RevenueInsightSeverity, string> = {
  HIGH:   'bg-red-500',
  MEDIUM: 'bg-amber-400',
  LOW:    'bg-neutral-300',
};

const SEVERITY_TEXT: Record<RevenueInsightSeverity, string> = {
  HIGH:   'text-red-600',
  MEDIUM: 'text-amber-600',
  LOW:    'text-neutral-400',
};

export interface InsightsFeedSectionProps {
  insights: RevenueInsight[];
  summary: string | null;
  queueHref?: string;
}

export function InsightsFeedSection({
  insights,
  summary,
  queueHref = '#queue',
}: InsightsFeedSectionProps) {
  if (insights.length === 0) {
    return (
      <div style={{ borderTop: '1px solid #E5E5E3', padding: '20px 0' }}>
        <p
          className="uppercase text-neutral-400 font-medium mb-4"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          AI Revenue Insights
        </p>
        <p className="text-sm text-neutral-500">
          Not enough active failed-payment data to generate meaningful revenue insights.
        </p>
      </div>
    );
  }

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      {/* Header */}
      <div className="flex items-baseline justify-between py-5">
        <div className="flex items-baseline gap-4">
          <p
            className="uppercase text-neutral-400 font-medium"
            style={{ fontSize: '10px', letterSpacing: '0.3em' }}
          >
            AI Revenue Insights
          </p>
          {summary && (
            <p className="text-xs text-neutral-400 max-w-[500px] truncate">{summary}</p>
          )}
        </div>
        <Link
          href={queueHref}
          className="text-xs text-neutral-400 hover:text-neutral-900 transition-colors duration-150 arrow-link"
          style={{ textDecoration: 'none' }}
        >
          View Queue <span className="arrow">→</span>
        </Link>
      </div>

      {/* Insight rows */}
      <ul>
        {insights.map((insight) => {
          const typeColor = TYPE_COLOR[insight.type];
          return (
            <li
              key={insight.id}
              className="flex gap-5 items-start py-4 trow-hover"
              style={{ borderTop: '1px solid #F0F0EE' }}
            >
              {/* Severity dot */}
              <span
                className={`mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[insight.severity]}`}
              />

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className="text-[10px] font-bold uppercase tracking-widest"
                    style={{ color: typeColor }}
                  >
                    {TYPE_LABELS[insight.type]}
                  </span>
                  <span
                    className={`text-[10px] font-medium uppercase tracking-wide ${SEVERITY_TEXT[insight.severity]}`}
                  >
                    {insight.severity}
                  </span>
                </div>
                <p className="text-sm font-medium text-neutral-900 mb-0.5">{insight.title}</p>
                <p className="text-sm text-neutral-500 leading-snug">{insight.message}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
