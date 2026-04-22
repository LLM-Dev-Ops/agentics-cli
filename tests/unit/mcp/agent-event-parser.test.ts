/**
 * ADR-PIPELINE-090 tests — stderr → AgentEvent parser + report formatter.
 *
 * These regexes interpret log lines emitted by three files:
 *   - src/commands/agents.ts              ([RUVECTOR], [local])
 *   - src/pipeline/swarm-orchestrator.ts  ([AGENTICS] [OK|FAIL|FB|!!])
 *   - src/pipeline/auto-chain.ts          (>> Phase N: ...)
 * A drift in any of those prefixes would silently drop events from the
 * Agent Invocation Report, so these tests are the contract between those
 * emitters and the MCP parser.
 */

import { describe, it, expect } from '@jest/globals';
import { parseAgentEvent, formatAgentEventLive, formatAgentReport, type AgentEvent } from '../../../src/mcp/agent-event-parser.js';

describe('parseAgentEvent', () => {
  it('parses a Phase 2 header and updates state.phase', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('  >> Phase 2: Deep Research', state);
    expect(ev?.kind).toBe('phase-header');
    expect(ev?.phase).toBe(2);
    expect(ev?.role).toBe('Deep Research');
    expect(state.phase).toBe(2);
  });

  it('parses [RUVECTOR] simulation start', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('  [RUVECTOR] Running simulation before graph-routed dispatch (ADR-016)...', state);
    expect(ev?.kind).toBe('sim-start');
    expect(ev?.domain).toBe('simulator');
    expect(ev?.agent).toBe('enterprise');
  });

  it('parses [RUVECTOR] simulation success', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('  [RUVECTOR] Simulation succeeded', state);
    expect(ev?.kind).toBe('sim-ok');
  });

  it('parses [RUVECTOR] retry line', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('  [RUVECTOR] Retry 1/3 after 10s backoff...', state);
    expect(ev?.kind).toBe('sim-retry');
  });

  it('parses [RUVECTOR] terminal-error line (ADR-089)', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('  [RUVECTOR] Terminal error (not retrying): contract_violation', state);
    expect(ev?.kind).toBe('sim-fail');
    expect(ev?.reason).toContain('contract_violation');
  });

  it('parses [AGENTICS] [OK] agent line with timing', () => {
    const state = { phase: 2 };
    const ev = parseAgentEvent('  [AGENTICS] [OK] copilot/planner (Research planner) — 93867ms', state);
    expect(ev?.kind).toBe('ok');
    expect(ev?.domain).toBe('copilot');
    expect(ev?.agent).toBe('planner');
    expect(ev?.role).toBe('Research planner');
    expect(ev?.timingMs).toBe(93867);
    expect(ev?.phase).toBe(2);
  });

  it('parses [AGENTICS] [FAIL] with failure suffix', () => {
    const state = { phase: 2 };
    const ev = parseAgentEvent('  [AGENTICS] [FAIL] research-lab/hypothesis (Research hypothesis tester) — 30000ms Agent research-lab/hypothesis timed out', state);
    expect(ev?.kind).toBe('fail');
    expect(ev?.timingMs).toBe(30000);
    expect(ev?.reason).toContain('timed out');
  });

  it('parses [AGENTICS] [FB] local fallback suffix', () => {
    const state = { phase: 2 };
    const ev = parseAgentEvent('  [AGENTICS] [FB] research-lab/hypothesis (Research hypothesis tester) — 1558ms (local fallback)', state);
    expect(ev?.kind).toBe('fallback');
    expect(ev?.domain).toBe('research-lab');
  });

  it('parses [local] dispatcher fallback line with reason', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('[local] costops/attribution using local compute: Service unreachable', state);
    expect(ev?.kind).toBe('fallback');
    expect(ev?.domain).toBe('costops');
    expect(ev?.agent).toBe('attribution');
    expect(ev?.reason).toBe('Service unreachable');
  });

  it('parses [local] dispatcher fallback line without reason', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('[local] copilot/planner missing API key', state);
    // This line is the legacy pattern that doesn't include "using local compute"
    // — intentionally NOT matched; the caller logs a separate [AGENTICS] line
    // for the actual agent outcome.
    expect(ev).toBeNull();
  });

  it('parses [PREFLIGHT] ADR-089 line', () => {
    const state = { phase: 2 };
    const ev = parseAgentEvent('  [PREFLIGHT] 2/7 backends healthy in 3012ms (verdict: abort)', state);
    expect(ev?.kind).toBe('preflight');
    expect(ev?.reason).toContain('2/7 backends healthy');
  });

  it('parses Phase 1 verdict DEGRADED (ADR-089)', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('Phase 1 verdict: DEGRADED — 2 of 5 agents errored; local-fallback × 3', state);
    expect(ev?.kind).toBe('verdict');
    expect(ev?.role).toBe('DEGRADED');
    expect(ev?.reason).toContain('agents errored');
  });

  it('returns null for unrelated lines', () => {
    const state = { phase: 1 };
    expect(parseAgentEvent('Capability graph routing — 5 agents across 2 repos', state)).toBeNull();
    expect(parseAgentEvent('', state)).toBeNull();
    expect(parseAgentEvent('  ', state)).toBeNull();
  });

  it('strips ANSI escape codes', () => {
    const state = { phase: 1 };
    const ev = parseAgentEvent('\x1b[32m  [RUVECTOR] Simulation succeeded\x1b[0m', state);
    expect(ev?.kind).toBe('sim-ok');
  });
});

