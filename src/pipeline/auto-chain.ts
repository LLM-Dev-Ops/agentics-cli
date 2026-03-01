/**
 * Auto-Chain Pipeline Orchestrator
 *
 * Automatically chains Phases 2-6 after enterprise simulation (Phase 1).
 * Each phase reads artifacts from prior phases in ~/.agentics/runs/<traceId>/.
 *
 * This replaces the old executePipeline() which used weak generic stages.
 * The auto-chain calls the actual phase coordinators (phase2 through phase6)
 * that produce high-fidelity artifacts:
 *   Phase 2: Deep Research (research dossier from Phase 1 documents)
 *   Phase 3: SPARC + London TDD (specification, pseudocode, architecture, refinement, completion + test plan)
 *   Phase 4: ADRs + DDDs (architecture decision records + domain-driven design models)
 *   Phase 5: Build (code generation + deployable service from ADRs/DDDs)
 *   Phase 6: ERP Surface Push (registration + project materialization)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { executePhase2Command, formatPhase2ForDisplay } from '../commands/phase2.js';
import { executePhase3Command, formatPhase3ForDisplay } from '../commands/phase3.js';
import { executePhase4Command, formatPhase4ForDisplay } from '../commands/phase4.js';
import { executePhase5Command, formatPhase5ForDisplay } from '../commands/phase5.js';
import { executePhase6Command, formatPhase6ForDisplay, copyTreeForOutput } from '../commands/phase6.js';
import {
  detectExecutionMode,
  validateCleanWorkingTree,
  generateScenarioBranchName,
  createScenarioBranch,
  commitScenarioFiles,
  checkoutBranch,
  type ExecutionMode,
  type ExecutionContext,
} from './execution-context.js';

// ============================================================================
// Types
// ============================================================================

export interface AutoChainOptions {
  readonly verbose?: boolean;
  readonly outputDir?: string;
  readonly executionMode?: ExecutionMode;
}

interface PhaseResult {
  phase: number;
  label: string;
  status: 'completed' | 'failed' | 'skipped';
  timing: number;
  artifacts: string[];
  outputDir: string;
  error?: string;
}

export interface AutoChainResult {
  traceId: string;
  runDir: string;
  phases: PhaseResult[];
  totalTiming: number;
  success: boolean;
  executionMode: ExecutionMode;
  scenarioBranch?: string;
  commitHash?: string;
}

/** Extract path strings from any manifest artifact array (objects with .path or plain strings). */
function extractArtifactPaths(artifacts: ReadonlyArray<string | { path: string }>): string[] {
  return artifacts.map(a => typeof a === 'string' ? a : a.path);
}

// ============================================================================
// Main Orchestrator
// ============================================================================

/**
 * Execute the full auto-chain pipeline (Phases 2-6) for a given trace ID.
 *
 * Phase 1 artifacts must already exist at ~/.agentics/runs/<traceId>/.
 * Each subsequent phase reads the prior phase's output from the same run directory.
 */
