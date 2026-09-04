import type { RecoveryExperiment } from '../../domain/experiment/types';

// ── Demo experiments ───────────────────────────────────────────────────────────
//
// These are static demo fixtures that mirror the approach used for failed-payments.json.
// Status is RUNNING so the dashboard shows live metrics derived from the existing dataset.

export const DEMO_EXPERIMENTS: readonly RecoveryExperiment[] = [
  {
    id: 'exp_retry_timing_001',
    name: 'Retry Timing Optimization',
    description:
      'Compare quick (30-min) vs delayed (120-min) retry for payments eligible for retry. ' +
      'Tests whether faster retries improve recovery rate.',
    status: 'RUNNING',
    dimension: 'RETRY_TIMING',
    variantA: {
      id: 'A',
      name: 'Quick Retry (30 min)',
      description: 'Retry payment after 30 minutes.',
      strategy: { dimension: 'RETRY_TIMING', retryDelayMinutes: 30 },
    },
    variantB: {
      id: 'B',
      name: 'Delayed Retry (120 min)',
      description: 'Retry payment after 120 minutes.',
      strategy: { dimension: 'RETRY_TIMING', retryDelayMinutes: 120 },
    },
    allocationPercent: { a: 50, b: 50 },
    startedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'exp_message_tone_001',
    name: 'Recovery Message Tone',
    description:
      'Compare neutral vs friendly recovery message tone. ' +
      'Tests whether warmer messaging increases customer response rates.',
    status: 'RUNNING',
    dimension: 'MESSAGE_TONE',
    variantA: {
      id: 'A',
      name: 'Neutral',
      description: 'Professional, concise recovery message.',
      strategy: { dimension: 'MESSAGE_TONE', tone: 'NEUTRAL' },
    },
    variantB: {
      id: 'B',
      name: 'Friendly',
      description: 'Warm, conversational recovery message.',
      strategy: { dimension: 'MESSAGE_TONE', tone: 'FRIENDLY' },
    },
    allocationPercent: { a: 50, b: 50 },
    startedAt: '2026-08-15T00:00:00.000Z',
  },
] as const;
