/**
 * ADR-PIPELINE-116 — Loud Failure Over Silent Template Fallback.
 *
 * Unit coverage for the honesty-contract machinery in
 * `src/pipeline/phase-failure.ts`. Auditors found ZERO tests referencing this
 * module — these tests lock in the verdict/exit-code semantics, the real-engine
 * predicate, the AGENTICS_KEEP_TEMPLATES transition gate, the PHASE-FAIL
 * artifact writer, the manifest verdict writer, and the reference-run
 * regression that proves the original false-success (exit 0) is closed.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeRunVerdict,
  verdictToExitCode,
  isRealEngineTier,
  keepTemplates,
  writePhaseFailArtifact,
  writeRunVerdictToManifest,
  PHASE_FAILURES,
} from '../../../src/pipeline/phase-failure.js';
import type { EngineTier, RunVerdict, PhaseFailureKey } from '../../../src/pipeline/phase-failure.js';

// ── helpers ────────────────────────────────────────────────────────────────

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── D2: computeRunVerdict ────────────────────────────────────────────────────

describe('computeRunVerdict', () => {
  it('returns success when every recorded phase used a real engine tier', () => {
    const tiers: Record<string, EngineTier> = {
      sparc: 'ruflo',
      ddd: 'claude-print',
      tdd: 'codex',
    };
    expect(computeRunVerdict(tiers)).toBe('success');
  });

  it('returns failed when every phase used a non-real tier (none/template)', () => {
    const tiers: Record<string, EngineTier> = {
      sparc: 'none',
      ddd: 'template',
      tdd: 'none',
    };
    expect(computeRunVerdict(tiers)).toBe('failed');
  });

  it('returns degraded when some phases are real and some are non-real', () => {
    const tiers: Record<string, EngineTier> = {
      sparc: 'ruflo',
      ddd: 'template',
      tdd: 'none',
    };
    expect(computeRunVerdict(tiers)).toBe('degraded');
  });

  it('returns degraded for a single real + single template mix', () => {
    expect(computeRunVerdict({ a: 'codex', b: 'template' })).toBe('degraded');
  });

  it('returns failed for empty input (no phases recorded)', () => {
    // Locks in the documented behaviour: zero recorded phases == failed.
    expect(computeRunVerdict({})).toBe('failed');
  });
});

// ── D3: verdictToExitCode (exhaustive) ───────────────────────────────────────

describe('verdictToExitCode', () => {
  it('maps success -> 0', () => {
    expect(verdictToExitCode('success')).toBe(0);
  });

  it('maps degraded -> 1', () => {
    expect(verdictToExitCode('degraded')).toBe(1);
  });

  it('maps failed -> 2', () => {
    expect(verdictToExitCode('failed')).toBe(2);
  });

  it('covers every RunVerdict value exhaustively', () => {
    const all: RunVerdict[] = ['success', 'degraded', 'failed'];
    expect(all.map(verdictToExitCode)).toEqual([0, 1, 2]);
  });
});

// ── D4: isRealEngineTier ─────────────────────────────────────────────────────

describe('isRealEngineTier', () => {
  it('returns true for real engine tiers (ruflo, claude-print, codex)', () => {
    expect(isRealEngineTier('ruflo')).toBe(true);
    expect(isRealEngineTier('claude-print')).toBe(true);
    expect(isRealEngineTier('codex')).toBe(true);
  });

  it('returns false for non-real tiers (none, template)', () => {
    expect(isRealEngineTier('none')).toBe(false);
    expect(isRealEngineTier('template')).toBe(false);
  });

  it('returns false for an unknown / unexpected tier value', () => {
    // Defensive: anything not in the real set must not be counted.
    expect(isRealEngineTier('bogus' as EngineTier)).toBe(false);
  });
});

// ── D6: keepTemplates (transition gate) ──────────────────────────────────────

describe('keepTemplates', () => {
  const KEY = 'AGENTICS_KEEP_TEMPLATES';
  let saved: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  function withEnv(value: string | undefined): boolean {
    saved = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    return keepTemplates();
  }

  it('defaults to true when the env var is unset (transition default = keep)', () => {
    expect(withEnv(undefined)).toBe(true);
  });

  it('defaults to true when the env var is empty/whitespace', () => {
    expect(withEnv('   ')).toBe(true);
  });

  it('returns false for explicit disable values: false/0/no/off (case-insensitive)', () => {
    expect(withEnv('false')).toBe(false);
    expect(withEnv('0')).toBe(false);
    expect(withEnv('no')).toBe(false);
    expect(withEnv('off')).toBe(false);
    expect(withEnv('OFF')).toBe(false);
  });

  it('returns true for explicit keep values: true/1', () => {
    expect(withEnv('true')).toBe(true);
    expect(withEnv('1')).toBe(true);
  });

  it('returns true for any non-disable token (only false/0/no/off disable)', () => {
    expect(withEnv('yes')).toBe(true);
    expect(withEnv('anything')).toBe(true);
  });
});

// ── D1: writePhaseFailArtifact / PHASE_FAILURES registry ─────────────────────

describe('writePhaseFailArtifact + PHASE_FAILURES', () => {
  let runDir: string;

  afterEach(() => {
    if (runDir) rmTmp(runDir);
  });

  const expectedNames: Record<PhaseFailureKey, string> = {
    sparc: 'SPARC-FAIL-001.md',
    ddd: 'DDD-FAIL-001.md',
    tdd: 'TDD-FAIL-001.md',
    prompts: 'PROMPT-FAIL-001.md',
    proto: 'PROTO-FAIL-001.md',
    deliverables: 'DELIVER-FAIL-001.md',
  };

  it('registry declares the expected artifact filename for each phase', () => {
    for (const key of Object.keys(expectedNames) as PhaseFailureKey[]) {
      expect(PHASE_FAILURES[key].artifactName).toBe(expectedNames[key]);
    }
  });

  it('writes a loud-failure artifact per phase with Status: Failed and the right filename', () => {
    runDir = mkTmp('adr116-artifact-');
    for (const key of Object.keys(expectedNames) as PhaseFailureKey[]) {
      const artifactPath = writePhaseFailArtifact({
        runDir,
        key,
        reason: 'no-engine-available',
        backend: { tier: 'none', reason: 'no real engine configured' },
        pipelineState: { upstreamReady: true, dependenciesMet: false },
        detail: `synthetic failure for ${key}`,
      });

      // Filename matches the registry entry.
      expect(path.basename(artifactPath)).toBe(expectedNames[key]);

      // File was actually created.
      expect(fs.existsSync(artifactPath)).toBe(true);

      const body = fs.readFileSync(artifactPath, 'utf-8');
      expect(body).toContain('**Status:** Failed');
      expect(body).toContain('**Reason:** no-engine-available');
      expect(body).toContain(PHASE_FAILURES[key].phaseLabel);
      // Backend resolver result is recorded.
      expect(body).toContain('- **tier:** none');
      // Recovery instructions present (never template boilerplate).
      expect(body).toContain('## Recovery');
    }
  });

  it('writes under the registry relDir for the phase', () => {
    runDir = mkTmp('adr116-reldir-');
    const artifactPath = writePhaseFailArtifact({
      runDir,
      key: 'sparc',
      reason: 'no-engine-available',
    });
    expect(artifactPath).toBe(path.join(runDir, PHASE_FAILURES.sparc.relDir, 'SPARC-FAIL-001.md'));
    expect(fs.existsSync(artifactPath)).toBe(true);
  });

  it('records "tier: unknown" when no backend result is supplied', () => {
    runDir = mkTmp('adr116-nobackend-');
    const artifactPath = writePhaseFailArtifact({
      runDir,
      key: 'ddd',
      reason: 'skipped-due-to-upstream',
    });
    const body = fs.readFileSync(artifactPath, 'utf-8');
    expect(body).toContain('tier:** unknown');
  });
});

// ── D2: writeRunVerdictToManifest ────────────────────────────────────────────

describe('writeRunVerdictToManifest', () => {
  let runDir: string;

  afterEach(() => {
    if (runDir) rmTmp(runDir);
  });

  it('merges run_verdict / engine_tiers / degraded into a fresh manifest (degraded case)', () => {
    runDir = mkTmp('adr116-manifest-');
    const tiers: Record<string, EngineTier> = { sparc: 'ruflo', ddd: 'template' };

    const { verdict, degraded } = writeRunVerdictToManifest(runDir, tiers);

    expect(verdict).toBe('degraded');
    expect(degraded).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(manifest.run_verdict).toBe('degraded');
    expect(manifest.degraded).toBe(true);
    expect(manifest.engine_tiers).toEqual(tiers);
  });

  it('preserves pre-existing manifest keys when merging (read-modify-write)', () => {
    runDir = mkTmp('adr116-manifest-merge-');
    const manifestPath = path.join(runDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ traceId: 'abc123', existing: true }), 'utf-8');

    const tiers: Record<string, EngineTier> = { sparc: 'ruflo', ddd: 'codex' };
    const { verdict, degraded } = writeRunVerdictToManifest(runDir, tiers);

    expect(verdict).toBe('success');
    expect(degraded).toBe(false);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.traceId).toBe('abc123');
    expect(manifest.existing).toBe(true);
    expect(manifest.run_verdict).toBe('success');
    expect(manifest.degraded).toBe(false);
    expect(manifest.engine_tiers).toEqual(tiers);
  });

  it('records failed + degraded=false when no phase used a real engine', () => {
    runDir = mkTmp('adr116-manifest-failed-');
    const tiers: Record<string, EngineTier> = { sparc: 'none', ddd: 'template' };

    const { verdict, degraded } = writeRunVerdictToManifest(runDir, tiers);

    expect(verdict).toBe('failed');
    expect(degraded).toBe(false);

    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
    expect(manifest.run_verdict).toBe('failed');
    expect(manifest.degraded).toBe(false);
  });
});

// ── Combined reference-run regression (closes the false-success bug) ──────────

describe('ADR-116 reference-run regression', () => {
  let runDir: string;

  afterEach(() => {
    if (runDir) rmTmp(runDir);
  });

  it('reference run (all tiers none/template) => verdict failed, exit code 2', () => {
    // The original bug: a run where no phase produced real engine output still
    // exited 0 ("false success"). This proves it now fails loudly.
    const referenceTiers: Record<string, EngineTier> = {
      sparc: 'template',
      ddd: 'template',
      tdd: 'template',
      prompts: 'none',
      proto: 'none',
      deliverables: 'none',
    };

    const verdict = computeRunVerdict(referenceTiers);
    expect(verdict).toBe('failed');
    expect(verdictToExitCode(verdict)).toBe(2);

    // And the same verdict is what gets persisted to the manifest.
    runDir = mkTmp('adr116-refrun-');
    const { verdict: persisted, degraded } = writeRunVerdictToManifest(runDir, referenceTiers);
    expect(persisted).toBe('failed');
    expect(degraded).toBe(false);
    expect(verdictToExitCode(persisted)).toBe(2);
  });
});
