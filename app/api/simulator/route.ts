import { runDashboard } from '@/src/lib/dashboardData';
import { runSimulation } from '@/src/services/simulation/recoverySimulator';
import { buildRecoveryQueue } from '@/src/services/queue/recoveryQueue';
import type { RecoverySimulationScenario, SimulationStrategyMode, SimulationScenarioType } from '@/src/domain/simulation/types';

export const dynamic = 'force-dynamic';

// ── Input validation ──────────────────────────────────────────────────────────

const VALID_SCENARIO_TYPES = new Set<SimulationScenarioType>([
  'HIGH_CONFIDENCE', 'CRITICAL_RISK', 'TOP_QUEUE', 'PAYMENT_METHOD',
  'FAILURE_REASON', 'RETRY_WINDOW', 'BEST_OBSERVED_STRATEGY', 'CUSTOM',
]);

const VALID_STRATEGY_MODES = new Set<SimulationStrategyMode>([
  'USE_CURRENT_RECOMMENDATION', 'FIXED_RETRY_DELAY', 'USE_METHOD_SWITCH', 'BEST_OBSERVED_STRATEGY',
]);

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function parseScenario(body: unknown): RecoverySimulationScenario | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  if (!isString(b['id']) || b['id'].length === 0) return null;
  if (!isString(b['name']) || b['name'].length === 0) return null;
  if (!isString(b['type']) || !VALID_SCENARIO_TYPES.has(b['type'] as SimulationScenarioType)) return null;

  const strategy = b['strategy'];
  if (typeof strategy !== 'object' || strategy === null) return null;
  const strat = strategy as Record<string, unknown>;
  if (!isString(strat['mode']) || !VALID_STRATEGY_MODES.has(strat['mode'] as SimulationStrategyMode)) return null;
  if (strat['retryDelayMinutes'] !== undefined && typeof strat['retryDelayMinutes'] !== 'number') return null;

  const filters = b['filters'];
  if (filters !== undefined && (typeof filters !== 'object' || filters === null)) return null;

  return {
    id: b['id'] as string,
    name: (b['name'] as string).slice(0, 100),
    description: isString(b['description']) ? b['description'].slice(0, 300) : '',
    type: b['type'] as SimulationScenarioType,
    filters: (filters as RecoverySimulationScenario['filters']) ?? {},
    strategy: {
      mode: strat['mode'] as SimulationStrategyMode,
      retryDelayMinutes: typeof strat['retryDelayMinutes'] === 'number'
        ? Math.max(1, Math.round(strat['retryDelayMinutes']))
        : undefined,
      useRecommendedMethodSwitch: typeof strat['useRecommendedMethodSwitch'] === 'boolean'
        ? strat['useRecommendedMethodSwitch']
        : undefined,
    },
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const scenario = parseScenario(body);
  if (!scenario) {
    return Response.json(
      { error: 'Invalid scenario. Required: id (string), name (string), type (SimulationScenarioType), strategy.mode (SimulationStrategyMode).' },
      { status: 400 },
    );
  }

  const data = runDashboard();
  const queueItems = buildRecoveryQueue(data.batch.cases).items;
  const customerSegmentMap = new Map(
    data.customerRecovery.customers.map((c) => [c.customerId, c.segment]),
  );

  const result = runSimulation({
    cases: data.batch.cases,
    scenario,
    queueItems,
    strategyAnalytics: data.strategyAnalytics,
    customerSegmentMap,
  });

  return Response.json(result);
}
