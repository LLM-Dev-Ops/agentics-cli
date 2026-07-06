/**
 * MetaHarness Quality & Security Gate — ADR-PIPELINE-118 (Phase 5.5)
 *
 * Runs static, no-execution MetaHarness assessments (`score`, `mcp-scan`,
 * `threat-model`, `sbom`) on the generated prototype between Phase 5 (Build) and
 * Phase 6 (ERP push). Writes each result under `<runDir>/metaharness/`, returns
 * a structured gate result for the auto-chain to record in the manifest and, in
 * `block` mode, to decide whether Phase 6 may proceed.
 *
 * Modes (AGENTICS_METAHARNESS_GATE): `off` | `advisory` (default) | `block`.
 * Advisory surfaces risk without stopping the run (the pipeline is decision
 * support); block gates Phase 6 on a minimum score and no `critical` findings.
 * When a required (block-mode) gate cannot run (`tier: 'none'`), it emits a
 * loud-failure artifact (ADR-116) rather than silently passing.
 *
 * All four assessments are static analyses run against files on disk — the gate
 * never installs, executes, or mutates the prototype (ADR-118 §D5).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { resolveMetaHarness, metaHarnessArgv, type MetaHarnessResolution } from './metaharness-resolver.js';

const execFileAsync = promisify(execFile);

/** Per-assessment subprocess budget. Static analyses; generous but bounded. */
const ASSESSMENT_TIMEOUT_MS = 60_000;

export type GateMode = 'off' | 'advisory' | 'block';
export type McpScanVerdict = 'pass' | 'warn' | 'critical' | 'unknown';

export interface AssessmentOutcome {
  readonly name: string;
  readonly ran: boolean;
  readonly artifact?: string; // runDir-relative
  readonly reason?: string; // when ran=false
}

export interface MetaHarnessGateResult {
  readonly ran: boolean;
  readonly mode: GateMode;
  readonly tier: MetaHarnessResolution['tier'];
  /** Overall score 0–100 from the scorecard, or null when unavailable. */
  readonly score: number | null;
  readonly mcpScan: McpScanVerdict;
  /** block mode: true → Phase 6 may proceed; false → blocked-by-gate. Always true off/advisory. */
  readonly proceed: boolean;
  readonly reason: string;
  readonly assessments: AssessmentOutcome[];
  readonly artifacts: string[];
  /** Set when a required (block) gate could not run — path to the loud-failure ADR. */
  readonly failureArtifact?: string;
}

/** Parse the gate mode from the environment (default advisory). */
export function resolveGateMode(): GateMode {
  const v = (process.env['AGENTICS_METAHARNESS_GATE'] ?? '').trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'block') return 'block';
  return 'advisory';
}

function minScore(): number {
  const n = parseInt(process.env['AGENTICS_METAHARNESS_MIN_SCORE'] ?? '', 10);
  return Number.isFinite(n) ? n : 60;
}

/** Run one MetaHarness CLI subcommand, writing raw stdout to `artifactRel`. */
async function runAssessment(
  resolution: MetaHarnessResolution,
  name: string,
  sub: string[],
  runDir: string,
  artifactRel: string,
): Promise<{ outcome: AssessmentOutcome; stdout: string | null }> {
  const argv = metaHarnessArgv(resolution, sub);
  if (!argv) {
    return { outcome: { name, ran: false, reason: `tier ${resolution.tier} cannot run CLI subcommand` }, stdout: null };
  }
  try {
    const { stdout } = await execFileAsync(argv.command, argv.args, {
      timeout: ASSESSMENT_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 8_000_000,
    });
    const outAbs = path.join(runDir, artifactRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, stdout, 'utf-8');
    return { outcome: { name, ran: true, artifact: artifactRel }, stdout };
  } catch (err) {
    // Unknown subcommand / non-zero exit / timeout — record, do not throw.
    return {
      outcome: { name, ran: false, reason: (err as Error).message.split('\n')[0] },
      stdout: null,
    };
  }
}

/** Best-effort extraction of an overall 0–100 score from a scorecard JSON blob. */
function extractScore(stdout: string | null): number | null {
  if (!stdout) return null;
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>;
    for (const key of ['overall', 'overall_score', 'score', 'composite', 'composite_score', 'total']) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    // Nested { scorecard: { overall } } shapes.
    const nested = obj['scorecard'] as Record<string, unknown> | undefined;
    if (nested && typeof nested['overall'] === 'number') return nested['overall'] as number;
  } catch {
    // Not JSON — try a "score: NN" text scrape.
    const m = stdout.match(/\b(?:overall|score)\b[^0-9]{0,12}(\d{1,3})\b/i);
    if (m) return Math.min(100, parseInt(m[1]!, 10));
  }
  return null;
}

