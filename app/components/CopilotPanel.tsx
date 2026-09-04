'use client';

import { useState } from 'react';
import type { CopilotResponse, CopilotSource } from '@/src/domain/copilot/types';

const DEFAULT_STARTERS = [
  'What should I focus on first?',
  'Show my top recovery opportunities',
  'How much revenue is at risk?',
  'What will recover in the next 24 hours?',
  'Are there any anomalies?',
  'Which experiment is leading?',
];

function isCopilotSource(value: unknown): value is CopilotSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' && typeof record.label === 'string';
}

function isCopilotResponse(value: unknown): value is CopilotResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.intent === 'string' &&
    typeof record.answer === 'string' &&
    Array.isArray(record.sources) &&
    record.sources.every(isCopilotSource) &&
    Array.isArray(record.suggestedFollowUps) &&
    record.suggestedFollowUps.every((item) => typeof item === 'string') &&
    typeof record.requiresApproval === 'boolean'
  );
}

export function CopilotPanel({
  paymentId,
  compact = false,
  starterQuestions = DEFAULT_STARTERS,
}: {
  paymentId?: string;
  compact?: boolean;
  starterQuestions?: string[];
}) {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<CopilotResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isLoading) return;

    setQuery(trimmed);
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed, paymentId }),
      });
      const payload: unknown = await res.json();
      if (!res.ok || !isCopilotResponse(payload)) {
        setError('Copilot could not answer this request.');
        return;
      }
      setResponse(payload);
    } catch {
      setError('Copilot is unavailable right now.');
    } finally {
      setIsLoading(false);
    }
  }

  const starters = starterQuestions.slice(0, compact ? 4 : 6);

  return (
    <div style={{ borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3' }}>
      {/* Label */}
      <div className="flex items-center justify-between py-6">
        <p
          className="uppercase text-neutral-400 font-medium"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Ask Recovery Intelligence
        </p>
        {response?.requiresApproval && (
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-700 border border-amber-200 px-2 py-0.5 bg-amber-50"
            style={{ borderRadius: 2 }}>
            Approval required
          </span>
        )}
      </div>

      {/* Large search-style input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(query);
        }}
        className="flex items-center gap-0"
        style={{ borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3' }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            paymentId
              ? `Ask about this payment…`
              : 'What should I focus on first?'
          }
          maxLength={1000}
          className="flex-1 bg-transparent outline-none text-neutral-900 placeholder-neutral-300"
          style={{
            padding: '20px 0',
            fontSize: 16,
            fontWeight: 400,
          }}
        />
        <button
          type="submit"
          disabled={isLoading || query.trim().length === 0}
          className="shrink-0 flex items-center gap-2 text-neutral-900 disabled:text-neutral-300 transition-colors duration-150"
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '0 0 0 24px',
            letterSpacing: '0.02em',
          }}
        >
          {isLoading ? 'Thinking…' : (
            <>
              Ask
              <span className="arrow" style={{ fontSize: 16, marginLeft: 2 }}>→</span>
            </>
          )}
        </button>
      </form>

      {/* Suggested starters */}
      <div className="py-5 flex flex-wrap gap-2">
        <span
          className="text-neutral-300 text-xs self-center mr-1"
          style={{ fontSize: '11px' }}
        >
          Suggested:
        </span>
        {starters.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => void ask(q)}
            className="text-neutral-500 hover:text-neutral-900 transition-colors duration-150"
            style={{
              fontSize: '12px',
              background: 'none',
              border: 'none',
              padding: '0',
              cursor: 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
              textDecorationColor: '#D4D4D4',
            }}
          >
            {q}
          </button>
        ))}
      </div>

      {/* Response area */}
      {(error || response) && (
        <div style={{ borderTop: '1px solid #EBEBEB', paddingTop: '24px', paddingBottom: '24px' }}>
          {error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : response ? (
            <div className="space-y-5">
              <p className="whitespace-pre-line text-[15px] leading-7 text-neutral-700 max-w-[640px]">
                {response.answer}
              </p>

              {response.sources.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-[10px] text-neutral-400 uppercase tracking-widest mr-1">Sources</span>
                  {response.sources.map((source) => (
                    <span
                      key={`${source.type}:${source.id ?? source.label}`}
                      className="text-[11px] font-medium text-neutral-500 bg-neutral-100 px-2 py-0.5"
                      style={{ borderRadius: 2 }}
                    >
                      {source.label}
                    </span>
                  ))}
                </div>
              )}

              {response.suggestedFollowUps.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-neutral-400 mb-3">Follow-ups</p>
                  <div className="flex flex-wrap gap-3">
                    {response.suggestedFollowUps.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => void ask(q)}
                        className="text-neutral-500 hover:text-neutral-900 transition-colors duration-150 text-sm"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textUnderlineOffset: 3,
                          textDecorationColor: '#D4D4D4',
                        }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {!response && !error && (
        <p className="text-xs text-neutral-400 pb-6">
          Answers draw from recovery queue, risk scoring, forecasts, insights, anomalies, and experiments.
        </p>
      )}
    </div>
  );
}
