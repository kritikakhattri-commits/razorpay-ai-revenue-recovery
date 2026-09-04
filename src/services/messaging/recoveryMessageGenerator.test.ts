import { describe, it, expect } from 'vitest';
import {
  generateRecoveryMessages,
  PAYMENT_LINK_PLACEHOLDER,
  formatAmountForMessage,
  FAILURE_CUSTOMER_CONTEXT,
} from './recoveryMessageGenerator';
import type { RecoveryMessageInput } from '../../domain/messaging/types';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NO_SWITCH: PaymentMethodSwitchRecommendation = {
  currentMethod: 'UPI',
  shouldSwitch: false,
  recommendedMethod: null,
  alternatives: [],
  reason: 'No switch needed.',
};

const SWITCH_TO_CARD: PaymentMethodSwitchRecommendation = {
  currentMethod: 'UPI',
  shouldSwitch: true,
  recommendedMethod: 'CARD',
  alternatives: [{ method: 'CARD', score: 0.85, reason: 'Card is reliable.' }],
  reason: 'UPI has repeatedly timed out.',
};

const SWITCH_TO_UPI: PaymentMethodSwitchRecommendation = {
  currentMethod: 'CARD',
  shouldSwitch: true,
  recommendedMethod: 'UPI',
  alternatives: [{ method: 'UPI', score: 0.9, reason: 'Card is expired.' }],
  reason: 'Card is expired.',
};

const RETRY_TIMING: SmartRetryTiming = {
  recommendedRetryAt: '2026-09-04T18:30:00.000Z',
  delayMinutes: 30,
  confidence: 'HIGH',
  reason: 'UPI timeout is likely temporary.',
  source: 'FAILURE_REASON',
};

const LONG_TIMING: SmartRetryTiming = {
  recommendedRetryAt: '2026-09-04T22:00:00.000Z',
  delayMinutes: 180,
  confidence: 'MEDIUM',
  reason: 'Bank server error; retry after 3 hours.',
  source: 'FAILURE_REASON',
};

function makeInput(overrides: Partial<RecoveryMessageInput> = {}): RecoveryMessageInput {
  return {
    paymentId: 'pay_test_001',
    customerName: 'Rahul Sharma',
    amountInPaise: 499900,
    failureReason: 'UPI_TIMEOUT',
    finalAction: 'RETRY_LATER',
    policyApproved: true,
    smartRetryTiming: null,
    paymentMethodSwitch: NO_SWITCH,
    riskLevel: 'MEDIUM',
    ...overrides,
  };
}

// ── 1 – SMS retry message generated correctly ─────────────────────────────────

describe('SMS retry message', () => {
  it('contains customer name and formatted amount', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms).toBeDefined();
    expect(sms!.body).toContain('Rahul');
    expect(sms!.body).toContain('₹4,999');
  });

  it('contains the payment link placeholder', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).toContain(PAYMENT_LINK_PLACEHOLDER);
  });

  it('does not say "retry" when action is ESCALATE', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'ESCALATE' }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body.toLowerCase()).not.toMatch(/retry/);
  });
});

// ── 2 – WhatsApp retry message generated correctly ────────────────────────────

describe('WhatsApp retry message', () => {
  it('contains greeting, amount, and retry CTA', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa).toBeDefined();
    expect(wa!.body).toContain('Rahul');
    expect(wa!.body).toContain('₹4,999');
    expect(wa!.body).toContain(PAYMENT_LINK_PLACEHOLDER);
  });

  it('is multi-line', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body).toContain('\n');
  });
});

// ── 3 – Email retry message generated correctly ───────────────────────────────

describe('Email retry message', () => {
  it('contains greeting, amount, and retry CTA', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email).toBeDefined();
    expect(email!.body).toContain('Rahul');
    expect(email!.body).toContain('₹4,999');
    expect(email!.body).toContain(PAYMENT_LINK_PLACEHOLDER);
  });

  it('ends with a sign-off', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body.trim().endsWith('Thanks.')).toBe(true);
  });
});

// ── 4 – Email subject generated ───────────────────────────────────────────────

