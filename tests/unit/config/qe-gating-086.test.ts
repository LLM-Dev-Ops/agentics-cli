/**
 * ADR-PIPELINE-086 acceptance tests — QE gating config + executor.
 *
 * Exercises:
 *   - Env var parsing (on/advisory/off/invalid/empty/whitespace)
 *   - Persisted file load + invalid file fallback
 *   - Source precedence (env > persisted > default)
 *   - persistQeGating reason validation + round-trip
 *   - executePhase8Qe decision tree across all three modes
 *   - Bypass record construction + report header formatting
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGatingValue,
  loadPersistedQeGating,
  persistQeGating,
  resolveQeGatingMode,
  isGatingOn,
  isGatingAdvisory,
  isGatingOff,
  InvalidGatingValueError,
  EmptyReasonError,
  ENV_VAR_NAME,
  DEFAULT_MODE,
} from '../../../src/config/qe-gating.js';
import {
  executePhase8Qe,
  buildValidationReportBypassHeader,
  emitBypassLog,
  type QeAgentInvocation,
  type BypassRecord,
} from '../../../src/pipeline/phase5-build/qe-gating-executor.js';

// ============================================================================
// Env var parsing
// ============================================================================

describe('ADR-086: parseGatingValue', () => {
  it('accepts "on"', () => expect(parseGatingValue('on')).toBe('on'));
  it('accepts "advisory"', () => expect(parseGatingValue('advisory')).toBe('advisory'));
  it('accepts "off"', () => expect(parseGatingValue('off')).toBe('off'));

  it('is case-insensitive', () => {
    expect(parseGatingValue('ON')).toBe('on');
    expect(parseGatingValue('Advisory')).toBe('advisory');
    expect(parseGatingValue('OFF')).toBe('off');
  });

  it('trims whitespace', () => {
    expect(parseGatingValue('  on  ')).toBe('on');
    expect(parseGatingValue('\toff\n')).toBe('off');
  });

  it('returns null for empty / undefined / whitespace-only', () => {
    expect(parseGatingValue('')).toBeNull();
    expect(parseGatingValue(undefined)).toBeNull();
    expect(parseGatingValue('   ')).toBeNull();
  });

  it('throws on invalid value', () => {
    expect(() => parseGatingValue('enabled')).toThrow(InvalidGatingValueError);
    expect(() => parseGatingValue('true')).toThrow(InvalidGatingValueError);
    expect(() => parseGatingValue('1')).toThrow(InvalidGatingValueError);
  });
});

// ============================================================================
// Persisted config
// ============================================================================

describe('ADR-086: persisted qe-gating.json', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'qe-gating-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', () => {
    expect(loadPersistedQeGating({ configDir: tempDir })).toBeNull();
  });

  it('loads a valid persisted record', () => {
    writeFileSync(join(tempDir, 'qe-gating.json'), JSON.stringify({
      mode: 'advisory',
      reason: 'on-call: FP rate 6% over 7d',
      applied_at: '2026-05-22T14:03:12Z',
      applied_by: 'on-call@example.com',
    }));
    const loaded = loadPersistedQeGating({ configDir: tempDir });
    expect(loaded?.mode).toBe('advisory');
    expect(loaded?.reason).toContain('FP rate');
  });

  it('ignores invalid JSON', () => {
    writeFileSync(join(tempDir, 'qe-gating.json'), '{ not json');
    expect(loadPersistedQeGating({ configDir: tempDir })).toBeNull();
  });

  it('ignores files with unknown mode values', () => {
    writeFileSync(join(tempDir, 'qe-gating.json'), JSON.stringify({
      mode: 'enabled',
      reason: 'x',
      applied_at: '2026-05-22T00:00:00Z',
    }));
    expect(loadPersistedQeGating({ configDir: tempDir })).toBeNull();
  });

  describe('persistQeGating', () => {
    it('writes a round-trippable record', () => {
      const record = persistQeGating('advisory', 'test reason', {
        configDir: tempDir,
        now: new Date('2026-05-22T14:03:12Z'),
        appliedBy: 'alice',
      });
      expect(record.mode).toBe('advisory');
      expect(record.reason).toBe('test reason');
      expect(record.applied_at).toBe('2026-05-22T14:03:12.000Z');

      const loaded = loadPersistedQeGating({ configDir: tempDir });
      expect(loaded?.mode).toBe(record.mode);
      expect(loaded?.reason).toBe(record.reason);
      expect(loaded?.applied_at).toBe(record.applied_at);
      expect(loaded?.applied_by).toBe(record.applied_by);
    });

    it('rejects empty reason when mode is advisory', () => {
      expect(() => persistQeGating('advisory', '', { configDir: tempDir })).toThrow(EmptyReasonError);
      expect(() => persistQeGating('advisory', '   ', { configDir: tempDir })).toThrow(EmptyReasonError);
    });

    it('rejects empty reason when mode is off', () => {
      expect(() => persistQeGating('off', '', { configDir: tempDir })).toThrow(EmptyReasonError);
    });

    it('allows empty reason when mode is on (recovery path)', () => {
      expect(() => persistQeGating('on', '', { configDir: tempDir })).not.toThrow();
    });

    it('includes correlation_id when provided', () => {
      const record = persistQeGating('off', 'outage', {
        configDir: tempDir,
        correlationId: 'corr-123',
      });
      expect(record.correlation_id).toBe('corr-123');
    });
  });
});

// ============================================================================
// Resolution precedence
// ============================================================================

describe('ADR-086: resolveQeGatingMode (env > persisted > default)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'qe-resolve-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses env var when set', () => {
    const result = resolveQeGatingMode({
      env: { [ENV_VAR_NAME]: 'advisory' },
      configDir: tempDir,
    });
    expect(result).toEqual(expect.objectContaining({ mode: 'advisory', source: 'env' }));
  });

  it('env overrides persisted', () => {
    writeFileSync(join(tempDir, 'qe-gating.json'), JSON.stringify({
      mode: 'off', reason: 'persisted', applied_at: '2026-01-01T00:00:00Z',
    }));
    const result = resolveQeGatingMode({
      env: { [ENV_VAR_NAME]: 'on' },
      configDir: tempDir,
    });
    expect(result.mode).toBe('on');
    expect(result.source).toBe('env');
  });

  it('falls to persisted when env is unset', () => {
    writeFileSync(join(tempDir, 'qe-gating.json'), JSON.stringify({
      mode: 'off', reason: 'upstream outage', applied_at: '2026-01-01T00:00:00Z',
    }));
    const result = resolveQeGatingMode({ env: {}, configDir: tempDir });
    expect(result.mode).toBe('off');
    expect(result.source).toBe('persisted');
    expect(result.reason).toBe('upstream outage');
  });

  it('falls to default when neither env nor persisted is present', () => {
    const result = resolveQeGatingMode({ env: {}, configDir: tempDir });
    expect(result.mode).toBe(DEFAULT_MODE);
    expect(result.source).toBe('default');
  });

  it('falls to persisted when env is whitespace-only', () => {
    writeFileSync(join(tempDir, 'qe-gating.json'), JSON.stringify({
      mode: 'advisory', reason: 'persisted', applied_at: '2026-01-01T00:00:00Z',
    }));
    const result = resolveQeGatingMode({
      env: { [ENV_VAR_NAME]: '   ' },
      configDir: tempDir,
    });
    expect(result.source).toBe('persisted');
  });

  it('helpers match resolved mode', () => {
    expect(isGatingOn({ env: { [ENV_VAR_NAME]: 'on' }, configDir: tempDir })).toBe(true);
    expect(isGatingAdvisory({ env: { [ENV_VAR_NAME]: 'advisory' }, configDir: tempDir })).toBe(true);
    expect(isGatingOff({ env: { [ENV_VAR_NAME]: 'off' }, configDir: tempDir })).toBe(true);
  });
});

// ============================================================================
// Phase-8 executor decision tree
// ============================================================================

describe('ADR-086: executePhase8Qe', () => {
  const agents = ['agent-a', 'agent-b', 'agent-c'] as const;

  const mkInvokeAll = (status: 200 | 502 = 200): ((id: string) => Promise<QeAgentInvocation>) => {
    return async (id) => ({ agent: id, status, data: {} });
  };

  const mkInvokeMixed = (failingAgent: string): ((id: string) => Promise<QeAgentInvocation>) => {
    return async (id) => {
      if (id === failingAgent) return { agent: id, status: 502, error: 'UPSTREAM_ERROR' };
      return { agent: id, status: 200, data: {} };
    };
  };

  describe('mode=on', () => {
    it('completes when all agents succeed', async () => {
      const outcome = await executePhase8Qe([...agents], mkInvokeAll(200), {
        correlationId: 'corr-1',
        modeOverride: { mode: 'on', source: 'default' },
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.mode).toBe('on');
      expect(outcome.warnings).toHaveLength(0);
      expect(outcome.exitCode).toBeUndefined();
    });

    it('sets exit code 141 when any agent fails', async () => {
      const outcome = await executePhase8Qe([...agents], mkInvokeMixed('agent-b'), {
        correlationId: 'corr-2',
        modeOverride: { mode: 'on', source: 'default' },
      });
      expect(outcome.mode).toBe('on');
      expect(outcome.exitCode).toBe(141);
      expect(outcome.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('mode=advisory', () => {
    it('completes with warnings when an agent fails', async () => {
      const outcome = await executePhase8Qe([...agents], mkInvokeMixed('agent-c'), {
        correlationId: 'corr-3',
        modeOverride: { mode: 'advisory', source: 'env' },
      });
      expect(outcome.status).toBe('completed_with_warnings');
      expect(outcome.exitCode).toBeUndefined();
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0]).toContain('agent-c');
      expect(outcome.warnings[0]).toContain('advisory mode');
      expect(outcome.bypassRecord).toBeDefined();
      expect(outcome.bypassRecord?.affected_agents).toEqual(['agent-c']);
    });

    it('completes cleanly with no bypass record when all agents succeed', async () => {
      const outcome = await executePhase8Qe([...agents], mkInvokeAll(200), {
        correlationId: 'corr-3b',
        modeOverride: { mode: 'advisory', source: 'env' },
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.bypassRecord).toBeUndefined();
    });
  });

  describe('mode=off', () => {
    it('returns bypassed without invoking any agents', async () => {
      let invokeCalls = 0;
      const outcome = await executePhase8Qe([...agents], async (id) => {
        invokeCalls++;
        return { agent: id, status: 200 };
      }, {
        correlationId: 'corr-4',
        modeOverride: { mode: 'off', source: 'persisted', reason: 'upstream outage' },
      });
      expect(invokeCalls).toBe(0);
      expect(outcome.status).toBe('bypassed');
      expect(outcome.invocations).toEqual([]);
      expect(outcome.bypassRecord?.mode).toBe('off');
      expect(outcome.bypassRecord?.affected_agents).toEqual([...agents]);
      expect(outcome.bypassRecord?.reason).toBe('upstream outage');
    });
  });

  it('preserves correlation_id in bypass records', async () => {
    const outcome = await executePhase8Qe([...agents], mkInvokeAll(200), {
      correlationId: 'unique-corr-xyz',
      modeOverride: { mode: 'off', source: 'env' },
    });
    expect(outcome.bypassRecord?.correlation_id).toBe('unique-corr-xyz');
  });
});

// ============================================================================
// VALIDATION_REPORT header
// ============================================================================

describe('ADR-086: buildValidationReportBypassHeader', () => {
  const baseRecord: BypassRecord = {
    timestamp: '2026-05-22T14:03:12Z',
    mode: 'advisory',
    source: 'env',
    reason: 'FP rate 6.2% exceeds threshold',
    correlation_id: 'corr-abc',
    affected_agents: ['flaky-detection', 'defect-prediction'],
  };

  it('includes the bypass warning marker', () => {
    const header = buildValidationReportBypassHeader(baseRecord);
    expect(header).toContain('⚠️ **QE GATING BYPASSED**');
  });

  it('labels advisory mode correctly', () => {
    const header = buildValidationReportBypassHeader(baseRecord);
    expect(header).toContain('ADVISORY (warnings-only)');
  });

  it('labels off mode correctly', () => {
    const offRecord: BypassRecord = { ...baseRecord, mode: 'off' };
    const header = buildValidationReportBypassHeader(offRecord);
    expect(header).toContain('OFF (skipped)');
  });

  it('includes reason, timestamp, correlation, affected agents', () => {
    const header = buildValidationReportBypassHeader(baseRecord);
    expect(header).toContain('FP rate 6.2% exceeds threshold');
    expect(header).toContain('2026-05-22T14:03:12Z');
    expect(header).toContain('corr-abc');
    expect(header).toContain('flaky-detection, defect-prediction');
  });

  it('handles missing reason gracefully', () => {
    const noReason: BypassRecord = { ...baseRecord };
    delete noReason.reason;
    const header = buildValidationReportBypassHeader(noReason);
    expect(header).toContain('Reason: (not provided)');
  });

  it('handles empty affected_agents (full bypass)', () => {
    const fullBypass: BypassRecord = { ...baseRecord, mode: 'off', affected_agents: [] };
    const header = buildValidationReportBypassHeader(fullBypass);
    expect(header).toContain('(none — full bypass)');
  });

  it('references ADR-086 and the runbook', () => {
    const header = buildValidationReportBypassHeader(baseRecord);
    expect(header).toContain('ADR-PIPELINE-086');
    expect(header).toContain('qe-gating-recovery-086.md');
  });
});

// ============================================================================
// Bypass log emission
// ============================================================================

describe('ADR-086: emitBypassLog', () => {
  it('emits a single JSON line with event="qe_gating_bypass"', () => {
    const lines: string[] = [];
    const record: BypassRecord = {
      timestamp: '2026-05-22T14:03:12Z',
      mode: 'advisory',
      source: 'env',
      reason: 'test',
      correlation_id: 'corr-xyz',
      affected_agents: ['a', 'b'],
    };
    emitBypassLog(record, (s) => lines.push(s));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0]!.trim());
    expect(parsed.event).toBe('qe_gating_bypass');
    expect(parsed.level).toBe('WARN');
    expect(parsed.mode).toBe('advisory');
    expect(parsed.correlation_id).toBe('corr-xyz');
  });
});
