import type { PaymentMethod, FailureReason } from '../payments/types';
import type { CustomerRecoverySegment } from '../customerRecovery/types';

export type RecoveryStrategyType =
  | 'RETRY'
  | 'PAYMENT_METHOD_SWITCH'
  | 'PAYMENT_LINK'
  | 'ESCALATION';

export type RetryDelayBucket =
  | 'UNDER_30_MIN'
  | '30_TO_60_MIN'
  | '1_TO_3_HR'
  | '3_TO_6_HR'
  | '6_TO_24_HR'
  | 'OVER_24_HR';

export type StrategyPerformanceStatus =
  | 'INSUFFICIENT_DATA'
  | 'OBSERVED'
  | 'LEADING';

export type MetricDataSource = 'OBSERVED' | 'EXPERIMENT';

export interface RecoveryStrategyKey {
  readonly type: RecoveryStrategyType;
  // RETRY: same-method, bucketed by policy-approved delay
  readonly retryDelayBucket?: RetryDelayBucket;
  readonly paymentMethod?: PaymentMethod;
  // PAYMENT_METHOD_SWITCH: cross-method transition
  readonly fromPaymentMethod?: PaymentMethod;
  readonly toPaymentMethod?: PaymentMethod;
}

export interface RecoveryStrategyMetrics {
  readonly strategyKey: RecoveryStrategyKey;
  readonly label: string;

  readonly totalAttempts: number;
  readonly completedAttempts: number;

  readonly recoveredCount: number;
  readonly failedCount: number;
  readonly pendingCount: number;
  readonly escalatedCount: number;
  readonly blockedCount: number;

  // recoveredCount / completedAttempts. null when completedAttempts === 0.
  readonly recoveryRate: number | null;

  readonly attemptedRevenueInPaise: number;
  readonly recoveredRevenueInPaise: number;

  // recoveredRevenueInPaise / attemptedRevenueInPaise. null when attemptedRevenueInPaise === 0.
  readonly revenueRecoveryRate: number | null;

  // recoveredRevenueInPaise / recoveredCount. null when recoveredCount === 0.
  readonly averageRecoveredRevenueInPaise: number | null;

  // Average minutes from payment.failedAt to executionResult.executedAt for RECOVERED cases.
  readonly averageRecoveryTimeMinutes: number | null;

  readonly performanceStatus: StrategyPerformanceStatus;
  readonly dataSource: MetricDataSource;
}

export interface FailureReasonPerformance {
  readonly failureReason: FailureReason;
  readonly totalAttempts: number;
  readonly completedAttempts: number;
  readonly recoveredCount: number;
  readonly recoveryRate: number | null;
  readonly recoveredRevenueInPaise: number;
  // Best strategy for this failure reason. null when no strategy meets minimum sample.
  readonly bestStrategy: RecoveryStrategyMetrics | null;
  readonly strategyBreakdown: readonly RecoveryStrategyMetrics[];
}

export interface PaymentMethodPerformance {
  readonly paymentMethod: PaymentMethod;
  readonly totalAttempts: number;
  readonly completedAttempts: number;
  readonly recoveredCount: number;
  readonly totalFailedRevenueInPaise: number;
  readonly recoveredRevenueInPaise: number;
  readonly recoveryRate: number | null;
  readonly averageRecoveryTimeMinutes: number | null;
  readonly bestStrategy: RecoveryStrategyMetrics | null;
}

export interface CustomerSegmentPerformance {
  readonly segment: CustomerRecoverySegment;
  readonly totalAttempts: number;
  readonly completedAttempts: number;
  readonly recoveredCount: number;
  readonly recoveryRate: number | null;
  readonly recoveredRevenueInPaise: number;
  readonly averageRecoveryTimeMinutes: number | null;
}

export interface ExperimentStrategyPerformance {
  readonly experimentId: string;
  readonly experimentName: string;
  readonly dimension: string;
  readonly variantAId: 'A';
  readonly variantAName: string;
  readonly variantARecoveryRate: number;
  readonly variantACompletedCount: number;
  readonly variantBId: 'B';
  readonly variantBName: string;
  readonly variantBRecoveryRate: number;
  readonly variantBCompletedCount: number;
  readonly leadingVariantId: 'A' | 'B' | null;
  readonly comparisonStatus: string;
  readonly dataSource: 'EXPERIMENT';
}

export interface MessageToneAnalytics {
  readonly experimentId: string;
  readonly neutralName: string;
  readonly neutralRecoveryRate: number;
  readonly neutralCompletedCount: number;
  readonly friendlyName: string;
  readonly friendlyRecoveryRate: number;
  readonly friendlyCompletedCount: number;
  readonly leadingTone: 'NEUTRAL' | 'FRIENDLY' | null;
  readonly comparisonStatus: string;
  readonly dataSource: 'EXPERIMENT';
  // Recovery messages are drafts only — this explains the data source limitation.
  readonly note: string;
}

export interface StrategyPortfolioSummary {
  readonly totalAttempts: number;
  readonly totalCompletedAttempts: number;
  readonly portfolioRecoveryRate: number | null;
  readonly totalRecoveredRevenueInPaise: number;
  readonly averageRecoveryTimeMinutes: number | null;
  // Strategy with highest observed recovery rate. null when no strategy has sufficient data.
  readonly bestRecoveryRateStrategy: RecoveryStrategyMetrics | null;
  // Strategy with most recovered revenue. May differ from bestRecoveryRateStrategy.
  readonly highestRevenueStrategy: RecoveryStrategyMetrics | null;
  // Strategy with lowest average recovery time. null when no timing data.
  readonly fastestStrategy: RecoveryStrategyMetrics | null;
  // Strategy with lowest observed recovery rate. null when same as best (only one observed).
  readonly weakestRecoveryRateStrategy: RecoveryStrategyMetrics | null;
  readonly insufficientDataCount: number;
  readonly observedCount: number;
  readonly leadingCount: number;
}

export interface StrategyAnalyticsResult {
  readonly strategyMetrics: readonly RecoveryStrategyMetrics[];
  readonly failureReasonPerformance: readonly FailureReasonPerformance[];
  readonly paymentMethodPerformance: readonly PaymentMethodPerformance[];
  readonly customerSegmentPerformance: readonly CustomerSegmentPerformance[];
  readonly experimentPerformance: readonly ExperimentStrategyPerformance[];
  readonly messageToneAnalytics: MessageToneAnalytics | null;
  readonly portfolioSummary: StrategyPortfolioSummary;
  readonly generatedAt: string;
}
