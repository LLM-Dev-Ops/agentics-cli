/**
 * ADR-PIPELINE-097 — live-status renderer tests.
 *
 * Tests cover: TTY detection rules, AgentPanel state machine, PhaseSpinner
 * lifecycle, and the contract that non-TTY mode is silent (so legacy log
 * scrapers don't see duplicate output).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  AgentPanel,
  PhaseSpinner,
  isLiveCapable,
} from '../../../../src/cli/ui/live-status.js';

// ============================================================================
// Test scaffolding — capture stderr writes without touching the real stream
// ============================================================================

interface StderrCapture {
  buffer: string[];
  restore: () => void;
}

function captureStderr(): StderrCapture {
  const buffer: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buffer.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    buffer,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_TTY = process.stderr.isTTY;

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stderr, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  resetEnv();
  setTTY(false);
  delete process.env['NO_COLOR'];
  delete process.env['CI'];
  delete process.env['AGENTICS_NO_LIVE'];
});

afterEach(() => {
  setTTY(ORIGINAL_TTY ?? false);
  resetEnv();
});

// ============================================================================
// isLiveCapable
// ============================================================================

describe('isLiveCapable', () => {
  it('returns false when stderr is not a TTY', () => {
    setTTY(false);
    expect(isLiveCapable()).toBe(false);
  });

  it('returns true when stderr is a TTY and no opt-out env is set', () => {
    setTTY(true);
    expect(isLiveCapable()).toBe(true);
  });

  it('returns false when CI=true even with TTY', () => {
    setTTY(true);
    process.env['CI'] = 'true';
    expect(isLiveCapable()).toBe(false);
  });

  it('returns false when NO_COLOR is set even with TTY', () => {
    setTTY(true);
    process.env['NO_COLOR'] = '1';
    expect(isLiveCapable()).toBe(false);
  });

  it('returns false when AGENTICS_NO_LIVE=1 even with TTY', () => {
    setTTY(true);
    process.env['AGENTICS_NO_LIVE'] = '1';
    expect(isLiveCapable()).toBe(false);
  });
});

// ============================================================================
// AgentPanel — non-TTY contract: silent in render, returns correct counts
// ============================================================================

describe('AgentPanel (non-TTY mode)', () => {
  it('writes nothing to stderr in non-TTY mode — caller owns logging', () => {
    setTTY(false);
    const cap = captureStderr();
    try {
      const panel = new AgentPanel('Phase 2', [
        { id: 'shield/pii', label: 'shield/pii' },
        { id: 'shield/secrets', label: 'shield/secrets' },
      ]).start();
      panel.begin('shield/pii');
      panel.complete('shield/pii', 'success');
      panel.complete('shield/secrets', 'failed', 'timeout');
      panel.stop();
    } finally {
      cap.restore();
    }
    expect(cap.buffer.join('')).toBe('');
  });

  it('returns accurate success/failed/skipped counts in non-TTY mode', () => {
    setTTY(false);
    const panel = new AgentPanel('Phase 2', [
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
      { id: 'c', label: 'c' },
      { id: 'd', label: 'd' }, // never completed → counts as skipped
    ]).start();
    panel.complete('a', 'success');
    panel.complete('b', 'failed');
    panel.complete('c', 'skipped');
    const summary = panel.stop();
    expect(summary).toEqual({ success: 1, failed: 1, skipped: 2 });
  });

  it('is idempotent — second complete() with same status is a no-op', () => {
    setTTY(false);
    const panel = new AgentPanel('Phase 2', [{ id: 'a', label: 'a' }]).start();
    panel.complete('a', 'success');
    panel.complete('a', 'success'); // no double-count
    expect(panel.stop()).toEqual({ success: 1, failed: 0, skipped: 0 });
  });

  it('ignores unknown agent ids without throwing', () => {
    setTTY(false);
    const panel = new AgentPanel('Phase 2', [{ id: 'a', label: 'a' }]).start();
    expect(() => panel.begin('nope')).not.toThrow();
    expect(() => panel.complete('nope', 'success')).not.toThrow();
    expect(panel.stop()).toEqual({ success: 0, failed: 0, skipped: 1 });
  });

  it('promotes pending+running rows to skipped on stop()', () => {
    setTTY(false);
    const panel = new AgentPanel('Phase 2', [
      { id: 'a', label: 'a' }, // pending → skipped
      { id: 'b', label: 'b' }, // running → skipped
    ]).start();
    panel.begin('b');
    expect(panel.stop()).toEqual({ success: 0, failed: 0, skipped: 2 });
  });
});

// ============================================================================
// AgentPanel — TTY mode: actually writes frames
// ============================================================================

describe('AgentPanel (TTY mode)', () => {
  it('writes a colored header + at least one row in TTY mode', () => {
    setTTY(true);
    const cap = captureStderr();
    try {
      const panel = new AgentPanel('Phase 2', [
        { id: 'shield/pii', label: 'shield/pii' },
      ]).start();
      panel.complete('shield/pii', 'success');
      panel.stop();
    } finally {
      cap.restore();
    }
    const out = cap.buffer.join('');
    expect(out).toContain('Phase 2');
    expect(out).toContain('shield/pii');
    // ANSI escape present (color)
    expect(out).toMatch(/\x1b\[/);
  });

  it('emits a final summary line on stop() in TTY mode', () => {
    setTTY(true);
    const cap = captureStderr();
    try {
      const panel = new AgentPanel('Phase 2', [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ]).start();
      panel.complete('a', 'success');
      panel.complete('b', 'failed');
      panel.stop();
    } finally {
      cap.restore();
    }
    const out = cap.buffer.join('');
    expect(out).toMatch(/1✓/);
    expect(out).toMatch(/1✗/);
  });
});

// ============================================================================
// PhaseSpinner
// ============================================================================

describe('PhaseSpinner (non-TTY mode)', () => {
  it('writes nothing to stderr — caller owns phase boundary logging', () => {
    setTTY(false);
    const cap = captureStderr();
    try {
      const sp = new PhaseSpinner('Phase 2: Deep Research').start();
      sp.setLabel('Phase 2: Deep Research (verifying)');
      sp.succeed('Phase 2 complete');
    } finally {
      cap.restore();
    }
    expect(cap.buffer.join('')).toBe('');
  });
});

describe('PhaseSpinner (TTY mode)', () => {
  it('writes a final success line on succeed()', () => {
    setTTY(true);
    const cap = captureStderr();
    try {
      const sp = new PhaseSpinner('Phase 2').start();
      sp.succeed('Phase 2 done');
    } finally {
      cap.restore();
    }
    expect(cap.buffer.join('')).toContain('Phase 2 done');
  });

  it('writes a final fail line on fail()', () => {
    setTTY(true);
    const cap = captureStderr();
    try {
      const sp = new PhaseSpinner('Phase 2').start();
      sp.fail('aborted');
    } finally {
      cap.restore();
    }
    expect(cap.buffer.join('')).toContain('aborted');
  });
});
