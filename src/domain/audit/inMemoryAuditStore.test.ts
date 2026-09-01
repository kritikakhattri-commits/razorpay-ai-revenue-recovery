import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditStore } from './inMemoryAuditStore';
import type { AuditEntry } from './types';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    auditId: 'audit_1',
    paymentId: 'pay_001',
    eventType: 'PAYMENT_FAILED',
    timestamp: '2025-06-01T10:00:00.000Z',
    message: 'Payment failed with UPI_TIMEOUT.',
    metadata: { failureReason: 'UPI_TIMEOUT' },
    ...overrides,
  };
}

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore;

  beforeEach(() => {
    store = new InMemoryAuditStore();
  });

  describe('append', () => {
    it('stores an entry retrievable via getAll', () => {
      const entry = makeEntry();
      store.append(entry);
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0]).toEqual(entry);
    });

    it('stores multiple entries without dropping any', () => {
      store.append(makeEntry({ auditId: 'a1', paymentId: 'pay_001' }));
      store.append(makeEntry({ auditId: 'a2', paymentId: 'pay_001' }));
      store.append(makeEntry({ auditId: 'a3', paymentId: 'pay_002' }));
      expect(store.getAll()).toHaveLength(3);
    });

    it('does not store a reference to the input — mutating input after append does not affect stored entry', () => {
      const entry = makeEntry({ metadata: { key: 'original' } });
      store.append(entry);
      entry.metadata['key'] = 'mutated';
      expect(store.getAll()[0].metadata['key']).toBe('original');
    });
  });

  describe('getAll', () => {
    it('returns entries in insertion order', () => {
      store.append(makeEntry({ auditId: 'a1', eventType: 'PAYMENT_FAILED' }));
      store.append(makeEntry({ auditId: 'a2', eventType: 'RECOVERY_RECOMMENDED' }));
      store.append(makeEntry({ auditId: 'a3', eventType: 'POLICY_APPROVED' }));
      const all = store.getAll();
      expect(all[0].eventType).toBe('PAYMENT_FAILED');
      expect(all[1].eventType).toBe('RECOVERY_RECOMMENDED');
      expect(all[2].eventType).toBe('POLICY_APPROVED');
    });

    it('returns an empty array when no entries have been appended', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('returns a new array on each call — internal storage is not exposed', () => {
      store.append(makeEntry());
      const r1 = store.getAll();
      const r2 = store.getAll();
      expect(r1).not.toBe(r2);
    });

    it('mutating a returned entry does not affect the stored entry', () => {
      store.append(makeEntry({ message: 'original message' }));
      const results = store.getAll();
      results[0].message = 'mutated';
      expect(store.getAll()[0].message).toBe('original message');
    });

    it('mutating a returned entry metadata does not affect stored metadata', () => {
      store.append(makeEntry({ metadata: { key: 'original' } }));
      const results = store.getAll();
      results[0].metadata['key'] = 'mutated';
      expect(store.getAll()[0].metadata['key']).toBe('original');
    });
  });

  describe('getByPaymentId', () => {
    it('returns only entries whose paymentId matches', () => {
      store.append(makeEntry({ auditId: 'a1', paymentId: 'pay_001' }));
      store.append(makeEntry({ auditId: 'a2', paymentId: 'pay_002' }));
      store.append(makeEntry({ auditId: 'a3', paymentId: 'pay_001' }));
      const results = store.getByPaymentId('pay_001');
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.paymentId === 'pay_001')).toBe(true);
    });

    it('returns an empty array when no entries match', () => {
      store.append(makeEntry({ paymentId: 'pay_001' }));
      expect(store.getByPaymentId('pay_unknown')).toEqual([]);
    });

    it('preserves insertion order for entries of the same paymentId', () => {
      store.append(makeEntry({ auditId: 'a1', paymentId: 'pay_001', eventType: 'PAYMENT_FAILED' }));
      store.append(makeEntry({ auditId: 'a2', paymentId: 'pay_002', eventType: 'PAYMENT_FAILED' }));
      store.append(makeEntry({ auditId: 'a3', paymentId: 'pay_001', eventType: 'RECOVERY_RECOMMENDED' }));
      const results = store.getByPaymentId('pay_001');
      expect(results[0].eventType).toBe('PAYMENT_FAILED');
      expect(results[1].eventType).toBe('RECOVERY_RECOMMENDED');
    });

    it('mutating a returned entry does not affect stored entries', () => {
      store.append(makeEntry({ paymentId: 'pay_001', message: 'original' }));
      const results = store.getByPaymentId('pay_001');
      results[0].message = 'mutated';
      expect(store.getByPaymentId('pay_001')[0].message).toBe('original');
    });

    it('returns a new array on each call', () => {
      store.append(makeEntry({ paymentId: 'pay_001' }));
      expect(store.getByPaymentId('pay_001')).not.toBe(store.getByPaymentId('pay_001'));
    });
  });
});
