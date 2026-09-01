import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { FailedPayment } from '../domain/payments/types';
import { parseFailedPayment } from '../domain/payments/validator';

export function loadFailedPayments(): FailedPayment[] {
  const filePath = resolve(process.cwd(), 'data', 'failed-payments.json');
  const raw = readFileSync(filePath, 'utf-8');
  const records: unknown = JSON.parse(raw);

  if (!Array.isArray(records)) {
    throw new Error('failed-payments.json must contain a JSON array');
  }

  return records.map((record: unknown, index: number) => {
    const result = parseFailedPayment(record);
    if (!result.success) {
      const msgs = result.errors.map((e) => `${e.field}: ${e.message}`).join(', ');
      throw new Error(`Record at index ${index} failed validation: ${msgs}`);
    }
    return result.data;
  });
}