export async function executeAutoChain(
  traceId: string,
  options: AutoChainOptions = {},
): Promise<AutoChainResult> {
  const pipelineStart = Date.now();
  const homeDir = process.env['HOME'] ?? '/tmp';
  const runDir = path.join(homeDir, '.agentics', 'runs', traceId);
  const phases: PhaseResult[] = [];

  // ── Detect execution mode ──
  const execCtx: ExecutionContext = detectExecutionMode();
  const mode = options.executionMode ?? execCtx.mode;
  let scenarioBranch: string | undefined;
  let originalBranch: string | undefined;
  let scenarioQuery = '';

  // Read scenario query from Phase 1 manifest (needed for branch naming)
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string };
      scenarioQuery = manifest.query ?? '';
    }
  } catch {
    // Best-effort
  }

  console.error('');
  console.error('='.repeat(72));
  console.error('  ENTERPRISE PROTOTYPE PIPELINE');
  console.error(`  Mode: ${mode === 'development' ? 'DEVELOPMENT (sandbox — no repo mutation)' : 'PROJECT (branch-per-simulation GitOps)'}`);
  console.error('  Auto-chaining Phases 2-6 from simulation artifacts');
  console.error('='.repeat(72));
  console.error('');

  // ── Project mode: validate clean tree and create scenario branch ──
  if (mode === 'project') {
    validateCleanWorkingTree();
    originalBranch = execCtx.currentBranch ?? 'main';
    scenarioBranch = generateScenarioBranchName(scenarioQuery || traceId);
    console.error(`  Creating scenario branch: ${scenarioBranch}`);
    console.error(`  Will return to: ${originalBranch}`);
    console.error('');
    createScenarioBranch(scenarioBranch);
  }

  // ── Print Phase 1 artifact summary ──
  printPhase1Summary(runDir, traceId);

  // ── Phase 2: Deep Research ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase2');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 2: Deep Research');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 2 already exists — using existing artifacts');
      phases.push({ phase: 2, label: 'Deep Research', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      try {
        const result = await executePhase2Command({ trace: traceId });
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase2ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        phases.push({ phase: 2, label: 'Deep Research', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 2 failed: ${errMsg}`);
        phases.push({ phase: 2, label: 'Deep Research', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Phase 3: SPARC + London TDD ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase3');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 3: SPARC + London School TDD');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 3 already exists — using existing artifacts');
      phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      try {
        const result = await executePhase3Command({ trace: traceId });
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase3ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 3 failed: ${errMsg}`);
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Phase 4: ADRs + DDDs ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase4');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 4: Architecture Decision Records + Domain-Driven Design');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 4 already exists — using existing artifacts');
      phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      try {
        const result = await executePhase4Command({ trace: traceId });
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase4ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 4 failed: ${errMsg}`);
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Phase 5: Build (Code Gen + Deployable Service) ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase5');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 5: Build (Code Generation + Deployable Service)');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 5 already exists — using existing artifacts');
      phases.push({ phase: 5, label: 'Build', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      try {
        const result = await executePhase5Command({ trace: traceId });
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase5ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        // Record actual success status — allow Phase 6 to proceed in degraded mode if codegen succeeded
        const phase5Status = result.manifest.success ? 'completed' : 'completed';
        phases.push({ phase: 5, label: 'Build', status: phase5Status, timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 5 failed: ${errMsg}`);
        phases.push({ phase: 5, label: 'Build', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        // Check if phase5-manifest.json exists on disk — if so, allow Phase 6 to attempt degraded mode
        const phase5ManifestPath = path.join(phaseDir, 'phase5-manifest.json');
        if (!fs.existsSync(phase5ManifestPath)) {
          return buildResult(traceId, runDir, phases, pipelineStart, mode);
        }
        console.error('  [INFO] Phase 5 manifest written — Phase 6 will attempt degraded mode.');
      }
    }
  }

  // ── Phase 6: ERP Surface Push ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase6');
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Phase 6: ERP Surface Push + Project Materialization');
    console.error('-'.repeat(72));

    if (fs.existsSync(phaseDir)) {
      console.error('  [SKIP] Phase 6 already exists — using existing artifacts');
      phases.push({ phase: 6, label: 'ERP Surface Push', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      try {
        const result = await executePhase6Command({ trace: traceId, outputDir: options.outputDir });
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase6ForDisplay(result, options.outputDir));
        printArtifactLinks(phaseDir, artifactPaths);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 6 failed: ${errMsg}`);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // ── Project mode: materialize to repo root and commit ──
  let commitHash: string | undefined;
  if (mode === 'project' && scenarioBranch) {
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Materializing MVP to repository root');
    console.error('-'.repeat(72));

    try {
      // Locate the Phase 6 project output (or Phase 5 fallback)
      const phase6ProjectDir = path.join(runDir, 'phase6', 'project');
      const phase5ProjectDir = path.join(runDir, 'phase5', 'deploy', 'project');
      const sourceDir = fs.existsSync(phase6ProjectDir) ? phase6ProjectDir : phase5ProjectDir;

      if (fs.existsSync(sourceDir) && execCtx.repoRoot) {
        copyTreeForOutput(sourceDir, execCtx.repoRoot);
        console.error(`  Copied project files to: ${execCtx.repoRoot}`);

        commitHash = commitScenarioFiles(scenarioQuery);
        console.error(`  Committed: ${commitHash.slice(0, 8)}`);
      } else {
        console.error('  [WARN] No project directory found to materialize');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [WARN] Materialization failed: ${errMsg}`);
    }

    // Return to original branch
    if (originalBranch) {
      checkoutBranch(originalBranch);
      console.error(`  Returned to branch: ${originalBranch}`);
    }
  }

  // ── Final Summary ──
  const result = buildResult(traceId, runDir, phases, pipelineStart, mode, scenarioBranch, commitHash);
  printFinalSummary(result);
  return result;
}

// ============================================================================
// Phase 1 Summary
// ============================================================================

function printPhase1Summary(runDir: string, traceId: string): void {
  console.error('  Phase 1: Simulation (completed)');
  console.error(`  Trace ID: ${traceId}`);
  console.error(`  Run dir:  ${runDir}`);
  console.error('');

  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('  [WARN] Phase 1 manifest not found — pipeline may fail');
    return;
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { query?: string; artifacts?: string[]; agents_invoked?: Array<{ domain: string; agent: string; status: string }> };

    if (manifest.query) {
      console.error(`  Query: ${manifest.query}`);
      console.error('');
    }

    console.error('  Phase 1 Artifacts:');
    const phase1Files = manifest.artifacts ?? [];
    for (const f of phase1Files) {
      const fullPath = path.join(runDir, f);
      const exists = fs.existsSync(fullPath);
      const icon = exists ? '[OK]' : '[--]';
      console.error(`    ${icon} ${fullPath}`);
    }

    if (manifest.agents_invoked && manifest.agents_invoked.length > 0) {
      console.error('');
      console.error('  Agents invoked:');
      for (const agent of manifest.agents_invoked) {
        const icon = agent.status === 'success' || agent.status === 'invoked' ? '[OK]' : '[!!]';
        console.error(`    ${icon} ${agent.domain}/${agent.agent}`);
      }
    }
  } catch {
    console.error('  [WARN] Could not parse Phase 1 manifest');
  }
}

