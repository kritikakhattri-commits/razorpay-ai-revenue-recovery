import type { PaymentMethod, FailureReason } from '../payments/types';
import type { RecoveryPriority } from '../recovery/recoveryScore';
import type { RevenueRiskLevel } from '../recovery/revenueAtRisk';
import type { CustomerRecoverySegment } from '../customerRecovery/types';

export type SimulationScenarioType =
  | 'HIGH_CONFIDENCE'
  | 'CRITICAL_RISK'
  | 'TOP_QUEUE'
  | 'PAYMENT_METHOD'
  | 'FAILURE_REASON'
  | 'RETRY_WINDOW'
  | 'BEST_OBSERVED_STRATEGY'
  | 'CUSTOM';

export type SimulationStrategyMode =
  | 'USE_CURRENT_RECOMMENDATION'
  | 'FIXED_RETRY_DELAY'
  | 'USE_METHOD_SWITCH'
  | 'BEST_OBSERVED_STRATEGY';

export type SimulationPolicyOutcome = 'APPROVED' | 'MODIFIED' | 'BLOCKED';

export interface SimulationFilters {
  readonly recoveryPriority?: readonly RecoveryPriority[];
  readonly riskLevel?: readonly RevenueRiskLevel[];
  readonly paymentMethods?: readonly PaymentMethod[];
  readonly failureReasons?: readonly FailureReason[];
  // maxQueueRank: only include payments whose queue rank (1-indexed) is ≤ this value.
  readonly maxQueueRank?: number;
  readonly customerSegments?: readonly CustomerRecoverySegment[];
}

export interface SimulationStrategy {
  readonly mode: SimulationStrategyMode;
  // Used when mode === 'FIXED_RETRY_DELAY'. Only applied to RETRY_LATER recommendations.
  readonly retryDelayMinutes?: number;
  // Used when mode === 'USE_METHOD_SWITCH'. True = prefer paymentMethodSwitch recommendation.
  readonly useRecommendedMethodSwitch?: boolean;
}

export interface RecoverySimulationScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: SimulationScenarioType;
  readonly filters: SimulationFilters;
  readonly strategy: SimulationStrategy;
}

export interface SimulatedPaymentResult {
  readonly paymentId: string;
  readonly customerName: string;
  readonly failedAmountInPaise: number;
  // Base: recoveryScore.expectedRecoverableAmountInPaise
  // Adjusted if mode === BEST_OBSERVED_STRATEGY and policy approved with sufficient data.
  readonly estimatedRecoverableInPaise: number;
  readonly riskLevel: RevenueRiskLevel;
  // Label of the current policy-approved strategy (from existing policyDecision.finalAction).
  readonly currentStrategyLabel: string;
  // Label of the candidate strategy the simulator would apply (before policy evaluation).
  readonly simulatedStrategyLabel: string;
  // Outcome of running the candidate through the PolicyEngine dry-run.
  readonly policyOutcome: SimulationPolicyOutcome;
  readonly policyReason: string;
  readonly policyRulesApplied: readonly string[];
}

export interface RecoverySimulationResult {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly scenarioDescription: string;

  readonly eligiblePaymentCount: number;
  readonly targetedFailedRevenueInPaise: number;

  // estimatedRecoverableRevenueInPaise / targetedFailedRevenueInPaise
  readonly estimatedRecoverableRevenueInPaise: number;
  readonly estimatedUnrecoveredRevenueInPaise: number;
  readonly estimatedRecoveryRate: number;

  // Same as estimatedUnrecoveredRevenueInPaise (revenue remaining after scenario).
  readonly estimatedRevenueAtRiskInPaise: number;

  // PolicyEngine dry-run outcome counts.
  readonly policyApprovedCount: number;
  readonly policyModifiedCount: number;
  readonly policyBlockedCount: number;

  readonly affectedPaymentIds: readonly string[];
  readonly paymentResults: readonly SimulatedPaymentResult[];

  readonly notes: readonly string[];

  // Comparison with current baseline (sum of recoveryScore.expectedRecoverableAmountInPaise).
  readonly baselineEstimatedRecoverableInPaise: number;
  readonly scenarioDeltaInPaise: number;

  readonly simulatedAt: string;
  // Safety marker: always true; ensures no caller confuses this with an execution result.
  readonly isSimulationOnly: true;
}

export interface SimulationComparisonResult {
  readonly scenarios: readonly RecoverySimulationResult[];
  readonly bestByRecoveryRate: RecoverySimulationResult | null;
  readonly bestByRevenue: RecoverySimulationResult | null;
  readonly bestByCount: RecoverySimulationResult | null;
}
