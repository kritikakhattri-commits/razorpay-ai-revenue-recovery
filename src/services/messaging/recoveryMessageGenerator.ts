import type { RecoveryAction } from '../../domain/recovery/types';
import type { FailureReason, PaymentMethod } from '../../domain/payments/types';
import type { SmartRetryTiming } from '../../domain/recovery/retryTiming';
import type { PaymentMethodSwitchRecommendation } from '../../domain/recovery/paymentMethodSwitching';
import type { RevenueRiskLevel } from '../../domain/recovery/revenueAtRisk';
import type {
  RecoveryMessageChannel,
  RecoveryMessageTone,
  RecoveryMessageDraft,
  RecoveryMessageInput,
} from '../../domain/messaging/types';

export const PAYMENT_LINK_PLACEHOLDER = '{paymentLink}';

// ── Customer-safe failure context ──────────────────────────────────────────────
//
// Failure codes are never shown. Only EXPIRED_CARD warrants a subtle hint in
// non-SMS channels (card needs updating). All other reasons use generic copy.

export const FAILURE_CUSTOMER_CONTEXT: Record<FailureReason, string | null> = {
  EXPIRED_CARD:          'Your current card may need to be updated.',
  INSUFFICIENT_BALANCE:  null,
  UPI_TIMEOUT:           null,
  BANK_SERVER_ERROR:     null,
  AUTHENTICATION_FAILED: null,
  CUSTOMER_ABANDONED:    null,
};

// ── Method labels for customer messages ───────────────────────────────────────

