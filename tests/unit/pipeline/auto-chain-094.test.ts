/**
 * ADR-PIPELINE-094 Decision 4 — Phase 6 always emits a phase-result entry.
 *
 * Unit tests for the `pushSkippedDueToUpstream` helper. End-to-end coverage
 * (running the actual auto-chain) lives in the originating-run regression
 * test added later; these tests pin the helper's contract.
 */

import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';

import {
  pushSkippedDueToUpstream,
  type PhaseResult,
} from '../../../src/pipeline/auto-chain.js';

const RUN_DIR = '/tmp/run-094';

function makeFailedPhase(phase: number, label: string, errMsg: string): PhaseResult {
  return {
    phase,
    label,
    status: 'failed',
    timing: 1234,
    artifacts: [],
    outputDir: path.join(RUN_DIR, `phase${phase}`),
    error: errMsg,
  };
}

describe('ADR-094 D4 — pushSkippedDueToUpstream', () => {
  it('pushes Phase 6 (and any other downstream) when Phase 5 fails', () => {
    const phases: PhaseResult[] = [
      makeFailedPhase(5, 'Build', 'fanout timeout cascade'),
    ];

    pushSkippedDueToUpstream(phases, { phase: 5, label: 'Build', reason: 'fanout timeout cascade' }, RUN_DIR);

    const phase6 = phases.find((p) => p.phase === 6);
    expect(phase6).toBeDefined();
    expect(phase6!.status).toBe('skipped-due-to-upstream');
    expect(phase6!.outputDir).toBe(path.join(RUN_DIR, 'phase6'));
    expect(phase6!.error).toContain('Upstream phase 5');
    expect(phase6!.error).toContain('fanout timeout cascade');
    expect(phase6!.timing).toBe(0);
    expect(phase6!.artifacts).toEqual([]);
  });

  it('pushes phases 3, 4, 5, 6 when Phase 2 fails', () => {
    const phases: PhaseResult[] = [
      makeFailedPhase(2, 'Deep Research', 'phase1 manifest missing'),
    ];

    pushSkippedDueToUpstream(phases, { phase: 2, label: 'Deep Research', reason: 'phase1 manifest missing' }, RUN_DIR);

    const downstream = phases.filter((p) => p.phase > 2);
    expect(downstream).toHaveLength(4);
    expect(downstream.map((p) => p.phase).sort()).toEqual([3, 4, 5, 6]);
    for (const p of downstream) {
      expect(p.status).toBe('skipped-due-to-upstream');
      expect(p.error).toContain('Upstream phase 2 (Deep Research)');
    }
  });

  it('is idempotent — does not re-push phases already on the list', () => {
    const phases: PhaseResult[] = [
      makeFailedPhase(2, 'Deep Research', 'err'),
      // Phase 3 already pushed (e.g. as a recovery completion)
      {
        phase: 3,
        label: 'SPARC + London TDD',
        status: 'completed',
        timing: 100,
        artifacts: ['sparc/specification.md'],
        outputDir: path.join(RUN_DIR, 'phase3'),
      },
    ];

    pushSkippedDueToUpstream(phases, { phase: 2, label: 'Deep Research', reason: 'err' }, RUN_DIR);

    const phase3 = phases.find((p) => p.phase === 3);
    expect(phase3!.status).toBe('completed'); // unchanged
    expect(phase3!.timing).toBe(100);
    // 4, 5, 6 added; 3 not re-pushed
    expect(phases.filter((p) => p.phase === 3)).toHaveLength(1);
    expect(phases.filter((p) => p.phase === 4)).toHaveLength(1);
    expect(phases.filter((p) => p.phase === 5)).toHaveLength(1);
    expect(phases.filter((p) => p.phase === 6)).toHaveLength(1);
  });

  it('truncates a long upstream reason to ≤200 chars + ellipsis', () => {
    const phases: PhaseResult[] = [];
    const longReason = 'x'.repeat(500);
    pushSkippedDueToUpstream(phases, { phase: 5, label: 'Build', reason: longReason }, RUN_DIR);
    const phase6 = phases.find((p) => p.phase === 6)!;
    // Header text plus 200-char excerpt plus ellipsis. Allow some headroom for the prefix.
    expect(phase6.error!.length).toBeLessThan(300);
    expect(phase6.error).toContain('…');
  });

  it('does nothing when only Phase 6 has not yet been pushed and upstream is Phase 6 itself', () => {
    const phases: PhaseResult[] = [
      { phase: 6, label: 'ERP Surface Push', status: 'failed', timing: 0, artifacts: [], outputDir: path.join(RUN_DIR, 'phase6'), error: 'erp 401' },
    ];
    const before = phases.length;
    pushSkippedDueToUpstream(phases, { phase: 6, label: 'ERP Surface Push', reason: 'erp 401' }, RUN_DIR);
    expect(phases.length).toBe(before);
  });
});
