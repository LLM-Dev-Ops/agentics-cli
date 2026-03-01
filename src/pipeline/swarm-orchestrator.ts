/**
 * Swarm Orchestrator — Claude-Flow Integration for Pipeline Phases
 *
 * Wraps each pipeline phase (2-6) with claude-flow swarm coordination:
 *   - Initializes a hierarchical swarm before the pipeline starts
 *   - Dispatches specialized agents per phase (researcher, architect, coder, tester, reviewer)
 *   - Stores phase artifacts in swarm memory for cross-phase knowledge sharing
 *   - Runs quality review agents after each phase
 *   - Records metrics and learning patterns
 *
 * Graceful degradation: if claude-flow is not available, all methods succeed
 * silently and the pipeline falls back to local-only execution.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface SwarmConfig {
  readonly topology: 'hierarchical' | 'hierarchical-mesh' | 'mesh';
  readonly maxAgents: number;
  readonly strategy: 'specialized' | 'balanced';
  readonly traceId: string;
  readonly runDir: string;
}

export interface PhaseAgent {
  readonly role: string;
  readonly type: string;
  readonly description: string;
}

export interface SwarmPhaseConfig {
  readonly phase: number;
  readonly label: string;
  readonly agents: PhaseAgent[];
  readonly memoryNamespace: string;
}

export interface SwarmStatus {
  readonly initialized: boolean;
  readonly available: boolean;
  readonly agentCount: number;
  readonly tasksCompleted: number;
  readonly memoryEntries: number;
}

// ============================================================================
// Phase Agent Configurations
// ============================================================================

/** Agent teams dispatched per pipeline phase. */
export const PHASE_AGENTS: Record<number, SwarmPhaseConfig> = {
  2: {
    phase: 2,
    label: 'Deep Research',
    memoryNamespace: 'phase2-research',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate deep research extraction from simulation artifacts' },
      { role: 'researcher', type: 'researcher', description: 'Extract and synthesize knowledge from Phase 1 artifacts' },
      { role: 'analyst', type: 'analyst', description: 'Cross-reference dossier items and identify gaps' },
    ],
  },
  3: {
    phase: 3,
    label: 'SPARC + London TDD',
    memoryNamespace: 'phase3-sparc',
    agents: [
      { role: 'coordinator', type: 'sparc-coord', description: 'Orchestrate SPARC methodology phases' },
      { role: 'specification', type: 'specification', description: 'Generate SPARC specification from research dossier' },
      { role: 'pseudocode', type: 'pseudocode', description: 'Design algorithms and pseudocode from specification' },
      { role: 'architect', type: 'architecture', description: 'Design microservice architecture from pseudocode' },
      { role: 'tester', type: 'tester', description: 'Generate London School TDD plan with mock contracts' },
    ],
  },
  4: {
    phase: 4,
    label: 'ADRs + DDDs',
    memoryNamespace: 'phase4-adrs',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate ADR and DDD generation' },
      { role: 'adr-writer', type: 'system-architect', description: 'Generate Architecture Decision Records from SPARC output' },
      { role: 'ddd-modeler', type: 'system-architect', description: 'Generate DDD bounded contexts, aggregates, and domain events' },
      { role: 'reviewer', type: 'reviewer', description: 'Review ADRs and DDD model for consistency and completeness' },
    ],
  },
  5: {
    phase: 5,
    label: 'Build (Code Generation)',
    memoryNamespace: 'phase5-build',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate code generation and integration' },
      { role: 'coder', type: 'coder', description: 'Generate domain code from ADRs and DDD model' },
      { role: 'test-writer', type: 'tester', description: 'Generate test files from TDD plan' },
      { role: 'integration', type: 'backend-dev', description: 'Infer and inject integration dependencies' },
      { role: 'reviewer', type: 'reviewer', description: 'Review generated code for quality and completeness' },
    ],
  },
  6: {
    phase: 6,
    label: 'ERP Surface Push',
    memoryNamespace: 'phase6-deploy',
    agents: [
      { role: 'coordinator', type: 'planner', description: 'Coordinate deployment and ERP registration' },
      { role: 'deployer', type: 'backend-dev', description: 'Generate deployment configurations and scripts' },
    ],
  },
};

