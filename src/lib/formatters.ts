export function formatPaise(paise: number): string {
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
  return `₹${formatted}`;
}

export function formatCompactPaise(paise: number): string {
  const rupees = paise / 100;
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';

  if (abs >= 100000) {
    return `${sign}₹${formatCompactNumber(abs / 100000)}L`;
  }
  if (abs >= 1000) {
    return `${sign}₹${formatCompactNumber(abs / 1000)}K`;
  }
  return formatPaise(paise);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function formatDelayMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours} hr`;
  return `${hours} hr ${remainingMinutes} min`;
}

export function formatUtcDateTime(timestamp: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

const ACTION_LABELS: Record<string, string> = {
  RETRY_LATER: 'Retry Later',
  SEND_PAYMENT_LINK: 'Payment Link',
  UPDATE_PAYMENT_METHOD: 'Update Method',
  ESCALATE: 'Escalate',
};

const FAILURE_LABELS: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'Insufficient Balance',
  UPI_TIMEOUT: 'UPI Timeout',
  BANK_SERVER_ERROR: 'Bank Server Error',
  EXPIRED_CARD: 'Expired Card',
  AUTHENTICATION_FAILED: 'Auth Failed',
  CUSTOMER_ABANDONED: 'Abandoned',
};

const METHOD_LABELS: Record<string, string> = {
  UPI: 'UPI',
  CARD: 'Card',
  NETBANKING: 'Net Banking',
  WALLET: 'Wallet',
};

export function formatAction(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function formatFailureReason(reason: string): string {
  return FAILURE_LABELS[reason] ?? reason;
}

export function formatPaymentMethod(method: string): string {
  return METHOD_LABELS[method] ?? method;
}
