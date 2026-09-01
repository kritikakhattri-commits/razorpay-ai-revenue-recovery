/**
 * RecoveryOrchestrator development demo.
 *
 * Loads the first payment from the synthetic dataset, runs it through the
 * full recovery workflow, and prints each stage to stdout.
 *
 * Usage:
 *   npx tsx scripts/demo.ts
 */

import { loadFailedPayments } from '../src/lib/failedPaymentLoader';
import { computeRecoveryRecommendation } from '../src/domain/recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../src/domain/policy/policyEngine';
import { SimulatedRecoveryActionExecutor } from '../src/domain/executor/simulatedRecoveryActionExecutor';
import { InMemoryAuditStore } from '../src/domain/audit/inMemoryAuditStore';
import { AuditLogger } from '../src/services/audit/auditLogger';
import { RecoveryOrchestrator } from '../src/services/recovery/recoveryOrchestrator';

function formatPaise(paise: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

function hr(label: string): void {
  console.log('\n' + '─'.repeat(50));
  console.log(` ${label}`);
  console.log('─'.repeat(50));
}

const payments = loadFailedPayments();
const payment = payments[0];

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

const recoveryCase = orchestrator.recover(payment);

hr('Payment');
console.log(`  ID         : ${recoveryCase.payment.paymentId}`);
console.log(`  Customer   : ${recoveryCase.payment.customerName}`);
console.log(`  Amount     : ${formatPaise(recoveryCase.payment.amount)}`);
console.log(`  Method     : ${recoveryCase.payment.paymentMethod}`);
console.log(`  Failure    : ${recoveryCase.payment.failureReason}`);
console.log(`  Attempts   : ${recoveryCase.payment.attemptCount}`);

hr('Recommendation');
console.log(`  Action     : ${recoveryCase.recommendation.recommendedAction}`);
console.log(`  Confidence : ${(recoveryCase.recommendation.confidence * 100).toFixed(1)}%`);
console.log(`  Retry After: ${recoveryCase.recommendation.retryAfterMinutes ?? 'N/A'} min`);
console.log(`  Diagnosis  : ${recoveryCase.recommendation.diagnosis}`);
console.log(`  Reasoning  : ${recoveryCase.recommendation.reasoning}`);

hr('Policy Decision');
console.log(`  Approved   : ${recoveryCase.policyDecision.approved ? 'Yes' : 'No'}`);
console.log(`  Final Action: ${recoveryCase.policyDecision.finalAction}`);
console.log(`  Reason     : ${recoveryCase.policyDecision.reason}`);
console.log(`  Rules      : ${recoveryCase.policyDecision.policyRulesApplied.join(', ') || 'none'}`);

hr('Execution Result');
console.log(`  Status     : ${recoveryCase.executionResult.status}`);
console.log(`  Action     : ${recoveryCase.executionResult.action}`);
console.log(`  Message    : ${recoveryCase.executionResult.message}`);

hr('Recovered Amount');
console.log(`  ${formatPaise(recoveryCase.recoveredAmount)}`);

hr('Audit Timeline');
for (const entry of recoveryCase.auditEntries) {
  console.log(`  [${entry.auditId}] ${entry.eventType}`);
  console.log(`        ${entry.message}`);
}

console.log('\n' + '─'.repeat(50) + '\n');