// ============================================================================
// Claude-Flow Availability Detection
// ============================================================================

let _claudeFlowAvailable: boolean | null = null;

/**
 * Check if claude-flow CLI is available. Caches the result.
 */
export function isClaudeFlowAvailable(): boolean {
  if (_claudeFlowAvailable !== null) return _claudeFlowAvailable;

  try {
    execSync('npx @claude-flow/cli@latest --version', {
      stdio: 'pipe',
      timeout: 15000,
    });
    _claudeFlowAvailable = true;
  } catch {
    _claudeFlowAvailable = false;
  }
  return _claudeFlowAvailable;
}

/** Reset the availability cache (for testing). */
export function resetAvailabilityCache(): void {
  _claudeFlowAvailable = null;
}

// ============================================================================
// Safe CLI Execution
// ============================================================================

function cfExec(command: string, timeoutMs = 30000): string | null {
  try {
    return execSync(`npx @claude-flow/cli@latest ${command}`, {
      stdio: 'pipe',
      timeout: timeoutMs,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Swarm Lifecycle
// ============================================================================

/**
 * Initialize the claude-flow swarm for the pipeline.
 * Returns true if swarm was initialized, false if claude-flow unavailable.
 */
export function initSwarm(config: SwarmConfig): boolean {
  if (!isClaudeFlowAvailable()) {
    console.error('  [SWARM] Claude-Flow not available — running pipeline in local mode');
    return false;
  }

  console.error('  [SWARM] Initializing Ruflo swarm orchestration...');

  // Initialize swarm with anti-drift config
  const initResult = cfExec(
    `swarm init --topology ${config.topology} --max-agents ${config.maxAgents} --strategy ${config.strategy}`,
  );

  if (!initResult) {
    console.error('  [SWARM] Swarm init failed — falling back to local mode');
    return false;
  }

  // Store pipeline metadata in memory
  cfExec(
    `memory store --namespace pipeline --key "trace-${config.traceId}" --value "Pipeline started at ${new Date().toISOString()}"`,
  );

  console.error(`  [SWARM] Swarm initialized: topology=${config.topology}, max-agents=${config.maxAgents}`);
  return true;
}

/**
 * Dispatch phase-specific agents and create tasks for a pipeline phase.
 */
export function dispatchPhaseAgents(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  _runDir: string,
): void {
  if (!isClaudeFlowAvailable()) return;

  console.error(`  [SWARM] Dispatching ${phaseConfig.agents.length} agents for Phase ${phaseConfig.phase}: ${phaseConfig.label}`);

  // Create a task for the phase
  cfExec(
    `task create --description "Phase ${phaseConfig.phase}: ${phaseConfig.label} — trace ${traceId}" --type implementation`,
    60000,
  );

  // Spawn specialized agents
  for (const agent of phaseConfig.agents) {
    cfExec(
      `agent spawn -t ${agent.type} --name "${agent.role}-p${phaseConfig.phase}" --task "${agent.description}"`,
      30000,
    );
  }

  // Pre-task hook for routing intelligence
  cfExec(
    `hooks pre-task --description "Phase ${phaseConfig.phase}: ${phaseConfig.label}" --coordinate-swarm true`,
  );

  // Search memory for relevant patterns from past executions
  const patterns = cfExec(
    `memory search --query "${phaseConfig.label}" --namespace patterns --limit 3`,
  );
  if (patterns && patterns.length > 10) {
    console.error(`  [SWARM] Found prior patterns for ${phaseConfig.label}`);
  }
}

/**
 * Store phase artifacts in swarm memory for cross-phase coordination.
 */
export function storePhaseArtifacts(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  runDir: string,
  artifacts: string[],
  timing: number,
): void {
  if (!isClaudeFlowAvailable()) return;

  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);

  // Store artifact list in memory
  const artifactSummary = artifacts.slice(0, 10).join(', ');
  cfExec(
    `memory store --namespace ${phaseConfig.memoryNamespace} --key "artifacts-${traceId}" --value "${artifactSummary.replace(/"/g, '\\"')}"`,
  );

  // Store timing metrics
  cfExec(
    `memory store --namespace metrics --key "phase${phaseConfig.phase}-timing-${traceId}" --value "${timing}ms"`,
  );

  // Post-task hook for learning
  cfExec(
    `hooks post-task --task-id "phase${phaseConfig.phase}-${traceId}" --success true --store-results true`,
  );

  // Read key artifact content and store summaries in memory for downstream phases
  const keyArtifacts: Record<number, string[]> = {
    2: ['research-dossier.json'],
    3: ['sparc-combined.json', 'tdd/tdd-plan.json'],
    4: ['adrs/adr-index.json', 'ddd/domain-model.json'],
    5: ['phase5-manifest.json'],
    6: ['phase6-manifest.json'],
  };

  const filesToStore = keyArtifacts[phaseConfig.phase] ?? [];
  for (const file of filesToStore) {
    const fullPath = path.join(phaseDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        // Store a truncated summary (memory has size limits)
        const summary = content.slice(0, 2000);
        cfExec(
          `memory store --namespace ${phaseConfig.memoryNamespace} --key "${path.basename(file)}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        );
      } catch {
        // Non-fatal
      }
    }
  }

  console.error(`  [SWARM] Phase ${phaseConfig.phase} artifacts stored in memory (${artifacts.length} files, ${timing}ms)`);
}

/**
 * Run a quality review agent on phase output.
 */
export function reviewPhaseOutput(
  phaseConfig: SwarmPhaseConfig,
  _traceId: string,
  runDir: string,
): void {
  if (!isClaudeFlowAvailable()) return;

  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);
  if (!fs.existsSync(phaseDir)) return;

  // Spawn a reviewer agent to validate phase output
  cfExec(
    `agent spawn -t reviewer --name "reviewer-p${phaseConfig.phase}" --task "Review Phase ${phaseConfig.phase} (${phaseConfig.label}) output at ${phaseDir} for quality and completeness"`,
    30000,
  );

  // Train neural patterns on successful phase completion
  cfExec(
    `hooks post-edit --file "${phaseDir}" --train-neural true`,
  );
}

/**
 * Record a phase failure in swarm memory.
 */
export function recordPhaseFailure(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  error: string,
): void {
  if (!isClaudeFlowAvailable()) return;

  cfExec(
    `memory store --namespace failures --key "phase${phaseConfig.phase}-${traceId}" --value "FAILED: ${error.slice(0, 200).replace(/"/g, '\\"')}"`,
  );

  cfExec(
    `hooks post-task --task-id "phase${phaseConfig.phase}-${traceId}" --success false`,
  );
}

/**
 * Shutdown the swarm and persist metrics.
 */
export function shutdownSwarm(traceId: string, success: boolean, totalTiming: number): void {
  if (!isClaudeFlowAvailable()) return;

  console.error('  [SWARM] Shutting down swarm and persisting metrics...');

  // Store pipeline completion in memory
  cfExec(
    `memory store --namespace pipeline --key "completed-${traceId}" --value "Pipeline ${success ? 'succeeded' : 'failed'} in ${totalTiming}ms at ${new Date().toISOString()}"`,
  );

  // Store successful pattern for future reference
  if (success) {
    cfExec(
      `memory store --namespace patterns --key "pipeline-success-${Date.now()}" --value "Full pipeline completed in ${totalTiming}ms for trace ${traceId}"`,
    );
  }

  // Export session metrics
  cfExec(
    `hooks session-end --generate-summary true --export-metrics true`,
  );

  // Shutdown the swarm
  cfExec('swarm shutdown', 15000);

  console.error('  [SWARM] Swarm shutdown complete');
}

/**
 * Get current swarm status.
 */
export function getSwarmStatus(): SwarmStatus {
  if (!isClaudeFlowAvailable()) {
    return { initialized: false, available: false, agentCount: 0, tasksCompleted: 0, memoryEntries: 0 };
  }

  const status = cfExec('swarm status');
  const agentList = cfExec('agent list');
  cfExec('memory stats');

  // Parse agent count from output (best-effort)
  const agentCount = agentList ? (agentList.match(/agent/gi) ?? []).length : 0;

  return {
    initialized: status !== null,
    available: true,
    agentCount,
    tasksCompleted: 0,
    memoryEntries: 0,
  };
}
