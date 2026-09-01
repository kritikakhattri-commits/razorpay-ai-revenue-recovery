export type PaymentId = string & { readonly __brand: 'PaymentId' };
export type CustomerId = string & { readonly __brand: 'CustomerId' };

export type PaymentMethod = 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET';

export type FailureReason =
  | 'INSUFFICIENT_BALANCE'
  | 'UPI_TIMEOUT'
  | 'BANK_SERVER_ERROR'
  | 'EXPIRED_CARD'
  | 'AUTHENTICATION_FAILED'
  | 'CUSTOMER_ABANDONED';

export type Currency = 'INR';

export interface FailedPayment {
  paymentId: PaymentId;
  customerId: CustomerId;
  customerName: string;
  amount: number;
  currency: Currency;
  paymentMethod: PaymentMethod;
  failureReason: FailureReason;
  attemptCount: number;
  previousSuccessfulPayments: number;
  lastAttemptAt: string;
  failedAt: string;
}
