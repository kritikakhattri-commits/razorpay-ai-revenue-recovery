import type { RecoverySimulationResult, SimulationComparisonResult } from '../../domain/simulation/types';

// ── Scenario comparison ───────────────────────────────────────────────────────
//
// Compares two or more simulation results. Does not run new simulations.
// All comparison is deterministic: tie-breaks by scenarioId alphabetically.

export function compareRecoverySimulations(
  results: readonly RecoverySimulationResult[],
): SimulationComparisonResult {
  if (results.length === 0) {
    return {
      scenarios: [],
      bestByRecoveryRate: null,
      bestByRevenue: null,
      bestByCount: null,
    };
  }

  const withData = results.filter((r) => r.eligiblePaymentCount > 0);

  const bestByRecoveryRate = withData.length === 0
    ? null
    : [...withData].sort((a, b) => {
        const diff = b.estimatedRecoveryRate - a.estimatedRecoveryRate;
        if (diff !== 0) return diff;
        return a.scenarioId < b.scenarioId ? -1 : 1;
      })[0] ?? null;

  const bestByRevenue = withData.length === 0
    ? null
    : [...withData].sort((a, b) => {
        const diff = b.estimatedRecoverableRevenueInPaise - a.estimatedRecoverableRevenueInPaise;
        if (diff !== 0) return diff;
        return a.scenarioId < b.scenarioId ? -1 : 1;
      })[0] ?? null;

  const bestByCount = withData.length === 0
    ? null
    : [...withData].sort((a, b) => {
        const diff = b.eligiblePaymentCount - a.eligiblePaymentCount;
        if (diff !== 0) return diff;
        return a.scenarioId < b.scenarioId ? -1 : 1;
      })[0] ?? null;

  return {
    scenarios: results,
    bestByRecoveryRate,
    bestByRevenue,
    bestByCount,
  };
}
