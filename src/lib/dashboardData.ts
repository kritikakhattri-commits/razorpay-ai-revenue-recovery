import { loadFailedPayments } from './failedPaymentLoader';
import { computeRecoveryRecommendation } from '../domain/recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../domain/policy/policyEngine';
import { SimulatedRecoveryActionExecutor } from '../domain/executor/simulatedRecoveryActionExecutor';
import { InMemoryAuditStore } from '../domain/audit/inMemoryAuditStore';
import { AuditLogger } from '../services/audit/auditLogger';
import { RecoveryOrchestrator } from '../services/recovery/recoveryOrchestrator';
import { BatchRecoveryService } from '../services/recovery/batchRecoveryService';
import type { BatchRecoveryResult, RecoveryCase } from '../services/recovery/types';
import { generateInsights, generateInsightSummary } from '../services/insights/insightEngine';
import { detectAnomalies } from '../services/anomaly/anomalyEngine';
import { runAllExperiments } from '../services/experiment/experimentEngine';
import { DEMO_EXPERIMENTS } from '../services/experiment/experimentRegistry';
import type { RevenueInsight } from '../domain/insights/types';
import type { PaymentFailureAnomaly } from '../domain/anomaly/types';
import type { ExperimentResult } from '../domain/experiment/types';
import { buildCustomerRecoveryPortfolio, getCustomerRecoveryScoreById } from '../services/customerRecovery/customerRecoveryScore';
import { buildRecoveryQueue } from '../services/queue/recoveryQueue';
import type { CustomerRecoveryPortfolio, CustomerRecoveryScore } from '../domain/customerRecovery/types';
import type { CustomerId } from '../domain/payments/types';
import { computeStrategyAnalytics } from '../services/strategyAnalytics/strategyAnalyticsEngine';
import type { StrategyAnalyticsResult } from '../domain/strategyAnalytics/types';
import { runPresetSimulations } from '../services/simulation/recoverySimulator';
import { PRESET_SCENARIOS } from '../services/simulation/scenarioPresets';
import type { RecoverySimulationResult } from '../domain/simulation/types';
import { computeRecoveryHealth, buildRecoveryExecutiveSummary } from '../services/recoveryHealth/recoveryHealthEngine';
import type { RecoveryExecutiveSummary } from '../domain/recoveryHealth/types';

export type { RevenueInsight };
export type { PaymentFailureAnomaly };
export type { ExperimentResult };
export type { CustomerRecoveryPortfolio, CustomerRecoveryScore };
export type { StrategyAnalyticsResult };
export type { RecoverySimulationResult };
export type { RecoveryExecutiveSummary };

function makeOrchestrator() {
  const auditStore = new InMemoryAuditStore();
  const auditLogger = new AuditLogger(auditStore);
  const executor = new SimulatedRecoveryActionExecutor();
  return new RecoveryOrchestrator({
    decisionEngine: computeRecoveryRecommendation,
    policyEngine: evaluatePolicy,
    executor,
    auditLogger,
    auditStore,
  });
}

export interface DashboardData {
  batch: BatchRecoveryResult;
  insights: RevenueInsight[];
  insightSummary: string | null;
  anomalies: PaymentFailureAnomaly[];
  experimentResults: ExperimentResult[];
  customerRecovery: CustomerRecoveryPortfolio;
  strategyAnalytics: StrategyAnalyticsResult;
  presetSimulations: RecoverySimulationResult[];
  recoveryHealth: RecoveryExecutiveSummary;
}

export function runDashboard(): DashboardData {
  const payments = loadFailedPayments();
  const batch = new BatchRecoveryService(makeOrchestrator()).process(payments);
  const anomalies = detectAnomalies({ cases: batch.cases });
  const experimentResults = runAllExperiments(DEMO_EXPERIMENTS, batch.cases);
  const experimentComparisons = experimentResults.map((r) => r.comparison);
  const customerRecovery = buildCustomerRecoveryPortfolio(batch.cases);

  // Build segment map for Feature 14 (consumes Feature 13 output)
  const customerSegmentMap = new Map(
    customerRecovery.customers.map((c) => [c.customerId, c.segment]),
  );
  const strategyAnalytics = computeStrategyAnalytics({
    cases: batch.cases,
    experimentResults,
    customerSegmentMap,
  });

  const queueItems = buildRecoveryQueue(batch.cases).items;
  const presetSimulations = runPresetSimulations(PRESET_SCENARIOS, {
    cases: batch.cases,
    queueItems,
    strategyAnalytics,
    customerSegmentMap,
  });

  const insightInput = {
    cases: batch.cases,
    forecast: batch.forecast,
    anomalies,
    experimentComparisons,
    strategyAnalytics,
  };

  const healthInput = {
    batch,
    anomalies,
    strategyAnalytics,
    customerRecovery,
    queueItems,
    generatedAt: new Date().toISOString(),
  };
  const health = computeRecoveryHealth(healthInput);
  const recoveryHealth = buildRecoveryExecutiveSummary({ ...healthInput, health });

  return {
    batch,
    anomalies,
    experimentResults,
    customerRecovery,
    strategyAnalytics,
    presetSimulations,
    recoveryHealth,
    insights: generateInsights(insightInput),
    insightSummary: generateInsightSummary(insightInput),
  };
}

export function runBatchRecovery(): BatchRecoveryResult {
  const payments = loadFailedPayments();
  const batchService = new BatchRecoveryService(makeOrchestrator());
  return batchService.process(payments);
}

export function getRecoveryCaseByPaymentId(paymentId: string): RecoveryCase | undefined {
  const payments = loadFailedPayments();
  const payment = payments.find((p) => p.paymentId === paymentId);
  if (!payment) return undefined;
  return makeOrchestrator().recover(payment);
}

export function getCustomerRecoveryScoreForPaymentId(
  paymentId: string,
): CustomerRecoveryScore | null {
  const dashboard = runDashboard();
  const recoveryCase = dashboard.batch.cases.find((c) => c.payment.paymentId === paymentId);
  if (!recoveryCase) return null;
  return getCustomerRecoveryScoreById(
    recoveryCase.payment.customerId,
    dashboard.batch.cases,
  );
}

export function getCustomerRecoveryDetailByCustomerId(customerId: string): {
  score: CustomerRecoveryScore;
  cases: RecoveryCase[];
} | null {
  const dashboard = runDashboard();
  const typedCustomerId = customerId as CustomerId;
  const score = getCustomerRecoveryScoreById(typedCustomerId, dashboard.batch.cases);
  if (!score) return null;
  return {
    score,
    cases: dashboard.batch.cases.filter((c) => c.payment.customerId === typedCustomerId),
  };
}
