import type { FailedPayment, PaymentMethod } from '../payments/types';

export interface PaymentMethodAlternative {
  method: PaymentMethod;
  score: number;
  reason: string;
}

export interface PaymentMethodSwitchRecommendation {
  currentMethod: PaymentMethod;
  shouldSwitch: boolean;
  recommendedMethod: PaymentMethod | null;
  alternatives: PaymentMethodAlternative[];
  reason: string;
}

export interface PaymentMethodSwitchInput {
  payment: FailedPayment;
}

const REPEATED_FAILURE_THRESHOLD = 2;

// Suitability scores represent ranking fitness (0–1) for recovery, not ML probabilities.
type MethodEntry = { method: PaymentMethod; score: number; reason: string };

const EXPIRED_CARD_ENTRIES: MethodEntry[] = [
  {
    method: 'UPI',
    score: 0.90,
    reason: 'UPI requires no physical card and is unaffected by card expiry.',
  },
  {
    method: 'CARD',
    score: 0.75,
    reason: 'A different valid card can complete the payment successfully.',
  },
  {
    method: 'NETBANKING',
    score: 0.60,
    reason: 'Net banking provides a reliable card-independent payment route.',
  },
  {
    method: 'WALLET',
    score: 0.50,
    reason: 'Wallet balance may cover the payment without requiring a card.',
  },
];

const CARD_DECLINE_ENTRIES: MethodEntry[] = [
  {
    method: 'UPI',
    score: 0.90,
    reason: 'UPI bypasses the card issuer and draws directly from the bank account.',
  },
  {
    method: 'NETBANKING',
    score: 0.70,
    reason: 'Net banking provides a direct bank debit that avoids card issuer restrictions.',
  },
  {
    method: 'WALLET',
    score: 0.55,
    reason: 'Pre-loaded wallet funds are independent of card issuer approval.',
  },
];

const UPI_REPEATED_ENTRIES: MethodEntry[] = [
  {
    method: 'CARD',
    score: 0.85,
    reason: 'Card payment bypasses UPI infrastructure entirely.',
  },
  {
    method: 'NETBANKING',
    score: 0.70,
    reason: 'Net banking uses a separate payment channel not affected by UPI gateway issues.',
  },
  {
    method: 'WALLET',
    score: 0.55,
    reason: 'Wallet payment avoids UPI gateway dependency.',
  },
];

const WALLET_FAILURE_ENTRIES: MethodEntry[] = [
  {
    method: 'UPI',
    score: 0.90,
    reason: 'UPI draws directly from the bank account, independent of wallet balance.',
  },
  {
    method: 'CARD',
    score: 0.75,
    reason: 'Card payment is a reliable fallback when wallet transactions fail.',
  },
  {
    method: 'NETBANKING',
    score: 0.60,
    reason: 'Net banking provides a direct bank route that bypasses the wallet.',
  },
];

const NETBANKING_FAILURE_ENTRIES: MethodEntry[] = [
  {
    method: 'UPI',
    score: 0.90,
    reason: 'UPI provides a fast bank-linked payment without requiring a browser redirect.',
  },
  {
    method: 'CARD',
    score: 0.75,
    reason: 'Card payment is a reliable fallback for net banking failures.',
  },
  {
    method: 'WALLET',
    score: 0.55,
    reason: 'Wallet funds cover the payment if pre-loaded, avoiding net banking entirely.',
  },
];

function buildAlternatives(
  entries: MethodEntry[],
  exclude: PaymentMethod | null,
): PaymentMethodAlternative[] {
  const seen = new Set<PaymentMethod>();
  const result: PaymentMethodAlternative[] = [];
  for (const entry of entries) {
    if (seen.has(entry.method)) continue;
    if (entry.method === exclude) continue;
    seen.add(entry.method);
    result.push({ method: entry.method, score: entry.score, reason: entry.reason });
  }
  return result;
}

function noSwitch(
  currentMethod: PaymentMethod,
  reason: string,
): PaymentMethodSwitchRecommendation {
  return { currentMethod, shouldSwitch: false, recommendedMethod: null, alternatives: [], reason };
}

