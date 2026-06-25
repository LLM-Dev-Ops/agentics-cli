/**
 * ADR-PIPELINE-116 — Loud Failure Over Silent Template Fallback.
 *
 * Shared per-phase loud-failure machinery. Generalises the `ADR-FAIL-001`
 * pattern (ADR-PIPELINE-100 §D5, which remains the canonical ADR-phase
 * implementation in `phase2/phases/adr-generator.ts`) into a single helper that
 * every other generation phase uses to emit a `PHASE-FAIL` artifact when no real
 * engine produced content.
 *
 * Responsibilities:
 *   - D1: `writePhaseFailArtifact()` — emit `<PHASE>-FAIL-001.md` for SPARC, DDD,
 *         TDD, prompts, prototype, and deliverables phases.
 *   - D2: `computeRunVerdict()` — derive `success | degraded | failed` from the
 *         per-phase `engine_tier` map.
 *   - D3: `verdictToExitCode()` — map the verdict to a process exit code.
 *   - D4: `isRealEngineTier()` — the single predicate that decides whether an
 *         artifact counts as a promoted/real-engine artifact.
 *   - D6: `keepTemplates()` — the `AGENTICS_KEEP_TEMPLATES` transition gate.
 *
 * ── LANG-FAIL vs PROTO-FAIL reconciliation (D1, phase 5b) ───────────────────
 * ADR-PIPELINE-115 already emits `LANG-FAIL-001.md` from
 * `phases/rust-scaffold-generator.ts` for the two language-authority failures:
 *   • unsupported resolved language (no scaffold path), and
 *   • Rust resolved but no engine available (tier 'none').
 * Those remain LANG-FAIL — they are language/no-engine decisions made by the
 * scaffold-language authority. `PROTO-FAIL-001.md` (defined here) covers any
 * OTHER phase-5b prototype failure: a scaffold emission that throws, or the
 * loud-failure-only mode suppressing the TS/Python skeleton. Both live under
 * `<runDir>/phase5b/`; a reader treats either filename as "phase 5b failed".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BackendResolution } from './backend-resolver.js';

/**
 * The engine tier that actually produced a phase's content. Mirrors
 * `BackendResolution['tier']` for the real engines and adds the two
 * non-real markers used by ADR-116.
 *   - `ruflo | claude-print | codex` — a real engine produced the content.
 *   - `template`                     — canned template content (never counted).
 *   - `none`                         — nothing produced (loud failure).
 */
export type EngineTier = 'ruflo' | 'claude-print' | 'codex' | 'template' | 'none';

/** Top-level run verdict (ADR-116 §D2). */
export type RunVerdict = 'success' | 'degraded' | 'failed';

/** Process exit code derived from the run verdict (ADR-116 §D3). */
export type VerdictExitCode = 0 | 1 | 2;

const REAL_TIERS: ReadonlySet<EngineTier> = new Set<EngineTier>(['ruflo', 'claude-print', 'codex']);

/**
 * D4 predicate: only real-engine artifacts are counted as promoted. Template
 * and failure (`none`) tiers are never counted. This is the single source of
 * truth that `incrementPromotion`-style accumulators consult.
 */
export function isRealEngineTier(tier: EngineTier): boolean {
  return REAL_TIERS.has(tier);
}

/**
 * D6 transition gate. The FINAL ADR-116 default is "no templates, loud failure"
 * — but flipping that now would break the existing suite and every offline run.
 * During the transition window the default is therefore KEEP: template paths may
 * still EMIT (so the build stays green), but their artifacts are tier
 * `'template'`, are never counted, and drive the verdict to degraded/failed.
 *
 * Loud-failure-only mode (no template emission; PHASE-FAIL artifacts instead)
 * activates ONLY when explicitly disabled:
 *   AGENTICS_KEEP_TEMPLATES=false | 0 | no | off
 *
 * The final default-flip (keep → loud) is the post-verification step once
 * ADR-112/113/114 engine fixes are confirmed green in CI.
 */
export function keepTemplates(): boolean {
  const raw = (process.env['AGENTICS_KEEP_TEMPLATES'] ?? '').trim().toLowerCase();
  if (raw === '') return true; // transition default — preserve current emission
  return !/^(0|false|no|off)$/.test(raw);
}

/**
 * D2: compute the run verdict from the per-phase `engine_tier` map.
 *   - success  = every recorded phase produced real engine output.
 *   - failed   = no phase produced real engine output (or no phases recorded).
 *   - degraded = some real, some template/failed.
 */