/** Best-effort mcp-scan verdict from its JSON/text output. */
function extractMcpVerdict(stdout: string | null): McpScanVerdict {
  if (!stdout) return 'unknown';
  const lower = stdout.toLowerCase();
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>;
    const findings = (obj['findings'] ?? obj['issues']) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(findings)) {
      const sev = findings.map((f) => String(f['severity'] ?? '').toLowerCase());
      if (sev.includes('critical')) return 'critical';
      if (sev.includes('high') || sev.includes('warn') || sev.includes('medium')) return 'warn';
      return 'pass';
    }
  } catch {
    /* fall through to text heuristic */
  }
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('warn') || lower.includes('high')) return 'warn';
  return 'pass';
}

function writeLoudFailure(runDir: string, resolution: MetaHarnessResolution, mode: GateMode): string {
  const rel = 'metaharness/METAHARNESS-FAIL-001.md';
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = [
    '# METAHARNESS-FAIL-001: Quality & Security Gate Could Not Run',
    '',
    '**Status:** Failed',
    `**Mode:** ${mode} (blocking)`,
    '**Phase:** 5.5 (between Build and ERP push)',
    '',
    '## What happened',
    '',
    'The MetaHarness quality & security gate (ADR-PIPELINE-118) is required in `block` mode,',
    'but MetaHarness could not be resolved, so no fit/cost/safety score or tool-surface threat',
    'scan could be produced for the generated prototype. Per ADR-PIPELINE-116, the pipeline',
    'emits this loud-failure artifact instead of silently passing an unverified prototype to',
    'the ERP surface.',
    '',
    '## Resolver result',
    '',
    '```',
    `tier:   ${resolution.tier}`,
    `reason: ${resolution.reason}`,
    '```',
    '',
    '## Recovery',
    '',
    '1. Install MetaHarness (`npm i -g metaharness`) or set `AGENTICS_METAHARNESS_BIN`.',
    '2. Or connect the ruflo / claude-flow MCP server and set `AGENTICS_METAHARNESS_MCP=1`.',
    '3. Or run in advisory mode: `AGENTICS_METAHARNESS_GATE=advisory` (surfaces risk, does not block).',
    '',
  ].join('\n');
  fs.writeFileSync(abs, body + '\n', 'utf-8');
  return rel;
}

export interface GenomeResult {
  readonly ran: boolean;
  readonly score: number | null;
  readonly artifact?: string; // runDir-relative
  readonly reason: string;
}