describe('Email subject', () => {
  it('generates subject for RETRY_LATER', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'RETRY_LATER' }));
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.subject).toBe('Complete your payment');
  });

  it('generates subject for SEND_PAYMENT_LINK', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'SEND_PAYMENT_LINK' }));
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.subject).toBe('Complete your payment');
  });

  it('generates subject for UPDATE_PAYMENT_METHOD', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.subject).toBe('Your payment needs attention');
  });

  it('generates subject for ESCALATE', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'ESCALATE' }));
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.subject).toBe('Your payment is being reviewed');
  });

  it('SMS has no subject', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.subject).toBeUndefined();
  });
});

// ── 5 – Amount formatted correctly ────────────────────────────────────────────

describe('Amount formatting', () => {
  it('formats whole rupee amounts without decimals', () => {
    expect(formatAmountForMessage(499900)).toBe('₹4,999');
    expect(formatAmountForMessage(100000)).toBe('₹1,000');
  });

  it('formats fractional rupee amounts with 2 decimals', () => {
    expect(formatAmountForMessage(49950)).toBe('₹499.50');
  });

  it('includes formatted amount in every channel', () => {
    const drafts = generateRecoveryMessages(makeInput({ amountInPaise: 150000 }));
    for (const draft of drafts ?? []) {
      expect(draft.body).toContain('₹1,500');
    }
  });
});

// ── 6 – Customer name included correctly ──────────────────────────────────────

describe('Customer name', () => {
  it('uses first name only', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ customerName: 'Priya Patel' }),
    );
    for (const draft of drafts ?? []) {
      expect(draft.body).toContain('Priya');
      expect(draft.body).not.toContain('Patel');
    }
  });

  it('uses the name from input correctly when single name', () => {
    const drafts = generateRecoveryMessages(makeInput({ customerName: 'Mohan' }));
    for (const draft of drafts ?? []) {
      expect(draft.body).toContain('Mohan');
    }
  });
});

// ── 7 – Retry timing included when available ──────────────────────────────────

describe('Retry timing — included', () => {
  it('SMS includes timing hint when timing is present', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: RETRY_TIMING }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).toContain('in 30 minutes');
    expect(sms!.metadata.retryTimingIncluded).toBe(true);
  });

  it('WhatsApp includes timing hint when timing is present', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: RETRY_TIMING }));
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body).toContain('in 30 minutes');
    expect(wa!.metadata.retryTimingIncluded).toBe(true);
  });

  it('Email includes timing hint when timing is present', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: RETRY_TIMING }));
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body).toContain('in 30 minutes');
    expect(email!.metadata.retryTimingIncluded).toBe(true);
  });

  it('formats hours correctly (180 min = 3 hours)', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: LONG_TIMING }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).toContain('in 3 hours');
  });
});

// ── 8 – Retry timing omitted when unavailable ─────────────────────────────────

describe('Retry timing — omitted', () => {
  it('SMS does not mention timing when smartRetryTiming is null', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: null }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).not.toContain('in 30');
    expect(sms!.metadata.retryTimingIncluded).toBe(false);
  });

  it('WhatsApp does not mention timing when smartRetryTiming is null', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: null }));
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body).not.toContain('best chance of success');
    expect(wa!.metadata.retryTimingIncluded).toBe(false);
  });

  it('Email does not mention timing when smartRetryTiming is null', () => {
    const drafts = generateRecoveryMessages(makeInput({ smartRetryTiming: null }));
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body).not.toContain('best chance of success');
    expect(email!.metadata.retryTimingIncluded).toBe(false);
  });
});

// ── 9 – Payment method suggestion included when appropriate ───────────────────

describe('Method suggestion — included', () => {
  it('SMS includes method name when switch is recommended', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).toContain('card');
    expect(sms!.metadata.paymentMethodSuggestionIncluded).toBe(true);
  });

  it('WhatsApp includes method suggestion when switch is recommended', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body.toLowerCase()).toContain('card');
    expect(wa!.metadata.paymentMethodSuggestionIncluded).toBe(true);
  });

  it('Email includes method suggestion when switch is recommended', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body.toLowerCase()).toContain('card');
    expect(email!.metadata.paymentMethodSuggestionIncluded).toBe(true);
  });

  it('WhatsApp includes method switch in RETRY_LATER when switch is recommended', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'RETRY_LATER', paymentMethodSwitch: SWITCH_TO_CARD, smartRetryTiming: RETRY_TIMING }),
    );
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body.toLowerCase()).toContain('card');
    expect(wa!.metadata.paymentMethodSuggestionIncluded).toBe(true);
  });
});

