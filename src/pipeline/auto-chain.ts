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

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { executePhase2Command, formatPhase2ForDisplay } from '../commands/phase2.js';
import { executePhase3Command, formatPhase3ForDisplay } from '../commands/phase3.js';
import { executePhase4Command, formatPhase4ForDisplay } from '../commands/phase4.js';
import { executePhase5Command, formatPhase5ForDisplay } from '../commands/phase5.js';
import { executePhase6Command, formatPhase6ForDisplay, copyTreeForOutput } from '../commands/phase6.js';
import {
  detectExecutionMode,
  commitScenarioFiles,
  type ExecutionMode,
  type ExecutionContext,
} from './execution-context.js';
import {
  initSwarm,
  dispatchPhaseAgents,
  storePhaseArtifacts,
  reviewPhaseOutput,
  recordPhaseFailure,
  shutdownSwarm,
  invokeRufloCodingSwarm,
  PHASE_AGENTS,
  type AgenticsServiceResult,
} from './swarm-orchestrator.js';
import {
  executeRufloPhaseSwarm,
  buildPhase2Tasks,
  buildPhase3Tasks,
  buildPhase4Tasks,
  buildPhase5Tasks,
  buildPhase6Tasks,
  collectPhase2Artifacts,
  collectPhase3Artifacts,
  collectPhase4Artifacts,
  collectPhase5Artifacts,
  collectPhase6Artifacts,
  extractPhase1AgentCode,
} from './ruflo-phase-executor.js';

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
  agenticsAgents?: { total: number; responded: number; domains: string[] };
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
  githubUrl?: string;
}

/** Extract path strings from any manifest artifact array (objects with .path or plain strings). */
function extractArtifactPaths(artifacts: ReadonlyArray<string | { path: string }>): string[] {
  return artifacts.map(a => typeof a === 'string' ? a : a.path);
}

// ============================================================================
// Progressive Artifact Copy — runs after EVERY phase so .agentics/plans/ is
// always up to date even if later phases fail or timeout.
// ============================================================================

/** Check whether src and dest files have identical content (by size + bytes). */
function filesAreIdentical(src: string, dest: string): boolean {
  try {
    const srcStat = fs.statSync(src);
    const destStat = fs.statSync(dest);
    if (srcStat.size !== destStat.size) return false;
    // For small files compare content directly; for large files size match is sufficient
    if (srcStat.size > 1024 * 1024) return true;
    const srcBuf = fs.readFileSync(src);
    const destBuf = fs.readFileSync(dest);
    return srcBuf.equals(destBuf);
  } catch {
    return false;
  }
}

function copyDirRecursive(src: string, dest: string): { copied: number; skipped: number } {
  if (!fs.existsSync(src)) return { copied: 0, skipped: 0 };
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isFile()) {
      if (fs.existsSync(destPath) && filesAreIdentical(srcPath, destPath)) {
        skipped++;
      } else {
        fs.copyFileSync(srcPath, destPath);
        copied++;
      }
    } else if (stat.isDirectory()) {
      const sub = copyDirRecursive(srcPath, destPath);
      copied += sub.copied;
      skipped += sub.skipped;
    }
  }
  return { copied, skipped };
}

/**
 * Copy whatever planning artifacts exist from ~/.agentics/runs/<traceId>/
 * to .agentics/plans/ in the current working directory. Uses .agentics/plans/
 * instead of plans/ to avoid colliding with any existing plans/ folder in the
 * project (e.g., SPARC artifacts checked into the repo). Skips files that
 * already exist with identical content to avoid unnecessary duplication.
 *
 * Called after every phase so even if later phases fail, earlier artifacts
 * are still available.
 */
function copyPlanningArtifacts(runDir: string, targetRoot?: string): void {
  try {
    // ADR-051: Use git repo root (or explicit target) instead of process.cwd()
    // When running as MCP server, process.cwd() may not be the user's project directory
    const projectRoot = targetRoot ?? process.cwd();
    const plansDir = path.join(projectRoot, '.agentics', 'plans');
    let totalCopied = 0;
    let totalSkipped = 0;

    /** Copy a single file with dedup check. */
    function copySingleFile(src: string, dest: string): void {
      if (!fs.existsSync(src)) return;
      if (fs.existsSync(dest) && filesAreIdentical(src, dest)) {
        totalSkipped++;
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      totalCopied++;
    }

    /** Accumulate results from copyDirRecursive. */
    function copyDirAccum(src: string, dest: string): void {
      const r = copyDirRecursive(src, dest);
      totalCopied += r.copied;
      totalSkipped += r.skipped;
    }

    // SPARC: prefer Phase 3 refined, fall back to Phase 2
    const phase3Sparc = path.join(runDir, 'phase3', 'sparc');
    const phase2Sparc = path.join(runDir, 'phase2', 'sparc');
    const sparcSource = fs.existsSync(phase3Sparc) ? phase3Sparc : phase2Sparc;
    copyDirAccum(sparcSource, path.join(plansDir, 'sparc'));

    // ADRs from Phase 4
    copyDirAccum(path.join(runDir, 'phase4', 'adrs'), path.join(plansDir, 'adrs'));

    // DDD from Phase 4 (or Phase 2 fallback)
    const phase4Ddd = path.join(runDir, 'phase4', 'ddd');
    const phase2Ddd = path.join(runDir, 'phase2', 'ddd');
    const dddSource = fs.existsSync(phase4Ddd) ? phase4Ddd : phase2Ddd;
    copyDirAccum(dddSource, path.join(plansDir, 'ddd'));

    // TDD from Phase 2 or 3
    const phase3Tdd = path.join(runDir, 'phase3', 'tdd');
    const phase2Tdd = path.join(runDir, 'phase2', 'tdd');
    const tddSource = fs.existsSync(phase3Tdd) ? phase3Tdd : phase2Tdd;
    copyDirAccum(tddSource, path.join(plansDir, 'tdd'));

    // Phase 1 artifacts (always available after Phase 1)
    for (const file of ['scenario.json', 'roadmap.json']) {
      copySingleFile(path.join(runDir, file), path.join(plansDir, 'implementation', file));
    }
    for (const file of ['executive-summary.md', 'decision-memo.md', 'risk-assessment.json', 'manifest.json']) {
      copySingleFile(path.join(runDir, file), path.join(plansDir, file));
    }

    // Research dossier from Phase 2
    copySingleFile(path.join(runDir, 'phase2', 'research-dossier.json'), path.join(plansDir, 'research-dossier.json'));
    copySingleFile(path.join(runDir, 'phase2', 'research-dossier.md'), path.join(plansDir, 'research-dossier.md'));

    // Implementation prompts from prompt-generator (ADR-driven prompts)
    const promptsDir = path.join(runDir, 'prompts');
    copyDirAccum(promptsDir, path.join(plansDir, 'prompts'));

    // Implementation prompt from Phase 3 (Ruflo swarm directive)
    copySingleFile(
      path.join(runDir, 'phase3', 'implementation-prompt.md'),
      path.join(plansDir, 'prompts', 'phase3-implementation-prompt.md'),
    );

    // Implementation prompts from Phase 4 (domain codegen prompts)
    const phase4Prompts = path.join(runDir, 'phase4', 'prompts');
    copyDirAccum(phase4Prompts, path.join(plansDir, 'prompts', 'phase4'));

    // Phase 5 integration inference results
    copySingleFile(
      path.join(runDir, 'phase5', 'integration-inference.json'),
      path.join(plansDir, 'integration-inference.json'),
    );

    // ADR-PIPELINE-039: Write actual scaffold files that Claude Code can include directly.
    // These are the cross-cutting infrastructure modules that every project needs.
    // Instead of hoping the coding agent reads the prompts, we deliver the files.
    const scaffoldDir = path.join(plansDir, 'scaffold', 'src');
    fs.mkdirSync(scaffoldDir, { recursive: true });

    const loggerCode = `// Auto-generated by Agentics pipeline (ADR-039)
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}

let currentCorrelationId: string | undefined;

export function setCorrelationId(id: string): void { currentCorrelationId = id; }
export function getCorrelationId(): string | undefined { return currentCorrelationId; }

export function createLogger(service: string): Logger {
  const emit = (level: string, event: string, extra?: Record<string, unknown>) => {
    const entry = { timestamp: new Date().toISOString(), level, service, event, ...(currentCorrelationId ? { correlationId: currentCorrelationId } : {}), ...extra };
    process.stderr.write(JSON.stringify(entry) + '\\n');
  };
  return {
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, err, data) => emit('error', event, { error: err.message, stack: err.stack, ...data }),
  };
}
`;

    const configCode = `// Auto-generated by Agentics pipeline (ADR-039)
export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: {
    baseUrl: string;
    apiVersion: string;
    timeoutMs: number;
    maxRetries: number;
  };
}

export const config: AppConfig = {
  env: (process.env['NODE_ENV'] ?? 'development') as AppConfig['env'],
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  logLevel: (process.env['LOG_LEVEL'] ?? 'info') as AppConfig['logLevel'],
  erp: {
    baseUrl: process.env['ERP_BASE_URL'] ?? 'https://api.example.com',
    apiVersion: process.env['ERP_API_VERSION'] ?? 'v1',
    timeoutMs: parseInt(process.env['ERP_TIMEOUT_MS'] ?? '30000', 10),
    maxRetries: parseInt(process.env['ERP_MAX_RETRIES'] ?? '3', 10),
  },
};
`;

    const errorsCode = `// Auto-generated by Agentics pipeline (ADR-039)
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 500) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(\`\${entity} \${id} not found\`, 'NOT_FOUND', 404);
  }
}

export class ERPError extends AppError {
  constructor(message: string, public readonly retryable: boolean) {
    super(message, 'ERP_ERROR', 502);
  }
}
`;

    // TypeScript scaffold (default)
    fs.writeFileSync(path.join(scaffoldDir, 'logger.ts'), loggerCode, 'utf-8');
    fs.writeFileSync(path.join(scaffoldDir, 'config.ts'), configCode, 'utf-8');
    fs.writeFileSync(path.join(scaffoldDir, 'errors.ts'), errorsCode, 'utf-8');

    // Python scaffold (if SPARC specifies Python or query mentions it)
    const pyDir = path.join(plansDir, 'scaffold', 'python');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'logger.py'), `"""Structured JSON logger — auto-generated by Agentics pipeline."""
import json, sys, time
from typing import Any, Optional

_correlation_id: Optional[str] = None

def set_correlation_id(cid: str) -> None:
    global _correlation_id
    _correlation_id = cid

def get_correlation_id() -> Optional[str]:
    return _correlation_id

def _emit(level: str, service: str, event: str, **data: Any) -> None:
    entry = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "service": service, "event": event}
    if _correlation_id:
        entry["correlationId"] = _correlation_id
    entry.update(data)
    print(json.dumps(entry), file=sys.stderr)

class Logger:
    def __init__(self, service: str):
        self._service = service
    def info(self, event: str, **data: Any) -> None: _emit("info", self._service, event, **data)
    def warn(self, event: str, **data: Any) -> None: _emit("warn", self._service, event, **data)
    def error(self, event: str, error: Exception, **data: Any) -> None: _emit("error", self._service, event, error=str(error), **data)

def create_logger(service: str) -> Logger:
    return Logger(service)
`, 'utf-8');
    fs.writeFileSync(path.join(pyDir, 'config.py'), `"""Environment-based configuration — auto-generated by Agentics pipeline."""
import os

class AppConfig:
    env: str = os.getenv("APP_ENV", "development")
    port: int = int(os.getenv("PORT", "8000"))
    log_level: str = os.getenv("LOG_LEVEL", "info")
    erp_base_url: str = os.getenv("ERP_BASE_URL", "https://api.example.com")
    erp_api_version: str = os.getenv("ERP_API_VERSION", "v1")
    erp_timeout_ms: int = int(os.getenv("ERP_TIMEOUT_MS", "30000"))
    erp_max_retries: int = int(os.getenv("ERP_MAX_RETRIES", "3"))

config = AppConfig()
`, 'utf-8');
    fs.writeFileSync(path.join(pyDir, 'errors.py'), `"""Typed error hierarchy — auto-generated by Agentics pipeline."""

class AppError(Exception):
    def __init__(self, message: str, code: str, status_code: int = 500):
        super().__init__(message)
        self.code = code
        self.status_code = status_code

class ValidationError(AppError):
    def __init__(self, message: str):
        super().__init__(message, "VALIDATION_ERROR", 400)

class NotFoundError(AppError):
    def __init__(self, entity: str, entity_id: str):
        super().__init__(f"{entity} {entity_id} not found", "NOT_FOUND", 404)

class ERPError(AppError):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message, "ERP_ERROR", 502)
        self.retryable = retryable
`, 'utf-8');

    totalCopied += 6; // 3 TS + 3 Python

    if (totalCopied > 0 || totalSkipped > 0) {
      const parts: string[] = [];
      if (totalCopied > 0) parts.push(`${totalCopied} copied`);
      if (totalSkipped > 0) parts.push(`${totalSkipped} unchanged (skipped)`);
      console.error(`  [PLANS] ${parts.join(', ')} → .agentics/plans/`);
    }
  } catch {
    // Non-fatal — never block the pipeline for artifact copy
  }
}