const METHOD_FOR_MESSAGE: Record<PaymentMethod, string> = {
  UPI:        'UPI',
  CARD:       'card',
  NETBANKING: 'net banking',
  WALLET:     'wallet',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatAmountForMessage(paise: number): string {
  const rupees = paise / 100;
  const formatted = Number.isInteger(rupees)
    ? rupees.toLocaleString('en-IN')
    : rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₹${formatted}`;
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `in ${minutes} minute${minutes !== 1 ? 's' : ''}`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (rem === 0) return `in ${hours} hour${hours !== 1 ? 's' : ''}`;
  return `in ${hours} hr ${rem} min`;
}

function firstNameFrom(fullName: string): string {
  return fullName.split(' ')[0] ?? fullName;
}

function resolveTone(
  riskLevel: RevenueRiskLevel,
  finalAction: RecoveryAction,
  tone?: RecoveryMessageTone,
): RecoveryMessageTone {
  if (tone !== undefined) return tone;
  if (finalAction === 'ESCALATE') return 'NEUTRAL';
  if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') return 'URGENT';
  return 'NEUTRAL';
}

// ── Internal template context ─────────────────────────────────────────────────

interface TemplateContext {
  name: string;
  amount: string;
  tone: RecoveryMessageTone;
  timing: SmartRetryTiming | null;
  methodSwitch: PaymentMethodSwitchRecommendation;
  failureReason: FailureReason;
}

interface ChannelResult {
  body: string;
  subject?: string;
  retryTimingIncluded: boolean;
  methodSuggestionIncluded: boolean;
}

// ── SMS ───────────────────────────────────────────────────────────────────────
//
// Target: under 130 chars (excluding placeholder) so a ~30-char URL fits in 160.
// SMS never shows failure context hints — every character matters.

function buildSms(action: RecoveryAction, ctx: TemplateContext): ChannelResult {
  switch (action) {
    case 'RETRY_LATER':
    case 'SEND_PAYMENT_LINK': {
      const timingIncluded = ctx.timing !== null;

      let intro: string;
      if (ctx.tone === 'FRIENDLY') {
        intro = `Hi ${ctx.name}, it looks like your ${ctx.amount} payment didn't go through.`;
      } else {
        intro = `Hi ${ctx.name}, your ${ctx.amount} payment didn't go through.`;
      }

      let cta: string;
      if (ctx.timing) {
        cta = `Please retry ${formatDelay(ctx.timing.delayMinutes)}:`;
      } else if (ctx.tone === 'URGENT') {
        cta = 'Please retry as soon as possible:';
      } else {
        cta = 'Please retry securely here:';
      }

      const body = `${intro} ${cta} ${PAYMENT_LINK_PLACEHOLDER}`;
      return { body, retryTimingIncluded: timingIncluded, methodSuggestionIncluded: false };
    }

    case 'UPDATE_PAYMENT_METHOD': {
      const methodIncluded =
        ctx.methodSwitch.shouldSwitch && ctx.methodSwitch.recommendedMethod !== null;
      const methodCta = methodIncluded && ctx.methodSwitch.recommendedMethod
        ? `Please try ${METHOD_FOR_MESSAGE[ctx.methodSwitch.recommendedMethod]} instead:`
        : 'Please use another payment method:';

      const body =
        `Hi ${ctx.name}, your ${ctx.amount} payment couldn't be completed. ${methodCta} ${PAYMENT_LINK_PLACEHOLDER}`;
      return { body, retryTimingIncluded: false, methodSuggestionIncluded: methodIncluded };
    }

    case 'ESCALATE': {
      const body =
        `Hi ${ctx.name}, we're reviewing an issue with your recent ${ctx.amount} payment. No action is needed from you right now.`;
      return { body, retryTimingIncluded: false, methodSuggestionIncluded: false };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled action: ${String(_exhaustive)}`);
    }
  }
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

function buildWhatsApp(action: RecoveryAction, ctx: TemplateContext): ChannelResult {
  switch (action) {
    case 'RETRY_LATER':
    case 'SEND_PAYMENT_LINK': {
      const timingIncluded = ctx.timing !== null;
      const methodIncluded =
        ctx.methodSwitch.shouldSwitch && ctx.methodSwitch.recommendedMethod !== null;

      const intro =
        ctx.tone === 'FRIENDLY'
          ? `Hi ${ctx.name},\n\nWe noticed your recent payment of ${ctx.amount} didn't go through.`
          : `Hi ${ctx.name},\n\nYour recent payment of ${ctx.amount} didn't go through.`;

      let body = `${intro}\n\nYou can retry securely using the link below:\n\n${PAYMENT_LINK_PLACEHOLDER}`;

      if (ctx.timing) {
        body += `\n\nFor the best chance of success, please retry ${formatDelay(ctx.timing.delayMinutes)}.`;
      }

      if (methodIncluded && ctx.methodSwitch.recommendedMethod) {
        body += `\n\nIf the issue continues, you can also try ${METHOD_FOR_MESSAGE[ctx.methodSwitch.recommendedMethod]}.`;
      }

      if (ctx.tone === 'URGENT') {
        body += '\n\nPlease retry at your earliest convenience.';
      }

      return { body, retryTimingIncluded: timingIncluded, methodSuggestionIncluded: methodIncluded };
    }

    case 'UPDATE_PAYMENT_METHOD': {
      const methodIncluded =
        ctx.methodSwitch.shouldSwitch && ctx.methodSwitch.recommendedMethod !== null;
      const failureHint = FAILURE_CUSTOMER_CONTEXT[ctx.failureReason];

      let body = `Hi ${ctx.name},\n\nYour recent payment of ${ctx.amount} couldn't be completed.`;
      if (failureHint) body += `\n\n${failureHint}`;
      body += `\n\nPlease use a different payment method to complete your payment:\n\n${PAYMENT_LINK_PLACEHOLDER}`;

      if (methodIncluded && ctx.methodSwitch.recommendedMethod) {
        body += `\n\nWe suggest trying ${METHOD_FOR_MESSAGE[ctx.methodSwitch.recommendedMethod]}.`;
      }

      return { body, retryTimingIncluded: false, methodSuggestionIncluded: methodIncluded };
    }

    case 'ESCALATE': {
      const body =
        `Hi ${ctx.name},\n\nWe're reviewing an issue with your recent payment of ${ctx.amount}.\n\nNo action is required from you right now. We'll update you if anything changes.`;
      return { body, retryTimingIncluded: false, methodSuggestionIncluded: false };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled action: ${String(_exhaustive)}`);
    }
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

function buildEmail(action: RecoveryAction, ctx: TemplateContext): ChannelResult {
  switch (action) {
    case 'RETRY_LATER':
    case 'SEND_PAYMENT_LINK': {
      const timingIncluded = ctx.timing !== null;
      const methodIncluded =
        ctx.methodSwitch.shouldSwitch && ctx.methodSwitch.recommendedMethod !== null;

      const subject = 'Complete your payment';
      let body =
        `Hi ${ctx.name},\n\nWe weren't able to complete your recent payment of ${ctx.amount}.\n\nPlease retry securely using the payment link below.\n\n${PAYMENT_LINK_PLACEHOLDER}`;

      if (ctx.timing) {
        body += `\n\nFor the best chance of success, please retry ${formatDelay(ctx.timing.delayMinutes)}.`;
      }

      if (methodIncluded && ctx.methodSwitch.recommendedMethod) {
        body += `\n\nIf the issue continues, you can try ${METHOD_FOR_MESSAGE[ctx.methodSwitch.recommendedMethod]} instead.`;
      }

      if (ctx.tone === 'URGENT') {
        body += '\n\nPlease retry at your earliest convenience.';
      }

      body += '\n\nThanks.';

      return { subject, body, retryTimingIncluded: timingIncluded, methodSuggestionIncluded: methodIncluded };
    }

    case 'UPDATE_PAYMENT_METHOD': {
      const methodIncluded =
        ctx.methodSwitch.shouldSwitch && ctx.methodSwitch.recommendedMethod !== null;
      const failureHint = FAILURE_CUSTOMER_CONTEXT[ctx.failureReason];

      const subject = 'Your payment needs attention';
      let body = `Hi ${ctx.name},\n\nWe weren't able to complete your recent payment of ${ctx.amount}.`;
      if (failureHint) body += `\n\n${failureHint}`;
      body += `\n\nPlease use a different payment method to complete your payment.\n\n${PAYMENT_LINK_PLACEHOLDER}`;

      if (methodIncluded && ctx.methodSwitch.recommendedMethod) {
        body += `\n\nWe suggest trying ${METHOD_FOR_MESSAGE[ctx.methodSwitch.recommendedMethod]}.`;
      }

      body += '\n\nThanks.';

      return { subject, body, retryTimingIncluded: false, methodSuggestionIncluded: methodIncluded };
    }

    case 'ESCALATE': {
      const subject = 'Your payment is being reviewed';
      const body =
        `Hi ${ctx.name},\n\nWe're reviewing an issue with your recent payment of ${ctx.amount}.\n\nNo action is required from you right now. We'll update you if anything changes.\n\nThanks.`;
      return { subject, body, retryTimingIncluded: false, methodSuggestionIncluded: false };
    }

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled action: ${String(_exhaustive)}`);
    }
  }
}

// ── Fact validation ───────────────────────────────────────────────────────────
//
// Guards against template bugs that could produce contradictory or unsafe output.
// Runs on every generated draft before it is returned.

const RAW_FAILURE_CODES: readonly string[] = [
  'INSUFFICIENT_BALANCE',
  'UPI_TIMEOUT',
  'BANK_SERVER_ERROR',
  'EXPIRED_CARD',
  'AUTHENTICATION_FAILED',
  'CUSTOMER_ABANDONED',
];

const INTERNAL_FIELD_FRAGMENTS: readonly string[] = [
  'recoveryProbability',
  'revenueAtRiskScore',
  'confidence:',
  'PolicyEngine',
  'riskScore',
];

function validateDraft(draft: RecoveryMessageDraft, input: RecoveryMessageInput): void {
  const formattedAmount = formatAmountForMessage(input.amountInPaise);
  if (!draft.body.includes(formattedAmount)) {
    throw new Error(
      `[RecoveryMessageGenerator] Draft body is missing the formatted amount "${formattedAmount}". ` +
      `Channel: ${draft.channel}, Action: ${draft.generatedFromAction}`,
    );
  }

  const name = firstNameFrom(input.customerName);
  if (!draft.body.includes(name)) {
    throw new Error(
      `[RecoveryMessageGenerator] Draft body is missing the customer name "${name}". ` +
      `Channel: ${draft.channel}`,
    );
  }

  for (const code of RAW_FAILURE_CODES) {
    if (draft.body.includes(code)) {
      throw new Error(
        `[RecoveryMessageGenerator] Draft body contains raw failure code "${code}". ` +
        `Channel: ${draft.channel}`,
      );
    }
  }

  for (const fragment of INTERNAL_FIELD_FRAGMENTS) {
    if (draft.body.includes(fragment)) {
      throw new Error(
        `[RecoveryMessageGenerator] Draft body contains internal field fragment "${fragment}". ` +
        `Channel: ${draft.channel}`,
      );
    }
  }

  if (input.finalAction === 'ESCALATE' && draft.requiresPaymentLink) {
    throw new Error(
      '[RecoveryMessageGenerator] ESCALATE drafts must not require a payment link.',
    );
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

function makeDraft(
  channel: RecoveryMessageChannel,
  result: ChannelResult,
  input: RecoveryMessageInput,
  tone: RecoveryMessageTone,
  requiresPaymentLink: boolean,
): RecoveryMessageDraft {
  return {
    channel,
    tone,
    subject: result.subject,
    body: result.body,
    paymentId: input.paymentId,
    generatedFromAction: input.finalAction,
    requiresPaymentLink,
    metadata: {
      retryTimingIncluded: result.retryTimingIncluded,
      paymentMethodSuggestionIncluded: result.methodSuggestionIncluded,
    },
  };
}

export function generateRecoveryMessages(
  input: RecoveryMessageInput,
): RecoveryMessageDraft[] | null {
  if (!input.policyApproved) {
    return null;
  }

  const { finalAction } = input;
  const tone = resolveTone(input.riskLevel, finalAction, input.tone);

  const ctx: TemplateContext = {
    name: firstNameFrom(input.customerName),
    amount: formatAmountForMessage(input.amountInPaise),
    tone,
    timing: input.smartRetryTiming,
    methodSwitch: input.paymentMethodSwitch,
    failureReason: input.failureReason,
  };

  const requiresPaymentLink = finalAction !== 'ESCALATE';

  const drafts: RecoveryMessageDraft[] = [
    makeDraft('SMS',      buildSms(finalAction, ctx),      input, tone, requiresPaymentLink),
    makeDraft('WHATSAPP', buildWhatsApp(finalAction, ctx), input, tone, requiresPaymentLink),
    makeDraft('EMAIL',    buildEmail(finalAction, ctx),    input, tone, requiresPaymentLink),
  ];

  for (const draft of drafts) {
    validateDraft(draft, input);
  }

  return drafts;
}

export function messageDraftForChannel(
  drafts: RecoveryMessageDraft[],
  channel: RecoveryMessageChannel,
): RecoveryMessageDraft | undefined {
  return drafts.find((d) => d.channel === channel);
}