export function computeRunVerdict(engineTiers: Readonly<Record<string, EngineTier>>): RunVerdict {
  const tiers = Object.values(engineTiers);
  if (tiers.length === 0) return 'failed';
  const realCount = tiers.filter(isRealEngineTier).length;
  if (realCount === tiers.length) return 'success';
  if (realCount === 0) return 'failed';
  return 'degraded';
}

/** D3: map verdict → exit code (success→0, degraded→1, failed→2). */
export function verdictToExitCode(verdict: RunVerdict): VerdictExitCode {
  switch (verdict) {
    case 'success': return 0;
    case 'degraded': return 1;
    case 'failed': return 2;
  }
}

/** D1: per-phase failure-artifact descriptor. */
export interface PhaseFailureSpec {
  /** Human-readable phase label written into the artifact header. */
  readonly phaseLabel: string;
  /** Artifact filename, e.g. `SPARC-FAIL-001.md`. */
  readonly artifactName: string;
  /** Directory under `<runDir>/` where the artifact is written. */
  readonly relDir: string;
  /** Which engine to configure / which ADR to consult. */
  readonly recovery: string;
}

/**
 * The canonical PHASE-FAIL artifact registry (ADR-116 §D1 table). The ADR phase
 * (`ADR-FAIL-001`) is intentionally absent — it keeps its existing, richer
 * implementation in `adr-generator.ts`. Phase 5b uses `LANG-FAIL` for
 * language/no-engine failures and `PROTO-FAIL` (here) for other failures.
 */
export const PHASE_FAILURES = {
  sparc: {
    phaseLabel: 'Phase 3 — SPARC',
    artifactName: 'SPARC-FAIL-001.md',
    relDir: path.join('phase3', 'sparc'),
    recovery:
      'Configure a real synthesis engine (ruflo or `claude --print`) and re-run. ' +
      'See ADR-PIPELINE-112 (backend policy) and ADR-PIPELINE-116 (loud failure).',
  },
  ddd: {
    phaseLabel: 'Phase 4 — DDD',
    artifactName: 'DDD-FAIL-001.md',
    relDir: path.join('phase4', 'ddd'),
    recovery:
      'Configure a real synthesis engine (ruflo or `claude --print`) and re-run. ' +
      'See ADR-PIPELINE-114 (claude --print transport) and ADR-PIPELINE-116.',
  },
  tdd: {
    phaseLabel: 'Phase 4 — TDD',
    artifactName: 'TDD-FAIL-001.md',
    relDir: path.join('phase4', 'tdd'),
    recovery:
      'Configure a real synthesis engine (ruflo or `claude --print`) and re-run. ' +
      'See ADR-PIPELINE-114 and ADR-PIPELINE-116.',
  },
  prompts: {
    phaseLabel: 'Phase 5a — Implementation Prompts',
    artifactName: 'PROMPT-FAIL-001.md',
    relDir: 'phase5a',
    recovery:
      'Implementation prompts cite upstream SPARC/ADR/DDD/TDD content; they cannot ' +
      'be synthesised coherently with no engine. Configure ruflo or `claude --print` ' +
      'and re-run. See ADR-PIPELINE-116 §D6.',
  },
  proto: {
    phaseLabel: 'Phase 5b — Prototype',
    artifactName: 'PROTO-FAIL-001.md',
    relDir: 'phase5b',
    recovery:
      'Prototype scaffold generation failed for a non-language reason (emission ' +
      'error, or loud-failure-only mode suppressing the template skeleton). ' +
      'Language/no-engine failures emit LANG-FAIL-001 instead. See ADR-PIPELINE-115 ' +
      '§D4/§D5 and ADR-PIPELINE-116.',
  },
  deliverables: {
    phaseLabel: 'Phase 7 — Consulting Deliverables',
    artifactName: 'DELIVER-FAIL-001.md',
    relDir: 'deliverables',
    recovery:
      'Phase 7 produces the enterprise decision pack from upstream phases. When ' +
      'every upstream engineering phase failed, no deliverable can be written ' +
      'honestly. Fix the upstream engine failures and re-run. See ADR-PIPELINE-105 ' +
      '(deliverable guarantee) and ADR-PIPELINE-116 §D5.',
  },
} as const satisfies Record<string, PhaseFailureSpec>;

