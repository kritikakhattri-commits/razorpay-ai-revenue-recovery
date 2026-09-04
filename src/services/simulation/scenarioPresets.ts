import type { RecoverySimulationScenario } from '../../domain/simulation/types';

// ── Preset scenarios ──────────────────────────────────────────────────────────
//
// All presets are deterministic: given the same portfolio, they always produce the same result.
// Presets intentionally cover different recovery levers to give operators meaningful comparisons.

export const PRESET_SCENARIOS: readonly RecoverySimulationScenario[] = [
  {
    id: 'preset_high_confidence',
    name: 'High-Confidence Payments',
    description: 'All payments with HIGH Recovery Priority (≥70% recovery probability) using the current approved strategy',
    type: 'HIGH_CONFIDENCE',
    filters: { recoveryPriority: ['HIGH'] },
    strategy: { mode: 'USE_CURRENT_RECOMMENDATION' },
  },
  {
    id: 'preset_critical_risk',
    name: 'Critical-Risk Focus',
    description: 'All CRITICAL revenue-at-risk payments using the current approved strategy',
    type: 'CRITICAL_RISK',
    filters: { riskLevel: ['CRITICAL'] },
    strategy: { mode: 'USE_CURRENT_RECOMMENDATION' },
  },
  {
    id: 'preset_top_queue',
    name: 'Top 10 Recovery Queue',
    description: 'The top 10 highest expected-recovery payments from the recovery queue',
    type: 'TOP_QUEUE',
    filters: { maxQueueRank: 10 },
    strategy: { mode: 'USE_CURRENT_RECOMMENDATION' },
  },
  {
    id: 'preset_upi_timeout_60min',
    name: 'UPI Timeout — 60-Min Retry',
    description: 'All UPI_TIMEOUT failures on UPI payments, retried within 60 minutes',
    type: 'RETRY_WINDOW',
    filters: { failureReasons: ['UPI_TIMEOUT'], paymentMethods: ['UPI'] },
    strategy: { mode: 'FIXED_RETRY_DELAY', retryDelayMinutes: 60 },
  },
  {
    id: 'preset_best_observed',
    name: 'Best Observed Strategy',
    description: 'Use the Feature 14 best observed strategy per failure reason. Falls back to current recommendation when data is insufficient.',
    type: 'BEST_OBSERVED_STRATEGY',
    filters: {},
    strategy: { mode: 'BEST_OBSERVED_STRATEGY' },
  },
] as const;

export function findPreset(id: string): RecoverySimulationScenario | undefined {
  return PRESET_SCENARIOS.find((s) => s.id === id);
}
