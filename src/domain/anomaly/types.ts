import type { PaymentMethod, FailureReason } from '../payments/types';

export type AnomalyType =
  | 'FAILURE_VOLUME_SPIKE'
  | 'FAILURE_REASON_SPIKE'
  | 'PAYMENT_METHOD_SPIKE'
  | 'REVENUE_SPIKE'
  | 'RISK_CONCENTRATION';

export type AnomalySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface PaymentFailureAnomaly {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;

  title: string;
  message: string;

  // observedValue: raw count or revenue in the current window
  // baselineValue: normalized expected value per current-window-length period (null when no baseline data)
  // ratioToBaseline: observedValue / baselineValue (null when baselineValue is null or 0)
  observedValue: number;
  baselineValue: number | null;
  ratioToBaseline: number | null;

  // anomalyScore: 0–100, formula: min(100, ratioScore + revenueScore)
  //   ratioScore   = min(60, round((ratio - 1) * 20))  — null ratio → 30
  //   revenueScore = min(40, round(affectedRevenue / 50_000))
  anomalyScore: number;

  affectedPaymentCount: number;
  affectedRevenueInPaise: number;
  revenueAtRiskInPaise: number;

  paymentMethod?: PaymentMethod;
  failureReason?: FailureReason;

  windowStart: string;
  windowEnd: string;

  relatedPaymentIds: string[];
}
