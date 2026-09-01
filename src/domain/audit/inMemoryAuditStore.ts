import type { AuditEntry, AuditStore } from './types';

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.entries.push(deepCopy(entry));
  }

  getByPaymentId(paymentId: string): readonly AuditEntry[] {
    return this.entries
      .filter((e) => e.paymentId === paymentId)
      .map(deepCopy);
  }

  getAll(): readonly AuditEntry[] {
    return this.entries.map(deepCopy);
  }
}