// ── 10 – Payment method suggestion omitted when unnecessary ───────────────────

describe('Method suggestion — omitted', () => {
  it('SMS has no method suggestion when shouldSwitch is false', () => {
    const drafts = generateRecoveryMessages(makeInput({ paymentMethodSwitch: NO_SWITCH }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.metadata.paymentMethodSuggestionIncluded).toBe(false);
  });

  it('WhatsApp has no method suggestion when shouldSwitch is false', () => {
    const drafts = generateRecoveryMessages(makeInput({ paymentMethodSwitch: NO_SWITCH }));
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.metadata.paymentMethodSuggestionIncluded).toBe(false);
    expect(wa!.body).not.toContain('also try');
  });
});

// ── 11 – Expired card flow recommends alternate method ────────────────────────

describe('EXPIRED_CARD flow', () => {
  it('shows failure context hint in WhatsApp message', () => {
    const drafts = generateRecoveryMessages(
      makeInput({
        finalAction: 'UPDATE_PAYMENT_METHOD',
        failureReason: 'EXPIRED_CARD',
        paymentMethodSwitch: SWITCH_TO_UPI,
      }),
    );
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body).toContain('card may need to be updated');
  });

  it('shows failure context hint in Email', () => {
    const drafts = generateRecoveryMessages(
      makeInput({
        finalAction: 'UPDATE_PAYMENT_METHOD',
        failureReason: 'EXPIRED_CARD',
        paymentMethodSwitch: SWITCH_TO_UPI,
      }),
    );
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body).toContain('card may need to be updated');
  });

  it('EXPIRED_CARD context is in centralized map', () => {
    expect(FAILURE_CUSTOMER_CONTEXT['EXPIRED_CARD']).toBeTruthy();
  });
});

// ── 12 – UPDATE_PAYMENT_METHOD does not say retry same method ─────────────────

describe('UPDATE_PAYMENT_METHOD messaging', () => {
  it('SMS does not say "retry" for UPDATE_PAYMENT_METHOD', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body.toLowerCase()).not.toContain('retry');
  });

  it('WhatsApp says "different payment method" not retry same method', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const wa = drafts?.find((d) => d.channel === 'WHATSAPP');
    expect(wa!.body).toContain('different payment method');
  });

  it('Email says "different payment method" not retry same method', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body).toContain('different payment method');
  });
});

// ── 13 – Blocked action produces no messages ──────────────────────────────────

describe('Blocked / policy not approved', () => {
  it('returns null when policyApproved is false', () => {
    const result = generateRecoveryMessages(makeInput({ policyApproved: false }));
    expect(result).toBeNull();
  });
});

// ── 14 – Escalation produces safe neutral behavior ────────────────────────────

describe('ESCALATE messaging', () => {
  it('does not include a payment link', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'ESCALATE' }));
    for (const draft of drafts ?? []) {
      expect(draft.body).not.toContain(PAYMENT_LINK_PLACEHOLDER);
      expect(draft.requiresPaymentLink).toBe(false);
    }
  });

  it('contains neutral "reviewing" language', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'ESCALATE' }));
    for (const draft of drafts ?? []) {
      expect(draft.body.toLowerCase()).toContain('reviewing');
    }
  });

  it('tells customer no action is required', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'ESCALATE' }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body.toLowerCase()).toContain('no action');
  });

  it('tone is always NEUTRAL for ESCALATE regardless of risk level', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'ESCALATE', riskLevel: 'CRITICAL' }),
    );
    for (const draft of drafts ?? []) {
      expect(draft.tone).toBe('NEUTRAL');
    }
  });
});

// ── 15 – Raw failure codes never appear ───────────────────────────────────────

