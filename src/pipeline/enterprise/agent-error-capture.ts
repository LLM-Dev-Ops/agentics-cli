/**
 * ADR-PIPELINE-094 Decision 6 — Phase 1 diligence-agent error capture.
 *
 * Persists agent invocation failures from the enterprise simulation passes
 * (Phase 1) to `<runDir>/agent-errors.json` and emits a 200-char excerpt for
 * `status.json.phase1.failed_agents[]`. Pre-094 these errors were dropped on
 * the floor — autochain.log only said "errored", which made the originating
 * `4ed715bf` run's 4 of 12 agent failures untriageable.
 *
 * The persistence is best-effort: never throws, never blocks the pipeline
 * on an I/O failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentInvocationResult,
  PassOutput,
} from './types.js';

/** Single failed-agent entry written to agent-errors.json. */
export interface FailedAgentEntry {
  readonly domain: string;
  readonly agent: string;
  readonly role: string;
  readonly pass: number;
  readonly status: number;
  readonly duration_ms: number;
  readonly timestamp: string;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly stack_excerpt?: string;
    readonly tier: 'cloud' | 'local' | 'unknown';
    readonly first_byte_ms?: number;
  };
}

/** Top-level shape of `<runDir>/agent-errors.json`. */
export interface AgentErrorsFile {
  readonly trace_id: string;
  readonly captured_at: string;
  readonly total_failures: number;
  readonly failures: ReadonlyArray<FailedAgentEntry>;
}

/** 200-char excerpt entry for status.json. */
export interface StatusFailedAgentSummary {
  readonly domain: string;
  readonly agent: string;
  readonly role: string;
  readonly tier: string;
  readonly error_excerpt: string;
}

/**
 * Selects failures from a list of pass outputs. A failure is any
 * `AgentInvocationResult` with `error` populated OR `status >= 400`.
 */
export function collectFailedAgents(
  passOutputs: ReadonlyArray<PassOutput>,
): FailedAgentEntry[] {
  const failures: FailedAgentEntry[] = [];
  for (const pass of passOutputs) {
    for (const r of pass.agentResults ?? []) {
      if (!isFailedResult(r)) continue;
      failures.push(toFailedEntry(r));
    }
  }
  return failures;
}

function isFailedResult(r: AgentInvocationResult): boolean {
  if (r.error) return true;
  if (typeof r.status === 'number' && r.status >= 400) return true;
  return false;
}

function toFailedEntry(r: AgentInvocationResult): FailedAgentEntry {
  // Synthesize an error if the result was status>=400 without `error` field
  // (defensive — newer code always populates `error` in the catch branch).
  const err = r.error ?? {
    type: 'HttpError',
    message: `agent returned status ${r.status}`,
    tier: 'unknown' as const,
  };
  return {
    domain: r.agent.domain,
    agent: r.agent.agent,
    role: r.agent.role,
    pass: r.pass,
    status: r.status,
    duration_ms: r.durationMs,
    timestamp: r.timestamp,
    error: err,
  };
}

/**
 * Persists `<runDir>/agent-errors.json`. No-op when there are no failures.
 * Never throws — I/O errors emit a stderr line and return.
 *
 * @param runDir absolute path to the simulation run directory
 * @param traceId the run's trace ID (mirrored into the file for joinability)
 * @param passOutputs all enterprise passes; failures are pulled from each
 */
export function persistAgentErrors(
  runDir: string,
  traceId: string,
  passOutputs: ReadonlyArray<PassOutput>,
): void {
  const failures = collectFailedAgents(passOutputs);
  if (failures.length === 0) return;

  const file: AgentErrorsFile = {
    trace_id: traceId,
    captured_at: new Date().toISOString(),
    total_failures: failures.length,
    failures,
  };

  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'agent-errors.json'),
      JSON.stringify(file, null, 2) + '\n',
      'utf8',
    );
  } catch (err) {
    process.stderr.write(
      `[AGENT-ERRORS] failed to write agent-errors.json — ${(err as Error).message}\n`,
    );
  }
}

/**
 * Builds the `phase1.failed_agents[]` summary array for status.json.
 * Truncates each error message to 200 chars per ADR-094 D6.
 */
export function buildFailedAgentsForStatus(
  passOutputs: ReadonlyArray<PassOutput>,
): StatusFailedAgentSummary[] {
  const failures = collectFailedAgents(passOutputs);
  return failures.map((f) => ({
    domain: f.domain,
    agent: f.agent,
    role: f.role,
    tier: f.error.tier,
    error_excerpt: f.error.message.length > 200
      ? f.error.message.slice(0, 200) + '…'
      : f.error.message,
  }));
}

/**
 * ADR-094 D6 — patch `status.json` at `<runDir>/status.json` with the
 * `phase1.failed_agents[]` summary so `agentics status` and the
 * `agentics-status` MCP tool can surface failures without re-reading
 * `agent-errors.json`. Mirrors the ADR-089 §6 / Phase-2 preflight pattern
 * already in `swarm-orchestrator.ts:writePhase2PreflightToStatus`.
 *
 * Best-effort: if status.json does not exist (shell-mode runs that don't
 * pre-create it), or write fails, returns silently. Never throws.
 */
export function writeFailedAgentsToStatus(
  runDir: string,
  passOutputs: ReadonlyArray<PassOutput>,
): void {
  const summaries = buildFailedAgentsForStatus(passOutputs);
  if (summaries.length === 0) return;

  const statusPath = path.join(runDir, 'status.json');
  let current: Record<string, unknown>;
  try {
    if (!fs.existsSync(statusPath)) return;
    current = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(
      `[AGENT-ERRORS] could not read status.json — ${(err as Error).message}\n`,
    );
    return;
  }

  // Merge into existing phase1 block (preserves existing fields like
  // phase1_verdict, phase1_reason, phase1_stats from ADR-089).
  const phase1 = (current['phase1'] as Record<string, unknown> | undefined) ?? {};
  phase1['failed_agents'] = summaries;
  phase1['failed_agents_count'] = summaries.length;
  phase1['failed_agents_captured_at'] = new Date().toISOString();
  current['phase1'] = phase1;

  // Atomic write via temp + rename to avoid partial-write races against
  // concurrent status readers.
  try {
    const tmp = statusPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, statusPath);
  } catch (err) {
    process.stderr.write(
      `[AGENT-ERRORS] could not patch status.json — ${(err as Error).message}\n`,
    );
  }
}