/** Whether the advisory pre-flight genome is enabled (ADR-117 §D3, default off). */
export function isGenomeEnabled(): boolean {
  const v = (process.env['AGENTICS_METAHARNESS_GENOME'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Pre-flight genome (ADR-117 §D3): a deterministic, no-execution readiness read
 * of the working repo, written to `<runDir>/metaharness/genome.json`. Purely
 * advisory — it NEVER blocks the run; a low score is decision-relevant context
 * for the exec brief, not a stop condition. Only the CLI tier can produce it
 * from here; other tiers record `ran: false` with a reason.
 */
export async function runMetaHarnessGenome(runDir: string, targetRepo: string): Promise<GenomeResult> {
  if (!isGenomeEnabled()) {
    return { ran: false, score: null, reason: 'pre-flight genome disabled (AGENTICS_METAHARNESS_GENOME)' };
  }
  const resolution = await resolveMetaHarness();
  if (resolution.tier !== 'cli') {
    return { ran: false, score: null, reason: `genome unavailable in tier ${resolution.tier}: ${resolution.reason}` };
  }
  const { outcome, stdout } = await runAssessment(
    resolution, 'genome', ['genome', targetRepo, '--json'], runDir, 'metaharness/genome.json',
  );
  return {
    ran: outcome.ran,
    score: extractScore(stdout),
    artifact: outcome.artifact,
    reason: outcome.ran ? 'genome written' : (outcome.reason ?? 'genome did not run'),
  };
}

/**
 * Run the Phase 5.5 gate against the generated prototype directory.
 *
 * @param runDir the run directory (artifacts written under runDir/metaharness/)
 * @param projectDir the generated prototype directory to assess (Phase 5/6 project)
 */
export async function runMetaHarnessGate(runDir: string, projectDir: string): Promise<MetaHarnessGateResult> {
  const mode = resolveGateMode();
  if (mode === 'off') {
    return {
      ran: false, mode, tier: 'none', score: null, mcpScan: 'unknown',
      proceed: true, reason: 'gate disabled (AGENTICS_METAHARNESS_GATE=off)', assessments: [], artifacts: [],
    };
  }

  const resolution = await resolveMetaHarness();

  if (resolution.tier === 'none') {
    if (mode === 'block') {
      const failureArtifact = writeLoudFailure(runDir, resolution, mode);
      return {
        ran: false, mode, tier: 'none', score: null, mcpScan: 'unknown',
        proceed: false, reason: `MetaHarness unavailable in block mode: ${resolution.reason}`,
        assessments: [], artifacts: [failureArtifact], failureArtifact,
      };
    }
    return {
      ran: false, mode, tier: 'none', score: null, mcpScan: 'unknown',
      proceed: true, reason: `MetaHarness unavailable (advisory): ${resolution.reason}`,
      assessments: [], artifacts: [],
    };
  }

  // MCP tier: the CLI process defers to the host's metaharness_* MCP tools, which
  // it cannot invoke from here. Record the intent honestly; the host orchestrator
  // performs the scan. Advisory proceeds; block cannot self-verify from the CLI,
  // so it withholds the ERP push AND emits the loud-failure artifact (ADR-116)
  // rather than blocking silently.
  if (resolution.tier === 'mcp') {
    const reason = 'MetaHarness MCP tier — assessments run via the host metaharness_* tools, not the CLI subprocess';
    if (mode === 'block') {
      const failureArtifact = writeLoudFailure(runDir, resolution, mode);
      return {
        ran: false, mode, tier: 'mcp', score: null, mcpScan: 'unknown',
        proceed: false, reason: `${reason} — cannot self-verify in block mode`,
        assessments: [], artifacts: [failureArtifact], failureArtifact,
      };
    }
    return {
      ran: false, mode, tier: 'mcp', score: null, mcpScan: 'unknown',
      proceed: true, reason, assessments: [], artifacts: [],
    };
  }

  // CLI tier — run the four static assessments.
  const assessments: AssessmentOutcome[] = [];
  const artifacts: string[] = [];

  const score = await runAssessment(resolution, 'score', ['score', projectDir, '--json'], runDir, 'metaharness/scorecard.json');
  assessments.push(score.outcome);
  if (score.outcome.artifact) artifacts.push(score.outcome.artifact);

  const scan = await runAssessment(resolution, 'mcp-scan', ['mcp-scan', projectDir, '--json'], runDir, 'metaharness/mcp-scan.json');
  assessments.push(scan.outcome);
  if (scan.outcome.artifact) artifacts.push(scan.outcome.artifact);

  const threat = await runAssessment(resolution, 'threat-model', ['threat-model', projectDir], runDir, 'metaharness/threat-model.md');
  assessments.push(threat.outcome);
  if (threat.outcome.artifact) artifacts.push(threat.outcome.artifact);

  const sbom = await runAssessment(resolution, 'sbom', ['sbom', projectDir], runDir, 'metaharness/sbom.spdx.json');
  assessments.push(sbom.outcome);
  if (sbom.outcome.artifact) artifacts.push(sbom.outcome.artifact);

  const scoreVal = extractScore(score.stdout);
  const mcpVerdict = extractMcpVerdict(scan.stdout);
  const ranAny = assessments.some((a) => a.ran);

  // Decide proceed (block mode only). Fail-closed on a critical scan; require the
  // minimum score when a score was obtained. A totally unavailable CLI in block
  // mode (no assessment ran) is treated like tier:none above would be.
  let proceed = true;
  let reason: string;
  if (mode === 'block') {
    if (!ranAny) {
      const failureArtifact = writeLoudFailure(runDir, resolution, mode);
      artifacts.push(failureArtifact);
      return {
        ran: false, mode, tier: resolution.tier, score: null, mcpScan: mcpVerdict,
        proceed: false, reason: 'block mode: no MetaHarness assessment produced output',
        assessments, artifacts, failureArtifact,
      };
    }
    const scoreOk = scoreVal === null ? true : scoreVal >= minScore();
    const scanOk = mcpVerdict !== 'critical';
    proceed = scoreOk && scanOk;
    reason = proceed
      ? `block: score ${scoreVal ?? 'n/a'} >= ${minScore()} and mcp-scan=${mcpVerdict}`
      : `block: gate failed (score ${scoreVal ?? 'n/a'} vs min ${minScore()}, mcp-scan=${mcpVerdict})`;
  } else {
    reason = `advisory: score ${scoreVal ?? 'n/a'}, mcp-scan=${mcpVerdict}`;
  }

  return {
    ran: ranAny, mode, tier: resolution.tier, score: scoreVal, mcpScan: mcpVerdict,
    proceed, reason, assessments, artifacts,
  };
}
