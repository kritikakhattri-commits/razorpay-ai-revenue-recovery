import type { RecoveryTimelineEvent, RecoveryTimelineReadModel } from '@/src/domain/timeline/types';

const STATUS_STYLE: Record<RecoveryTimelineEvent['status'], { dot: string; badge: string }> = {
  INFO: {
    dot: 'bg-slate-400',
    badge: 'bg-slate-50 text-slate-600 border border-slate-100',
  },
  SUCCESS: {
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  },
  WARNING: {
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-700 border border-amber-100',
  },
  BLOCKED: {
    dot: 'bg-red-500',
    badge: 'bg-red-50 text-red-700 border border-red-100',
  },
};

function timeLabel(timestamp: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function detailEntries(event: RecoveryTimelineEvent): Array<[string, string | number | boolean | null]> {
  return Object.entries(event.details ?? {}).filter(([, value]) => value !== null);
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-neutral-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-neutral-900 tabular-nums">{value}</p>
    </div>
  );
}

function TimelineEvent({ event, isLast }: { event: RecoveryTimelineEvent; isLast: boolean }) {
  const style = STATUS_STYLE[event.status];
  const entries = detailEntries(event);

  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {!isLast && <div className="absolute left-[7px] top-5 h-full w-px bg-neutral-200" />}
      <div className={`relative mt-1 h-3.5 w-3.5 rounded-full ring-4 ring-white ${style.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <time className="text-xs font-medium text-neutral-400">{timeLabel(event.timestamp)}</time>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${style.badge}`}>
            {event.status}
          </span>
          <span className="text-xs text-neutral-400">{event.kind}</span>
        </div>
        <h3 className="mt-1 text-sm font-semibold text-neutral-900">{event.title}</h3>
        <p className="mt-0.5 text-sm text-neutral-600 leading-snug">{event.summary}</p>

        {entries.length > 0 && (
          <details className="mt-2 group">
            <summary className="cursor-pointer text-xs font-medium text-neutral-500 hover:text-neutral-900">
              Why
            </summary>
            <dl className="mt-2 grid gap-1.5 text-xs">
              {entries.map(([key, value]) => (
                <div key={key} className="flex gap-3">
                  <dt className="w-36 shrink-0 text-neutral-400">{key.replace(/([A-Z])/g, ' $1')}</dt>
                  <dd className="min-w-0 text-neutral-700">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </li>
  );
}

export function RecoveryTimelineSection({ timeline }: { timeline: RecoveryTimelineReadModel }) {
  const { summary } = timeline;

  return (
    <div id="timeline" className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-neutral-100">
        <h2 className="text-base font-semibold text-neutral-900">Payment Intelligence</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryItem label="Failed Amount" value={summary.failedAmountFormatted} />
          <SummaryItem label="Expected Recovery" value={summary.expectedRecoveryFormatted} />
          <SummaryItem label="Revenue At Risk" value={summary.revenueAtRiskFormatted} />
          <SummaryItem label="Priority" value={summary.recoveryPriority} />
          <SummaryItem label="Risk Level" value={summary.riskLevel} />
          <SummaryItem label="Strategy" value={summary.currentStrategy} />
          <SummaryItem label="Outcome" value={summary.currentOutcome} />
        </div>
      </div>

      <div className="px-6 py-5">
        <h2 className="text-base font-semibold text-neutral-900">Recovery Timeline</h2>
        <ol className="mt-5">
          {timeline.events.map((event, index) => (
            <TimelineEvent
              key={event.id}
              event={event}
              isLast={index === timeline.events.length - 1}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}