export type PhaseFailureKey = keyof typeof PHASE_FAILURES;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface WritePhaseFailureArgs {
  /** Pipeline run directory (`~/.agentics/runs/<traceId>`). */
  readonly runDir: string;
  /** Which phase failed. */
  readonly key: PhaseFailureKey;
  /** Machine/human reason, e.g. `no-engine-available`, `skipped-due-to-upstream`. */
  readonly reason: string;
  /** Backend resolver result (tier + reason) at the time of failure. */
  readonly backend?: Pick<BackendResolution, 'tier' | 'reason'> | null;
  /** Pipeline state snapshot (inputs available, dependencies met/unmet). */
  readonly pipelineState?: Readonly<Record<string, string | number | boolean>>;
  /** Optional extra detail line. */
  readonly detail?: string;
}

/**
 * D1: write a `<PHASE>-FAIL-001.md` loud-failure artifact and return its
 * absolute path. The artifact records the phase name, failure reason, backend
 * resolver result, pipeline state, and recovery instructions — never template
 * boilerplate. Best-effort writer: it never throws (mirrors the manifest
 * writers in auto-chain), returning the path it attempted regardless.
 */
export function writePhaseFailArtifact(args: WritePhaseFailureArgs): string {
  const spec = PHASE_FAILURES[args.key];
  const dir = path.join(args.runDir, spec.relDir);
  const artifactPath = path.join(dir, spec.artifactName);

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# ${spec.artifactName.replace(/\.md$/, '')}: ${spec.phaseLabel} Failed`);
  lines.push('');
  lines.push('**Status:** Failed');
  lines.push(`**Date:** ${today}`);
  lines.push(`**Phase:** ${spec.phaseLabel}`);
  lines.push(`**Reason:** ${args.reason}`);
  lines.push('');
  lines.push('## What happened');
  lines.push('');
  lines.push(
    `${spec.phaseLabel} could not produce real engine-generated content. Per ` +
    'ADR-PIPELINE-116 a loud-failure artifact is emitted instead of silent ' +
    'template boilerplate so the regression is visible at the artifact level ' +
    'rather than hidden behind a successful exit code.',
  );
  if (args.detail) {
    lines.push('');
    lines.push(args.detail);
  }
  lines.push('');
  lines.push('## Backend resolver result');
  lines.push('');
  if (args.backend) {
    lines.push(`- **tier:** ${args.backend.tier}`);
    lines.push(`- **reason:** ${args.backend.reason}`);
  } else {
    lines.push('- **tier:** unknown (resolver result not captured at this call site)');
  }
  lines.push('');
  lines.push('## Pipeline state');
  lines.push('');
  if (args.pipelineState && Object.keys(args.pipelineState).length > 0) {
    for (const [k, v] of Object.entries(args.pipelineState)) {
      lines.push(`- **${k}:** ${String(v)}`);
    }
  } else {
    lines.push('- (no additional state captured)');
  }
  lines.push('');
  lines.push('## Recovery');
  lines.push('');
  lines.push(spec.recovery);
  lines.push('');

  const body = lines.join('\n');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(artifactPath, body, { encoding: 'utf-8', mode: FILE_MODE });
  } catch {
    /* best-effort — never block the pipeline on a failure-artifact write */
  }
  return artifactPath;
}

/**
 * D2: merge the per-phase `engine_tier` map, the top-level `run_verdict`, and
 * the `degraded` boolean into `<runDir>/manifest.json`. Read-modify-write,
 * mirroring the other manifest writers in auto-chain. Returns the computed
 * verdict so the caller can also surface it on the in-memory result + exit code.
 *
 * Replaces the old `engineering_tier: "template"` top-level signal as the
 * authoritative honesty marker; `tier_counts` (ADR-091 `execution` block) is
 * retained for diagnostics but is NOT used to compute the verdict.
 */
export function writeRunVerdictToManifest(
  runDir: string,
  engineTiers: Readonly<Record<string, EngineTier>>,
): { verdict: RunVerdict; degraded: boolean } {
  const verdict = computeRunVerdict(engineTiers);
  const degraded = verdict === 'degraded';
  const manifestPath = path.join(runDir, 'manifest.json');
  try {
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        manifest = {};
      }
    }
    manifest['engine_tiers'] = { ...engineTiers };
    manifest['run_verdict'] = verdict;
    manifest['degraded'] = degraded;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600, encoding: 'utf-8' });
  } catch (err) {
    process.stderr.write(
      `  [ADR-116] Failed to merge run_verdict into manifest.json: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return { verdict, degraded };
}
