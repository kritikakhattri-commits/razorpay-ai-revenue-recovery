'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RecoverySimulationResult, SimulatedPaymentResult } from '@/src/domain/simulation/types';
import type { RecoverySimulationScenario } from '@/src/domain/simulation/types';
import { formatPaise, formatPercent } from '@/src/lib/formatters';

// ── Badge components ──────────────────────────────────────────────────────────

function PolicyBadge({ outcome }: { outcome: SimulatedPaymentResult['policyOutcome'] }) {
  const config = {
    APPROVED: { color: '#059669', bg: '#F0FDF4', border: '#BBF7D0', label: 'Approved' },
    MODIFIED: { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', label: 'Modified' },
    BLOCKED:  { color: '#DC2626', bg: '#FEF2F2', border: '#FECACA', label: 'Blocked'  },
  }[outcome];
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: config.color, background: config.bg, border: `1px solid ${config.border}`, padding: '2px 6px', borderRadius: 2 }}>
      {config.label}
    </span>
  );
}

function RiskBadge({ level }: { level: string }) {
  const colorMap: Record<string, { color: string; bg: string; border: string }> = {
    CRITICAL: { color: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
    HIGH:     { color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA' },
    MEDIUM:   { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
    LOW:      { color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB' },
  };
  const c = colorMap[level] ?? colorMap.LOW;
  return (
    <span style={{ fontSize: 10, fontWeight: 500, color: c.color, background: c.bg, border: `1px solid ${c.border}`, padding: '2px 6px', borderRadius: 2 }}>
      {level}
    </span>
  );
}

// ── Payment breakdown ─────────────────────────────────────────────────────────

function PaymentBreakdown({ results }: { results: readonly SimulatedPaymentResult[] }) {
  if (results.length === 0) {
    return <p style={{ fontSize: 13, color: '#9CA3AF', padding: '16px 0' }}>No payments match this scenario.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Payment', 'Customer', 'Failed', 'Est. Recovery', 'Risk', 'Current', 'Simulated', 'Policy'].map((col) => (
              <th
                key={col}
                style={{
                  padding: '8px 16px 8px 0',
                  textAlign: 'left',
                  fontSize: '9px',
                  fontWeight: 500,
                  color: '#AEAEAE',
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  borderBottom: '1px solid #E5E5E3',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.paymentId} className="trow-hover" style={{ borderBottom: '1px solid #F2F2F0' }}>
              <td style={{ padding: '10px 16px 10px 0' }}>
                <Link href={`/payments/${r.paymentId}`} className="text-blue-600 hover:underline" style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                  {r.paymentId}
                </Link>
              </td>
              <td style={{ padding: '10px 16px 10px 0', fontSize: 11, color: '#555' }}>{r.customerName}</td>
              <td style={{ padding: '10px 16px 10px 0', fontSize: 11, color: '#6B7280', textAlign: 'right' }}>{formatPaise(r.failedAmountInPaise)}</td>
              <td style={{ padding: '10px 16px 10px 0', fontSize: 11, fontWeight: 500, color: '#059669', textAlign: 'right' }}>{formatPaise(r.estimatedRecoverableInPaise)}</td>
              <td style={{ padding: '10px 16px 10px 0' }}><RiskBadge level={r.riskLevel} /></td>
              <td style={{ padding: '10px 16px 10px 0', fontSize: 11, color: '#9CA3AF' }}>{r.currentStrategyLabel}</td>
              <td style={{ padding: '10px 16px 10px 0', fontSize: 11, fontWeight: 500, color: '#333' }}>{r.simulatedStrategyLabel}</td>
              <td style={{ padding: '10px 0 10px 0' }}><PolicyBadge outcome={r.policyOutcome} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Simulation result ─────────────────────────────────────────────────────────

function SimulationResultCard({ result }: { result: RecoverySimulationResult }) {
  const delta = result.scenarioDeltaInPaise;
  return (
    <div className="space-y-6">
      {/* Safety banner */}
      <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', padding: '10px 16px', borderRadius: 3 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: '#92400E', letterSpacing: '0.04em' }}>
          SIMULATION ONLY — NO RECOVERY ACTIONS EXECUTED
        </p>
        <p style={{ fontSize: 11, color: '#B45309', marginTop: 2 }}>All figures are estimated projections.</p>
      </div>

      {/* Key metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, borderTop: '1px solid #E5E5E3', borderBottom: '1px solid #E5E5E3' }}>
        <SimMetric label="Payments" value={String(result.eligiblePaymentCount)} />
        <SimMetric label="Targeted" value={formatPaise(result.targetedFailedRevenueInPaise)} />
        <SimMetric label="Est. Recovery" value={formatPaise(result.estimatedRecoverableRevenueInPaise)} color="#059669" />
        <SimMetric label="Est. Rate" value={formatPercent(result.estimatedRecoveryRate)} last />
      </div>

      {/* Policy impact */}
      <div>
        <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 16 }}>
          Policy Impact
        </p>
        <div style={{ display: 'flex', gap: 32 }}>
          <PolicyStat label="Approved" value={result.policyApprovedCount} color="#059669" />
          <PolicyStat label="Modified" value={result.policyModifiedCount} color="#D97706" />
          <PolicyStat label="Blocked"  value={result.policyBlockedCount}  color="#DC2626" />
        </div>
      </div>

      {/* Baseline comparison */}
      {result.eligiblePaymentCount > 0 && (
        <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 16 }}>
          <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 12 }}>
            vs. Current Baseline
          </p>
          <div style={{ display: 'flex', gap: 32 }}>
            <BaseStat label="Current baseline" value={formatPaise(result.baselineEstimatedRecoverableInPaise)} />
            <BaseStat label="Scenario estimate" value={formatPaise(result.estimatedRecoverableRevenueInPaise)} />
            <div>
              <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>Difference</p>
              <p style={{ fontSize: 18, fontWeight: 500, color: delta > 0 ? '#059669' : delta < 0 ? '#DC2626' : '#9CA3AF' }}>
                {delta >= 0 ? '+' : ''}{formatPaise(delta)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Notes */}
      {result.notes.length > 0 && (
        <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 16 }}>
          <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>Notes</p>
          <ul className="space-y-1">
            {result.notes.map((note, i) => (
              <li key={i} style={{ fontSize: 11, color: note.startsWith('SIMULATION') ? '#92400E' : '#6B7280', fontWeight: note.startsWith('SIMULATION') ? 600 : 400 }}>
                {note.startsWith('SIMULATION') ? note : `· ${note}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Payment breakdown */}
      <div style={{ borderTop: '1px solid #E5E5E3', paddingTop: 16 }}>
        <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 16 }}>
          Payment Breakdown
        </p>
        <PaymentBreakdown results={result.paymentResults} />
      </div>
    </div>
  );
}

function SimMetric({ label, value, color, last = false }: { label: string; value: string; color?: string; last?: boolean }) {
  return (
    <div style={{ padding: '16px 20px', borderRight: last ? 'none' : '1px solid #E5E5E3' }}>
      <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 22, fontWeight: 300, color: color ?? '#111' }}>{value}</p>
    </div>
  );
}

function PolicyStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 300, color }}>{value}</p>
    </div>
  );
}

function BaseStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ fontSize: '9px', color: '#CCCCCC', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 16, fontWeight: 400, color: '#333' }}>{value}</p>
    </div>
  );
}

// ── Custom scenario form ──────────────────────────────────────────────────────

interface CustomFormState {
  recoveryPriority: string[];
  riskLevel: string[];
  paymentMethods: string[];
  failureReasons: string[];
  strategyMode: string;
  retryDelayMinutes: number;
}

const DEFAULT_CUSTOM: CustomFormState = {
  recoveryPriority: [],
  riskLevel: [],
  paymentMethods: [],
  failureReasons: [],
  strategyMode: 'USE_CURRENT_RECOMMENDATION',
  retryDelayMinutes: 60,
};

function toggle(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
}

function ToggleGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div>
      <p style={{ fontSize: '9px', color: '#AAAAAA', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onToggle(opt.value)}
              style={{
                fontSize: 11,
                padding: '4px 12px',
                borderRadius: 2,
                border: `1px solid ${active ? '#111' : '#E5E5E3'}`,
                background: active ? '#111' : 'white',
                color: active ? 'white' : '#6B7280',
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
                fontWeight: active ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CustomScenarioForm({ onResult }: { onResult: (r: RecoverySimulationResult) => void }) {
  const [form, setForm] = useState<CustomFormState>(DEFAULT_CUSTOM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCustom() {
    setLoading(true);
    setError(null);
    try {
      const filters: Record<string, unknown> = {};
      if (form.recoveryPriority.length > 0) filters['recoveryPriority'] = form.recoveryPriority;
      if (form.riskLevel.length > 0) filters['riskLevel'] = form.riskLevel;
      if (form.paymentMethods.length > 0) filters['paymentMethods'] = form.paymentMethods;
      if (form.failureReasons.length > 0) filters['failureReasons'] = form.failureReasons;

      const strategy: Record<string, unknown> = { mode: form.strategyMode };
      if (form.strategyMode === 'FIXED_RETRY_DELAY') {
        strategy['retryDelayMinutes'] = form.retryDelayMinutes;
      }

      const scenario: RecoverySimulationScenario = {
        id: 'custom',
        name: 'Custom Scenario',
        description: 'Operator-defined custom simulation',
        type: 'CUSTOM',
        filters: filters as RecoverySimulationScenario['filters'],
        strategy: strategy as unknown as RecoverySimulationScenario['strategy'],
      };

      const res = await fetch('/api/simulator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenario),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? 'Simulation failed');
      }
      onResult(await res.json() as RecoverySimulationResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <ToggleGroup
        label="Recovery Priority"
        options={[{ value: 'HIGH', label: 'HIGH' }, { value: 'MEDIUM', label: 'MEDIUM' }, { value: 'LOW', label: 'LOW' }]}
        selected={form.recoveryPriority}
        onToggle={(v) => setForm((f) => ({ ...f, recoveryPriority: toggle(f.recoveryPriority, v) }))}
      />
      <ToggleGroup
        label="Risk Level"
        options={[{ value: 'CRITICAL', label: 'Critical' }, { value: 'HIGH', label: 'High' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'LOW', label: 'Low' }]}
        selected={form.riskLevel}
        onToggle={(v) => setForm((f) => ({ ...f, riskLevel: toggle(f.riskLevel, v) }))}
      />
      <ToggleGroup
        label="Payment Method"
        options={[{ value: 'UPI', label: 'UPI' }, { value: 'CARD', label: 'Card' }, { value: 'NETBANKING', label: 'Netbanking' }, { value: 'WALLET', label: 'Wallet' }]}
        selected={form.paymentMethods}
        onToggle={(v) => setForm((f) => ({ ...f, paymentMethods: toggle(f.paymentMethods, v) }))}
      />
      <ToggleGroup
        label="Failure Reason"
        options={[
          { value: 'UPI_TIMEOUT', label: 'UPI Timeout' },
          { value: 'BANK_SERVER_ERROR', label: 'Bank Error' },
          { value: 'INSUFFICIENT_BALANCE', label: 'Insuf. Balance' },
          { value: 'EXPIRED_CARD', label: 'Expired Card' },
          { value: 'AUTHENTICATION_FAILED', label: 'Auth Failed' },
          { value: 'CUSTOMER_ABANDONED', label: 'Abandoned' },
        ]}
        selected={form.failureReasons}
        onToggle={(v) => setForm((f) => ({ ...f, failureReasons: toggle(f.failureReasons, v) }))}
      />

      <div>
        <p style={{ fontSize: '9px', color: '#AAAAAA', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>Strategy</p>
        <select
          value={form.strategyMode}
          onChange={(e) => setForm((f) => ({ ...f, strategyMode: e.target.value }))}
          style={{ fontSize: 12, border: '1px solid #E5E5E3', padding: '6px 12px', borderRadius: 2, background: 'white', color: '#333' }}
        >
          <option value="USE_CURRENT_RECOMMENDATION">Use Current Recommendation</option>
          <option value="FIXED_RETRY_DELAY">Fixed Retry Delay</option>
          <option value="USE_METHOD_SWITCH">Use Method Switch</option>
          <option value="BEST_OBSERVED_STRATEGY">Best Observed Strategy</option>
        </select>
      </div>

      {form.strategyMode === 'FIXED_RETRY_DELAY' && (
        <div>
          <p style={{ fontSize: '9px', color: '#AAAAAA', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 8 }}>
            Retry Delay (minutes)
          </p>
          <input
            type="number" min={1} max={10080}
            value={form.retryDelayMinutes}
            onChange={(e) => setForm((f) => ({ ...f, retryDelayMinutes: Number(e.target.value) }))}
            style={{ fontSize: 12, border: '1px solid #E5E5E3', padding: '6px 12px', borderRadius: 2, background: 'white', width: 100 }}
          />
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: '#DC2626' }}>{error}</p>}

      <button
        type="button"
        onClick={() => void runCustom()}
        disabled={loading}
        className="arrow-link"
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: loading ? '#9CA3AF' : '#111',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: loading ? 'default' : 'pointer',
          letterSpacing: '0.02em',
        }}
      >
        {loading ? 'Running…' : <>Run Simulation <span className="arrow">→</span></>}
      </button>
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export interface WhatIfSimulatorSectionProps {
  presetSimulations: RecoverySimulationResult[];
}

const TAB_CUSTOM = '__custom__';

export function WhatIfSimulatorSection({ presetSimulations }: WhatIfSimulatorSectionProps) {
  const defaultTab = presetSimulations[0]?.scenarioId ?? TAB_CUSTOM;
  const [selectedTab, setSelectedTab] = useState<string>(defaultTab);
  const [customResult, setCustomResult] = useState<RecoverySimulationResult | null>(null);

  const selectedPreset = presetSimulations.find((r) => r.scenarioId === selectedTab) ?? null;
  const isCustom       = selectedTab === TAB_CUSTOM;
  const activeResult   = isCustom ? customResult : selectedPreset;

  return (
    <div style={{ borderTop: '1px solid #E5E5E3' }}>
      {/* WHAT IF? hero header */}
      <div className="py-8">
        <p
          className="uppercase text-neutral-400 font-medium mb-1"
          style={{ fontSize: '10px', letterSpacing: '0.3em' }}
        >
          Recovery Simulator
        </p>
        <p style={{ fontSize: 32, fontWeight: 200, color: '#111', letterSpacing: '-0.01em' }}>
          What if?
        </p>
        <p style={{ fontSize: 14, color: '#9CA3AF', marginTop: 4 }}>
          Test hypothetical recovery scenarios safely. No actions are executed.
        </p>
      </div>

      {/* Scenario selector */}
      <div
        className="flex flex-wrap gap-0 pb-4"
        style={{ borderBottom: '1px solid #E5E5E3' }}
      >
        {presetSimulations.map((r) => {
          const active = selectedTab === r.scenarioId;
          return (
            <button
              key={r.scenarioId}
              type="button"
              onClick={() => setSelectedTab(r.scenarioId)}
              style={{
                fontSize: 12,
                padding: '6px 16px 6px 0',
                background: 'none',
                border: 'none',
                borderBottom: active ? '1.5px solid #111' : '1.5px solid transparent',
                color: active ? '#111' : '#9CA3AF',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                marginRight: 8,
                transition: 'color 120ms ease-out',
              }}
            >
              {r.scenarioName}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSelectedTab(TAB_CUSTOM)}
          style={{
            fontSize: 12,
            padding: '6px 16px 6px 0',
            background: 'none',
            border: 'none',
            borderBottom: isCustom ? '1.5px solid #111' : '1.5px solid transparent',
            color: isCustom ? '#111' : '#9CA3AF',
            fontWeight: isCustom ? 600 : 400,
            cursor: 'pointer',
            transition: 'color 120ms ease-out',
          }}
        >
          Custom Scenario
        </button>
      </div>

      {/* Scenario description */}
      {!isCustom && selectedPreset && (
        <p style={{ fontSize: 12, color: '#9CA3AF', padding: '16px 0' }}>
          {selectedPreset.scenarioDescription}
        </p>
      )}

      {/* Custom form */}
      {isCustom && (
        <div style={{ padding: '24px 0 24px 0', borderBottom: '1px solid #E5E5E3', marginBottom: 24 }}>
          <CustomScenarioForm onResult={setCustomResult} />
        </div>
      )}

      {/* Results */}
      <div className="py-6">
        {activeResult !== null ? (
          <SimulationResultCard result={activeResult} />
        ) : isCustom ? (
          <p style={{ fontSize: 13, color: '#9CA3AF', padding: '32px 0', textAlign: 'center' }}>
            Configure filters above and run the simulation to see results.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: '#9CA3AF', padding: '32px 0', textAlign: 'center' }}>
            No simulation data available for this scenario.
          </p>
        )}
      </div>
    </div>
  );
}