describe('formatAgentEventLive', () => {
  it('formats an ok event into a short line with timing', () => {
    const ev: AgentEvent = { phase: 2, kind: 'ok', domain: 'copilot', agent: 'planner', timingMs: 387, raw: '' };
    const line = formatAgentEventLive(ev);
    expect(line).toContain('copilot/planner');
    expect(line).toContain('(387ms)');
    expect(line).toContain('✓');
  });

  it('formats a fallback event with source hint', () => {
    const ev: AgentEvent = { phase: 1, kind: 'fallback', domain: 'costops', agent: 'attribution', raw: '' };
    const line = formatAgentEventLive(ev);
    expect(line).toContain('⚠');
    expect(line).toContain('local fallback');
  });
});

describe('formatAgentReport', () => {
  it('returns empty string for empty event list', () => {
    expect(formatAgentReport([])).toBe('');
  });

  it('builds a grouped-by-phase report with stats + per-agent rows', () => {
    const events: AgentEvent[] = [
      { phase: 1, kind: 'sim-ok', domain: 'simulator', agent: 'enterprise', raw: '' },
      { phase: 1, kind: 'ok', domain: 'copilot', agent: 'planner', timingMs: 387, raw: '' },
      { phase: 1, kind: 'fail', domain: 'memory-graph', agent: 'knowledge-graph', timingMs: 30042, reason: '503', raw: '' },
      { phase: 1, kind: 'fallback', domain: 'costops', agent: 'attribution', raw: '' },
      { phase: 1, kind: 'verdict', role: 'DEGRADED', reason: 'one agent errored', raw: '' },
      { phase: 2, kind: 'phase-header', role: 'Deep Research', raw: '' },
      { phase: 2, kind: 'preflight', reason: '[PREFLIGHT] 7/7 healthy', raw: '' },
      { phase: 2, kind: 'ok', domain: 'copilot', agent: 'decomposer', timingMs: 500, raw: '' },
    ];
    const report = formatAgentReport(events, 'trace-abc-123');
    expect(report).toContain('Agent Invocation Report');
    expect(report).toContain('Trace: trace-abc-123');
    expect(report).toContain('Phase 1:');
    expect(report).toContain('Phase 2: Deep Research');
    // Phase 1 counts: 2 ok (sim-ok + copilot), 1 fail, 1 fallback
    expect(report).toMatch(/Phase 1:[\s\S]*?2 ok · 1 fail · 1 local-fallback/);
    // Per-agent rows
    expect(report).toContain('copilot/planner');
    expect(report).toContain('memory-graph/knowledge-graph');
    expect(report).toContain('costops/attribution');
    expect(report).toContain('simulator/enterprise');
    // Verdict
    expect(report).toContain('DEGRADED');
    // Preflight annotation in phase 2
    expect(report).toContain('7/7 healthy');
  });
});
