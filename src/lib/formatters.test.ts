import { describe, it, expect } from 'vitest';
import {
  formatPaise,
  formatCompactPaise,
  formatPercent,
  formatConfidence,
  formatAction,
  formatFailureReason,
  formatPaymentMethod,
} from './formatters';

describe('formatPaise', () => {
  it('converts 2499 paise to ₹24.99', () => {
    expect(formatPaise(2499)).toBe('₹24.99');
  });

  it('converts 5000 paise to ₹50.00', () => {
    expect(formatPaise(5000)).toBe('₹50.00');
  });

  it('converts 250050 paise to ₹2,500.50', () => {
    expect(formatPaise(250050)).toBe('₹2,500.50');
  });

  it('converts 0 paise to ₹0.00', () => {
    expect(formatPaise(0)).toBe('₹0.00');
  });

  it('converts 100 paise to ₹1.00', () => {
    expect(formatPaise(100)).toBe('₹1.00');
  });

  it('converts 10000000 paise to ₹1,00,000.00 (lakh)', () => {
    const result = formatPaise(10000000);
    expect(result.startsWith('₹')).toBe(true);
    expect(result).toContain('1,00,000.00');
  });
});

describe('formatCompactPaise', () => {
  it('keeps small exact rupee values readable', () => {
    expect(formatCompactPaise(8880)).toBe('₹88.80');
  });

  it('formats dashboard thousands as compact K values', () => {
    expect(formatCompactPaise(8880000)).toBe('₹88.8K');
  });

  it('formats smaller dashboard thousands as compact K values', () => {
    expect(formatCompactPaise(1480000)).toBe('₹14.8K');
  });

  it('formats dashboard lakh values compactly', () => {
    expect(formatCompactPaise(12200000)).toBe('₹1.22L');
  });

  it('formats larger lakh values without unnecessary decimals', () => {
    expect(formatCompactPaise(148000000)).toBe('₹14.8L');
  });
});

describe('formatPercent', () => {
  it('formats 0 as 0.00%', () => {
    expect(formatPercent(0)).toBe('0.00%');
  });

  it('formats 1 as 100.00%', () => {
    expect(formatPercent(1)).toBe('100.00%');
  });

  it('formats 0.2511 as 25.11%', () => {
    expect(formatPercent(0.2511)).toBe('25.11%');
  });

  it('formats 0.5 as 50.00%', () => {
    expect(formatPercent(0.5)).toBe('50.00%');
  });
});

describe('formatConfidence', () => {
  it('formats 0.8 as 80%', () => {
    expect(formatConfidence(0.8)).toBe('80%');
  });

  it('formats 0.625 as 63%', () => {
    expect(formatConfidence(0.625)).toBe('63%');
  });

  it('formats 1 as 100%', () => {
    expect(formatConfidence(1)).toBe('100%');
  });

  it('formats 0 as 0%', () => {
    expect(formatConfidence(0)).toBe('0%');
  });

  it('rounds 0.555 to 56%', () => {
    expect(formatConfidence(0.555)).toBe('56%');
  });
});

describe('formatAction', () => {
  it('formats RETRY_LATER as Retry Later', () => {
    expect(formatAction('RETRY_LATER')).toBe('Retry Later');
  });

  it('formats SEND_PAYMENT_LINK as Payment Link', () => {
    expect(formatAction('SEND_PAYMENT_LINK')).toBe('Payment Link');
  });

  it('formats UPDATE_PAYMENT_METHOD as Update Method', () => {
    expect(formatAction('UPDATE_PAYMENT_METHOD')).toBe('Update Method');
  });

  it('formats ESCALATE as Escalate', () => {
    expect(formatAction('ESCALATE')).toBe('Escalate');
  });

  it('returns unknown actions unchanged', () => {
    expect(formatAction('UNKNOWN_ACTION')).toBe('UNKNOWN_ACTION');
  });
});

describe('formatFailureReason', () => {
  it('formats INSUFFICIENT_BALANCE', () => {
    expect(formatFailureReason('INSUFFICIENT_BALANCE')).toBe('Insufficient Balance');
  });

  it('formats UPI_TIMEOUT', () => {
    expect(formatFailureReason('UPI_TIMEOUT')).toBe('UPI Timeout');
  });

  it('formats BANK_SERVER_ERROR', () => {
    expect(formatFailureReason('BANK_SERVER_ERROR')).toBe('Bank Server Error');
  });

  it('formats EXPIRED_CARD', () => {
    expect(formatFailureReason('EXPIRED_CARD')).toBe('Expired Card');
  });

  it('formats AUTHENTICATION_FAILED', () => {
    expect(formatFailureReason('AUTHENTICATION_FAILED')).toBe('Auth Failed');
  });

  it('formats CUSTOMER_ABANDONED', () => {
    expect(formatFailureReason('CUSTOMER_ABANDONED')).toBe('Abandoned');
  });

  it('returns unknown reasons unchanged', () => {
    expect(formatFailureReason('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('formatPaymentMethod', () => {
  it('formats UPI as UPI', () => {
    expect(formatPaymentMethod('UPI')).toBe('UPI');
  });

  it('formats CARD as Card', () => {
    expect(formatPaymentMethod('CARD')).toBe('Card');
  });

  it('formats NETBANKING as Net Banking', () => {
    expect(formatPaymentMethod('NETBANKING')).toBe('Net Banking');
  });

  it('formats WALLET as Wallet', () => {
    expect(formatPaymentMethod('WALLET')).toBe('Wallet');
  });

  it('returns unknown methods unchanged', () => {
    expect(formatPaymentMethod('CRYPTO')).toBe('CRYPTO');
  });
});
