/**
 * Graph Validator (ADR-031 Phase 5)
 *
 * Tiered validation engine for the ecosystem capability graph.
 *
 * Tier 1 (Offline): Schema, uniqueness, weights, compositions, cycles
 * Tier 2 (Online): Repository existence, agent name consistency (requires API)
 * Tier 3 (Telemetry): Orphan detection (requires outcome data)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEcosystemGraph, resolveGraphPath } from './graph-loader.js';
import type { EcosystemGraph } from './graph-loader.js';
import { isWeightedAgent } from './weighted-resolver.js';
import { validateCompositionRules, detectCompositionCycles } from './composition-engine.js';
import type { CompositionRule } from './composition-engine.js';
import { loadOutcomes } from './outcome-recorder.js';

// ============================================================================
// Types
// ============================================================================

export type ValidationTier = 'offline' | 'online' | 'telemetry';
export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationResult {
  readonly rule: string;
  readonly severity: ValidationSeverity;
  readonly passed: boolean;
  readonly message: string;
  readonly details?: readonly string[];
}

export interface ValidationReport {
  readonly tier: ValidationTier;
  readonly results: readonly ValidationResult[];
  readonly passed: number;
  readonly failed: number;
  readonly warnings: number;
  readonly timestamp: string;
}

// ============================================================================
// Tier 1: Offline Validation
// ============================================================================

/**
 * Run Tier 1 offline validation rules.
 * No network required. Validates structural correctness.
 */
export function validateTier1(graphPath?: string): ValidationReport {
  const resolvedPath = graphPath ?? resolveGraphPath();
  const results: ValidationResult[] = [];

  // Rule 1: Schema validation (load will throw on invalid schema)
  let graph: EcosystemGraph | null = null;
  try {
    graph = loadEcosystemGraph({ graphPath: resolvedPath, forceReload: true });
    results.push({
      rule: 'Schema validation',
      severity: 'error',
      passed: true,
      message: `${graph.capabilities.length} capabilities valid`,
    });
  } catch (err) {
    results.push({
      rule: 'Schema validation',
      severity: 'error',
      passed: false,
      message: (err as Error).message,
    });
    return buildReport('offline', results);
  }

  // Rule 2: Unique capability names (already checked by loader, but explicit)
  const capNames = graph.capabilities.map(c => c.name);
  const uniqueNames = new Set(capNames);
  results.push({
    rule: 'Unique capability names',
    severity: 'error',
    passed: capNames.length === uniqueNames.size,
    message: capNames.length === uniqueNames.size
      ? 'no duplicates'
      : `${capNames.length - uniqueNames.size} duplicate(s) found`,
  });

  // Rule 3: Non-empty agents
  const emptyAgents = graph.capabilities.filter(c => c.agents.length === 0);
  results.push({
    rule: 'Non-empty agents',
    severity: 'error',
    passed: emptyAgents.length === 0,
    message: emptyAgents.length === 0
      ? 'all capabilities have agents'
      : `${emptyAgents.length} capability(s) missing agents: ${emptyAgents.map(c => c.name).join(', ')}`,
  });

  // Rule 4: Non-empty repos
  const emptyRepos = graph.capabilities.filter(c => c.repos.length === 0);
  results.push({
    rule: 'Non-empty repos',
    severity: 'error',
    passed: emptyRepos.length === 0,
    message: emptyRepos.length === 0
      ? 'all capabilities have repos'
      : `${emptyRepos.length} capability(s) missing repos: ${emptyRepos.map(c => c.name).join(', ')}`,
  });

  // Rule 5: Valid stage references
  const stageSet = new Set(graph.stages);
  const invalidStages = graph.capabilities.filter(c => c.stage && !stageSet.has(c.stage));
  results.push({
    rule: 'Valid stage references',
    severity: 'error',
    passed: invalidStages.length === 0,
    message: invalidStages.length === 0
      ? 'all stages exist'
      : `invalid stages in: ${invalidStages.map(c => `${c.name}(${c.stage})`).join(', ')}`,
  });

  // Rule 6: No circular dependencies (already checked by loader)
  results.push({
    rule: 'No circular dependencies',
    severity: 'error',
    passed: true,
    message: 'topological sort succeeded',
  });

  // Rule 9: Weight bounds
  const weightErrors: string[] = [];
  for (const cap of graph.capabilities) {
    for (const agent of cap.agents) {
      if (isWeightedAgent(agent)) {
        if (agent.weight < 0 || agent.weight > 1) {
          weightErrors.push(`${cap.name}/${agent.name}: weight ${agent.weight}`);
        }
      }
    }
  }
  results.push({
    rule: 'Weight bounds',
    severity: 'error',
    passed: weightErrors.length === 0,
    message: weightErrors.length === 0
      ? 'all weights in [0.0, 1.0]'
      : `${weightErrors.length} weight(s) out of range`,
    details: weightErrors.length > 0 ? weightErrors : undefined,
  });

  // Rules 10-11: Composition validation
  const compositions = loadCompositionsFromGraph(resolvedPath);
  if (compositions.length > 0) {
    const validCaps = new Set(capNames);
    const compErrors = validateCompositionRules(compositions, validCaps);
    results.push({
      rule: 'Composition rule validity',
      severity: 'error',
      passed: compErrors.length === 0,
      message: compErrors.length === 0
        ? 'all referenced capabilities exist'
        : `${compErrors.length} error(s)`,
      details: compErrors.length > 0 ? compErrors : undefined,
    });

    const cycles = detectCompositionCycles(compositions);
    results.push({
      rule: 'Composition cycle detection',
      severity: 'error',
      passed: !cycles.hasCycle,
      message: cycles.hasCycle
        ? `cycle detected among: ${cycles.cycleNodes.join(', ')}`
        : 'no cycles',
    });
  } else {
    results.push({
      rule: 'Composition rule validity',
      severity: 'error',
      passed: true,
      message: 'no composition rules defined',
    });
    results.push({
      rule: 'Composition cycle detection',
      severity: 'error',
      passed: true,
      message: 'no composition rules defined',
    });
  }

  // Rule 12: Fragment owner field (only relevant for federated graphs)
  const fragmentsDir = getFragmentsDir(resolvedPath);
  if (fragmentsDir && fs.existsSync(fragmentsDir)) {
    const missingOwners = checkFragmentOwners(fragmentsDir);
    results.push({
      rule: 'Fragment owner field',
      severity: 'warning',
      passed: missingOwners.length === 0,
      message: missingOwners.length === 0
        ? 'all fragments have owners'
        : `${missingOwners.length} fragments missing owner`,
      details: missingOwners.length > 0 ? missingOwners : undefined,
    });
  }

  return buildReport('offline', results);
}

