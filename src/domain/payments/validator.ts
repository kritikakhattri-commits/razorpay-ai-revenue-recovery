import type {
  FailedPayment,
  PaymentMethod,
  FailureReason,
  PaymentId,
  CustomerId,
} from './types';

export type ValidationError = {
  field: string;
  message: string;
};

export type ValidationFailure = {
  success: false;
  errors: ValidationError[];
};

export type ValidationSuccess = {
  success: true;
  data: FailedPayment;
};

export type ParseResult = ValidationSuccess | ValidationFailure;

const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'UPI',
  'CARD',
  'NETBANKING',
  'WALLET',
];

const FAILURE_REASONS: readonly FailureReason[] = [
  'INSUFFICIENT_BALANCE',
  'UPI_TIMEOUT',
  'BANK_SERVER_ERROR',
  'EXPIRED_CARD',
  'AUTHENTICATION_FAILED',
  'CUSTOMER_ABANDONED',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidISOTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  if (isNaN(date.getTime())) return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return PAYMENT_METHODS.includes(value as PaymentMethod);
}

function isFailureReason(value: unknown): value is FailureReason {
  return FAILURE_REASONS.includes(value as FailureReason);
}

export function parseFailedPayment(input: unknown): ParseResult {
  if (!isRecord(input)) {
    return {
      success: false,
      errors: [{ field: 'root', message: 'Input must be a plain object' }],
    };
  }

  const errors: ValidationError[] = [];

  if (typeof input.paymentId !== 'string' || input.paymentId.trim() === '') {
    errors.push({ field: 'paymentId', message: 'paymentId must be a non-empty string' });
  }

  if (typeof input.customerId !== 'string' || input.customerId.trim() === '') {
    errors.push({ field: 'customerId', message: 'customerId must be a non-empty string' });
  }

  if (typeof input.customerName !== 'string' || input.customerName.trim() === '') {
    errors.push({ field: 'customerName', message: 'customerName must be a non-empty string' });
  }

  if (
    typeof input.amount !== 'number' ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0
  ) {
    errors.push({ field: 'amount', message: 'amount must be a positive integer' });
  }

  if (input.currency !== 'INR') {
    errors.push({ field: 'currency', message: 'currency must be INR' });
  }

  if (!isPaymentMethod(input.paymentMethod)) {
    errors.push({
      field: 'paymentMethod',
      message: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`,
    });
  }

  if (!isFailureReason(input.failureReason)) {
    errors.push({
      field: 'failureReason',
      message: `failureReason must be one of: ${FAILURE_REASONS.join(', ')}`,
    });
  }

  if (
    typeof input.attemptCount !== 'number' ||
    !Number.isInteger(input.attemptCount) ||
    input.attemptCount < 0
  ) {
    errors.push({
      field: 'attemptCount',
      message: 'attemptCount must be a non-negative integer',
    });
  }

  if (
    typeof input.previousSuccessfulPayments !== 'number' ||
    !Number.isInteger(input.previousSuccessfulPayments) ||
    input.previousSuccessfulPayments < 0
  ) {
    errors.push({
      field: 'previousSuccessfulPayments',
      message: 'previousSuccessfulPayments must be a non-negative integer',
    });
  }

  if (!isValidISOTimestamp(input.lastAttemptAt)) {
    errors.push({
      field: 'lastAttemptAt',
      message: 'lastAttemptAt must be a valid ISO 8601 datetime string',
    });
  }

  if (!isValidISOTimestamp(input.failedAt)) {
    errors.push({
      field: 'failedAt',
      message: 'failedAt must be a valid ISO 8601 datetime string',
    });
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      paymentId: input.paymentId as PaymentId,
      customerId: input.customerId as CustomerId,
      customerName: input.customerName as string,
      amount: input.amount as number,
      currency: 'INR',
      paymentMethod: input.paymentMethod as PaymentMethod,
      failureReason: input.failureReason as FailureReason,
      attemptCount: input.attemptCount as number,
      previousSuccessfulPayments: input.previousSuccessfulPayments as number,
      lastAttemptAt: input.lastAttemptAt as string,
      failedAt: input.failedAt as string,
    },
  };
}
