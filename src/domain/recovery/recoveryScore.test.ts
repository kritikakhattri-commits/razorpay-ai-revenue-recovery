import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { calculateRecoveryScore } from './recoveryScore';

// ── Priority thresholds ──────────────────────────────────────────────────────

describe('priority — HIGH', () => {
  it('assigns HIGH when probability is 0.70 (exact boundary)', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.70 });
    expect(score.priority).toBe('HIGH');
  });

  it('assigns HIGH when probability is above 0.70', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.85 });
    expect(score.priority).toBe('HIGH');
  });

  it('assigns HIGH when probability is 1.0', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 1 });
    expect(score.priority).toBe('HIGH');
  });
});

describe('priority — MEDIUM', () => {
  it('assigns MEDIUM when probability is 0.40 (exact boundary)', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.40 });
    expect(score.priority).toBe('MEDIUM');
  });

  it('assigns MEDIUM when probability is between 0.40 and 0.70', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.55 });
    expect(score.priority).toBe('MEDIUM');
  });

  it('assigns MEDIUM when probability is just below 0.70', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.6999 });
    expect(score.priority).toBe('MEDIUM');
  });
});

describe('priority — LOW', () => {
  it('assigns LOW when probability is 0', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0 });
    expect(score.priority).toBe('LOW');
  });

  it('assigns LOW when probability is below 0.40', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.2 });
    expect(score.priority).toBe('LOW');
  });

  it('assigns LOW when probability is just below 0.40', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.3999 });
    expect(score.priority).toBe('LOW');
  });
});

// ── Expected amount calculation ──────────────────────────────────────────────

describe('expectedRecoverableAmountInPaise', () => {
  it('calculates expected amount correctly: 1800000 × 0.82 = 1476000', () => {
    const score = calculateRecoveryScore({ amountInPaise: 1800000, recoveryProbability: 0.82 });
    expect(score.expectedRecoverableAmountInPaise).toBe(1476000);
  });

  it('is 0 when probability is 0', () => {
    const score = calculateRecoveryScore({ amountInPaise: 500000, recoveryProbability: 0 });
    expect(score.expectedRecoverableAmountInPaise).toBe(0);
  });

  it('equals amount when probability is 1', () => {
    const score = calculateRecoveryScore({ amountInPaise: 250000, recoveryProbability: 1 });
    expect(score.expectedRecoverableAmountInPaise).toBe(250000);
  });

  it('is 0 when amount is 0', () => {
    const score = calculateRecoveryScore({ amountInPaise: 0, recoveryProbability: 0.9 });
    expect(score.expectedRecoverableAmountInPaise).toBe(0);
  });
});

describe('rounding behavior', () => {
  it('rounds 0.5 paise up', () => {
    // 3 × 0.5 = 1.5 → rounds to 2
    const score = calculateRecoveryScore({ amountInPaise: 3, recoveryProbability: 0.5 });
    expect(score.expectedRecoverableAmountInPaise).toBe(2);
  });

  it('rounds down when fractional part < 0.5', () => {
    // 7 × 0.3 = 2.1 → rounds to 2
    const score = calculateRecoveryScore({ amountInPaise: 7, recoveryProbability: 0.3 });
    expect(score.expectedRecoverableAmountInPaise).toBe(2);
  });

  it('rounds up when fractional part >= 0.5', () => {
    // 5 × 0.7 = 3.5 → rounds to 4
    const score = calculateRecoveryScore({ amountInPaise: 5, recoveryProbability: 0.7 });
    expect(score.expectedRecoverableAmountInPaise).toBe(4);
  });

  it('result is always an integer', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100001, recoveryProbability: 0.333 });
    expect(Number.isInteger(score.expectedRecoverableAmountInPaise)).toBe(true);
  });
});

// ── recoveryProbability passthrough ─────────────────────────────────────────

describe('recoveryProbability passthrough', () => {
  it('preserves the input probability in the result', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0.65 });
    expect(score.recoveryProbability).toBe(0.65);
  });

  it('preserves probability = 0', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0 });
    expect(score.recoveryProbability).toBe(0);
  });

  it('preserves probability = 1', () => {
    const score = calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 1 });
    expect(score.recoveryProbability).toBe(1);
  });
});

// ── Input validation — amountInPaise ────────────────────────────────────────

describe('validation — amountInPaise', () => {
  it('throws when amount is negative', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: -1, recoveryProbability: 0.5 }),
    ).toThrow();
  });

  it('throws when amount is a non-integer (fractional paise)', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100.5, recoveryProbability: 0.5 }),
    ).toThrow();
  });

  it('throws when amount is NaN', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: NaN, recoveryProbability: 0.5 }),
    ).toThrow();
  });

  it('throws when amount is Infinity', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: Infinity, recoveryProbability: 0.5 }),
    ).toThrow();
  });

  it('throws when amount is -Infinity', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: -Infinity, recoveryProbability: 0.5 }),
    ).toThrow();
  });

  it('accepts 0 as a valid amount', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 0, recoveryProbability: 0.5 }),
    ).not.toThrow();
  });
});

// ── Input validation — recoveryProbability ───────────────────────────────────

describe('validation — recoveryProbability', () => {
  it('throws when probability is below 0', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: -0.01 }),
    ).toThrow();
  });

  it('throws when probability is above 1', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 1.01 }),
    ).toThrow();
  });

  it('throws when probability is NaN', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: NaN }),
    ).toThrow();
  });

  it('throws when probability is Infinity', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: Infinity }),
    ).toThrow();
  });

  it('throws when probability is -Infinity', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: -Infinity }),
    ).toThrow();
  });

  it('accepts probability = 0', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 0 }),
    ).not.toThrow();
  });

  it('accepts probability = 1', () => {
    expect(() =>
      calculateRecoveryScore({ amountInPaise: 100000, recoveryProbability: 1 }),
    ).not.toThrow();
  });
});

// ── No side effects ──────────────────────────────────────────────────────────

describe('no side effects', () => {
  it('does not mutate the input object', () => {
    const input = { amountInPaise: 100000, recoveryProbability: 0.75 };
    const snapshot = { ...input };
    calculateRecoveryScore(input);
    expect(input).toEqual(snapshot);
  });

  it('returns the same result for the same input (deterministic)', () => {
    const input = { amountInPaise: 500000, recoveryProbability: 0.65 };
    expect(calculateRecoveryScore(input)).toEqual(calculateRecoveryScore(input));
  });
});

// ── Production calculation ownership ────────────────────────────────────────

describe('calculation ownership', () => {
  it('keeps expected recoverable amount calculation in the Recovery Score domain scorer', () => {
    const root = join(__dirname, '../../..');
    const files = collectTypeScriptFiles(root);
    const offenders = files.filter((file) => {
      const rel = relative(root, file);
      if (rel === 'src/domain/recovery/recoveryScore.ts') return false;
      if (rel.endsWith('.test.ts')) return false;
      const source = readFileSync(file, 'utf8');
      return source.includes('expectedRecoverableAmountInPaise: Math.round');
    });

    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });
});

function collectTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') {
        return [];
      }
      return collectTypeScriptFiles(fullPath);
    }
    return entry.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) ? [fullPath] : [];
  });
}