// ============================================================================
// Tier 3: Telemetry Validation
// ============================================================================

/**
 * Run Tier 3 telemetry validation rules.
 * Requires outcome data from Phase 2.
 */
export function validateTier3(
  graphPath?: string,
  options?: { basePath?: string; orphanDays?: number },
): ValidationReport {
  const resolvedPath = graphPath ?? resolveGraphPath();
  const results: ValidationResult[] = [];

  let graph: EcosystemGraph;
  try {
    graph = loadEcosystemGraph({ graphPath: resolvedPath, forceReload: true });
  } catch (err) {
    results.push({
      rule: 'Graph load',
      severity: 'error',
      passed: false,
      message: (err as Error).message,
    });
    return buildReport('telemetry', results);
  }

  // Rule 13: Orphan detection
  const outcomes = loadOutcomes({ basePath: options?.basePath });
  const orphanDays = options?.orphanDays ?? 30;
  const cutoff = new Date(Date.now() - orphanDays * 24 * 60 * 60 * 1000).toISOString();

  const recentOutcomes = outcomes.filter(o => o.timestamp >= cutoff);
  const usedCapabilities = new Set<string>();
  for (const o of recentOutcomes) {
    for (const cap of o.capabilities_used) {
      usedCapabilities.add(cap);
    }
  }

  // Find capabilities with no inbound depends_on and no recent usage
  const referencedCaps = new Set<string>();
  for (const cap of graph.capabilities) {
    if (cap.depends_on) {
      for (const dep of cap.depends_on) {
        referencedCaps.add(dep);
      }
    }
  }

  const orphans = graph.capabilities
    .filter(c => !referencedCaps.has(c.name) && !usedCapabilities.has(c.name))
    .map(c => c.name);

  if (recentOutcomes.length > 0) {
    results.push({
      rule: 'Orphan detection',
      severity: 'warning',
      passed: orphans.length === 0,
      message: orphans.length === 0
        ? `all capabilities used or referenced in last ${orphanDays} days`
        : `${orphans.length} orphan(s) detected (no usage or references in ${orphanDays} days)`,
      details: orphans.length > 0 ? orphans : undefined,
    });
  } else {
    results.push({
      rule: 'Orphan detection',
      severity: 'info',
      passed: true,
      message: 'no telemetry data available — skipping orphan detection',
    });
  }

  return buildReport('telemetry', results);
}

// ============================================================================
// Report Building
// ============================================================================

function buildReport(tier: ValidationTier, results: ValidationResult[]): ValidationReport {
  return {
    tier,
    results,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed && r.severity === 'error').length,
    warnings: results.filter(r => !r.passed && r.severity === 'warning').length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a validation report as human-readable output.
 */
export function formatValidationReport(report: ValidationReport): string {
  const tierLabel = report.tier === 'offline'
    ? 'Tier 1: Offline'
    : report.tier === 'online'
      ? 'Tier 2: Online'
      : 'Tier 3: Telemetry';

  const lines: string[] = [
    `Capability Graph Validation (${tierLabel})`,
    '='.repeat(50),
    '',
  ];

  for (const result of report.results) {
    const icon = result.passed
      ? '[PASS]'
      : result.severity === 'warning'
        ? '[WARN]'
        : result.severity === 'info'
          ? '[INFO]'
          : '[FAIL]';

    lines.push(`${icon} ${result.rule}: ${result.message}`);

    if (result.details && result.details.length > 0) {
      for (const detail of result.details) {
        lines.push(`         - ${detail}`);
      }
    }
  }

  lines.push('');
  lines.push(`Result: ${report.passed} passed, ${report.failed} failed, ${report.warnings} warning(s)`);

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

function loadCompositionsFromGraph(graphPath: string): CompositionRule[] {
  try {
    const raw = fs.readFileSync(graphPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(data['compositions'])) {
      return data['compositions'] as CompositionRule[];
    }
  } catch {
    // Ignore
  }
  return [];
}

function getFragmentsDir(graphPath: string): string | null {
  try {
    const raw = fs.readFileSync(graphPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data['fragments_dir'] === 'string') {
      return path.resolve(path.dirname(graphPath), data['fragments_dir'] as string);
    }
  } catch {
    // Ignore
  }
  return null;
}

function checkFragmentOwners(fragmentsDir: string): string[] {
  const missing: string[] = [];
  try {
    const files = fs.readdirSync(fragmentsDir).filter(f => f.endsWith('.graph.json'));
    for (const file of files) {
      const filePath = path.join(fragmentsDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data['owner'] || (typeof data['owner'] === 'string' && data['owner'].length === 0)) {
        missing.push(file);
      }
    }
  } catch {
    // Best effort
  }
  return missing;
}