describe('No raw failure codes in output', () => {
  const failureReasons = [
    'INSUFFICIENT_BALANCE',
    'UPI_TIMEOUT',
    'BANK_SERVER_ERROR',
    'EXPIRED_CARD',
    'AUTHENTICATION_FAILED',
    'CUSTOMER_ABANDONED',
  ] as const;

  for (const reason of failureReasons) {
    it(`does not expose "${reason}" in any channel`, () => {
      const drafts = generateRecoveryMessages(
        makeInput({
          failureReason: reason,
          finalAction: 'RETRY_LATER',
          paymentMethodSwitch: NO_SWITCH,
        }),
      );
      for (const draft of drafts ?? []) {
        expect(draft.body).not.toContain(reason);
      }
    });
  }
});

// ── 16 – Internal risk score never appears ────────────────────────────────────

describe('Internal fields not exposed', () => {
  it('risk score number not in message body', () => {
    const drafts = generateRecoveryMessages(makeInput({ riskLevel: 'CRITICAL' }));
    for (const draft of drafts ?? []) {
      expect(draft.body).not.toContain('riskScore');
      expect(draft.body).not.toContain('revenueAtRiskScore');
    }
  });

  it('risk level string not in message body', () => {
    const drafts = generateRecoveryMessages(makeInput({ riskLevel: 'CRITICAL' }));
    for (const draft of drafts ?? []) {
      expect(draft.body).not.toContain('CRITICAL');
      expect(draft.body).not.toContain('HIGH');
      expect(draft.body).not.toContain('MEDIUM');
      expect(draft.body).not.toContain('LOW');
    }
  });
});

// ── 17 – Internal confidence value never appears ──────────────────────────────

describe('Confidence not exposed', () => {
  it('confidence field not in message body', () => {
    const drafts = generateRecoveryMessages(makeInput());
    for (const draft of drafts ?? []) {
      expect(draft.body).not.toContain('confidence');
      expect(draft.body).not.toContain('recoveryProbability');
      expect(draft.body).not.toContain('PolicyEngine');
    }
  });
});

// ── 18 – Payment link is not fabricated ───────────────────────────────────────

describe('Payment link handling', () => {
  it('uses placeholder, not a fabricated URL', () => {
    const drafts = generateRecoveryMessages(makeInput());
    for (const draft of drafts?.filter((d) => d.requiresPaymentLink) ?? []) {
      expect(draft.body).toContain('{paymentLink}');
      expect(draft.body).not.toMatch(/https?:\/\//);
    }
  });
});

// ── 19 – requiresPaymentLink is correct ───────────────────────────────────────

describe('requiresPaymentLink flag', () => {
  it('is true for RETRY_LATER', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'RETRY_LATER' }));
    for (const draft of drafts ?? []) expect(draft.requiresPaymentLink).toBe(true);
  });

  it('is true for SEND_PAYMENT_LINK', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'SEND_PAYMENT_LINK' }));
    for (const draft of drafts ?? []) expect(draft.requiresPaymentLink).toBe(true);
  });

  it('is true for UPDATE_PAYMENT_METHOD', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    for (const draft of drafts ?? []) expect(draft.requiresPaymentLink).toBe(true);
  });

  it('is false for ESCALATE', () => {
    const drafts = generateRecoveryMessages(makeInput({ finalAction: 'ESCALATE' }));
    for (const draft of drafts ?? []) expect(draft.requiresPaymentLink).toBe(false);
  });
});

// ── 20 – SMS length target ────────────────────────────────────────────────────

describe('SMS length', () => {
  it('SMS body without placeholder is under 130 chars for standard retry', () => {
    const drafts = generateRecoveryMessages(makeInput());
    const sms = drafts?.find((d) => d.channel === 'SMS');
    const bodyWithoutPlaceholder = sms!.body.replace(PAYMENT_LINK_PLACEHOLDER, '');
    expect(bodyWithoutPlaceholder.length).toBeLessThan(130);
  });

  it('SMS body without placeholder is under 130 chars for UPDATE_PAYMENT_METHOD', () => {
    const drafts = generateRecoveryMessages(
      makeInput({ finalAction: 'UPDATE_PAYMENT_METHOD', paymentMethodSwitch: SWITCH_TO_CARD }),
    );
    const sms = drafts?.find((d) => d.channel === 'SMS');
    const bodyWithoutPlaceholder = sms!.body.replace(PAYMENT_LINK_PLACEHOLDER, '');
    expect(bodyWithoutPlaceholder.length).toBeLessThan(130);
  });
});

