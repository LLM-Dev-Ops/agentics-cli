/**
 * Phase 5 Build — Frontend Generation via Ruflo Agent Swarm
 *
 * Delegates frontend generation to ruflo's agent swarm, passing the
 * DDD domain model, SPARC spec, ADR decisions, and TDD plan as context.
 * Ruflo agents build a complete React+Vite+Tailwind frontend with:
 *   - Dashboard page with per-context overview
 *   - Per-bounded-context pages (data tables + command forms)
 *   - Typed API client from commands/queries
 *   - Layout with sidebar navigation
 *
 * Does NOT template code in-process — the ruflo agents do the building.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { Phase5BuildContext, Phase5BuildStage } from '../types.js';
import { resolveRufloBinary as resolveSharedRufloBinary, buildImplementationPrompt } from '../../ruflo-phase-executor.js';

const DIR_MODE = 0o700;

// ============================================================================
// Stage output type (matches coordinator pattern)
// ============================================================================

export interface FrontendStageOutput {
  readonly stage: Phase5BuildStage;
  readonly status: 'completed' | 'failed';
  readonly timing: number;
  readonly artifacts: string[];
  readonly summary: string;
  readonly data: Record<string, unknown>;
}

// ============================================================================
// Ruflo binary resolution
// ============================================================================

function resolveRufloBinary(): string | null {
  return resolveSharedRufloBinary();
}

// ============================================================================
// Count files helper
// ============================================================================

function countFilesInDir(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
      count += countFilesInDir(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

// ============================================================================
// Artifact locator
// ============================================================================

function findArtifact(phase5Dir: string, ...candidates: string[]): string | null {
  for (const candidate of candidates) {
    const full = path.join(phase5Dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// ============================================================================
// Public: Generate Frontend via Ruflo Swarm
// ============================================================================

/**
 * Orchestrate ruflo agents to build a frontend from DDD/SPARC/ADR/TDD artifacts.
 * Called as the final stage in the Phase 5 build pipeline.
 */
