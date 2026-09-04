import type { CustomerId, PaymentMethod } from '../payments/types';

export type CustomerRecoverySegment =
  | 'HIGH_RECOVERY_POTENTIAL'
  | 'MEDIUM_RECOVERY_POTENTIAL'
  | 'LOW_RECOVERY_POTENTIAL'
  | 'INSUFFICIENT_HISTORY';

export type HistoricalCustomerPaymentStatus = 'SUCCESSFUL' | 'FAILED';

export interface HistoricalCustomerPayment {
  customerId: CustomerId;
  paymentMethod: PaymentMethod;
  status: HistoricalCustomerPaymentStatus;
  completedAt?: string;
}

export interface CustomerRecoveryScore {
  customerId: CustomerId;
  customerName: string;
  score: number;
  segment: CustomerRecoverySegment;
  historicalSuccessRate: number | null;
  successfulPaymentCount: number;
  failedPaymentCount: number;
  activeFailedRevenueInPaise: number;
  expectedRecoverableRevenueInPaise: number;
  revenueAtRiskInPaise: number;
  preferredSuccessfulPaymentMethod: PaymentMethod | null;
  preferredSuccessfulPaymentWindow: string | null;
  factors: string[];
}

export interface CustomerRecoveryQueueItem extends CustomerRecoveryScore {
  rank: number;
}

export interface CustomerRecoveryPortfolio {
  customers: CustomerRecoveryQueueItem[];
  totalCustomers: number;
  totalActiveFailedRevenueInPaise: number;
  totalExpectedRecoverableRevenueInPaise: number;
  highRecoveryPotentialCount: number;
  mediumRecoveryPotentialCount: number;
  lowRecoveryPotentialCount: number;
  insufficientHistoryCount: number;
}