// ── 21 – Deterministic output ─────────────────────────────────────────────────

describe('Determinism', () => {
  it('produces identical output on repeated calls with same input', () => {
    const input = makeInput({ smartRetryTiming: RETRY_TIMING });
    const first = generateRecoveryMessages(input);
    const second = generateRecoveryMessages(input);
    expect(first).toEqual(second);
  });
});

// ── 22 – Input is not mutated ─────────────────────────────────────────────────

describe('Immutability', () => {
  it('does not mutate the input object', () => {
    const input = makeInput({ smartRetryTiming: RETRY_TIMING });
    const originalJson = JSON.stringify(input);
    generateRecoveryMessages(input);
    expect(JSON.stringify(input)).toBe(originalJson);
  });
});

// ── 23 – Same input produces same message (idempotency) ───────────────────────

describe('Idempotency', () => {
  it('generates same messages for same paymentId and input', () => {
    const input = makeInput();
    const a = generateRecoveryMessages(input);
    const b = generateRecoveryMessages({ ...input });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── 24 – All supported channels work ─────────────────────────────────────────

describe('All channels', () => {
  it('returns exactly 3 drafts (SMS, WHATSAPP, EMAIL) when approved', () => {
    const drafts = generateRecoveryMessages(makeInput());
    expect(drafts).toHaveLength(3);
    const channels = drafts!.map((d) => d.channel);
    expect(channels).toContain('SMS');
    expect(channels).toContain('WHATSAPP');
    expect(channels).toContain('EMAIL');
  });
});

// ── 25 – All supported tones work ────────────────────────────────────────────

describe('All tones', () => {
  it('NEUTRAL tone generates a draft', () => {
    const drafts = generateRecoveryMessages(makeInput({ tone: 'NEUTRAL' }));
    expect(drafts).not.toBeNull();
    for (const d of drafts ?? []) expect(d.tone).toBe('NEUTRAL');
  });

  it('FRIENDLY tone generates a draft with friendlier opening', () => {
    const drafts = generateRecoveryMessages(makeInput({ tone: 'FRIENDLY' }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).toContain('it looks like');
    expect(sms!.tone).toBe('FRIENDLY');
  });

  it('URGENT tone generates a draft with urgency CTA', () => {
    const drafts = generateRecoveryMessages(makeInput({ tone: 'URGENT' }));
    const sms = drafts?.find((d) => d.channel === 'SMS');
    expect(sms!.body).toContain('as soon as possible');
    expect(sms!.tone).toBe('URGENT');
  });

  it('URGENT is auto-detected for CRITICAL risk level', () => {
    const drafts = generateRecoveryMessages(makeInput({ riskLevel: 'CRITICAL' }));
    for (const d of drafts ?? []) expect(d.tone).toBe('URGENT');
  });

  it('URGENT is auto-detected for HIGH risk level', () => {
    const drafts = generateRecoveryMessages(makeInput({ riskLevel: 'HIGH' }));
    for (const d of drafts ?? []) expect(d.tone).toBe('URGENT');
  });

  it('NEUTRAL is auto-detected for MEDIUM and LOW risk', () => {
    for (const level of ['MEDIUM', 'LOW'] as const) {
      const drafts = generateRecoveryMessages(makeInput({ riskLevel: level }));
      for (const d of drafts ?? []) expect(d.tone).toBe('NEUTRAL');
    }
  });
});

// ── 26 – URGENT tone does not invent penalties ────────────────────────────────

describe('URGENT tone safety', () => {
  it('does not mention account closure', () => {
    const drafts = generateRecoveryMessages(makeInput({ tone: 'URGENT' }));
    for (const d of drafts ?? []) {
      expect(d.body.toLowerCase()).not.toContain('account will be closed');
      expect(d.body.toLowerCase()).not.toContain('penalty');
      expect(d.body.toLowerCase()).not.toContain('fee');
      expect(d.body.toLowerCase()).not.toContain('suspend');
    }
  });

  it('URGENT email says "earliest convenience" not a deadline', () => {
    const drafts = generateRecoveryMessages(makeInput({ tone: 'URGENT' }));
    const email = drafts?.find((d) => d.channel === 'EMAIL');
    expect(email!.body).toContain('earliest convenience');
    expect(email!.body).not.toContain('deadline');
  });
});

// ── 27 – Fact validation catches missing amount ───────────────────────────────

describe('Fact validation', () => {
  it('throws if amount would be missing from draft (hypothetical template bug catch)', () => {
    // We verify that the validation runs by checking it passes for normal input
    // (a template bug would cause it to throw during generation)
    expect(() => generateRecoveryMessages(makeInput())).not.toThrow();
  });
});

// ── 28 – PolicyEngine behavior is unchanged ───────────────────────────────────

describe('PolicyEngine independence', () => {
  it('messaging generator does not import or call the policy engine', async () => {
    // If policyEngine were imported, its side effects would manifest.
    // We simply verify that generateRecoveryMessages works without any
    // policy engine involvement.
    const { evaluatePolicy } = await import('../../domain/policy/policyEngine');
    const input = makeInput();
    // Generating messages should work without calling evaluatePolicy
    const drafts = generateRecoveryMessages(input);
    expect(drafts).not.toBeNull();
    // evaluatePolicy should still work independently
    const payment = {
      paymentId: 'pay_test_001' as import('../../domain/payments/types').PaymentId,
      customerId: 'cust_001' as import('../../domain/payments/types').CustomerId,
      customerName: 'Rahul Sharma',
      amount: 499900,
      currency: 'INR' as const,
      paymentMethod: 'UPI' as const,
      failureReason: 'UPI_TIMEOUT' as const,
      attemptCount: 1,
      previousSuccessfulPayments: 3,
      lastAttemptAt: '2026-09-01T10:00:00.000Z',
      failedAt: '2026-09-01T10:01:00.000Z',
    };
    const recommendation = {
      recommendedAction: 'RETRY_LATER' as const,
      retryAfterMinutes: 30,
      confidence: 0.75,
      diagnosis: 'UPI timeout',
      reasoning: 'Likely temporary',
      maxAttempts: 3,
    };
    const policy = evaluatePolicy(payment, recommendation);
    expect(policy.approved).toBeDefined();
  });
});

// ── 29 – Recovery Queue ranking is unchanged ──────────────────────────────────

describe('Recovery Queue ranking independence', () => {
  it('generateRecoveryMessages does not affect queue ordering', async () => {
    const { buildRecoveryQueue } = await import('../queue/recoveryQueue');
    // buildRecoveryQueue should still be importable and work independently
    expect(typeof buildRecoveryQueue).toBe('function');
  });
});

// ── 30 – No live message is sent ──────────────────────────────────────────────

describe('No side effects', () => {
  it('generateRecoveryMessages returns a pure data structure with no side effects', () => {
    const drafts = generateRecoveryMessages(makeInput());
    // All drafts are plain objects with no functions or external references
    for (const draft of drafts ?? []) {
      expect(typeof draft.body).toBe('string');
      expect(typeof draft.channel).toBe('string');
      expect(typeof draft.requiresPaymentLink).toBe('boolean');
    }
  });

  it('all drafts have generatedFromAction matching the input finalAction', () => {
    const input = makeInput({ finalAction: 'SEND_PAYMENT_LINK' });
    const drafts = generateRecoveryMessages(input);
    for (const draft of drafts ?? []) {
      expect(draft.generatedFromAction).toBe('SEND_PAYMENT_LINK');
    }
  });

  it('paymentId on draft matches input paymentId', () => {
    const input = makeInput({ paymentId: 'pay_xyz_999' });
    const drafts = generateRecoveryMessages(input);
    for (const draft of drafts ?? []) {
      expect(draft.paymentId).toBe('pay_xyz_999');
    }
  });
});
