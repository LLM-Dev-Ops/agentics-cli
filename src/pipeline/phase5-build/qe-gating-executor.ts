/**
 * QE Gating Executor (ADR-PIPELINE-086)
 *
 * Encapsulates the phase-8-validation decision tree driven by the gating mode
 * resolved from env / persisted config (see src/config/qe-gating.ts).
 *
 * Contract:
 *   on       → run all mandatory QE agents; any failure halts the pipeline
 *              with exit code 141 (via Ruvector Acceptance Gate integration
 *              upstream). The executor returns `status: 'completed'` or throws.
 *   advisory → run all mandatory QE agents; failures become warnings in the
 *              output. Returns `status: 'completed_with_warnings'`.
 *   off      → skip QE invocation entirely. Returns `status: 'bypassed'`.
 *
 * The executor is pure — it does not invoke agents itself; callers pass in an
 * `invokeAgent` callback. This keeps the module testable without a live
 * pipeline and independent of adapter implementation.
 */

import type { QeGatingMode, ResolvedQeGating } from '../../config/qe-gating.js';
import { resolveQeGatingMode } from '../../config/qe-gating.js';

// ============================================================================
// Types
// ============================================================================

export type Phase8Status = 'completed' | 'completed_with_warnings' | 'bypassed';

export interface QeAgentInvocation {
  agent: string;
  status: 200 | 502;
  data?: Record<string, unknown>;
  error?: string;
  timing_ms?: number;
}

export interface QeExecutionOutcome {
  status: Phase8Status;
  mode: QeGatingMode;
  source: ResolvedQeGating['source'];
  invocations: readonly QeAgentInvocation[];
  warnings: readonly string[];
  bypassRecord?: BypassRecord;
  /** Exit code upstream should propagate on failure (on mode only). */
  exitCode?: number;
}

export interface BypassRecord {
  timestamp: string;
  mode: 'advisory' | 'off';
  source: ResolvedQeGating['source'];
  reason?: string;
  correlation_id: string;
  affected_agents: readonly string[];
}

export type InvokeAgentFn = (agentId: string) => Promise<QeAgentInvocation>;

export interface ExecuteOptions {
  correlationId: string;
  /** Explicit mode override (tests). If omitted, resolves from env/persisted. */
  modeOverride?: ResolvedQeGating;
  /** Clock override. */
  now?: Date;
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Run phase-8 QE validation per the gating mode.
 *
 * @param mandatoryAgents — list of agent IDs the phase requires (from ADR-083)
 * @param invokeAgent — callback that dispatches a single agent invocation
 * @param options — correlation id + optional mode override
 */
export async function executePhase8Qe(
  mandatoryAgents: readonly string[],
  invokeAgent: InvokeAgentFn,
  options: ExecuteOptions,
): Promise<QeExecutionOutcome> {
  const resolved = options.modeOverride ?? resolveQeGatingMode();
  const now = options.now ?? new Date();

  if (resolved.mode === 'off') {
    const bypass: BypassRecord = {
      timestamp: now.toISOString(),
      mode: 'off',
      source: resolved.source,
      ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
      correlation_id: options.correlationId,
      affected_agents: [...mandatoryAgents],
    };
    emitBypassLog(bypass);
    return {
      status: 'bypassed',
      mode: 'off',
      source: resolved.source,
      invocations: [],
      warnings: [`QE gating bypassed (off): ${mandatoryAgents.length} mandatory agents skipped`],
      bypassRecord: bypass,
    };
  }

  const invocations: QeAgentInvocation[] = [];
  for (const agent of mandatoryAgents) {
    invocations.push(await invokeAgent(agent));
  }

  const failures = invocations.filter(i => i.status !== 200);

  if (resolved.mode === 'advisory') {
    const bypass: BypassRecord = {
      timestamp: now.toISOString(),
      mode: 'advisory',
      source: resolved.source,
      ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
      correlation_id: options.correlationId,
      affected_agents: failures.map(f => f.agent),
    };
    if (failures.length > 0) emitBypassLog(bypass);

    return {
      status: failures.length > 0 ? 'completed_with_warnings' : 'completed',
      mode: 'advisory',
      source: resolved.source,
      invocations,
      warnings: failures.map(f => `QE agent "${f.agent}" failed (${f.error ?? 'status ' + f.status}); advisory mode — not blocking`),
      ...(failures.length > 0 ? { bypassRecord: bypass } : {}),
    };
  }

  // mode === 'on' — any failure is a halting condition.
  if (failures.length > 0) {
    return {
      status: 'completed_with_warnings',  // caller upgrades to halt via exit code
      mode: 'on',
      source: resolved.source,
      invocations,
      warnings: failures.map(f => `QE agent "${f.agent}" failed (${f.error ?? 'status ' + f.status})`),
      exitCode: 141,
    };
  }

  return {
    status: 'completed',
    mode: 'on',
    source: resolved.source,
    invocations,
    warnings: [],
  };
}

// ============================================================================
// Bypass logging
// ============================================================================

/**
 * Emit a structured JSON log line to stderr describing a gating bypass.
 * Observatory consumes this via the standard stderr-to-metrics pipeline.
 */
export function emitBypassLog(record: BypassRecord, writeLine: (s: string) => void = (s) => process.stderr.write(s)): void {
  writeLine(JSON.stringify({
    level: 'WARN',
    event: 'qe_gating_bypass',
    ...record,
  }) + '\n');
}

// ============================================================================
// VALIDATION_REPORT header for bypassed runs
// ============================================================================

/**
 * Build the Markdown header block stamped onto VALIDATION_REPORT.md when a
 * bypass occurs. Callers prepend this to the normal report body so reviewers
 * see the bypass at the top.
 */
export function buildValidationReportBypassHeader(record: BypassRecord): string {
  const modeLabel = record.mode === 'off' ? 'OFF (skipped)' : 'ADVISORY (warnings-only)';
  const reasonLine = record.reason ? `> Reason: ${record.reason}` : '> Reason: (not provided)';
  return [
    '> ⚠️ **QE GATING BYPASSED**',
    `> Mode: ${modeLabel}`,
    `> Source: ${record.source} config`,
    reasonLine,
    `> Timestamp: ${record.timestamp}`,
    `> Correlation: ${record.correlation_id}`,
    `> Affected agents: ${record.affected_agents.length > 0 ? record.affected_agents.join(', ') : '(none — full bypass)'}`,
    '>',
    '> See ADR-PIPELINE-086 and `docs/runbooks/qe-gating-recovery-086.md` for recovery.',
    '',
  ].join('\n');
}