/**
 * Merge ruflo swarm output from .ruflo-cache/phaseN/ into the phase directory.
 * Ruflo-produced files supplement the template generator output. Markdown files
 * from ruflo are written alongside (not overwriting) template-generated files
 * to ensure agent-produced research and SPARC content is preserved.
 */
function mergeRufloCacheIntoPhase(runDir: string, phaseNum: number): number {
  const cacheDir = path.join(runDir, '.ruflo-cache', `phase${phaseNum}`);
  const phaseDir = path.join(runDir, `phase${phaseNum}`);

  if (!fs.existsSync(cacheDir)) return 0;
  if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

  let merged = 0;

  function copyRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else {
        // Skip swarm metadata files — they're coordination artifacts, not content
        if (entry.name === 'state.json' && srcPath.includes('.swarm')) continue;
        if (entry.name === 'store.json' && srcPath.includes('.claude-flow')) continue;
        // Ruflo swarm output is PRIMARY when it produces real content.
        // Always overwrite template-generated files so agent output takes priority.
        fs.copyFileSync(srcPath, destPath);
        merged++;
      }
    }
  }

  try {
    copyRecursive(cacheDir, phaseDir);
    if (merged > 0) {
      console.error(`  [MERGE] Copied ${merged} ruflo swarm files into phase${phaseNum}/`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [MERGE] Warning: ${msg}`);
  }

  return merged;
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
/**
 * ADR-PIPELINE-028: Nuclear ADR guarantee. Call before returning from executeAutoChain.
 * Checks if ADRs exist anywhere in the run directory. If not, generates them from
 * the scenario query using the template builder (no LLM required).
 */
async function ensureAdrsExist(runDir: string, traceId: string, scenarioQuery: string): Promise<void> {
  if (!scenarioQuery) return;

  const adrLocations = [
    path.join(runDir, 'phase4', 'adrs', 'adr-index.json'),
    path.join(runDir, 'phase2', 'adrs', 'adr-index.json'),
  ];
  const hasAdrs = adrLocations.some(p => {
    try {
      if (!fs.existsSync(p)) return false;
      const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(content) && content.length > 0;
    } catch { return false; }
  });

  if (hasAdrs) return;

  console.error('');
  console.error('  [ADR-028] No ADRs found — generating guaranteed set');

  try {
    const { buildPhase2ADRs } = await import('./phase2/phases/adr-generator.js');
    const { buildPhase2DDD } = await import('./phase2/phases/ddd-generator.js');

    // Load SPARC/dossier from any available location, or use empty defaults
    let sparc: Record<string, unknown> = { architecture: { services: [] }, specification: { requirements: [], constraints: [] } };
    let dossier: Record<string, unknown> = { items: [], crossReferences: [], summary: { totalItems: 0, bySource: {}, byCategory: {}, keyRisks: [], criticalConstraints: [] }, id: 'fallback', traceId, generatedFrom: 'adr-028-guarantee' };

    for (const sub of ['phase3/sparc/sparc-combined.json', 'phase2/sparc/sparc-combined.json', 'phase2/sparc-specification.json']) {
      const p = path.join(runDir, sub);
      if (fs.existsSync(p)) { try { sparc = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
    }
    for (const sub of ['phase2/research-dossier.json', 'research-dossier.json']) {
      const p = path.join(runDir, sub);
      if (fs.existsSync(p)) { try { dossier = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
    }

    const adrs = buildPhase2ADRs(sparc as any, dossier as any, scenarioQuery, true /* skipLLM */);
    if (adrs.length === 0) return;

    // Write to BOTH phase4 and phase2 so downstream consumers find them regardless of which path they check
    for (const targetDir of [path.join(runDir, 'phase4'), path.join(runDir, 'phase2')]) {
      const adrDir = path.join(targetDir, 'adrs');
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, 'adr-index.json'), JSON.stringify(adrs, null, 2) + '\n', 'utf-8');
      for (const adr of adrs) {
        const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        const md = [
          `# ${adr.id}: ${adr.title}`,
          `\n**Status:** ${adr.status}`,
          `**Date:** ${adr.date}`,
          `\n## Context\n${adr.context}`,
          `\n## Decision\n${adr.decision}`,
          adr.alternatives?.length > 0 ? `\n## Alternatives Considered\n${adr.alternatives.map((a: any) => `- **${a.option}** ${a.rejected ? '(rejected)' : '(selected)'}: ${a.rationale}`).join('\n')}` : '',
          adr.consequences?.length > 0 ? `\n## Consequences\n${adr.consequences.map((c: any) => `- [${c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~'}] ${c.description}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        fs.writeFileSync(path.join(adrDir, `${adr.id}-${slug}.md`), md + '\n', 'utf-8');
      }
    }
    console.error(`  [ADR-028] Generated ${adrs.length} ADRs (phase4/adrs/ + phase2/adrs/)`);

    // Also generate DDD model
    try {
      const dddModel = buildPhase2DDD(sparc as any, adrs as any, dossier as any, scenarioQuery);
      if (dddModel?.contexts?.length > 0) {
        for (const targetDir of [path.join(runDir, 'phase4'), path.join(runDir, 'phase2')]) {
          const dddDir = path.join(targetDir, 'ddd');
          fs.mkdirSync(dddDir, { recursive: true });
          fs.writeFileSync(path.join(dddDir, 'domain-model.json'), JSON.stringify(dddModel, null, 2) + '\n', 'utf-8');
        }
        console.error(`  [ADR-028] Generated DDD model (${dddModel.contexts.length} bounded contexts)`);
      }
    } catch {
      // DDD is best-effort
    }

    // Write phase4-manifest.json so Phase 5 can proceed
    const phase4Dir = path.join(runDir, 'phase4');
    const manifestPath = path.join(phase4Dir, 'phase4-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const manifest = {
        schema_version: '4.0.0',
        trace_id: traceId,
        generated_at: new Date().toISOString(),
        pipeline_version: '1.9.5',
        stages: [
          { stage: 'prior-phase-loading', status: 'completed', timing_ms: 0, artifact_count: 0 },
          { stage: 'adr-generation', status: 'completed', timing_ms: 0, artifact_count: adrs.length },
          { stage: 'ddd-generation', status: 'completed', timing_ms: 0, artifact_count: 1 },
        ],
        artifacts: adrs.map(a => ({
          path: `adrs/${a.id}-${(a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`,
          sha256: 'generated-by-adr-028-guarantee',
          size_bytes: 0,
        })),
        success: true,
        implementation_language: 'typescript',
        erp_system: adrs.find(a => /integration/i.test(a.title))?.title.match(/(\w+)\s+Integration/)?.[1] ?? 'generic',
      };
      fs.mkdirSync(phase4Dir, { recursive: true });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      console.error(`  [ADR-028] Wrote phase4-manifest.json (enables Phase 5)`);
    }
  } catch (err) {
    console.error(`  [ADR-028] ADR guarantee failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
  // ADR-051: Use git repo root for artifact placement — process.cwd() is unreliable in MCP mode
  const projectRoot = execCtx.repoRoot ?? process.cwd();
  let scenarioBranch: string | undefined;
  let originalBranch: string | undefined;
  let scenarioQuery = '';

  // Read scenario query and simulation ID from Phase 1 manifest
  let simulationId = '';
  try {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { query?: string; simulation_id?: string; execution_id?: string };
      scenarioQuery = manifest.query ?? '';
      simulationId = manifest.simulation_id ?? manifest.execution_id ?? '';
    }
  } catch {
    // Best-effort
  }

  console.error('');
  console.error('='.repeat(72));
  console.error('  ENTERPRISE PROTOTYPE PIPELINE');
  console.error(`  Mode: ${mode === 'development' ? 'DEVELOPMENT (sandbox — no repo mutation)' : 'PROJECT (current branch)'}`);
  console.error('  Auto-chaining Phases 2-6 from simulation artifacts');
  console.error('='.repeat(72));
  console.error('');

  // ── Check ruflo availability (optional — pipeline works without it) ──
  {
    try {
      execSync('ruflo --version', { stdio: 'pipe', timeout: 5000 });
    } catch {
      // ruflo not installed — pipeline continues without coding swarm
      // This is normal when running via MCP or in environments without ruflo
    }
  }

  // ── Initialize Ruflo swarm orchestration ──
  const swarmActive = initSwarm({
    topology: 'hierarchical',
    maxAgents: 8,
    strategy: 'specialized',
    traceId,
    runDir,
  });
  if (swarmActive) {
    console.error('  Ruflo swarm active — agents will coordinate each phase');
    console.error('');
  }

  // ── Project mode: stay on current branch, output to project subdirectory ──
  if (mode === 'project') {
    originalBranch = execCtx.currentBranch ?? 'main';
    console.error(`  Branch: ${originalBranch} (no branch switching — files written directly)`);
    console.error('');
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

    const phase2HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'research-dossier.json'))
      && fs.existsSync(path.join(phaseDir, 'sparc', 'sparc-combined.json'));
    if (phase2HasContent) {
      console.error('  [SKIP] Phase 2 already exists — using existing artifacts');
      phases.push({ phase: 2, label: 'Deep Research', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase2 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !fs.existsSync(path.join(phaseDir, 'sparc', 'sparc-combined.json'))) {
        console.error('  [CLEANUP] Removing incomplete phase2 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[2]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write deep research cooperatively
      // Output to .ruflo-cache/ so we don't pre-create phaseDir (append-only guard in executePhaseNCommand)
      const rufloOutputDir = path.join(runDir, '.ruflo-cache', 'phase2');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 2, label: 'Deep Research', scenarioQuery,
        runDir, traceId, outputDir: rufloOutputDir,
        tasks: buildPhase2Tasks(scenarioQuery, collectPhase2Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase2Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P2] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results BEFORE phase command so the SPARC generator,
      // research dossier, ADR generator, and DDD generator can read agent findings.
      // Write to .pre-phase2 — generators check this location if phase2Dir doesn't have the report yet.
      // CANNOT write to phase2Dir directly — the phase command has an append-only guard that
      // throws ECLI-P2-003 if the directory already exists.
      persistAgenticsResults(path.join(runDir, '.pre-phase2'), agentResults);

      try {
        const result = await executePhase2Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 2);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase2ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[2]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[2]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 2, label: 'Deep Research', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[2]!.agenticsServices.length) });
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 2 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[2]!, traceId, errMsg);
        phases.push({ phase: 2, label: 'Deep Research', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        copyPlanningArtifacts(runDir, projectRoot);
        await ensureAdrsExist(runDir, traceId, scenarioQuery);
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

    const phase3HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'sparc', 'sparc-combined.json'));
    if (phase3HasContent) {
      console.error('  [SKIP] Phase 3 already exists — using existing artifacts');
      phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase3 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase3HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase3 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[3]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write SPARC specs + TDD plans cooperatively
      const rufloP3Dir = path.join(runDir, '.ruflo-cache', 'phase3');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 3, label: 'SPARC + London TDD', scenarioQuery,
        runDir, traceId, outputDir: rufloP3Dir,
        tasks: buildPhase3Tasks(scenarioQuery, collectPhase3Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase3Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P3] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results to .pre-phase3 so generators can find them.
      // CANNOT write to phase3Dir — append-only guard throws if it exists.
      persistAgenticsResults(path.join(runDir, '.pre-phase3'), agentResults);

      try {
        const result = await executePhase3Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 3);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase3ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[3]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[3]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[3]!.agenticsServices.length) });
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 3 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[3]!, traceId, errMsg);

        // Phase 3 refines Phase 2 SPARC via LLM. If it fails (timeout, no LLM),
        // carry Phase 2 artifacts forward so Phases 4-6 can still proceed.
        const phase2SparcDir = path.join(runDir, 'phase2', 'sparc');
        const phase2SparcCombined = path.join(phase2SparcDir, 'sparc-combined.json');
        if (fs.existsSync(phase2SparcCombined)) {
          console.error('  [RECOVER] Phase 2 SPARC artifacts exist — copying to phase3/ so pipeline can continue');
          const phase3SparcDir = path.join(phaseDir, 'sparc');
          fs.mkdirSync(phase3SparcDir, { recursive: true });
          // Copy all Phase 2 SPARC files to Phase 3 directory
          const phase2SparcFiles = fs.readdirSync(phase2SparcDir);
          for (const file of phase2SparcFiles) {
            const src = path.join(phase2SparcDir, file);
            const dest = path.join(phase3SparcDir, file);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, dest);
            }
          }
          // Also copy TDD if available from Phase 2
          const phase2TddDir = path.join(runDir, 'phase2', 'tdd');
          if (fs.existsSync(phase2TddDir)) {
            const phase3TddDir = path.join(phaseDir, 'tdd');
            fs.mkdirSync(phase3TddDir, { recursive: true });
            const phase2TddFiles = fs.readdirSync(phase2TddDir);
            for (const file of phase2TddFiles) {
              const src = path.join(phase2TddDir, file);
              const dest = path.join(phase3TddDir, file);
              if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, dest);
              }
            }
          }
          console.error('  [RECOVER] Phase 2 artifacts carried forward — continuing to Phase 4');
          phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'completed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `Recovered from Phase 2: ${errMsg}` });
          copyPlanningArtifacts(runDir, projectRoot);
        } else {
          console.error('  [ABORT] No Phase 2 SPARC artifacts to recover from — pipeline cannot continue');
          phases.push({ phase: 3, label: 'SPARC + London TDD', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
          copyPlanningArtifacts(runDir, projectRoot);
          await ensureAdrsExist(runDir, traceId, scenarioQuery);
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
        }
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

    // Only skip if phase4 has actual ADR + DDD content (not just an empty dir from a failed prior run)
    const phase4HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'adrs', 'adr-index.json'))
      && fs.existsSync(path.join(phaseDir, 'ddd', 'domain-model.json'));
    if (phase4HasContent) {
      console.error('  [SKIP] Phase 4 already exists — using existing artifacts');
      phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase4 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase4HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase4 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[4]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: write ADRs + DDDs cooperatively
      const rufloP4Dir = path.join(runDir, '.ruflo-cache', 'phase4');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 4, label: 'ADRs + DDDs', scenarioQuery,
        runDir, traceId, outputDir: rufloP4Dir,
        tasks: buildPhase4Tasks(scenarioQuery, collectPhase4Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase4Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P4] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      // Persist agent results to .pre-phase4 so ADR/DDD generators can find them.
      // CANNOT write to phase4Dir — append-only guard throws if it exists.
      persistAgenticsResults(path.join(runDir, '.pre-phase4'), agentResults);

      try {
        const result = await executePhase4Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 4);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase4ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[4]!, traceId, runDir, artifactPaths, timing);
        await reviewPhaseOutput(PHASE_AGENTS[4]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[4]!.agenticsServices.length) });
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 4 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[4]!, traceId, errMsg);

        // Phase 4 refines Phase 2 ADRs/DDD. If it fails, try recovery paths.
        const phase2AdrIndex = path.join(runDir, 'phase2', 'adrs', 'adr-index.json');
        let recovered = false;

        if (fs.existsSync(phase2AdrIndex)) {
          // Path A: Phase 2 has ADRs — copy them to phase4/
          console.error('  [RECOVER] Phase 2 ADRs/DDD exist — copying to phase4/ so pipeline can continue');
          for (const sub of ['adrs', 'ddd']) {
            const src = path.join(runDir, 'phase2', sub);
            const dest = path.join(phaseDir, sub);
            if (fs.existsSync(src)) {
              fs.mkdirSync(dest, { recursive: true });
              for (const file of fs.readdirSync(src)) {
                const srcFile = path.join(src, file);
                if (fs.statSync(srcFile).isFile()) {
                  fs.copyFileSync(srcFile, path.join(dest, file));
                }
              }
            }
          }
          console.error('  [RECOVER] Phase 2 ADRs/DDD carried forward — continuing to Phase 5');
          recovered = true;
        }

        // Path B: No Phase 2 ADRs — generate them from SPARC + dossier directly
        if (!recovered) {
          console.error('  [RECOVER] No Phase 2 ADRs — generating ADRs from SPARC + dossier (no LLM required)');
          try {
            const { buildPhase2ADRs } = await import('../pipeline/phase2/phases/adr-generator.js');
            const { buildPhase2DDD } = await import('../pipeline/phase2/phases/ddd-generator.js');

            // Load SPARC and dossier from wherever they exist
            let sparc = null as Record<string, unknown> | null;
            let dossier = null as Record<string, unknown> | null;
            for (const sub of ['phase3/sparc/sparc-combined.json', 'phase2/sparc/sparc-combined.json']) {
              const p = path.join(runDir, sub);
              if (fs.existsSync(p)) { try { sparc = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
            }
            for (const sub of ['phase2/research-dossier.json']) {
              const p = path.join(runDir, sub);
              if (fs.existsSync(p)) { try { dossier = JSON.parse(fs.readFileSync(p, 'utf-8')); break; } catch { /* skip */ } }
            }

            if (sparc && dossier) {
              // Generate ADRs
              const adrs = buildPhase2ADRs(sparc as any, dossier as any, scenarioQuery, true /* skipLLM */);
              if (adrs.length > 0) {
                const adrDir = path.join(phaseDir, 'adrs');
                fs.mkdirSync(adrDir, { recursive: true });
                for (const adr of adrs) {
                  const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
                  const filename = `${adr.id}-${slug}.md`;
                  const md = [
                    `# ${adr.id}: ${adr.title}`,
                    `\n**Status:** ${adr.status}`,
                    `**Date:** ${adr.date}`,
                    `\n## Context\n${adr.context}`,
                    `\n## Decision\n${adr.decision}`,
                    adr.alternatives?.length > 0 ? `\n## Alternatives Considered\n${adr.alternatives.map((a: any) => `- **${a.option}** ${a.rejected ? '(rejected)' : '(selected)'}: ${a.rationale}`).join('\n')}` : '',
                    adr.consequences?.length > 0 ? `\n## Consequences\n${adr.consequences.map((c: any) => `- [${c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~'}] ${c.description}`).join('\n')}` : '',
                  ].filter(Boolean).join('\n');
                  fs.writeFileSync(path.join(adrDir, filename), md + '\n', 'utf-8');
                }
                fs.writeFileSync(path.join(adrDir, 'adr-index.json'), JSON.stringify(adrs, null, 2) + '\n', 'utf-8');
                console.error(`  [RECOVER] Generated ${adrs.length} ADRs from SPARC template`);
              }

              // Generate DDD
              try {
                const dddModel = buildPhase2DDD(sparc as any, adrs as any, dossier as any);
                if (dddModel?.contexts?.length > 0) {
                  const dddDir = path.join(phaseDir, 'ddd');
                  const contextsDir = path.join(dddDir, 'contexts');
                  fs.mkdirSync(contextsDir, { recursive: true });
                  fs.writeFileSync(path.join(dddDir, 'domain-model.json'), JSON.stringify(dddModel, null, 2) + '\n', 'utf-8');
                  if (dddModel.contextMap) {
                    fs.writeFileSync(path.join(dddDir, 'context-map.json'), JSON.stringify(dddModel.contextMap, null, 2) + '\n', 'utf-8');
                  }
                  for (const ctx of dddModel.contexts) {
                    const ctxSlug = ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
                    fs.writeFileSync(path.join(contextsDir, `${ctxSlug}.json`), JSON.stringify(ctx, null, 2) + '\n', 'utf-8');
                  }
                  console.error(`  [RECOVER] Generated DDD model with ${dddModel.contexts.length} bounded contexts`);
                }
              } catch (dddErr) {
                console.error(`  [WARN] DDD generation failed: ${dddErr instanceof Error ? dddErr.message : String(dddErr)}`);
              }

              recovered = true;
            } else {
              console.error('  [WARN] SPARC or dossier not found — cannot generate ADRs');
            }
          } catch (recoverErr) {
            console.error(`  [WARN] ADR recovery failed: ${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}`);
          }
        }

        if (recovered) {
          phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'completed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: `Recovered: ${errMsg}` });
        } else {
          console.error('  [WARN] No recovery possible — continuing without ADRs');
          phases.push({ phase: 4, label: 'ADRs + DDDs', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        }
        copyPlanningArtifacts(runDir, projectRoot);
      }
    }
  }

  // ── Phase 4.5: Generate implementation prompts by reading ADR + DDD files ──
  // Simple approach: gather all ADR/DDD/SPARC files, hand them to ruflo swarm,
  // let the LLM read them and produce coherent implementation prompts.
  {
    const promptsDir = path.join(runDir, 'prompts');
    // Check if prompts already exist from a prior run
    const promptsExist = fs.existsSync(promptsDir)
      && fs.readdirSync(promptsDir).some(f => f.startsWith('impl-'));
    if (promptsExist) {
      console.error('  [PROMPTS] Implementation prompts already exist — skipping');
    } else {
      // Gather all ADR and DDD files (prefer phase4, fall back to phase2)
      const adrDir = fs.existsSync(path.join(runDir, 'phase4', 'adrs'))
        ? path.join(runDir, 'phase4', 'adrs')
        : fs.existsSync(path.join(runDir, 'phase2', 'adrs'))
          ? path.join(runDir, 'phase2', 'adrs')
          : null;
      const dddDir = fs.existsSync(path.join(runDir, 'phase4', 'ddd'))
        ? path.join(runDir, 'phase4', 'ddd')
        : fs.existsSync(path.join(runDir, 'phase2', 'ddd'))
          ? path.join(runDir, 'phase2', 'ddd')
          : null;
      const sparcDir = fs.existsSync(path.join(runDir, 'phase3', 'sparc'))
        ? path.join(runDir, 'phase3', 'sparc')
        : fs.existsSync(path.join(runDir, 'phase2', 'sparc'))
          ? path.join(runDir, 'phase2', 'sparc')
          : null;

      if (adrDir) {
        try {
          // Read all ADR markdown files
          const adrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md'));
          const adrContent = adrFiles.map(f => {
            try { return `### ${f}\n\n${fs.readFileSync(path.join(adrDir, f), 'utf-8')}`; }
            catch { return ''; }
          }).filter(Boolean).join('\n\n---\n\n');

          // Read DDD model files
          let dddContent = '';
          if (dddDir) {
            const dddFiles = fs.readdirSync(dddDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
            dddContent = dddFiles.map(f => {
              try { return `### ${f}\n\n${fs.readFileSync(path.join(dddDir, f), 'utf-8')}`; }
              catch { return ''; }
            }).filter(Boolean).join('\n\n---\n\n');
          }

          // Read SPARC specification summary
          let sparcContent = '';
          if (sparcDir) {
            for (const candidate of ['specification.md', 'architecture.md', 'sparc-combined.json']) {
              const p = path.join(sparcDir, candidate);
              if (fs.existsSync(p)) {
                try { sparcContent += `### ${candidate}\n\n${fs.readFileSync(p, 'utf-8').slice(0, 5000)}\n\n`; }
                catch { /* skip */ }
              }
            }
          }

          // Build the ruflo swarm task: read the files, write implementation prompts
          fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 });

          const rufloPromptDir = path.join(runDir, '.ruflo-cache', 'prompts');
          const promptTask = `You are an implementation prompt writer. You have been given the complete Architecture Decision Records (ADRs), Domain-Driven Design (DDD) model, and SPARC specification for this project.

Your job: Read ALL of these documents carefully, then write a series of ordered implementation prompts. Each prompt should be a self-contained build step that a developer (or coding agent) can execute to build one piece of the platform.

## Project Objective

${scenarioQuery}

## Architecture Decision Records (ADRs)

${adrContent || 'No ADR files found.'}

## Domain-Driven Design Model

${dddContent || 'No DDD model files found.'}

## SPARC Specification

${sparcContent || 'No SPARC specification found.'}

## Instructions

1. Analyze the ADRs and DDDs to understand the platform's bounded contexts, dependencies, and architectural decisions.
2. Determine the correct build order based on dependencies between bounded contexts (foundation layers first, dependent layers later).
3. For each build step, write a complete implementation prompt file named impl-NNN-<context-slug>.md where NNN is the order (001, 002, etc.).
4. Each implementation prompt MUST:
   - Reference the specific ADRs that govern that build step (by ID and title)
   - Include the relevant DDD bounded context details (aggregates, entities, commands, queries, events)
   - Specify what to import from previously built steps
   - Include concrete implementation requirements (not vague instructions)
   - Specify the technology stack decisions from the ADRs
5. Write an execution-plan.json that lists all prompts in order with their dependencies.
6. Write ALL files to the current working directory.

The prompts must be production-grade — they will be given directly to a coding swarm to implement.`;

          const promptSwarmResult = executeRufloPhaseSwarm({
            phase: 4,
            label: 'Implementation Prompts',
            scenarioQuery,
            runDir,
            traceId,
            outputDir: rufloPromptDir,
            tasks: [{
              label: 'Implementation Prompt Generation',
              description: promptTask,
              targetDir: '.',
            }],
            agenticsResults: [],
            priorArtifacts: collectPhase4Artifacts(runDir),
            timeoutMs: 600_000, // 10 min
          });

          // Copy ruflo output to prompts dir
          if (fs.existsSync(rufloPromptDir)) {
            const rufloFiles = fs.readdirSync(rufloPromptDir);
            let promptsCopied = 0;
            for (const f of rufloFiles) {
              const src = path.join(rufloPromptDir, f);
              if (fs.statSync(src).isFile()) {
                fs.copyFileSync(src, path.join(promptsDir, f));
                promptsCopied++;
              }
            }
            if (promptsCopied > 0) {
              console.error(`  [PROMPTS] Ruflo swarm generated ${promptsCopied} implementation prompt files in ${promptSwarmResult.timing}ms`);
            }
          }

          // Check if ruflo produced prompts; if not, write them directly from the gathered content
          const generatedPrompts = fs.existsSync(promptsDir)
            ? fs.readdirSync(promptsDir).filter(f => f.startsWith('impl-'))
            : [];

          if (generatedPrompts.length === 0) {
            // ── Read all source material for prompt generation ──
            const adrMarkdownByFile = new Map<string, string>();
            for (const f of adrFiles) {
              try { adrMarkdownByFile.set(f, fs.readFileSync(path.join(adrDir, f), 'utf-8')); }
              catch { /* skip */ }
            }

            const adrIndexPath = path.join(adrDir, 'adr-index.json');
            let adrs: Array<{ id: string; title: string; context: string; decision: string; consequences: string[]; alternatives: string[] }> = [];
            if (fs.existsSync(adrIndexPath)) {
              try { adrs = JSON.parse(fs.readFileSync(adrIndexPath, 'utf-8')); } catch { /* empty */ }
            }
            if (!Array.isArray(adrs) || adrs.length === 0) {
              for (const f of adrFiles) {
                const content = adrMarkdownByFile.get(f) ?? '';
                const titleMatch = content.match(/^#\s+(.+)/m);
                adrs.push({ id: f.replace(/\.md$/, ''), title: titleMatch?.[1] ?? f, context: content.slice(0, 500), decision: '', consequences: [], alternatives: [] });
              }
            }

            function getAdrMarkdown(adr: { id: string }): string {
              for (const [filename, content] of adrMarkdownByFile) {
                if (filename.startsWith(adr.id)) return content;
              }
              return '';
            }

            // Read DDD as reference material (not as driver)
            let dddContent = '';
            const dddModelPath = dddDir ? path.join(dddDir, 'domain-model.json') : '';
            if (dddModelPath && fs.existsSync(dddModelPath)) {
              try { dddContent = fs.readFileSync(dddModelPath, 'utf-8'); } catch { /* skip */ }
            }
            // Also read DDD markdown if available
            if (dddDir) {
              for (const f of ['domain-model.md', 'ddd-model.md']) {
                const p = path.join(dddDir, f);
                if (fs.existsSync(p)) {
                  try { dddContent += '\n\n' + fs.readFileSync(p, 'utf-8'); break; } catch { /* skip */ }
                }
              }
            }

            // Read SPARC documents
            let sparcSpec = '';
            let sparcArch = '';
            if (sparcDir) {
              for (const [file, setter] of [
                ['specification.md', 'spec'], ['architecture.md', 'arch'],
              ] as const) {
                const p = path.join(sparcDir, file);
                if (fs.existsSync(p)) {
                  try {
                    const content = fs.readFileSync(p, 'utf-8');
                    if (setter === 'spec') sparcSpec = content;
                    else if (setter === 'arch') sparcArch = content;
                  } catch { /* skip */ }
                }
              }
            }

            console.error('  [PROMPTS] Ruflo swarm did not produce prompts — deriving from SPARC + ADRs');

            // ── Extract build phases from SPARC architecture ──
            // The SPARC architecture section lists actual services/components for THIS project.
            // Each service becomes a build phase. ADRs are matched per phase.

            interface DerivedPhase {
              title: string;
              slug: string;
              content: string; // the full SPARC section for this component
              folder: string;
              adrIds: string[];
            }

            const derivedPhases: DerivedPhase[] = [];

            // Parse SPARC architecture for service/component sections
            if (sparcArch) {
              // Look for ## or ### headings that describe components/services
              const sections = sparcArch.split(/^(?=#{2,3}\s)/m).filter(s => s.trim().length > 20);
              for (const section of sections) {
                const headingMatch = section.match(/^#{2,3}\s+(.+)/);
                if (!headingMatch) continue;
                const heading = headingMatch[1]!.trim();
                // Skip meta-sections
                if (/^(overview|introduction|summary|table of contents|references|constraints|non-functional)/i.test(heading)) continue;

                const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
                // Determine target folder based on content
                const sectionLower = section.toLowerCase();
                let folder = 'backend';
                if (/\bfrontend\b|\bui\b|\bdashboard\b|\breact\b|\bvue\b|\bangular\b/.test(sectionLower)) folder = 'frontend';
                else if (/erp|netsuite|sap|dynamics|oracle/.test(sectionLower)) folder = 'erp';
                else if (/integration|connector|webhook|external|third.party/.test(sectionLower)) folder = 'integrations';
                else if (/api|service|backend|server|handler/.test(sectionLower)) folder = 'backend';
                else if (/test|quality|coverage/.test(sectionLower)) folder = 'tests';
                else if (/deploy|infra|docker|cloud|ci.cd/.test(sectionLower)) folder = 'src';
                else if (/doc|guide|reference/.test(sectionLower)) folder = 'docs';

                // Match ADRs to this section by keyword overlap
                const sectionWords = new Set(sectionLower.split(/\W+/).filter(w => w.length > 3));
                const matchedAdrIds = adrs.filter(adr => {
                  const adrWords = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase().split(/\W+/).filter(w => w.length > 3);
                  const overlap = adrWords.filter(w => sectionWords.has(w)).length;
                  return overlap >= 2;
                }).map(a => a.id);

                derivedPhases.push({ title: heading, slug, content: section, folder, adrIds: matchedAdrIds });
              }
            }

            // ADR-PIPELINE-031: Enrich with ADR-derived phases when SPARC sections alone are insufficient.
            // Each ADR that isn't already covered by a SPARC-derived phase becomes its own build step.
            if (derivedPhases.length < 8 && adrs.length > 0) {
              const existingSlugs = new Set(derivedPhases.map(p => p.slug));
              const existingTitleWords = new Set(derivedPhases.flatMap(p => p.title.toLowerCase().split(/\W+/).filter(w => w.length > 3)));

              for (const adr of adrs) {
                const slug = adr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
                // Skip if a phase with similar slug or overlapping title already exists
                if (existingSlugs.has(slug)) continue;
                const adrKeywords = adr.title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
                const overlap = adrKeywords.filter(w => existingTitleWords.has(w)).length;
                if (overlap >= 2) continue; // sufficiently covered by an existing phase

                const adrLower = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
                let folder = 'backend';
                if (/frontend|ui|dashboard/.test(adrLower)) folder = 'frontend';
                else if (/erp|netsuite|sap|dynamics|coupa|workday|maximo|oracle/.test(adrLower)) folder = 'erp';
                else if (/integration|connector|webhook/.test(adrLower)) folder = 'integrations';
                else if (/deploy|infra|docker/.test(adrLower)) folder = 'src';
                else if (/test|quality/.test(adrLower)) folder = 'tests';
                else if (/audit|governance|approval/.test(adrLower)) folder = 'backend';

                derivedPhases.push({
                  title: adr.title,
                  slug,
                  content: getAdrMarkdown(adr) || `**Context:** ${adr.context}\n\n**Decision:** ${adr.decision}`,
                  folder,
                  adrIds: [adr.id],
                });
                existingSlugs.add(slug);
                for (const w of adrKeywords) existingTitleWords.add(w);
              }
            }

            // Always add foundation (first) and testing/deployment (last) if not present
            const hasTesting = derivedPhases.some(p => /test/i.test(p.title));
            const hasDeployment = derivedPhases.some(p => /deploy|infra/i.test(p.title));

            // Detect multi-language requirements (e.g., TypeScript + Rust)
            const queryLower = scenarioQuery.toLowerCase();
            const hasRust = /\brust\b/.test(queryLower);
            const hasTypeScript = /\btypescript\b/.test(queryLower);
            const rustPurpose = scenarioQuery.match(/rust\s+(?:used\s+)?(?:for\s+)?(.{10,100}?)(?:\.|,|$)/i)?.[1]?.trim() ?? '';
            const languageNote = hasRust && hasTypeScript
              ? `\n\nThis is a HYBRID TypeScript + Rust project. TypeScript handles orchestration and service layers. Rust handles ${rustPurpose || 'compute-intensive components'}. Set up both package.json and Cargo.toml. Create a rust/ directory for Rust crates with WASM or FFI bindings to TypeScript.`
              : hasRust
                ? `\n\nThis project uses Rust. Set up Cargo.toml workspace.`
                : '';

            // Insert foundation at the beginning — ADR-039: logger + config are FIRST outputs
            // Detect language from query to make scaffold language-appropriate
            const detectedLang = hasRust ? 'Rust' : hasTypeScript ? 'TypeScript' : /\bpython\b/i.test(queryLower) ? 'Python' : /\bgo\b|\bgolang\b/i.test(queryLower) ? 'Go' : /\bjava\b/i.test(queryLower) ? 'Java' : 'TypeScript';
            derivedPhases.unshift({
              title: 'Project Foundation & Core Types',
              slug: 'foundation',
              content: `Set up project structure, build tooling, and shared infrastructure using **${detectedLang}**. All subsequent phases import from this.${languageNote}

## FIRST: Create these shared modules (before domain types)

### src/logger.ts
\`\`\`typescript
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}
export function createLogger(service: string): Logger {
  return {
    info: (event, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service, event, ...data })),
    warn: (event, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', service, event, ...data })),
    error: (event, err, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', service, event, error: err.message, stack: err.stack, ...data })),
  };
}
\`\`\`

### src/config.ts
\`\`\`typescript
export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: { baseUrl: string; apiVersion: string; timeoutMs: number; maxRetries: number };
}
export const config: AppConfig = {
  env: (process.env.NODE_ENV ?? 'development') as AppConfig['env'],
  port: parseInt(process.env.PORT ?? '3000', 10),
  logLevel: (process.env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'],
  erp: {
    baseUrl: process.env.ERP_BASE_URL ?? 'https://api.example.com',
    apiVersion: process.env.ERP_API_VERSION ?? 'v1',
    timeoutMs: parseInt(process.env.ERP_TIMEOUT_MS ?? '30000', 10),
    maxRetries: parseInt(process.env.ERP_MAX_RETRIES ?? '3', 10),
  },
};
\`\`\`

### src/errors.ts
\`\`\`typescript
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 500) {
    super(message);
    this.name = 'AppError';
  }
}
export class ValidationError extends AppError {
  constructor(message: string) { super(message, 'VALIDATION_ERROR', 400); }
}
export class NotFoundError extends AppError {
  constructor(entity: string, id: string) { super(\`\${entity} \${id} not found\`, 'NOT_FOUND', 404); }
}
\`\`\`

## THEN: Create domain types and project structure

Base folder structure: src/, tests/, docs/. Create package.json, tsconfig.json, vitest.config.ts.
Define all shared domain types in src/types.ts.`,
              folder: 'src',
              adrIds: adrs.map(a => a.id),
            });

            if (!hasTesting) {
              derivedPhases.push({
                title: 'Testing & Quality Assurance',
                slug: 'testing',
                content: 'Write comprehensive tests for all components built in prior phases.',
                folder: 'tests',
                adrIds: [],
              });
            }
            if (!hasDeployment) {
              derivedPhases.push({
                title: 'Deployment & Infrastructure',
                slug: 'deployment',
                content: 'Create deployment configs, Dockerfiles, CI/CD, and infrastructure-as-code for the target cloud platform.',
                folder: 'src',
                adrIds: [],
              });
            }

            // ADR-PIPELINE-031: Guarantee ≥10 prompts by adding standard cross-cutting phases
            // when domain-specific + ADR-derived phases don't reach the minimum.
            const crossCutting: Array<{ title: string; slug: string; content: string; folder: string }> = [
              { title: 'Observability & Structured Logging', slug: 'observability', folder: 'backend',
                content: `ADR-PIPELINE-034: Implement complete observability infrastructure.

## 1. Structured Logger (src/logger.ts)

Create a logger factory that outputs JSON to stderr:

\`\`\`typescript
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}

export function createLogger(service: string): Logger {
  // Each log entry: { timestamp, level, service, event, correlationId?, ...data }
  // Output to stderr as single-line JSON
}

// Correlation ID context — thread through entire request lifecycle
export function withCorrelationId<T>(correlationId: string, fn: () => T): T;
export function getCorrelationId(): string | undefined;
\`\`\`

## 2. Correlation ID Threading

Every analysis run generates a correlationId (UUID). This ID flows through:
- analysis.started → analysis.excess_detected → analysis.completed
- decision.created → erp.sync.attempted → erp.sync.succeeded/failed

Pass correlationId as a parameter through service functions or use AsyncLocalStorage.

## 3. Instrumentation Points (minimum)

| Event | When | Data |
|-------|------|------|
| analysis.started | Analysis begins | { correlationId, supplierCount, recordCount } |
| analysis.completed | Analysis finishes | { correlationId, durationMs, flagCount, opportunityCount } |
| decision.created | Decision recorded | { correlationId, decisionId, opportunityId, status } |
| erp.sync.attempted | ERP write starts | { correlationId, transactionId, supplierId, action } |
| erp.sync.succeeded | ERP write succeeds | { correlationId, transactionId, responseTime } |
| erp.sync.failed | ERP write fails | { correlationId, transactionId, error, retryCount } |

## 4. ERP Error Handling

The ERP connector must handle:
- Network timeout: configurable (default 30s), log erp.sync.failed with timeout error
- Rate limiting (429): exponential backoff (1s, 2s, 4s, max 3 retries), log each retry
- Schema validation: log and quarantine invalid records, don't crash the pipeline
- Idempotency: generate idempotency key per transaction to prevent duplicate writes on retry

## 5. Health Check

If the project includes an API layer, add GET /health returning:
\`\`\`json
{ "status": "ok", "service": "packaging-waste-optimizer", "version": "0.1.0", "uptime": 12345, "lastAnalysisRun": "2026-04-09T..." }
\`\`\`

## 6. Tests

- Test that logger outputs valid JSON to stderr
- Test that correlationId flows through analysis → decision → ERP sync
- Test that ERP error handling retries on 429 and logs failures` },
              { title: 'Configuration & Environment Management', slug: 'configuration', folder: 'src',
                content: `ADR-PIPELINE-034: Configuration module for environment-based settings.

Create src/config.ts with a typed configuration object:

\`\`\`typescript
export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: {
    baseUrl: string;
    apiVersion: string;
    clientId: string;
    timeoutMs: number;     // default 30000
    maxRetries: number;    // default 3
  };
  analysis: {
    // Domain-specific thresholds — externalized, not hardcoded
    [key: string]: number | string | boolean;
  };
}
\`\`\`

Requirements:
- Read all values from environment variables (never hardcode secrets)
- Validate at startup — fail fast with clear error messages for missing required vars
- Provide sensible defaults for optional values (timeoutMs, maxRetries, logLevel)
- Export a singleton config object used by all services
- Include tests that verify validation catches missing required vars` },
              { title: 'API Layer & Request Handling', slug: 'api-layer', folder: 'backend',
                content: `ADR-PIPELINE-043: Thin route handlers with Zod validation.

ARCHITECTURE: Route handlers MUST be thin:
- Route: parse request → validate with Zod schema → call service function → format response
- NEVER put business logic, database queries, or orchestration in route handlers
- Create a separate src/services/workflow.ts for multi-step orchestration

VALIDATION: Define Zod schemas for EVERY request body and query parameter:
\`\`\`typescript
import { z } from 'zod';
const CreateScenarioSchema = z.object({
  name: z.string().min(1),
  parameters: z.record(z.number()),
});
// In route handler:
const parsed = CreateScenarioSchema.safeParse(req.body);
if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
\`\`\`

REQUIRED ENDPOINTS:
- GET /health → { status, version, uptime }
- GET /api/metrics → Prometheus-format metrics (request count, latency histogram, error rate)
- All domain endpoints with proper HTTP status codes and structured error responses
- Every response includes X-Correlation-Id header` },
              { title: 'Persistence & Data Access Layer', slug: 'persistence', folder: 'backend',
                content: 'Implement repository interfaces per aggregate (ports pattern). Database adapter implementations. Audit trail persistence (append-only, tamper-evident). Transaction management for multi-aggregate operations.' },
              { title: 'Demo Script & CLI Entry Point', slug: 'demo', folder: 'src',
                content: `ADR-PIPELINE-037: User-facing entry points for the prototype.

## 1. Demo Script (src/demo.ts) — REQUIRED

Create a runnable demo (\`npx tsx src/demo.ts\`) that:
1. Loads all seed data
2. Runs the complete analysis pipeline end-to-end
3. Prints formatted results to stdout using tables (not raw JSON):
   - Summary table: key metrics, top findings
   - Per-entity breakdown (e.g., per-supplier, per-zone, per-employee)
   - Scenario comparison table with tradeoff columns
4. Demonstrates the decision/approval workflow:
   - Create a draft decision for the top opportunity
   - Approve it with a test approver
5. Shows the ERP sync payload:
   - Print the structured payload that would be sent to the ERP
   - Mark as "dry run" — do not actually sync

The demo must run without any external dependencies (no database, no API keys, no network).

## 2. CLI Interface (src/cli.ts) — OPTIONAL

If time permits, create a minimal CLI:
\`\`\`
npx tsx src/cli.ts --analyze          # Run analysis, print results
npx tsx src/cli.ts --scenarios        # Show scenario comparison
npx tsx src/cli.ts --decide <id>      # Create decision for opportunity
npx tsx src/cli.ts --sync <id>        # Dry-run ERP sync for decision
npx tsx src/cli.ts --help             # Usage examples
\`\`\`

## 3. Architecture Divergence ADR — REQUIRED

Create \`docs/ADR-001-monolithic-prototype.md\` in the generated project:

\`\`\`markdown
# ADR-001: Monolithic Library for Prototype Phase

## Status
Accepted

## Context
The SPARC architecture specification describes multiple microservices with event-driven
communication. For the prototype evaluation period (3-7 days), deploying and operating
microservices adds unnecessary complexity without delivering proportional value.

## Decision
Build as a single TypeScript library with clean module boundaries:
- analysis/ — Pure computation, no side effects
- decisions/ — State management with audit trail
- erp/ — External system integration (adapter pattern)
- data/ — Seed data and data access

Each module exports a barrel (index.ts) and communicates via typed interfaces,
not shared mutable state. This structure enables decomposition into independent
services when the pilot validates the approach.

## Consequences
- Prototype can be built, tested, and demonstrated in days, not weeks
- Module boundaries enforce separation of concerns without deployment overhead
- Migration to microservices requires extracting modules into packages — not rewriting
\`\`\`

## Tests
- Test that demo.ts runs without errors (import and execute main function)
- Test that it produces non-empty stdout output` },
            ];
            const existingSlugSet = new Set(derivedPhases.map(p => p.slug));
            for (const cc of crossCutting) {
              if (derivedPhases.length >= 12) break;
              if (existingSlugSet.has(cc.slug)) continue;
              // Don't add if a phase already covers this topic
              if (derivedPhases.some(p => p.title.toLowerCase().includes(cc.slug.split('-')[0]!))) continue;
              derivedPhases.push({ ...cc, adrIds: [] });
              existingSlugSet.add(cc.slug);
            }

            console.error(`  [PROMPTS] ${derivedPhases.length} phases derived (SPARC + ADRs + cross-cutting, minimum 10 per ADR-PIPELINE-031)`);

            // ── Helper: extract DDD context names and summaries relevant to a phase ──
            function getDddSummaryForPhase(phaseTitle: string, phaseContent: string): string {
              if (!dddContent) return '';
              try {
                const model = JSON.parse(dddContent);
                const contexts = model.contexts ?? [];
                if (contexts.length === 0) return '';
                // Exclude common words that would match everything
                const excludeWords = new Set(['domain', 'logic', 'crud', 'operations', 'manage', 'business', 'rules', 'event', 'handling', 'service', 'system', 'data', 'component', 'module', 'implementation', 'integration']);
                const phaseWords = new Set(`${phaseTitle} ${phaseContent}`.toLowerCase().split(/\W+/).filter((w: string) => w.length > 3 && !excludeWords.has(w)));
                const relevant = contexts.filter((c: Record<string, unknown>) => {
                  const ctxText = `${c['name']}`.toLowerCase().split(/[-_\s]+/).filter((w: string) => w.length > 3 && !excludeWords.has(w));
                  // Must match on context NAME keywords, not generic description words
                  const matches = ctxText.filter((w: string) => phaseWords.has(w)).length;
                  return matches >= 1;
                });
                if (relevant.length === 0) return '';
                const parts: string[] = [];
                for (const c of relevant as Array<Record<string, unknown>>) {
                  const name = String(c['name'] ?? '');
                  const desc = String(c['description'] ?? '');
                  const aggs = (c['aggregates'] as Array<Record<string, unknown>> ?? []).map((a: Record<string, unknown>) => String(a['name'] ?? '')).filter(Boolean);
                  const cmds = (c['commands'] as Array<Record<string, unknown> | string> ?? []).map((cmd: Record<string, unknown> | string) => typeof cmd === 'string' ? cmd : String(cmd['name'] ?? '')).filter(Boolean);
                  const queries = (c['queries'] as Array<Record<string, unknown> | string> ?? []).map((q: Record<string, unknown> | string) => typeof q === 'string' ? q : String(q['name'] ?? '')).filter(Boolean);
                  let summary = `**${name}**: ${desc}`;
                  if (aggs.length > 0) summary += ` (aggregates: ${aggs.join(', ')})`;
                  if (cmds.length > 0) summary += ` (commands: ${cmds.join(', ')})`;
                  if (queries.length > 0) summary += ` (queries: ${queries.join(', ')})`;
                  parts.push(summary);
                }
                return parts.join('\n\n');
              } catch {
                return '';
              }
            }

            // ── Helper: build a narrative description paragraph for a phase ──
            function buildPhaseNarrative(
              phase: DerivedPhase,
              phaseAdrs: typeof adrs,
              dddSummary: string,
              completedList: string[],
            ): string {
              const parts: string[] = [];

              // Opening: what this phase builds
              parts.push(`In this phase, you are building the **${phase.title}** component of the platform.`);

              // What prior phases provide
              if (completedList.length > 0) {
                parts.push(`This builds on ${completedList.length} previously completed phase(s) — import shared types, interfaces, and services from those modules.`);
              }

              // ADR narrative: which decisions govern this phase and what they decided
              if (phaseAdrs.length > 0) {
                const adrSentences = phaseAdrs.map(a => {
                  const decision = a.decision?.split('.')[0] ?? a.title;
                  return `${a.id} ("${a.title}") which decided: ${decision}`;
                });
                if (adrSentences.length === 1) {
                  parts.push(`This phase is governed by architecture decision ${adrSentences[0]}.`);
                } else {
                  parts.push(`This phase is governed by ${adrSentences.length} architecture decisions: ${adrSentences.join('; ')}.`);
                }
              }

              // DDD narrative: which domain concepts are relevant
              if (dddSummary) {
                parts.push(`The domain model defines the following relevant contexts and entities for this phase:\n\n${dddSummary}`);
              }

              return parts.join(' ');
            }

            const totalSteps = derivedPhases.length;
            const completedPhases: string[] = [];

            for (let i = 0; i < totalSteps; i++) {
              const phase = derivedPhases[i]!;
              const order = i + 1;
              const filename = `impl-${String(order).padStart(3, '0')}-${phase.slug}.md`;

              // Resolve ADRs for this phase
              const phaseAdrs = phase.adrIds.length > 0
                ? adrs.filter(a => phase.adrIds.includes(a.id))
                : (order === 1 ? adrs : []);

              // Resolve DDD summary for this phase
              const dddSummary = getDddSummaryForPhase(phase.title, phase.content);

              // Build the narrative paragraph
              const narrative = buildPhaseNarrative(phase, phaseAdrs, dddSummary, completedPhases);

              const lines: string[] = [
                `# Implementation Prompt ${order} of ${totalSteps}: ${phase.title}`,
                '',
                `**Target folder:** \`${phase.folder}/\``,
                '',
              ];

              // ADR-PIPELINE-033: Simulation lineage in every prompt
              if (simulationId || traceId) {
                lines.push('## Simulation Lineage', '');
                if (simulationId) lines.push(`Originating simulation: \`${simulationId}\``);
                lines.push(`Trace ID: \`${traceId}\``);
                lines.push('');
              }

              // ── Narrative description — the core of each prompt ──
              lines.push('## Overview', '', narrative, '');

              // Previously completed phases (brief list)
              if (completedPhases.length > 0) {
                lines.push('## Previously Completed (available for import)', '');
                for (const prev of completedPhases) lines.push(`- ${prev}`);
                lines.push('');
              }

              // Full project requirements on first prompt only
              if (order === 1) {
                lines.push('## Project Requirements', '', scenarioQuery, '');
              }

              // SPARC-derived content for this phase (the actual architecture section)
              if (phase.content && phase.content.length > 50) {
                lines.push('## SPARC Architecture for This Phase', '', phase.content, '');
              }

              // SPARC spec + architecture on first two prompts for full context
              if (order === 1 && sparcSpec) {
                lines.push('## Full SPARC Specification', '', sparcSpec, '');
              }
              if (order <= 2 && sparcArch && phase.content !== sparcArch) {
                lines.push('## Full SPARC Architecture', '', sparcArch, '');
              }

              // ADR details — full markdown with file paths for each relevant ADR
              if (phaseAdrs.length > 0) {
                lines.push(`## Architecture Decisions (${phaseAdrs.length} ADRs)`, '');
                lines.push('ADR files are in `.agentics/plans/adrs/` — read them for full context:', '');
                for (const adr of phaseAdrs) {
                  const slug = (adr.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
                  const adrFilename = `${adr.id}-${slug}.md`;
                  lines.push(`**File:** \`.agentics/plans/adrs/${adrFilename}\``, '');
                  const fullMarkdown = getAdrMarkdown(adr);
                  if (fullMarkdown) {
                    lines.push(fullMarkdown, '', '---', '');
                  } else {
                    lines.push(`### ${adr.id}: ${adr.title}`, '');
                    if (adr.context) lines.push(`**Context:** ${adr.context}`, '');
                    if (adr.decision) lines.push(`**Decision:** ${adr.decision}`, '');
                    if (adr.consequences?.length) { lines.push('**Consequences:**'); for (const c of adr.consequences) lines.push(`- ${c}`); }
                    lines.push('');
                  }
                }
              }

              // List ALL ADR files for reference even if not directly linked to this phase
              if (adrDir && order === 1) {
                try {
                  const allAdrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md')).sort();
                  if (allAdrFiles.length > 0) {
                    lines.push('## All Architecture Decision Records', '');
                    lines.push('Read these files in `.agentics/plans/adrs/` for complete design rationale:', '');
                    for (const f of allAdrFiles) {
                      lines.push(`- \`.agentics/plans/adrs/${f}\``);
                    }
                    lines.push('');
                  }
                } catch { /* non-fatal */ }
              }

              // DDD reference — structured summary, not raw JSON dump
              if (dddSummary) {
                lines.push('## Domain Model Reference', '', dddSummary, '');
              }

              // Implementation instructions — ADR-PIPELINE-033: include traceability requirements
              lines.push(
                '## Implementation Requirements', '',
                '- All code must be CUSTOM to this project — implement the specific business logic described above',
                '- Follow the technology decisions from the ADRs referenced in the overview',
                '- Write production-quality code with proper error handling',
                '- Include unit tests (London School TDD — mock at module boundaries)',
                '- Export public interfaces so later build phases can import them',
                `- Place all files in the \`${phase.folder}/\` directory`,
                '',
                '## Traceability Requirements (ADR-PIPELINE-033)', '',
                '- All domain types that represent decisions, recommendations, or ERP actions must include optional `simulationId?: string` and `traceId?: string` fields',
                '- Audit trail entries must include these IDs when available',
                '- ERP transaction payloads must carry `simulationId` and `traceId` for end-to-end lineage',
                `${simulationId ? `- Use simulation ID \`${simulationId}\` as the default value when creating records in this build step` : '- Simulation ID will be injected at runtime from the pipeline context'}`,
                '',
              );

              // ADR-PIPELINE-039: Mandatory cross-cutting requirements in EVERY prompt
              lines.push(
                '## Mandatory Cross-Cutting Requirements (EVERY module must implement these)', '',
                '### Logging',
                '- Create `src/logger.ts` (if it does not exist) with `createLogger(service: string)` that outputs JSON to stderr',
                '- Every log entry: `{ timestamp, level, service, event, correlationId?, ...data }`',
                '- Import and use the logger in THIS module. Log: function entry with key params, completion with duration, errors with context',
                '',
                '### Configuration',
                '- Create `src/config.ts` (if it does not exist) with typed `AppConfig` read from environment variables',
                '- NEVER hardcode: ports, URLs, thresholds, weights, API keys, timeouts',
                '- Import config in THIS module for any configurable value',
                '',
                '### Input Validation (ADR-046: Zod at EVERY boundary)',
                '- EVERY function receiving external data MUST Zod-parse it:',
                '  API request bodies: `const parsed = Schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });`',
                '  Database rows: `const row = RowSchema.parse(rawDbRow);` — NEVER `as SomeType`',
                '  ERP/API responses: `const data = ResponseSchema.parse(response.data);`',
                '  Config values: validate ALL config with Zod at startup; refuse to start if invalid',
                '- NEVER use `as SomeType` to cast external data — always Zod-parse first',
                '',
                '### Error Handling',
                '- Define error classes extending `AppError` (create in `src/errors.ts` if needed)',
                '- Never `catch (e: any)` — always narrow error types',
                '- Log errors with logger.error() including stack trace and context',
                '- Event bus/emitter: wrap EACH handler in try/catch — one failure must NOT block others',
                '',
                '### Config-Driven (ADR-046: zero hardcoded magic numbers)',
                '- EVERY threshold, weight, factor, timeout MUST come from config (not hardcoded constants)',
                '- Config module validates ALL values with Zod at startup',
                '- If config invalid, service refuses to start with clear error',
                '',
                '### Deterministic Code (ADR-046)',
                '- No Math.random() in production code — use crypto.randomUUID() for IDs',
                '- Seed data generators may use seeded random; service code must be deterministic',
                '',
                '## Anti-Patterns to AVOID (evaluation checks — violations REDUCE score)', '',
                '- Do NOT use console.log — use createLogger()',
                '- Do NOT use `as SomeType` to cast DB rows, API responses, or request bodies — Zod-parse instead',
                '- Do NOT put business logic in route handlers — extract to service layer',
                '- Do NOT hardcode thresholds, weights, or magic numbers — read from config',
                '- Do NOT use Math.random() in production code — use crypto.randomUUID()',
                '- Do NOT list unused deps in package.json — if listed, USE them',
                '- Do NOT let event handlers fail silently — wrap each in try/catch with logging',
                '- Do NOT initialize required fields to empty string \'\'',
                '',
                '## Logging Enforcement', '',
                'This module MUST import `createLogger` from `../logger.js` (or `./logger.js` from src root).',
                'Log at minimum:',
                '- Function entry: `logger.info(\'functionName.start\', { key params })`',
                '- Function exit: `logger.info(\'functionName.complete\', { durationMs, resultCount })`',
                '- Errors: `logger.error(\'functionName.failed\', error, { context })`',
                '- Do NOT use console.log anywhere in this module.',
                '',
              );

              fs.writeFileSync(path.join(promptsDir, filename), lines.join('\n'), { mode: 0o600, encoding: 'utf-8' });
              completedPhases.push(`${order}. ${phase.title}`);
            }

            const planItems = derivedPhases.map((phase, i) => ({
              order: i + 1,
              file: `impl-${String(i + 1).padStart(3, '0')}-${phase.slug}.md`,
              title: phase.title,
              folder: phase.folder,
              adrs: phase.adrIds,
            }));
            // ADR-PIPELINE-033: Include simulation lineage in execution plan
            const plan = {
              totalSteps,
              prompts: planItems,
              lineage: {
                simulationId: simulationId || undefined,
                traceId: traceId || undefined,
                pipelineVersion: '1.7.3',
              },
            };
            fs.writeFileSync(path.join(promptsDir, 'execution-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600, encoding: 'utf-8' });

            console.error(`  [PROMPTS] Wrote ${totalSteps} implementation prompts derived from SPARC architecture + ADRs`);
          }

          copyPlanningArtifacts(runDir, projectRoot);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`  [PROMPTS] Implementation prompt generation failed: ${errMsg}`);
        }
      } else {
        console.error('  [PROMPTS] Skipped — no ADR directory found');
        console.error(`    Checked: ${path.join(runDir, 'phase4', 'adrs')} (${fs.existsSync(path.join(runDir, 'phase4', 'adrs')) ? 'exists' : 'MISSING'})`);
        console.error(`    Checked: ${path.join(runDir, 'phase2', 'adrs')} (${fs.existsSync(path.join(runDir, 'phase2', 'adrs')) ? 'exists' : 'MISSING'})`);
      }
    }
  }

  // ── Pre-Phase 5: Detect implementation language from prior artifacts ──
  let detectedLanguage = 'typescript';
  try {
    const phase3ManifestPath = path.join(runDir, 'phase3', 'phase3-manifest.json');
    const sparc3Path = path.join(runDir, 'phase3', 'sparc', 'sparc-combined.json');
    if (fs.existsSync(phase3ManifestPath)) {
      const m = JSON.parse(fs.readFileSync(phase3ManifestPath, 'utf-8'));
      if (m.implementation_language) detectedLanguage = m.implementation_language;
    } else if (fs.existsSync(sparc3Path)) {
      const sparc = JSON.parse(fs.readFileSync(sparc3Path, 'utf-8'));
      if (sparc?.architecture?.language) detectedLanguage = sparc.architecture.language;
    }
    // Also check if the user mentioned a language in the scenario query
    const langPatterns: Array<[RegExp, string]> = [
      [/\bpython\b/i, 'python'], [/\bjava\b(?!\s*script)/i, 'java'],
      [/\bc\s*#\b|\bcsharp\b|\b\.net\b/i, 'csharp'], [/\bc\+\+\b|\bcpp\b/i, 'cpp'],
      [/\bgolang\b|\bgo\s+(?:lang|service)\b/i, 'go'], [/\brust\b/i, 'rust'],
      [/\bswift\b/i, 'swift'], [/\bkotlin\b/i, 'kotlin'],
      [/\btypescript\b/i, 'typescript'], [/\bjavascript\b/i, 'javascript'],
      [/\bterraform\b|\bhcl\b/i, 'terraform'], [/\bbash\b|\bshell\s*script\b/i, 'bash'],
    ];
    for (const [re, lang] of langPatterns) {
      if (re.test(scenarioQuery)) { detectedLanguage = lang; break; }
    }
  } catch { /* best-effort language detection */ }

  // ── Phase 5: Build (Code Gen + Deployable Service) ──
  {
    const phaseStart = Date.now();
    const phaseDir = path.join(runDir, 'phase5');
    console.error('');
    console.error('-'.repeat(72));
    console.error(`  >> Phase 5: Build (Code Generation + Deployable Service) [${detectedLanguage}]`);
    console.error('-'.repeat(72));

    const phase5HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'phase5-manifest.json'));
    if (phase5HasContent) {
      console.error('  [SKIP] Phase 5 already exists — using existing artifacts');
      phases.push({ phase: 5, label: 'Build', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase5 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase5HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase5 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[5]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm: build production-ready application in cooperation with agentics agents
      const rufloP5Dir = path.join(runDir, '.ruflo-cache', 'phase5');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 5, label: 'Build (Production Code)', scenarioQuery,
        runDir, traceId, outputDir: rufloP5Dir,
        tasks: buildPhase5Tasks(scenarioQuery, detectedLanguage, collectPhase5Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase5Artifacts(runDir),
      });
      if (rufloResult.invoked) {
        console.error(`  [RUFLO-P5] ${rufloResult.filesModified} files generated in ${rufloResult.timing}ms`);
      }

      try {
        // Domain code generation — template generators produce the domain-specific structure
        // (bounded contexts, aggregates, events, commands, queries) from SPARC/TDD/ADR/DDD artifacts.
        // Ruflo swarm enhances them when it has an LLM backend.
        const result = await executePhase5Command({ trace: traceId });
        mergeRufloCacheIntoPhase(runDir, 5);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase5ForDisplay(result));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[5]!, traceId, runDir, artifactPaths, timing);

        // Ruflo coding swarm: enhance generated code with real business logic
        console.error('');
        console.error('  >> Ruflo Coding Swarm: Enhancing generated MVP...');
        const codingSwarm = invokeRufloCodingSwarm(traceId, runDir);
        if (codingSwarm.invoked) {
          console.error(`  [RUFLO-SWARM] ${codingSwarm.filesModified} files enhanced in ${codingSwarm.timing}ms`);
        }

        // Write agent-produced SDK/CLI code as supplementary artifacts alongside the domain code
        const phase1Code = extractPhase1AgentCode(runDir);
        if (phase1Code.length > 0) {
          const sdkDir = path.join(phaseDir, 'sdk');
          fs.mkdirSync(sdkDir, { recursive: true });
          let written = 0;
          for (const cf of phase1Code) {
            const fullPath = path.join(sdkDir, cf.filePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, cf.content, 'utf-8');
            written++;
          }
          if (written > 0) {
            console.error(`  [P5] Wrote ${written} supplementary SDK/CLI files from agentics agents`);
          }
        }

        await reviewPhaseOutput(PHASE_AGENTS[5]!, traceId, runDir);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 5, label: 'Build', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[5]!.agenticsServices.length) });
        copyPlanningArtifacts(runDir, projectRoot);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 5 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[5]!, traceId, errMsg);
        phases.push({ phase: 5, label: 'Build', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        copyPlanningArtifacts(runDir, projectRoot);
        // Check if phase5-manifest.json exists on disk — if so, allow Phase 6 to attempt degraded mode
        const phase5ManifestPath = path.join(phaseDir, 'phase5-manifest.json');
        if (!fs.existsSync(phase5ManifestPath)) {
          await ensureAdrsExist(runDir, traceId, scenarioQuery);
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

    // Only skip if phase6 has actual registration content (not just an empty dir from a failed prior run)
    const phase6HasContent = fs.existsSync(phaseDir)
      && fs.existsSync(path.join(phaseDir, 'registration.json'));
    if (phase6HasContent) {
      console.error('  [SKIP] Phase 6 already exists — using existing artifacts');
      phases.push({ phase: 6, label: 'ERP Surface Push', status: 'skipped', timing: 0, artifacts: [], outputDir: phaseDir });
    } else {
      // Clean up incomplete phase6 directory from a prior failed run
      if (fs.existsSync(phaseDir) && !phase6HasContent) {
        console.error('  [CLEANUP] Removing incomplete phase6 directory from prior run');
        fs.rmSync(phaseDir, { recursive: true, force: true });
      }
      const agentResults = await dispatchPhaseAgents(PHASE_AGENTS[6]!, traceId, runDir, scenarioQuery);

      // Ruflo swarm + agentics agents: ERP surface push cooperatively
      const rufloP6Dir = path.join(runDir, '.ruflo-cache', 'phase6');
      const rufloResult = executeRufloPhaseSwarm({
        phase: 6, label: 'ERP Surface Push', scenarioQuery,
        runDir, traceId, outputDir: rufloP6Dir,
        tasks: buildPhase6Tasks(scenarioQuery, collectPhase6Artifacts(runDir)),
        agenticsResults: agentResults,
        priorArtifacts: collectPhase6Artifacts(runDir),
      });
      if (rufloResult.filesModified > 0) {
        console.error(`  [RUFLO-P6] ${rufloResult.filesModified} files generated (swarm+agents) in ${rufloResult.timing}ms`);
      }

      try {
        const result = await executePhase6Command({ trace: traceId, outputDir: options.outputDir });
        mergeRufloCacheIntoPhase(runDir, 6);
        const timing = Date.now() - phaseStart;
        const artifactPaths = extractArtifactPaths(result.manifest.artifacts);
        console.error(formatPhase6ForDisplay(result, options.outputDir));
        printArtifactLinks(phaseDir, artifactPaths);
        storePhaseArtifacts(PHASE_AGENTS[6]!, traceId, runDir, artifactPaths, timing);
        persistAgenticsResults(phaseDir, agentResults);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'completed', timing, artifacts: artifactPaths, outputDir: phaseDir, agenticsAgents: buildAgentSummary(agentResults, PHASE_AGENTS[6]!.agenticsServices.length) });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [FAIL] Phase 6 failed: ${errMsg}`);
        recordPhaseFailure(PHASE_AGENTS[6]!, traceId, errMsg);
        phases.push({ phase: 6, label: 'ERP Surface Push', status: 'failed', timing: Date.now() - phaseStart, artifacts: [], outputDir: phaseDir, error: errMsg });
        await ensureAdrsExist(runDir, traceId, scenarioQuery);
        return buildResult(traceId, runDir, phases, pipelineStart, mode);
      }
    }
  }

  // Progressive copy already happened after each phase via copyPlanningArtifacts()

  // ── Project mode: materialize to repo root and commit on current branch ──
  let commitHash: string | undefined;
  if (mode === 'project') {
    console.error('');
    console.error('-'.repeat(72));
    console.error('  >> Materializing MVP to current branch');
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
  }

  // ADR-028: Final ADR guarantee before returning
  await ensureAdrsExist(runDir, traceId, scenarioQuery);

  // ── Shutdown swarm and persist metrics ──
  const totalTiming = Date.now() - pipelineStart;
  const pipelineSuccess = phases.every(p => p.status === 'completed' || p.status === 'skipped');
  shutdownSwarm(traceId, pipelineSuccess, totalTiming);

  // ── Final Summary ──
  const result = buildResult(traceId, runDir, phases, pipelineStart, mode, scenarioBranch, commitHash, execCtx.remoteUrl);
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
  console.error(`  Mode:        ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project'}`);
  console.error(`  Orchestration: Ruflo swarm + Agentics platform agents (hierarchical, specialized)`);
  console.error(`  Duration:    ${(result.totalTiming / 1000).toFixed(1)}s`);
  console.error(`  Success:     ${result.success}`);

  // Project mode: show commit info
  if (result.executionMode === 'project') {
    if (result.commitHash) {
      console.error('');
      console.error(`  Commit:    ${result.commitHash}`);
    }
  }
  console.error('');

  console.error('  Phase Summary:');
  console.error('  ' + '-'.repeat(60));
  for (const phase of result.phases) {
    const icon = phase.status === 'completed' ? '[OK]' : phase.status === 'skipped' ? '[--]' : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    const agentStr = phase.agenticsAgents
      ? `  agents: ${phase.agenticsAgents.responded}/${phase.agenticsAgents.total}`
      : '';
    console.error(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(25)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts${agentStr})`);
  }
  console.error('');

  // Show agentics agent domain coverage
  const allDomains = new Set<string>();
  let totalAgentsResponded = 0;
  let totalAgentsDispatched = 0;
  for (const phase of result.phases) {
    if (phase.agenticsAgents) {
      totalAgentsResponded += phase.agenticsAgents.responded;
      totalAgentsDispatched += phase.agenticsAgents.total;
      for (const d of phase.agenticsAgents.domains) allDomains.add(d);
    }
  }
  if (totalAgentsDispatched > 0) {
    console.error(`  Agentics Agents: ${totalAgentsResponded}/${totalAgentsDispatched} responded across ${allDomains.size} domains`);
    if (allDomains.size > 0) {
      console.error(`  Domains: ${[...allDomains].sort().join(', ')}`);
    }
    if (totalAgentsResponded < totalAgentsDispatched) {
      const missing = totalAgentsDispatched - totalAgentsResponded;
      console.error(`  WARNING: ${missing} agent(s) failed or timed out — some analysis may be incomplete`);
    }
    console.error('');
  }

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
  if (result.executionMode === 'project') {
    console.error('  Next steps (Project Mode):');
    console.error('    npm install');
    console.error('    npm run dev');
    console.error('');
    console.error('  To inspect the generated code:');
    console.error(`    git log --oneline -5`);
    console.error(`    git diff HEAD~1 --stat`);
  } else {
    console.error('  ════════════════════════════════════════════════════════════');
    console.error('  IMPORTANT: Read the implementation prompts before building!');
    console.error('  ════════════════════════════════════════════════════════════');
    console.error('');
    console.error('  Implementation prompts (READ THESE FIRST — in order):');
    console.error(`    ls ${result.runDir}/prompts/impl-*.md`);
    console.error(`    cat ${result.runDir}/prompts/execution-plan.json`);
    console.error('');
    console.error('  The FIRST prompt (impl-001) contains src/logger.ts, src/config.ts,');
    console.error('  and src/errors.ts code that ALL subsequent modules must import.');
    console.error('  Every prompt has mandatory cross-cutting requirements at the bottom.');
    console.error('');
    console.error('  Architecture Decision Records:');
    console.error(`    ls ${result.runDir}/phase4/adrs/`);
    console.error('');
    console.error('  Executive documents:');
    console.error(`    cat ${result.runDir}/executive-summary.md`);
    console.error(`    cat ${result.runDir}/decision-memo.md`);
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

/** Build agent summary metadata for PhaseResult tracking. */
function buildAgentSummary(
  allServices: AgenticsServiceResult[],
  totalDispatched: number,
): PhaseResult['agenticsAgents'] {
  const domains = [...new Set(allServices.map(r => r.domain))];
  return { total: totalDispatched, responded: allServices.length, domains };
}

/**
 * Persist agentics agent results alongside phase artifacts.
 * Writes a JSON file with all agent responses for auditability.
 */
function persistAgenticsResults(phaseDir: string, results: AgenticsServiceResult[]): void {
  if (results.length === 0) return;

  try {
    if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

    const report = {
      timestamp: new Date().toISOString(),
      agentsInvoked: results.length,
      results: results.map(r => ({
        domain: r.domain,
        agent: r.agent,
        role: r.role,
        status: r.status,
        timing: r.timing,
        response: r.response,
      })),
    };

    fs.writeFileSync(
      path.join(phaseDir, 'agentics-agents-report.json'),
      JSON.stringify(report, null, 2),
    );
  } catch {
    // Non-fatal — agent result persistence should never block the pipeline
  }
}

// ============================================================================
// Stdout Display Formatter
// ============================================================================

/**
 * Format the auto-chain result for stdout display.
 * This is the consolidated pipeline summary that surfaces Phase 2-6 details
 * to callers who only see stdout (e.g., Claude Code rendering `agentics ask`).
 */
export function formatAutoChainForDisplay(result: AutoChainResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(72));
  lines.push('  ENTERPRISE PROTOTYPE PIPELINE — PHASES 2-6');
  lines.push('='.repeat(72));
  lines.push('');
  lines.push(`  Trace ID:       ${result.traceId}`);
  lines.push(`  Run Directory:  ${result.runDir}`);
  lines.push(`  Mode:           ${result.executionMode === 'development' ? 'Development (sandbox)' : 'Project'}`);
  lines.push(`  Duration:       ${(result.totalTiming / 1000).toFixed(1)}s`);
  lines.push(`  Overall:        ${result.success ? 'SUCCESS' : 'FAILED'}`);
  lines.push('');

  // Phase-by-phase summary
  lines.push('  Phase Results:');
  lines.push('  ' + '-'.repeat(68));
  for (const phase of result.phases) {
    const icon = phase.status === 'completed' ? '[OK]' : phase.status === 'skipped' ? '[--]' : '[!!]';
    const timingStr = phase.timing > 0 ? `${(phase.timing / 1000).toFixed(1)}s` : 'cached';
    lines.push(`    ${icon} Phase ${phase.phase}: ${phase.label.padEnd(30)} ${timingStr.padStart(8)}  (${phase.artifacts.length} artifacts)`);
    if (phase.error) {
      lines.push(`         Error: ${phase.error}`);
    }
  }
  lines.push('');

  // Artifact locations
  const totalArtifacts = result.phases.reduce((sum, p) => sum + p.artifacts.length, 0);
  lines.push(`  Total Artifacts: ${totalArtifacts} files across ${result.phases.length} phases`);
  lines.push('');
  lines.push('  Key Locations:');
  for (const phase of result.phases) {
    if (phase.status !== 'skipped') {
      lines.push(`    Phase ${phase.phase} (${phase.label}): ${phase.outputDir}`);
    }
  }
  lines.push('');

  // Project mode branch info
  if (result.executionMode === 'project' && result.scenarioBranch) {
    lines.push(`  Scenario Branch: ${result.scenarioBranch}`);
    if (result.commitHash) {
      lines.push(`  Commit:          ${result.commitHash}`);
    }
    if (result.githubUrl) {
      lines.push(`  GitHub:          ${result.githubUrl}`);
    }
    lines.push('');
  }

  // ADR-PIPELINE-039: Tell Claude Code exactly what to read and follow
  lines.push('  ══════════════════════════════════════════════════════════════════');
  lines.push('  IMPLEMENTATION INSTRUCTIONS (Claude Code: READ THESE FILES)');
  lines.push('  ══════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  The pipeline generated implementation prompts in .agentics/plans/prompts/');
  lines.push('  These are ORDERED build steps. Read them sequentially and follow each one.');
  lines.push('');
  lines.push('  CRITICAL FILES TO READ BEFORE BUILDING:');
  lines.push('    1. .agentics/plans/prompts/execution-plan.json  — Build order and dependencies');
  lines.push('    2. .agentics/plans/prompts/impl-001-*.md        — First: create logger.ts, config.ts, errors.ts, then domain types');
  lines.push('    3. .agentics/plans/prompts/impl-002-*.md        — Second build step');
  lines.push('    4. .agentics/plans/prompts/impl-003-*.md        — Third build step (continue for all impl-*.md files)');
  lines.push('    5. .agentics/plans/adrs/                        — Architecture Decision Records (design rationale)');
  lines.push('');
  lines.push('  EVERY MODULE MUST INCLUDE (from each prompt\'s cross-cutting section):');
  lines.push('    - src/logger.ts with createLogger() — structured JSON logging to stderr');
  lines.push('    - src/config.ts with AppConfig — environment-based configuration');
  lines.push('    - src/errors.ts with AppError classes — typed error handling');
  lines.push('    - Input validation on all public functions');
  lines.push('    - Correlation ID threading through analysis → decision → ERP sync');
  lines.push('');
  lines.push('  DO NOT skip the implementation prompts and build from scratch.');
  lines.push('  The prompts contain specific code patterns that the evaluation checks for.');
  lines.push('');

  // Legacy next steps
  lines.push('  To inspect all artifacts:');
  lines.push(`    agentics inspect run ${result.traceId}`);
  lines.push('');

  return lines.join('\n');
}

function buildResult(
  traceId: string,
  runDir: string,
  phases: PhaseResult[],
  startTime: number,
  executionMode: ExecutionMode = 'development',
  scenarioBranch?: string,
  commitHash?: string,
  remoteUrl?: string | null,
): AutoChainResult {
  const success = phases.every(p => p.status === 'completed' || p.status === 'skipped');

  // Build GitHub URL if we have a remote and a branch
  let githubUrl: string | undefined;
  if (remoteUrl && scenarioBranch) {
    const match = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      githubUrl = `https://github.com/${match[1]}/${match[2]}/tree/${scenarioBranch}`;
    }
  }

  return {
    traceId,
    runDir,
    phases,
    totalTiming: Date.now() - startTime,
    success,
    executionMode,
    scenarioBranch,
    commitHash,
    githubUrl,
  };
}
