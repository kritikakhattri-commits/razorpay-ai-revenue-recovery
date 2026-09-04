import type { CopilotRequest } from '../../domain/copilot/types';
import type { PaymentId } from '../../domain/payments/types';

const MAX_QUERY_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCopilotRequest(value: unknown): CopilotRequest | null {
  if (!isRecord(value)) return null;
  if (typeof value.query !== 'string') return null;
  if (value.query.length > MAX_QUERY_LENGTH) return null;
  if (value.paymentId !== undefined && typeof value.paymentId !== 'string') return null;
  return {
    query: value.query,
    paymentId: value.paymentId as PaymentId | undefined,
  };
}
