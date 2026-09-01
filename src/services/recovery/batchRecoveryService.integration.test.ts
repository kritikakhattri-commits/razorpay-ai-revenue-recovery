/**
 * Integration tests: 40 FailedPayments → BatchRecoveryService (full pipeline)
 *
 * Wires: FailedPayment → RecoveryDecisionEngine → PolicyEngine →
 *        SimulatedRecoveryActionExecutor → AuditLogger → RecoveryOrchestrator →
 *        BatchRecoveryService
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFailedPayments } from '../../lib/failedPaymentLoader';
import { computeRecoveryRecommendation } from '../../domain/recovery/recoveryDecisionEngine';
import { evaluatePolicy } from '../../domain/policy/policyEngine';
import { SimulatedRecoveryActionExecutor } from '../../domain/executor/simulatedRecoveryActionExecutor';
import { InMemoryAuditStore } from '../../domain/audit/inMemoryAuditStore';
import { AuditLogger } from '../audit/auditLogger';
import { RecoveryOrchestrator } from './recoveryOrchestrator';
import { BatchRecoveryService } from './batchRecoveryService';
import type { BatchRecoveryResult } from './types';

function makePipeline() {
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
  return { service: new BatchRecoveryService(orchestrator), store };
}

// ---------------------------------------------------------------------------
// Dataset-wide run — executed once for all assertions
// ---------------------------------------------------------------------------

describe('BatchRecoveryService — 40-payment integration', () => {
  let result: BatchRecoveryResult;

  beforeAll(() => {
    const payments = loadFailedPayments();
    const { service } = makePipeline();
    result = service.process(payments);
  });

  it('returns exactly 40 RecoveryCases', () => {
    expect(result.cases).toHaveLength(40);
  });

  it('totalPayments is 40', () => {
    expect(result.totalPayments).toBe(40);
  });

  // -------------------------------------------------------------------------
  // Amount reconciliation
  // -------------------------------------------------------------------------

  it('totalRevenueAtRisk equals sum of all payment amounts', () => {
    const payments = loadFailedPayments();
    const expected = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(result.totalRevenueAtRisk).toBe(expected);
  });

  it('totalRecoveredRevenue equals sum of all case recoveredAmounts', () => {
    const expected = result.cases.reduce((sum, c) => sum + c.recoveredAmount, 0);
    expect(result.totalRecoveredRevenue).toBe(expected);
  });

  it('recovered revenue never exceeds revenue at risk', () => {
    expect(result.totalRecoveredRevenue).toBeLessThanOrEqual(result.totalRevenueAtRisk);
  });

  it('recoveryRate is between 0 and 1 inclusive', () => {
    expect(result.recoveryRate).toBeGreaterThanOrEqual(0);
    expect(result.recoveryRate).toBeLessThanOrEqual(1);
  });

  it('recoveryRate equals totalRecoveredRevenue / totalRevenueAtRisk', () => {
    const expected = result.totalRecoveredRevenue / result.totalRevenueAtRisk;
    expect(result.recoveryRate).toBeCloseTo(expected, 10);
  });

  // -------------------------------------------------------------------------
  // Status count reconciliation
  // -------------------------------------------------------------------------

  it('sum of all status counts equals totalPayments', () => {
    const countSum =
      result.recoveredPaymentCount +
      result.failedRecoveryCount +
      result.pendingPaymentCount +
      result.escalatedPaymentCount +
      result.blockedPaymentCount;
    expect(countSum).toBe(result.totalPayments);
  });

  it('status counts match individual case statuses', () => {
    let recovered = 0;
    let failed = 0;
    let pending = 0;
    let escalated = 0;
    let blocked = 0;

    for (const c of result.cases) {
      switch (c.executionResult.status) {
        case 'RECOVERED': recovered++; break;
        case 'FAILED': failed++; break;
        case 'PENDING': pending++; break;
        case 'ESCALATED': escalated++; break;
        case 'BLOCKED': blocked++; break;
      }
    }

    expect(result.recoveredPaymentCount).toBe(recovered);
    expect(result.failedRecoveryCount).toBe(failed);
    expect(result.pendingPaymentCount).toBe(pending);
    expect(result.escalatedPaymentCount).toBe(escalated);
    expect(result.blockedPaymentCount).toBe(blocked);
  });

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  it('every RecoveryCase has at least one audit entry', () => {
    for (const c of result.cases) {
      expect(c.auditEntries.length).toBeGreaterThan(0);
    }
  });

  it('every audit trail starts with PAYMENT_FAILED', () => {
    for (const c of result.cases) {
      expect(c.auditEntries[0].eventType).toBe('PAYMENT_FAILED');
    }
  });

  it('all audit entries in a case carry the correct paymentId', () => {
    for (const c of result.cases) {
      for (const entry of c.auditEntries) {
        expect(entry.paymentId).toBe(c.payment.paymentId);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Safety invariants
  // -------------------------------------------------------------------------

  it('no rejected policy decision produces an ACTION_EXECUTED audit event', () => {
    for (const c of result.cases) {
      if (!c.policyDecision.approved) {
        const eventTypes = c.auditEntries.map((e) => e.eventType);
        expect(eventTypes).not.toContain('ACTION_EXECUTED');
      }
    }
  });

  it('every RECOVERED case has recoveredAmount equal to payment.amount', () => {
    for (const c of result.cases) {
      if (c.executionResult.status === 'RECOVERED') {
        expect(c.recoveredAmount).toBe(c.payment.amount);
      }
    }
  });

  it('every non-recovered case has recoveredAmount of 0', () => {
    for (const c of result.cases) {
      if (c.executionResult.status !== 'RECOVERED') {
        expect(c.recoveredAmount).toBe(0);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------

  it('cases are returned in the same order as the input payments', () => {
    const payments = loadFailedPayments();
    for (let i = 0; i < payments.length; i++) {
      expect(result.cases[i].payment.paymentId).toBe(payments[i].paymentId);
    }
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it('input payments are not mutated during batch processing', () => {
    const payments = loadFailedPayments();
    const snapshots = payments.map((p) => JSON.stringify(p));
    const { service } = makePipeline();
    service.process(payments);
    payments.forEach((p, i) => {
      expect(JSON.stringify(p)).toBe(snapshots[i]);
    });
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  it('produces identical batch metrics on a second run with the same inputs', () => {
    const payments = loadFailedPayments();

    const { service: service1 } = makePipeline();
    const result1 = service1.process(payments);

    const { service: service2 } = makePipeline();
    const result2 = service2.process(payments);

    expect(result1.totalPayments).toBe(result2.totalPayments);
    expect(result1.totalRevenueAtRisk).toBe(result2.totalRevenueAtRisk);
    expect(result1.totalRecoveredRevenue).toBe(result2.totalRecoveredRevenue);
    expect(result1.recoveryRate).toBe(result2.recoveryRate);
    expect(result1.recoveredPaymentCount).toBe(result2.recoveredPaymentCount);
    expect(result1.failedRecoveryCount).toBe(result2.failedRecoveryCount);
    expect(result1.pendingPaymentCount).toBe(result2.pendingPaymentCount);
    expect(result1.escalatedPaymentCount).toBe(result2.escalatedPaymentCount);
    expect(result1.blockedPaymentCount).toBe(result2.blockedPaymentCount);

    for (let i = 0; i < result1.cases.length; i++) {
      expect(result1.cases[i].executionResult.status).toBe(result2.cases[i].executionResult.status);
      expect(result1.cases[i].recoveredAmount).toBe(result2.cases[i].recoveredAmount);
    }
  });
});
