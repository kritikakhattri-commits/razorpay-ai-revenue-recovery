import { describe, it, expect } from 'vitest';
import { parseFailedPayment } from './validator';

const validInput = {
  paymentId: 'pay_123abc',
  customerId: 'cust_456def',
  customerName: 'Priya Sharma',
  amount: 50000,
  currency: 'INR',
  paymentMethod: 'UPI',
  failureReason: 'INSUFFICIENT_BALANCE',
  attemptCount: 1,
  previousSuccessfulPayments: 3,
  lastAttemptAt: '2024-01-15T10:30:00.000Z',
  failedAt: '2024-01-15T10:30:05.123Z',
};

describe('parseFailedPayment', () => {
  describe('valid input', () => {
    it('accepts a fully valid payment', () => {
      const result = parseFailedPayment(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paymentId).toBe('pay_123abc');
        expect(result.data.currency).toBe('INR');
        expect(result.data.paymentMethod).toBe('UPI');
        expect(result.data.failureReason).toBe('INSUFFICIENT_BALANCE');
      }
    });

    it('accepts attemptCount of 0', () => {
      const result = parseFailedPayment({ ...validInput, attemptCount: 0 });
      expect(result.success).toBe(true);
    });

    it('accepts previousSuccessfulPayments of 0', () => {
      const result = parseFailedPayment({ ...validInput, previousSuccessfulPayments: 0 });
      expect(result.success).toBe(true);
    });

    it.each(['UPI', 'CARD', 'NETBANKING', 'WALLET'] as const)(
      'accepts paymentMethod %s',
      (method) => {
        const result = parseFailedPayment({ ...validInput, paymentMethod: method });
        expect(result.success).toBe(true);
      },
    );

    it.each([
      'INSUFFICIENT_BALANCE',
      'UPI_TIMEOUT',
      'BANK_SERVER_ERROR',
      'EXPIRED_CARD',
      'AUTHENTICATION_FAILED',
      'CUSTOMER_ABANDONED',
    ] as const)('accepts failureReason %s', (reason) => {
      const result = parseFailedPayment({ ...validInput, failureReason: reason });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid amount', () => {
    it('rejects amount of 0', () => {
      const result = parseFailedPayment({ ...validInput, amount: 0 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'amount')).toBe(true);
      }
    });

    it('rejects negative amount', () => {
      const result = parseFailedPayment({ ...validInput, amount: -100 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'amount')).toBe(true);
      }
    });

    it('rejects fractional amount', () => {
      const result = parseFailedPayment({ ...validInput, amount: 50.5 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'amount')).toBe(true);
      }
    });

    it('rejects string amount', () => {
      const result = parseFailedPayment({ ...validInput, amount: '500' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'amount')).toBe(true);
      }
    });
  });

  describe('invalid payment method', () => {
    it('rejects unknown payment method', () => {
      const result = parseFailedPayment({ ...validInput, paymentMethod: 'CREDIT_CARD' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'paymentMethod')).toBe(true);
      }
    });

    it('rejects lowercase payment method', () => {
      const result = parseFailedPayment({ ...validInput, paymentMethod: 'upi' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'paymentMethod')).toBe(true);
      }
    });
  });

  describe('invalid failure reason', () => {
    it('rejects unknown failure reason', () => {
      const result = parseFailedPayment({ ...validInput, failureReason: 'NETWORK_ERROR' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'failureReason')).toBe(true);
      }
    });

    it('rejects lowercase failure reason', () => {
      const result = parseFailedPayment({ ...validInput, failureReason: 'insufficient_balance' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'failureReason')).toBe(true);
      }
    });
  });

  describe('invalid timestamp', () => {
    it('rejects plain date string for lastAttemptAt', () => {
      const result = parseFailedPayment({ ...validInput, lastAttemptAt: '2024-01-15' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'lastAttemptAt')).toBe(true);
      }
    });

    it('rejects human-readable date for failedAt', () => {
      const result = parseFailedPayment({ ...validInput, failedAt: 'January 15, 2024' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'failedAt')).toBe(true);
      }
    });

    it('rejects unix epoch number for lastAttemptAt', () => {
      const result = parseFailedPayment({ ...validInput, lastAttemptAt: 1705315800000 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'lastAttemptAt')).toBe(true);
      }
    });

    it('rejects invalid date string for failedAt', () => {
      const result = parseFailedPayment({ ...validInput, failedAt: 'not-a-date' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'failedAt')).toBe(true);
      }
    });
  });

  describe('missing required fields', () => {
    it('rejects missing paymentId', () => {
      const input = Object.fromEntries(
        Object.entries(validInput).filter(([k]) => k !== 'paymentId'),
      );
      const result = parseFailedPayment(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'paymentId')).toBe(true);
      }
    });

    it('rejects missing customerId', () => {
      const input = Object.fromEntries(
        Object.entries(validInput).filter(([k]) => k !== 'customerId'),
      );
      const result = parseFailedPayment(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'customerId')).toBe(true);
      }
    });

    it('rejects missing customerName', () => {
      const input = Object.fromEntries(
        Object.entries(validInput).filter(([k]) => k !== 'customerName'),
      );
      const result = parseFailedPayment(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'customerName')).toBe(true);
      }
    });

    it('rejects empty string paymentId', () => {
      const result = parseFailedPayment({ ...validInput, paymentId: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'paymentId')).toBe(true);
      }
    });

    it('rejects whitespace-only customerName', () => {
      const result = parseFailedPayment({ ...validInput, customerName: '   ' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.field === 'customerName')).toBe(true);
      }
    });
  });

  describe('non-object input', () => {
    it('rejects null', () => {
      const result = parseFailedPayment(null);
      expect(result.success).toBe(false);
    });

    it('rejects a string', () => {
      const result = parseFailedPayment('not an object');
      expect(result.success).toBe(false);
    });

    it('rejects an array', () => {
      const result = parseFailedPayment([validInput]);
      expect(result.success).toBe(false);
    });
  });

  describe('error accumulation', () => {
    it('returns all errors when multiple fields are invalid', () => {
      const result = parseFailedPayment({
        ...validInput,
        amount: -1,
        paymentMethod: 'INVALID',
        failureReason: 'UNKNOWN',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
