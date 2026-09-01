/**
 * BatchRecoveryService development demo.
 *
 * Loads all 40 payments from the synthetic dataset, runs them through the full
 * recovery pipeline, and prints a batch summary plus a 5-case sample.
 *
 * Usage:
 *   npx tsx scripts/batch-demo.ts
 */

import { loadFailedPayments } from '../src/lib/failedPaymentLoader';
import { computeRecoveryRecommendation } from '../src/domain/recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../src/domain/policy/policyEngine';
import { SimulatedRecoveryActionExecutor } from '../src/domain/executor/simulatedRecoveryActionExecutor';
import { InMemoryAuditStore } from '../src/domain/audit/inMemoryAuditStore';
import { AuditLogger } from '../src/services/audit/auditLogger';
import { RecoveryOrchestrator } from '../src/services/recovery/recoveryOrchestrator';
import { BatchRecoveryService } from '../src/services/recovery/batchRecoveryService';

function formatPaise(paise: number): string {
  return (
    '₹' +
    new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(paise / 100)
  );
}

function formatRate(rate: number): string {
  return (rate * 100).toFixed(2) + '%';
}

function hr(): void {
  console.log('─'.repeat(60));
}

const store = new InMemoryAuditStore();
const logger = new AuditLogger(store);
const executor = new SimulatedRecoveryActionExecutor();

const orchestrator = new RecoveryOrchestrator({
  decisionEngine: computeRecoveryRecommendation,
  policyEngine: evaluatePolicy,
  executor,
  auditLogger: logger,
  auditStore: store,
});

const service = new BatchRecoveryService(orchestrator);
const payments = loadFailedPayments();
const result = service.process(payments);

console.log();
hr();
console.log(' AI Revenue Recovery — Batch Summary');
hr();
console.log();
console.log(`  Payments analyzed : ${result.totalPayments}`);
console.log(`  Revenue at risk   : ${formatPaise(result.totalRevenueAtRisk)}`);
console.log(`  Revenue recovered : ${formatPaise(result.totalRecoveredRevenue)}`);
console.log(`  Recovery rate     : ${formatRate(result.recoveryRate)}`);
console.log();
console.log(`  Recovered  : ${result.recoveredPaymentCount}`);
console.log(`  Failed     : ${result.failedRecoveryCount}`);
console.log(`  Pending    : ${result.pendingPaymentCount}`);
console.log(`  Escalated  : ${result.escalatedPaymentCount}`);
console.log(`  Blocked    : ${result.blockedPaymentCount}`);
console.log();

hr();
console.log(' Sample — first 5 cases');
hr();

const sample = result.cases.slice(0, 5);

for (const c of sample) {
  console.log();
  console.log(`  Payment ID        : ${c.payment.paymentId}`);
  console.log(`  Failure reason    : ${c.payment.failureReason}`);
  console.log(`  Recommended action: ${c.recommendation.recommendedAction}`);
  console.log(`  Policy final      : ${c.policyDecision.finalAction}`);
  console.log(`  Status            : ${c.executionResult.status}`);
  console.log(`  Recovered amount  : ${formatPaise(c.recoveredAmount)}`);
}

console.log();
hr();
console.log();
