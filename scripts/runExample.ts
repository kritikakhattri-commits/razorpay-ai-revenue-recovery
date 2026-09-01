// Run with: npx tsx scripts/runExample.ts
import type { FailedPayment } from '../src/domain/payments/types';
import { computeRecoveryRecommendation } from '../src/domain/recovery/recoveryDecisionEngine';

const examplePayment: FailedPayment = {
  paymentId: 'pay_demo001' as FailedPayment['paymentId'],
  customerId: 'cust_demo001' as FailedPayment['customerId'],
  customerName: 'Priya Sharma',
  amount: 149900,
  currency: 'INR',
  paymentMethod: 'UPI',
  failureReason: 'UPI_TIMEOUT',
  attemptCount: 1,
  previousSuccessfulPayments: 7,
  lastAttemptAt: '2024-06-01T14:22:00.000Z',
  failedAt: '2024-06-01T14:22:30.000Z',
};

const recommendation = computeRecoveryRecommendation(examplePayment);

console.log('\n=== Recovery Decision Engine — Example Output ===\n');
console.log('Input payment:');
console.log(`  ID:              ${examplePayment.paymentId}`);
console.log(`  Customer:        ${examplePayment.customerName}`);
console.log(`  Amount:          ₹${(examplePayment.amount / 100).toFixed(2)}`);
console.log(`  Method:          ${examplePayment.paymentMethod}`);
console.log(`  Failure:         ${examplePayment.failureReason}`);
console.log(`  Attempts:        ${examplePayment.attemptCount}`);
console.log(`  Prior successes: ${examplePayment.previousSuccessfulPayments}`);
console.log('\nRecommendation:');
console.log(`  Action:          ${recommendation.recommendedAction}`);
console.log(`  Retry after:     ${recommendation.retryAfterMinutes != null ? `${recommendation.retryAfterMinutes} minutes` : 'N/A'}`);
console.log(`  Confidence:      ${(recommendation.confidence * 100).toFixed(1)}%`);
console.log(`  Max attempts:    ${recommendation.maxAttempts}`);
console.log(`  Diagnosis:       ${recommendation.diagnosis}`);
console.log(`  Reasoning:       ${recommendation.reasoning}`);
console.log('');