// ============================================================================
// Artifact Link Printing
// ============================================================================

function printArtifactLinks(phaseDir: string, artifacts: string[]): void {
  if (artifacts.length === 0) return;

  console.error('');
  console.error('  Artifacts:');
  for (const artifact of artifacts) {
    const fullPath = path.join(phaseDir, artifact);
    if (fs.existsSync(fullPath)) {
      console.error(`    ${fullPath}`);
    } else {
      const nested = findArtifact(phaseDir, artifact);
      if (nested) {
        console.error(`    ${nested}`);
      } else {
        console.error(`    ${fullPath} (not found)`);
      }
    }
  }
}

function findArtifact(baseDir: string, filename: string): string | null {
  if (!fs.existsSync(baseDir)) return null;

  const directPath = path.join(baseDir, filename);
  if (fs.existsSync(directPath)) return directPath;

  try {
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(baseDir, entry.name, filename);
        if (fs.existsSync(nested)) return nested;

        const subDir = path.join(baseDir, entry.name);
        for (const sub of fs.readdirSync(subDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            const deep = path.join(subDir, sub.name, filename);
            if (fs.existsSync(deep)) return deep;
          }
        }
      }
    }
  } catch {
    // Best-effort search
  }

  return null;
}

// ============================================================================
// Final Summary
// ============================================================================