function withSwitch(
  currentMethod: PaymentMethod,
  alternatives: PaymentMethodAlternative[],
  reason: string,
): PaymentMethodSwitchRecommendation {
  const recommendedMethod = alternatives.length > 0 ? alternatives[0].method : null;
  return {
    currentMethod,
    shouldSwitch: alternatives.length > 0,
    recommendedMethod,
    alternatives,
    reason,
  };
}

export function computePaymentMethodSwitch(
  input: PaymentMethodSwitchInput,
): PaymentMethodSwitchRecommendation {
  const { payment } = input;
  const { paymentMethod, failureReason, attemptCount } = payment;

  switch (failureReason) {
    case 'EXPIRED_CARD': {
      // Card is expired — must switch. Another card is still a valid option.
      const alternatives = buildAlternatives(EXPIRED_CARD_ENTRIES, null);
      return withSwitch(
        paymentMethod,
        alternatives,
        'The current card is expired and cannot be retried. A different payment method is required.',
      );
    }

    case 'UPI_TIMEOUT': {
      if (attemptCount >= REPEATED_FAILURE_THRESHOLD) {
        // Repeated UPI failures — exclude UPI and recommend alternatives.
        const alternatives = buildAlternatives(UPI_REPEATED_ENTRIES, 'UPI');
        return withSwitch(
          paymentMethod,
          alternatives,
          'UPI has repeatedly timed out. Switching to card or net banking is recommended.',
        );
      }
      // First timeout is likely transient; smart retry timing handles scheduling.
      return noSwitch(
        paymentMethod,
        'UPI timeout appears temporary. Retrying after the recommended delay is preferred over switching methods.',
      );
    }

    case 'BANK_SERVER_ERROR': {
      if (paymentMethod === 'WALLET') {
        const alternatives = buildAlternatives(WALLET_FAILURE_ENTRIES, 'WALLET');
        return withSwitch(
          paymentMethod,
          alternatives,
          'Wallet payment failed due to a bank server error. UPI or card provides a more reliable alternative.',
        );
      }
      if (paymentMethod === 'NETBANKING') {
        const alternatives = buildAlternatives(NETBANKING_FAILURE_ENTRIES, 'NETBANKING');
        return withSwitch(
          paymentMethod,
          alternatives,
          'Net banking failed due to a bank server error. UPI or card avoids the same banking channel.',
        );
      }
      if (paymentMethod === 'CARD' && attemptCount >= REPEATED_FAILURE_THRESHOLD) {
        const alternatives = buildAlternatives(CARD_DECLINE_ENTRIES, null);
        return withSwitch(
          paymentMethod,
          alternatives,
          'Repeated card declines suggest the issuing bank is blocking this card. Switching to UPI is recommended.',
        );
      }
      // Transient bank server error on UPI or first-attempt CARD — retry preferred.
      return noSwitch(
        paymentMethod,
        'Bank server error is likely temporary. Retrying after the recommended delay is preferred.',
      );
    }

    case 'INSUFFICIENT_BALANCE': {
      // A different payment method will not resolve a funding shortfall.
      return noSwitch(
        paymentMethod,
        'Insufficient balance is a customer-side funding issue. Switching payment methods is unlikely to resolve this without additional customer action.',
      );
    }

    case 'AUTHENTICATION_FAILED': {
      // A fresh payment link resolves auth failures; method switching is not the primary action.
      return noSwitch(
        paymentMethod,
        'Authentication failure is resolved by a fresh payment session via a new payment link. Switching methods is not the primary recommendation.',
      );
    }

    case 'CUSTOMER_ABANDONED': {
      // Customer left before completing — re-engagement is the goal, not method switching.
      return noSwitch(
        paymentMethod,
        'Customer abandoned the payment flow. A fresh payment link is the primary recovery action. Switching methods is not recommended.',
      );
    }

    default: {
      const _exhaustive: never = failureReason;
      throw new Error(`Unhandled failure reason: ${String(_exhaustive)}`);
    }
  }
}
