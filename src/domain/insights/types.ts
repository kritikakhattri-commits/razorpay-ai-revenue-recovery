export type RevenueInsightType =
  | 'OPPORTUNITY'
  | 'RISK'
  | 'TREND'
  | 'FORECAST'
  | 'ACTION';

export type RevenueInsightSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RevenueInsight {
  id: string;
  type: RevenueInsightType;
  severity: RevenueInsightSeverity;
  title: string;
  message: string;
  metricValue?: number;
  metricUnit?: 'PAISE' | 'PERCENT' | 'COUNT';
  relatedPaymentIds?: string[];
  generatedAt: string;
}
