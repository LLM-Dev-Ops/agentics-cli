/**
 * ADR-PIPELINE-094 Decision 6 — Phase 1 diligence-agent error capture.
 *
 * Verifies agent-errors.json is written with full message + stack + type
 * + tier when an enterprise-pass agent fails. Pre-094 these errors were
 * dropped on the floor (autochain.log only said "errored").
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectFailedAgents,
  persistAgentErrors,
  buildFailedAgentsForStatus,
  writeFailedAgentsToStatus,
  type FailedAgentEntry,
  type AgentErrorsFile,
} from '../../../../src/pipeline/enterprise/agent-error-capture.js';
import type {
  AgentInvocationResult,
  PassOutput,
  PassNumber,
} from '../../../../src/pipeline/enterprise/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-err-094-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeFailedResult(
  domain: string,
  agent: string,
  message: string,
  pass: PassNumber = 1,
  type = 'TimeoutError',
): AgentInvocationResult {
  return {
    agent: { domain, agent, role: `${domain}-${agent}-role` },
    status: 500,
    response: { error: message },
    durationMs: 30050,
    pass,
    timestamp: '2026-04-25T02:56:09.000Z',
    error: {
      type,
      message,
      stack_excerpt: `${type}: ${message}\n    at fetch (/.../adapter.ts:42:11)`,
      tier: 'cloud',
      first_byte_ms: 30050,
    },
  };
}

function makeSuccessResult(domain: string, agent: string, pass: PassNumber = 1): AgentInvocationResult {
  return {
    agent: { domain, agent, role: `${domain}-${agent}-role` },
    status: 200,
    response: { ok: true },
    durationMs: 1200,
    pass,
    timestamp: '2026-04-25T02:56:10.000Z',
  };
}

function makePassOutput(passNum: PassNumber, agentResults: AgentInvocationResult[]): PassOutput {
  return {
    pass: 'pass-1' as PassOutput['pass'],
    passNumber: passNum,
    status: 'completed',
    data: {},
    artifacts: [],
    agentResults,
    durationMs: 1000,
    summary: 'test',
  };
}

describe('ADR-094 D6 — collectFailedAgents', () => {
  it('returns failures with full error detail and skips successes', () => {
    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', 'agent invocation exceeded 30000ms'),
      makeSuccessResult('simulator', 'enterprise'),
      makeFailedResult('diligence-artifacts', 'adr-generation', 'connection refused'),
    ])];

    const failures = collectFailedAgents(passes);
    expect(failures).toHaveLength(2);
    expect(failures[0]!.agent).toBe('sparc-specification');
    expect(failures[0]!.error.type).toBe('TimeoutError');
    expect(failures[0]!.error.message).toContain('30000ms');
    expect(failures[0]!.error.stack_excerpt).toBeTruthy();
    expect(failures[0]!.error.tier).toBe('cloud');
    expect(failures[1]!.agent).toBe('adr-generation');
  });

  it('treats status >= 400 without explicit error as a failure', () => {
    const result: AgentInvocationResult = {
      agent: { domain: 'diligence-artifacts', agent: 'sparc-merge', role: 'merge' },
      status: 503,
      response: { error: 'Service Unavailable' },
      durationMs: 100,
      pass: 1,
      timestamp: '2026-04-25T02:56:09.000Z',
    };
    const passes = [makePassOutput(1, [result])];
    const failures = collectFailedAgents(passes);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error.type).toBe('HttpError');
  });

  it('returns empty array when no failures', () => {
    const passes = [makePassOutput(1, [
      makeSuccessResult('simulator', 'enterprise'),
      makeSuccessResult('research-lab', 'hypothesis'),
    ])];
    expect(collectFailedAgents(passes)).toEqual([]);
  });
});

describe('ADR-094 D6 — persistAgentErrors', () => {
  it('writes agent-errors.json to <runDir> with full failure detail', () => {
    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', 'timed out'),
      makeFailedResult('diligence-artifacts', 'adr-generation', 'ECONNREFUSED'),
      makeFailedResult('test-bench', 'regression', '503 Service Unavailable'),
      makeFailedResult('diligence-artifacts', 'sparc-merge', 'merge conflict in stage outputs'),
    ])];

    persistAgentErrors(tmpDir, 'trace-094-d6', passes);

    const target = path.join(tmpDir, 'agent-errors.json');
    expect(fs.existsSync(target)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as AgentErrorsFile;
    expect(parsed.trace_id).toBe('trace-094-d6');
    expect(parsed.total_failures).toBe(4);
    expect(parsed.failures).toHaveLength(4);
    const agentNames = parsed.failures.map((f: FailedAgentEntry) => f.agent).sort();
    expect(agentNames).toEqual(['adr-generation', 'regression', 'sparc-merge', 'sparc-specification']);
    for (const f of parsed.failures) {
      expect(f.error.message).toBeTruthy();
      expect(f.error.tier).toBeTruthy();
    }
  });

  it('does not write the file when there are no failures', () => {
    const passes = [makePassOutput(1, [makeSuccessResult('simulator', 'enterprise')])];
    persistAgentErrors(tmpDir, 'trace-094-d6-clean', passes);
    expect(fs.existsSync(path.join(tmpDir, 'agent-errors.json'))).toBe(false);
  });

  it('is best-effort — does not throw when runDir is unwritable (returns silently)', () => {
    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', 'err'),
    ])];
    // Use a fake unwritable path; persistAgentErrors must swallow the error.
    expect(() => persistAgentErrors('/nonexistent/path/that-does-not-exist/094', 'trace', passes)).not.toThrow();
  });
});

describe('ADR-094 D6 — writeFailedAgentsToStatus', () => {
  it('patches phase1.failed_agents[] into an existing status.json', () => {
    // Pre-create status.json with existing fields (mirrors ADR-089 §6 layout).
    const statusPath = path.join(tmpDir, 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify({
      phase1: { phase1_verdict: 'degraded', phase1_reason: 'agents errored' },
      phase2_preflight: { probed: 7, healthy: ['simulator-agents'] },
    }, null, 2));

    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', 'timed out at 30s'),
      makeFailedResult('diligence-artifacts', 'sparc-merge', 'merge failed'),
    ])];

    writeFailedAgentsToStatus(tmpDir, passes);

    const updated = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    const phase1 = updated['phase1'] as Record<string, unknown>;
    // Existing fields preserved
    expect(phase1['phase1_verdict']).toBe('degraded');
    expect(phase1['phase1_reason']).toBe('agents errored');
    // New fields added
    expect(Array.isArray(phase1['failed_agents'])).toBe(true);
    expect((phase1['failed_agents'] as unknown[]).length).toBe(2);
    expect(phase1['failed_agents_count']).toBe(2);
    expect(typeof phase1['failed_agents_captured_at']).toBe('string');
    // Sibling phase2_preflight untouched
    expect(updated['phase2_preflight']).toBeDefined();
  });

  it('is a no-op when status.json does not exist (shell-mode runs)', () => {
    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', 'err'),
    ])];
    writeFailedAgentsToStatus(tmpDir, passes);
    expect(fs.existsSync(path.join(tmpDir, 'status.json'))).toBe(false);
  });

  it('is a no-op when there are no failed agents', () => {
    const statusPath = path.join(tmpDir, 'status.json');
    const original = JSON.stringify({ phase1: { phase1_verdict: 'healthy' } });
    fs.writeFileSync(statusPath, original);

    writeFailedAgentsToStatus(tmpDir, [makePassOutput(1, [makeSuccessResult('simulator', 'enterprise')])]);

    expect(fs.readFileSync(statusPath, 'utf8')).toBe(original);
  });
});

describe('ADR-094 D6 — buildFailedAgentsForStatus', () => {
  it('produces 200-char-truncated excerpts for status.json.phase1.failed_agents[]', () => {
    const longMsg = 'x'.repeat(500);
    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', longMsg),
    ])];

    const summaries = buildFailedAgentsForStatus(passes);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.error_excerpt.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(summaries[0]!.error_excerpt.endsWith('…')).toBe(true);
    expect(summaries[0]!.tier).toBe('cloud');
    expect(summaries[0]!.domain).toBe('diligence-artifacts');
    expect(summaries[0]!.agent).toBe('sparc-specification');
  });

  it('does not truncate short messages', () => {
    const passes = [makePassOutput(1, [
      makeFailedResult('diligence-artifacts', 'sparc-specification', 'short error'),
    ])];
    const summaries = buildFailedAgentsForStatus(passes);
    expect(summaries[0]!.error_excerpt).toBe('short error');
  });
});
