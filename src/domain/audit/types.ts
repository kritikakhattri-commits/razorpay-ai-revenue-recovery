export type AuditEventType =
  | 'PAYMENT_FAILED'
  | 'RECOVERY_RECOMMENDED'
  | 'POLICY_APPROVED'
  | 'POLICY_REJECTED'
  | 'ACTION_EXECUTED'
  | 'PAYMENT_RECOVERED'
  | 'RECOVERY_FAILED'
  | 'RECOVERY_PENDING'
  | 'ESCALATED'
  | 'ACTION_BLOCKED';

export interface AuditEntry {
  auditId: string;
  paymentId: string;
  eventType: AuditEventType;
  timestamp: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AuditStore {
  append(entry: AuditEntry): void;
  getByPaymentId(paymentId: string): readonly AuditEntry[];
  getAll(): readonly AuditEntry[];
}