export function generateFrontend(context: Phase5BuildContext): FrontendStageOutput {
  const startTime = Date.now();
  const stage: Phase5BuildStage = 'frontend-generation';

  // Locate artifacts from the merged phase2 directory
  const mergedDir = path.join(context.phase5Dir, '.phase2-merged');
  const codegenDir = path.join(context.phase5Dir, 'codegen');

  const dddModelPath = findArtifact(mergedDir, 'ddd/domain-model.json')
    ?? findArtifact(context.phase2Dir, 'ddd/domain-model.json');
  const sparcPath = findArtifact(mergedDir, 'sparc/sparc-combined.json', 'sparc-combined.json')
    ?? findArtifact(context.phase2Dir, 'sparc/sparc-combined.json', 'sparc-combined.json');
  const adrPath = findArtifact(mergedDir, 'adrs/adr-index.json')
    ?? findArtifact(context.phase2Dir, 'adrs/adr-index.json');
  const tddPath = findArtifact(mergedDir, 'tdd/tdd-plan.json')
    ?? findArtifact(context.phase2Dir, 'tdd/tdd-plan.json');

  // Target directory for frontend
  const projectDir = path.join(codegenDir, 'project');
  const uiDir = path.join(projectDir, 'ui');
  fs.mkdirSync(uiDir, { recursive: true, mode: DIR_MODE });

  // Build artifact context
  const artifactParts: string[] = [];
  if (sparcPath) artifactParts.push(`SPARC=${sparcPath}`);
  if (adrPath) artifactParts.push(`ADRs=${adrPath}`);
  if (dddModelPath) artifactParts.push(`DDD=${dddModelPath}`);
  if (tddPath) artifactParts.push(`TDD=${tddPath}`);
  // artifactParts used for logging below

  // Read DDD model for context summary
  let contextCount = 0;
  let commandCount = 0;
  let queryCount = 0;
  if (dddModelPath) {
    try {
      const model = JSON.parse(fs.readFileSync(dddModelPath, 'utf-8'));
      const contexts = model?.contexts ?? [];
      contextCount = contexts.length;
      for (const ctx of contexts) {
        commandCount += (ctx.commands ?? []).length;
        queryCount += (ctx.queries ?? []).length;
      }
    } catch { /* best effort */ }
  }

  console.error(`  [FRONTEND] DDD: ${contextCount} contexts, ${commandCount} commands, ${queryCount} queries`);
  console.error(`  [FRONTEND] Artifacts: ${artifactParts.length}/4 available`);

  // Find ruflo binary
  const rufloBin = resolveRufloBinary();
  if (!rufloBin) {
    const timing = Date.now() - startTime;
    console.error('  [FRONTEND] ruflo not available — frontend generation skipped');
    return {
      stage,
      status: 'completed',
      timing,
      artifacts: [],
      summary: '     Frontend: skipped (ruflo not available)',
      data: { skipped: true, reason: 'ruflo not installed' },
    };
  }

  // Count files before
  const filesBefore = countFilesInDir(uiDir);

  // Initialize a frontend-specific swarm
  try {
    spawnSync(rufloBin, [
      'swarm', 'init',
      '--topology', 'hierarchical',
      '--max-agents', '6',
      '--strategy', 'specialized',
    ], { cwd: uiDir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
  } catch { /* non-fatal */ }

  // Build implementation prompt for frontend
  const scenario = context.scenarioQuery || 'enterprise application';
  const implArtifacts: Record<string, string> = {};
  if (dddModelPath) implArtifacts['DDD'] = dddModelPath;
  if (sparcPath) implArtifacts['SPARC'] = sparcPath;
  if (adrPath) implArtifacts['ADRs'] = adrPath;
  if (tddPath) implArtifacts['TDD'] = tddPath;

  const implPrompt = buildImplementationPrompt(implArtifacts, scenario, 'typescript');

  const taskDescriptions = [
    `React+Vite+Tailwind scaffold: package.json, vite.config.ts, tailwind.config.js, tsconfig.json, index.html. ${contextCount} bounded contexts. Target: ${uiDir}`,
    `Dashboard + layout: sidebar listing ${contextCount} bounded contexts, overview cards, system health. Target: ${uiDir}/src`,
    `Per-context CRUD pages: ${contextCount} pages with DataTable for ${queryCount} queries, CommandForm for ${commandCount} commands. Target: ${uiDir}/src/pages`,
    `Typed API client: fetch wrapper per command/query from DDD model. Target: ${uiDir}/src/api`,
    `Reusable components: DataTable, CommandForm, StatusBadge, ErrorBoundary, LoadingSkeleton. Target: ${uiDir}/src/components`,
  ];

  let tasksCreated = 0;
  for (const desc of taskDescriptions) {
    try {
      spawnSync(rufloBin, [
        'task', 'create',
        '--type', 'implementation',
        '--description', desc,
      ], { cwd: uiDir, timeout: 30000, encoding: 'utf-8', stdio: 'pipe' });
      tasksCreated++;
    } catch { /* non-fatal */ }
  }

  console.error(`  [FRONTEND] Created ${tasksCreated} frontend tasks`);

  // Start the frontend swarm with implementation prompt as objective
  const objective = implPrompt.slice(0, 2000) + `\n\nFrontend focus: ${contextCount} bounded contexts, ${commandCount} commands, ${queryCount} queries. Target: ${uiDir}`;

  let swarmOk = false;
  try {
    spawnSync(rufloBin, [
      'swarm', 'start',
      '--objective', objective,
      '-s', 'development',
    ], { cwd: uiDir, timeout: 600000, encoding: 'utf-8', stdio: 'pipe' });
    swarmOk = true;
    console.error('  [FRONTEND] Frontend swarm completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [FRONTEND] Swarm note: ${msg.slice(0, 200)}`);
  }

  // Count files after
  const filesAfter = countFilesInDir(uiDir);
  const newFiles = Math.max(0, filesAfter - filesBefore);
  const timing = Date.now() - startTime;

  // Collect generated artifact paths
  const artifacts: string[] = [];
  if (fs.existsSync(uiDir)) {
    const collectFiles = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) {
          collectFiles(full);
        } else if (entry.isFile()) {
          artifacts.push(full);
        }
      }
    };
    collectFiles(uiDir);
  }

  console.error(`  [FRONTEND] Result: ${newFiles} files, ${tasksCreated} tasks, ${timing}ms`);

  return {
    stage,
    status: 'completed',
    timing,
    artifacts,
    summary: `     Frontend: ${tasksCreated} tasks dispatched, ${newFiles} files generated via ruflo swarm in ${timing}ms`,
    data: {
      swarmStarted: swarmOk,
      tasksCreated,
      filesGenerated: newFiles,
      contexts: contextCount,
      commands: commandCount,
      queries: queryCount,
    },
  };
}