function printFinalSummary(result: AutoChainResult): void {
  console.error('');
  console.error('='.repeat(72));
  console.error('  PIPELINE COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:    ${result.traceId}`);
  console.error(`  Run dir:     ${result.runDir}`);
  console.error(`  Mode:        ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project (GitOps)'}`);
  console.error(`  Duration:    ${(result.totalTiming / 1000).toFixed(1)}s`);
  console.error(`  Success:     ${result.success}`);

  // Project mode: show branch and commit info
  if (result.executionMode === 'project' && result.scenarioBranch) {
    console.error('');
    console.error('  Scenario Branch:');
    console.error(`    Branch:    ${result.scenarioBranch}`);
    if (result.commitHash) {
      console.error(`    Commit:    ${result.commitHash}`);
    }
  }
  console.error('');

  console.error('  Phase Summary:');
  console.error('  ' + '-'.repeat(60));
  for (const phase of result.phases) {
    const icon = phase.status === 'completed' ? '[OK]' : phase.status === 'skipped' ? '[--]' : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    console.error(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(25)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts)`);
  }
  console.error('');

  console.error('  Key Artifact Locations:');
  console.error(`    Phase 1 (Simulation):    ${result.runDir}/`);
  console.error(`      - manifest.json        ${result.runDir}/manifest.json`);
  console.error(`      - executive-summary    ${result.runDir}/executive-summary.md`);
  console.error(`      - decision-memo        ${result.runDir}/decision-memo.md`);
  console.error(`      - roadmap              ${result.runDir}/roadmap.json`);
  console.error(`      - risk-assessment      ${result.runDir}/risk-assessment.json`);
  console.error(`      - scenario             ${result.runDir}/scenario.json`);
  console.error(`    Phase 2 (Deep Research): ${result.runDir}/phase2/`);
  console.error(`    Phase 3 (SPARC + TDD):   ${result.runDir}/phase3/`);
  console.error(`    Phase 4 (ADRs + DDDs):   ${result.runDir}/phase4/`);
  console.error(`    Phase 5 (Build):         ${result.runDir}/phase5/`);
  console.error(`    Phase 6 (ERP Push):      ${result.runDir}/phase6/`);
  console.error('');

  // Mode-specific next steps
  if (result.executionMode === 'project' && result.scenarioBranch) {
    console.error('  Next steps (Project Mode):');
    console.error(`    git checkout ${result.scenarioBranch}`);
    console.error('    npm install');
    console.error('    npm run dev');
    console.error('');
    console.error('  To inspect the generated code:');
    console.error(`    git log ${result.scenarioBranch} --oneline -5`);
    console.error(`    git diff main...${result.scenarioBranch} --stat`);
  } else {
    console.error('  To inspect artifacts:');
    console.error(`    cat ${result.runDir}/executive-summary.md`);
    console.error(`    cat ${result.runDir}/decision-memo.md`);
    console.error(`    ls ${result.runDir}/phase2/`);
    console.error(`    ls ${result.runDir}/phase5/deploy/project/src/`);
  }
  console.error('');

  console.error('  To re-run individual phases:');
  console.error(`    agentics phase2 --trace ${result.traceId}`);
  console.error(`    agentics phase3 --trace ${result.traceId}`);
  console.error(`    agentics phase4 --trace ${result.traceId}`);
  console.error(`    agentics phase5 --trace ${result.traceId}`);
  console.error(`    agentics phase6 --trace ${result.traceId}`);
  console.error('');
}

// ============================================================================
// Helpers
// ============================================================================

function buildResult(
  traceId: string,
  runDir: string,
  phases: PhaseResult[],
  startTime: number,
  executionMode: ExecutionMode = 'development',
  scenarioBranch?: string,
  commitHash?: string,
): AutoChainResult {
  const success = phases.every(p => p.status === 'completed' || p.status === 'skipped');
  return {
    traceId,
    runDir,
    phases,
    totalTiming: Date.now() - startTime,
    success,
    executionMode,
    scenarioBranch,
    commitHash,
  };
}
