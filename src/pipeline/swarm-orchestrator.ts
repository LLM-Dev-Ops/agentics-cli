/**
 * Swarm Orchestrator — Ruflo + Agentics Platform Integration
 *
 * Coordinates Ruflo swarm agents with Agentics platform services:
 *   1. Ensures Ruflo (claude-flow) is installed as a first-class dependency
 *   2. Initializes hierarchical swarm with anti-drift config
 *   3. Dispatches swarm agents + agentics platform agents per phase
 *   4. Stores all results in swarm memory for cross-phase coordination
 *   5. Runs quality/security reviews using agentics agents after each phase
 *
 * Ruflo swarm coordinates. Agentics agents do real work.
 * Together they form a team that produces enterprise-grade artifacts.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { executeAgentsInvokeCommand } from '../commands/agents.js';
import type { AgentsInvokeResult } from '../commands/agents.js';
import type { CommandOptions } from '../types/index.js';

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

/** Agentics platform service invocation for a pipeline phase. */
export interface AgenticsServiceCall {
  readonly domain: string;
  readonly agent: string;
  readonly role: string; // human-readable role in the team
}

export interface SwarmPhaseConfig {
  readonly phase: number;
  readonly label: string;
  readonly agents: PhaseAgent[];
  readonly agenticsServices: AgenticsServiceCall[];
  readonly memoryNamespace: string;
}

export interface AgenticsServiceResult {
  readonly domain: string;
  readonly agent: string;
  readonly role: string;
  readonly status: number;
  readonly response: unknown;
  readonly timing: number;
}

export interface SwarmStatus {
  readonly initialized: boolean;
  readonly available: boolean;
  readonly agentCount: number;
  readonly agenticsServicesInvoked: number;
  readonly tasksCompleted: number;
  readonly memoryEntries: number;
}

// ============================================================================
// Phase Agent + Agentics Service Configurations
// ============================================================================

/**
 * Agent teams dispatched per pipeline phase.
 *
 * Each phase has:
 *   - `agents`: Ruflo swarm agents (coordination, spawned via claude-flow CLI)
 *   - `agenticsServices`: Agentics platform agents (real work, invoked via agentics CLI)
 *
 * The swarm agents coordinate; the agentics agents analyze, validate, and enrich.
 */
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
    agenticsServices: [
      { domain: 'copilot', agent: 'planner', role: 'Research planner' },
      { domain: 'copilot', agent: 'decomposer', role: 'Requirements decomposer' },
      { domain: 'research-lab', agent: 'hypothesis', role: 'Research hypotheses' },
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Knowledge graph builder' },
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
    agenticsServices: [
      { domain: 'copilot', agent: 'decomposer', role: 'Spec decomposer' },
      { domain: 'copilot', agent: 'meta-reasoner', role: 'Architecture reasoner' },
      { domain: 'test-bench', agent: 'quality', role: 'Spec quality evaluator' },
      { domain: 'schema-registry', agent: 'validate', role: 'Schema validator' },
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
    agenticsServices: [
      { domain: 'governance-dashboard', agent: 'audit', role: 'Architecture auditor' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Impact analyst' },
      { domain: 'copilot', agent: 'reflection', role: 'Decision reflector' },
      { domain: 'platform', agent: 'risk-score', role: 'Architecture risk scorer' },
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
    agenticsServices: [
      { domain: 'shield', agent: 'secrets', role: 'Secrets scanner' },
      { domain: 'shield', agent: 'pii', role: 'PII detector' },
      { domain: 'test-bench', agent: 'quality', role: 'Code quality evaluator' },
      { domain: 'config-manager', agent: 'validate', role: 'Config validator' },
      { domain: 'copilot', agent: 'reflection', role: 'Code review reflector' },
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
    agenticsServices: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'ERP surface mapper' },
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Auth configurator' },
      { domain: 'platform', agent: 'risk-score', role: 'Deployment risk scorer' },
    ],
  },
};

// ============================================================================
// Contextual Agent Triggers — Dynamic Agentics Agent Selection
// ============================================================================

/**
 * Keyword-to-agent mapping for dynamic dispatch. When scenario text or phase
 * artifacts contain these keywords, the corresponding agentics agents are added
 * to the phase dispatch alongside the fixed defaults.
 *
 * This ensures the full breadth of the platform is leveraged contextually.
 */
interface ContextualTrigger {
  readonly keywords: string[];
  readonly agents: AgenticsServiceCall[];
  /** Only dispatch for these phases (empty = all phases) */
  readonly phases?: number[];
}

const CONTEXTUAL_TRIGGERS: ContextualTrigger[] = [
  // ── ERP / SAP / Enterprise Systems ──
  {
    keywords: ['sap', 's4hana', 's/4hana', 'erp', 'abap', 'bapi', 'idoc', 'odata'],
    agents: [
      { domain: 'connector-hub', agent: 'erp-surface', role: 'ERP surface mapper' },
      { domain: 'connector-hub', agent: 'database-query', role: 'ERP data querier' },
    ],
  },
  // ── Security & Compliance ──
  {
    keywords: ['security', 'compliance', 'gdpr', 'hipaa', 'sox', 'pci', 'encryption', 'zero-trust'],
    agents: [
      { domain: 'shield', agent: 'prompt-injection', role: 'Injection scanner' },
      { domain: 'shield', agent: 'credential-exposure', role: 'Credential scanner' },
      { domain: 'governance-dashboard', agent: 'oversight', role: 'Governance oversight' },
      { domain: 'policy-engine', agent: 'enforce', role: 'Policy enforcer' },
      { domain: 'data-vault', agent: 'access-control', role: 'Access control validator' },
    ],
  },
  // ── Cost / FinOps ──
  {
    keywords: ['cost', 'budget', 'roi', 'spending', 'finops', 'billing', 'pricing'],
    agents: [
      { domain: 'costops', agent: 'attribution', role: 'Cost attribution analyst' },
      { domain: 'costops', agent: 'roi', role: 'ROI calculator' },
      { domain: 'costops', agent: 'tradeoff', role: 'Cost-quality tradeoff analyst' },
    ],
  },
  // ── Performance / Latency ──
  {
    keywords: ['performance', 'latency', 'p99', 'throughput', 'scalability', 'scale', 'high-volume'],
    agents: [
      { domain: 'latency-lens', agent: 'latency', role: 'Latency profiler' },
      { domain: 'auto-optimizer', agent: 'self-optimize', role: 'Self-optimizer' },
    ],
  },
  // ── Monitoring / Observability ──
  {
    keywords: ['monitoring', 'observability', 'telemetry', 'alerting', 'dashboard', 'metrics'],
    agents: [
      { domain: 'observatory', agent: 'telemetry', role: 'Telemetry designer' },
      { domain: 'observatory', agent: 'health-check', role: 'Health check architect' },
      { domain: 'observatory', agent: 'slo', role: 'SLO designer' },
      { domain: 'sentinel', agent: 'alert', role: 'Alert rule designer' },
    ],
  },
  // ── Auth / Identity ──
  {
    keywords: ['oauth', 'sso', 'authentication', 'authorization', 'identity', 'jwt', 'saml', 'oidc'],
    agents: [
      { domain: 'connector-hub', agent: 'auth-identity', role: 'Auth architect' },
      { domain: 'data-vault', agent: 'access-control', role: 'Access control designer' },
    ],
  },
  // ── Webhooks / Event-Driven / Integration ──
  {
    keywords: ['webhook', 'event-driven', 'pubsub', 'kafka', 'rabbitmq', 'message queue', 'integration'],
    agents: [
      { domain: 'connector-hub', agent: 'webhook-ingest', role: 'Webhook architect' },
      { domain: 'connector-hub', agent: 'event-normalize', role: 'Event normalizer' },
      { domain: 'orchestrator', agent: 'workflow', role: 'Workflow architect' },
    ],
  },
  // ── ML / AI Models ──
  {
    keywords: ['machine learning', 'ml model', 'inference', 'prediction', 'neural', 'llm', 'ai model'],
    agents: [
      { domain: 'inference-gateway', agent: 'route', role: 'Inference router' },
      { domain: 'auto-optimizer', agent: 'model-select', role: 'Model selector' },
    ],
  },
  // ── Workflow / Orchestration ──
  {
    keywords: ['workflow', 'pipeline', 'orchestration', 'scheduler', 'cron', 'batch'],
    agents: [
      { domain: 'orchestrator', agent: 'workflow', role: 'Workflow planner' },
      { domain: 'orchestrator', agent: 'dependencies', role: 'Dependency resolver' },
      { domain: 'orchestrator', agent: 'scheduler', role: 'Scheduler' },
    ],
  },
  // ── Incident / Reliability ──
  {
    keywords: ['incident', 'outage', 'sla', 'reliability', 'fault-tolerance', 'resilience', 'disaster recovery'],
    agents: [
      { domain: 'incident-manager', agent: 'escalation', role: 'Incident planner' },
      { domain: 'edge', agent: 'circuit-breaker', role: 'Circuit breaker designer' },
      { domain: 'edge', agent: 'failover', role: 'Failover architect' },
    ],
  },
  // ── Risk / Decision Making ──
  {
    keywords: ['risk', 'risk assessment', 'decision', 'go/no-go', 'impact analysis'],
    agents: [
      { domain: 'platform', agent: 'risk-score', role: 'Risk scorer' },
      { domain: 'platform', agent: 'decision-memo', role: 'Decision memo writer' },
      { domain: 'simulator', agent: 'what-if', role: 'What-if simulator' },
      { domain: 'governance-dashboard', agent: 'impact', role: 'Impact analyst' },
    ],
  },
  // ── Anomaly / Drift Detection ──
  {
    keywords: ['anomaly', 'drift', 'detection', 'outlier', 'fraud', 'leakage'],
    agents: [
      { domain: 'sentinel', agent: 'anomaly', role: 'Anomaly detector' },
      { domain: 'sentinel', agent: 'drift', role: 'Drift detector' },
      { domain: 'sentinel', agent: 'correlation', role: 'Event correlator' },
    ],
  },
  // ── Data Protection / Privacy ──
  {
    keywords: ['pii', 'anonymize', 'de-identify', 'data protection', 'privacy', 'redaction'],
    agents: [
      { domain: 'data-vault', agent: 'anonymize', role: 'Data anonymizer' },
      { domain: 'shield', agent: 'pii', role: 'PII scanner' },
      { domain: 'shield', agent: 'redaction', role: 'Redaction engine' },
    ],
  },
  // ── Testing / Quality (for Phase 5 code gen) ──
  {
    keywords: ['test', 'quality', 'benchmark', 'regression', 'validation'],
    agents: [
      { domain: 'test-bench', agent: 'benchmark', role: 'Benchmark runner' },
      { domain: 'test-bench', agent: 'regression', role: 'Regression tester' },
    ],
    phases: [5],
  },
  // ── Knowledge / Memory ──
  {
    keywords: ['knowledge graph', 'memory', 'context', 'retrieval', 'rag', 'embedding'],
    agents: [
      { domain: 'memory-graph', agent: 'knowledge-graph', role: 'Knowledge graph architect' },
      { domain: 'memory-graph', agent: 'retrieval', role: 'Retrieval optimizer' },
      { domain: 'memory-graph', agent: 'patterns', role: 'Pattern learner' },
    ],
  },
  // ── Executive / Reporting ──
  {
    keywords: ['executive', 'board', 'report', 'summary', 'stakeholder', 'leadership'],
    agents: [
      { domain: 'platform', agent: 'executive-summary', role: 'Executive summarizer' },
      { domain: 'analytics-hub', agent: 'recommendation', role: 'Recommendation writer' },
    ],
    phases: [6],
  },
];

/**
 * Scan scenario text + phase context for keywords and return additional
 * agentics agents to dispatch alongside the fixed defaults.
 *
 * Deduplicates against already-scheduled agents to avoid double-invocation.
 */
export function inferContextualAgents(
  scenarioQuery: string,
  phaseConfig: SwarmPhaseConfig,
  runDir: string,
): AgenticsServiceCall[] {
  // Build searchable text from scenario + prior-phase artifacts
  let searchText = scenarioQuery.toLowerCase();

  // Include key artifact text for richer context matching
  const contextFiles: Record<number, string[]> = {
    2: [],
    3: ['phase2/research-dossier.json'],
    4: ['phase3/sparc/sparc-combined.json'],
    5: ['phase4/ddd/domain-model.json'],
    6: ['phase5/phase5-manifest.json'],
  };

  for (const file of contextFiles[phaseConfig.phase] ?? []) {
    const fullPath = path.join(runDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        searchText += ' ' + content.slice(0, 3000).toLowerCase();
      } catch {
        // Non-fatal
      }
    }
  }

  // Build set of already-scheduled agent keys for dedup
  const scheduled = new Set(
    phaseConfig.agenticsServices.map(s => `${s.domain}/${s.agent}`),
  );

  const additional: AgenticsServiceCall[] = [];
  const addedKeys = new Set<string>();

  for (const trigger of CONTEXTUAL_TRIGGERS) {
    // Phase filter: skip triggers that don't apply to this phase
    if (trigger.phases && trigger.phases.length > 0 && !trigger.phases.includes(phaseConfig.phase)) {
      continue;
    }

    // Check if any keyword matches the scenario/context text
    const matched = trigger.keywords.some(kw => searchText.includes(kw));
    if (!matched) continue;

    // Add agents that aren't already scheduled
    for (const agent of trigger.agents) {
      const key = `${agent.domain}/${agent.agent}`;
      if (!scheduled.has(key) && !addedKeys.has(key)) {
        additional.push(agent);
        addedKeys.add(key);
      }
    }
  }

  return additional;
}

// ============================================================================
// Ruflo Coding Swarm — Real Code Enhancement
// ============================================================================

/**
 * Invoke the Ruflo coding swarm to enhance generated code.
 *
 * After the deterministic generators produce the project scaffold and base
 * implementations, ruflo fill uses the claude-flow swarm to fill remaining
 * stubs with real logic derived from ADRs, DDD model, and TDD plan.
 *
 * This is the "coding swarm" — a team of specialized agents coordinated
 * by Ruflo that actually build the high-fidelity MVP.
 */
export function invokeRufloCodingSwarm(
  traceId: string,
  runDir: string,
): { invoked: boolean; filesModified: number; timing: number } {
  const start = Date.now();

  // Find the ruflo binary (first-class dependency)
  let rufloBin: string | null = null;
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'ruflo');
  if (fs.existsSync(localBin)) {
    rufloBin = localBin;
  } else {
    // Walk up directory tree
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'ruflo');
      if (fs.existsSync(candidate)) {
        rufloBin = candidate;
        break;
      }
      dir = path.dirname(dir);
    }
  }

  if (!rufloBin) {
    console.error('  [RUFLO-SWARM] ruflo binary not found — coding swarm skipped');
    return { invoked: false, filesModified: 0, timing: Date.now() - start };
  }

  // Locate generated project and supporting artifacts
  const codegenProject = path.join(runDir, 'phase5', 'codegen', 'project');
  const deployProject = path.join(runDir, 'phase5', 'deploy', 'project');
  const projectDir = fs.existsSync(codegenProject) ? codegenProject : deployProject;

  if (!fs.existsSync(projectDir)) {
    console.error('  [RUFLO-SWARM] No generated project found — coding swarm skipped');
    return { invoked: false, filesModified: 0, timing: Date.now() - start };
  }

  // Locate ADRs, DDD model, TDD plan for ruflo fill context
  const adrIndex = findArtifactUp(runDir, 'adrs/adr-index.json');
  const dddModel = findArtifactUp(runDir, 'ddd/domain-model.json');
  const tddPlan = findArtifactUp(runDir, 'tdd/tdd-plan.json');

  // Detect language from project files
  const language = fs.existsSync(path.join(projectDir, 'Cargo.toml')) ? 'rust' : 'typescript';

  // Build ruflo fill command
  const args = ['fill', '--language', language, '--target', projectDir];
  if (adrIndex) args.push('--adr-index', adrIndex);
  if (dddModel) args.push('--ddd-model', dddModel);
  if (tddPlan) args.push('--tdd-plan', tddPlan);

  console.error(`  [RUFLO-SWARM] Invoking coding swarm on ${projectDir}`);
  console.error(`  [RUFLO-SWARM] Language: ${language}, ADRs: ${adrIndex ? 'yes' : 'no'}, DDD: ${dddModel ? 'yes' : 'no'}, TDD: ${tddPlan ? 'yes' : 'no'}`);

  // Spawn the swarm coding task via claude-flow
  if (isClaudeFlowAvailable()) {
    cfExec(
      `agent spawn -t coder --name "ruflo-coder-${traceId.slice(0, 8)}" --task "Fill implementation stubs in ${projectDir} using ruflo coding swarm"`,
      30000,
    );
    cfExec(
      `task create --description "Ruflo coding swarm: fill stubs in generated ${language} project — trace ${traceId}" --type implementation`,
      30000,
    );
  }

  // Execute ruflo fill
  try {
    const result = execSync(`${rufloBin} ${args.join(' ')}`, {
      cwd: projectDir,
      timeout: 300_000,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const filesMatch = result.match(/(\d+)\s+files?\s+modified/i);
    const filesModified = filesMatch?.[1] ? parseInt(filesMatch[1], 10) : 0;
    const timing = Date.now() - start;

    console.error(`  [RUFLO-SWARM] Coding swarm completed: ${filesModified} files enhanced in ${timing}ms`);

    // Store result in swarm memory
    if (isClaudeFlowAvailable()) {
      cfExec(
        `memory store --namespace phase5-build --key "ruflo-fill-${traceId}" --value "Ruflo coding swarm filled ${filesModified} files in ${timing}ms"`,
      );
      cfExec(
        `hooks post-task --task-id "ruflo-fill-${traceId}" --success true --store-results true`,
      );
    }

    return { invoked: true, filesModified, timing };
  } catch (err) {
    const timing = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [RUFLO-SWARM] Coding swarm failed: ${msg.slice(0, 200)}`);

    if (isClaudeFlowAvailable()) {
      cfExec(
        `memory store --namespace failures --key "ruflo-fill-${traceId}" --value "FAILED: ${msg.slice(0, 200).replace(/"/g, '\\"')}"`,
      );
    }

    return { invoked: false, filesModified: 0, timing };
  }
}

/** Search phase directories for an artifact file. */
function findArtifactUp(runDir: string, relativePath: string): string | null {
  // Check in phase4, phase3, phase2 directories
  for (const phase of ['phase4', 'phase3', 'phase2']) {
    const candidate = path.join(runDir, phase, relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Check in merged directory
  const merged = path.join(runDir, 'phase5', '.phase2-merged', relativePath);
  if (fs.existsSync(merged)) return merged;
  return null;
}

// ============================================================================
// Ruflo Binary Resolution & Installation
// ============================================================================

let _cfBinary: string | null = null;

/**
 * Resolve the claude-flow binary from the local node_modules.
 * claude-flow is a first-class dependency in package.json — no npx needed.
 */
function resolveClaudeFlowBinary(): string {
  if (_cfBinary) return _cfBinary;

  // Priority 1: Local node_modules binary (package.json dependency)
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'claude-flow');
  if (fs.existsSync(localBin)) {
    _cfBinary = localBin;
    return _cfBinary;
  }

  // Priority 2: Walk up from this file's directory to find node_modules
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'claude-flow');
    if (fs.existsSync(candidate)) {
      _cfBinary = candidate;
      return _cfBinary;
    }
    dir = path.dirname(dir);
  }

  // Priority 3: Global fallback — try which
  try {
    const global = execSync('which claude-flow', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (global) {
      _cfBinary = global;
      return _cfBinary;
    }
  } catch {
    // Not found globally
  }

  // Priority 4: npx fallback (last resort — slower but works)
  _cfBinary = 'npx claude-flow';
  return _cfBinary;
}

/**
 * Ensure Ruflo (claude-flow) is installed and functional.
 *
 * claude-flow is a declared dependency in package.json. If the binary is
 * missing (e.g. node_modules was cleared), we re-install it automatically.
 * This guarantees the swarm orchestrator always has its runtime available.
 *
 * Returns the path to the binary, or null if installation failed.
 */
export function ensureRufloInstalled(): string | null {
  const binary = resolveClaudeFlowBinary();

  // Verify the binary actually works
  try {
    execSync(`${binary} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    return binary;
  } catch {
    // Binary found but broken, or npx fallback — try installing
  }

  console.error('  [RUFLO] claude-flow not found — installing from package.json dependency...');
  try {
    execSync('npm install claude-flow --no-save', {
      stdio: 'pipe',
      timeout: 60000,
      cwd: process.cwd(),
    });
    // Reset cache and re-resolve
    _cfBinary = null;
    const newBinary = resolveClaudeFlowBinary();

    execSync(`${newBinary} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    console.error('  [RUFLO] claude-flow installed successfully');
    return newBinary;
  } catch {
    console.error('  [RUFLO] claude-flow installation failed — swarm features degraded');
    return null;
  }
}

// ============================================================================
// Ruflo CLI Availability
// ============================================================================

let _rufloAvailable: boolean | null = null;
let _rufloVerified = false;

/**
 * Check if Ruflo is available. On first call, ensures installation.
 */
export function isClaudeFlowAvailable(): boolean {
  if (_rufloAvailable !== null) return _rufloAvailable;

  if (!_rufloVerified) {
    _rufloVerified = true;
    const binary = ensureRufloInstalled();
    _rufloAvailable = binary !== null;
  }

  return _rufloAvailable ?? false;
}

/** Reset the availability cache (for testing). */
export function resetAvailabilityCache(): void {
  _rufloAvailable = null;
  _rufloVerified = false;
  _cfBinary = null;
}

// ============================================================================
// Safe Ruflo CLI Execution
// ============================================================================

function cfExec(command: string, timeoutMs = 30000): string | null {
  const binary = resolveClaudeFlowBinary();
  try {
    return execSync(`${binary} ${command}`, {
      stdio: 'pipe',
      timeout: timeoutMs,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Agentics Platform Agent Invocation
// ============================================================================

/**
 * Invoke an Agentics platform agent and return its result.
 * Never throws — failures are captured and returned as null.
 */
async function invokeAgenticsService(
  svc: AgenticsServiceCall,
  prompt: string,
  traceId: string,
): Promise<AgenticsServiceResult | null> {
  const start = Date.now();
  const options: CommandOptions = { trace_id: traceId };

  try {
    const result: AgentsInvokeResult = await executeAgentsInvokeCommand(
      svc.domain,
      svc.agent,
      { text: prompt },
      options,
    );

    return {
      domain: svc.domain,
      agent: svc.agent,
      role: svc.role,
      status: result.status,
      response: result.response,
      timing: Date.now() - start,
    };
  } catch {
    // Non-fatal — agent invocation failures never block the pipeline
    return null;
  }
}

/**
 * Dispatch all agentics platform agents for a phase in parallel.
 * Returns results from all agents (some may be null on failure).
 */
async function dispatchAgenticsServices(
  services: AgenticsServiceCall[],
  prompt: string,
  traceId: string,
): Promise<AgenticsServiceResult[]> {
  if (services.length === 0) return [];

  const promises = services.map(svc => invokeAgenticsService(svc, prompt, traceId));
  const results = await Promise.allSettled(promises);

  const collected: AgenticsServiceResult[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) {
      collected.push(r.value);
    }
  }
  return collected;
}

/**
 * Build the prompt text for agentics agents based on phase context.
 */
function buildPhasePrompt(
  phaseConfig: SwarmPhaseConfig,
  scenarioQuery: string,
  runDir: string,
): string {
  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);
  let context = `Pipeline Phase ${phaseConfig.phase}: ${phaseConfig.label}\n`;
  context += `Scenario: ${scenarioQuery.slice(0, 500)}\n`;

  // Include key prior-phase artifact summaries for context
  const contextFiles: Record<number, string[]> = {
    2: [],
    3: ['phase2/research-dossier.json'],
    4: ['phase3/sparc/sparc-combined.json'],
    5: ['phase4/ddd/domain-model.json', 'phase4/adrs/adr-index.json'],
    6: ['phase5/phase5-manifest.json'],
  };

  const files = contextFiles[phaseConfig.phase] ?? [];
  for (const file of files) {
    const fullPath = path.join(runDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        context += `\n--- ${file} (excerpt) ---\n${content.slice(0, 1500)}\n`;
      } catch {
        // Non-fatal
      }
    }
  }

  // Include current phase artifacts if they exist (for review agents)
  if (fs.existsSync(phaseDir)) {
    try {
      const entries = fs.readdirSync(phaseDir).slice(0, 10);
      context += `\nPhase ${phaseConfig.phase} artifacts: ${entries.join(', ')}\n`;
    } catch {
      // Non-fatal
    }
  }

  return context;
}

// ============================================================================
// Swarm Lifecycle
// ============================================================================

/**
 * Initialize the Ruflo swarm for the pipeline.
 *
 * Ensures claude-flow is installed (first-class dependency), then initializes
 * the hierarchical swarm with anti-drift configuration.
 *
 * Returns true if swarm was initialized, false on failure.
 */
export function initSwarm(config: SwarmConfig): boolean {
  if (!isClaudeFlowAvailable()) {
    console.error('  [RUFLO] Swarm unavailable — running pipeline in local-only mode');
    return false;
  }

  console.error('  [RUFLO] Initializing swarm orchestration...');

  // Initialize swarm with anti-drift config
  const initResult = cfExec(
    `swarm init --topology ${config.topology} --max-agents ${config.maxAgents} --strategy ${config.strategy}`,
  );

  if (!initResult) {
    console.error('  [RUFLO] Swarm init failed — falling back to local mode');
    return false;
  }

  // Store pipeline metadata in swarm memory
  cfExec(
    `memory store --namespace pipeline --key "trace-${config.traceId}" --value "Pipeline started at ${new Date().toISOString()}"`,
  );

  // Start session for cross-phase learning
  cfExec(
    `hooks session-start --session-id "pipeline-${config.traceId}" --auto-configure true`,
  );

  console.error(`  [RUFLO] Swarm initialized: topology=${config.topology}, max-agents=${config.maxAgents}`);
  console.error(`  [RUFLO] Agentics platform agents will be dispatched per phase`);
  return true;
}

/**
 * Dispatch swarm agents + agentics platform agents for a pipeline phase.
 *
 * The Ruflo swarm coordinates agent teams while agentics platform services
 * (deployed in GCloud, cached locally) do real analysis, validation, and
 * enrichment work. Together they form a team.
 */
export async function dispatchPhaseAgents(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  runDir: string,
  scenarioQuery = '',
): Promise<AgenticsServiceResult[]> {
  const agenticsResults: AgenticsServiceResult[] = [];

  // ── 1. Ruflo swarm coordination ──
  if (isClaudeFlowAvailable()) {
    console.error(`  [RUFLO] Dispatching ${phaseConfig.agents.length} swarm agents for Phase ${phaseConfig.phase}: ${phaseConfig.label}`);

    // Create a task for the phase
    cfExec(
      `task create --description "Phase ${phaseConfig.phase}: ${phaseConfig.label} — trace ${traceId}" --type implementation`,
      60000,
    );

    // Spawn specialized swarm agents
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
      console.error(`  [RUFLO] Found prior patterns for ${phaseConfig.label}`);
    }
  }

  // ── 2. Infer contextual agents from scenario + artifacts ──
  const contextualAgents = inferContextualAgents(scenarioQuery, phaseConfig, runDir);
  if (contextualAgents.length > 0) {
    const ctxNames = contextualAgents.map(s => `${s.domain}/${s.agent}`);
    console.error(`  [AGENTICS] +${contextualAgents.length} contextual agents triggered: ${ctxNames.join(', ')}`);
  }

  // ── 3. Agentics platform agent dispatch (fixed defaults + contextual) ──
  const allServices = [...phaseConfig.agenticsServices, ...contextualAgents];
  if (allServices.length > 0) {
    const serviceNames = allServices.map(s => `${s.domain}/${s.agent}`);
    console.error(`  [AGENTICS] Dispatching ${allServices.length} platform agents: ${serviceNames.join(', ')}`);

    const prompt = buildPhasePrompt(phaseConfig, scenarioQuery, runDir);
    const results = await dispatchAgenticsServices(allServices, prompt, traceId);

    for (const r of results) {
      agenticsResults.push(r);
      const icon = r.status === 200 ? '[OK]' : '[!!]';
      console.error(`  [AGENTICS] ${icon} ${r.domain}/${r.agent} (${r.role}) — ${r.timing}ms`);

      // Store successful results in swarm memory for cross-phase access
      if (isClaudeFlowAvailable() && r.status === 200) {
        const summary = typeof r.response === 'string'
          ? r.response.slice(0, 500)
          : JSON.stringify(r.response).slice(0, 500);
        cfExec(
          `memory store --namespace ${phaseConfig.memoryNamespace} --key "${r.domain}-${r.agent}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        );
      }
    }

    if (results.length > 0) {
      console.error(`  [AGENTICS] ${results.length}/${allServices.length} agents responded for Phase ${phaseConfig.phase}`);
    }
  }

  return agenticsResults;
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
        const summary = content.slice(0, 2000);
        cfExec(
          `memory store --namespace ${phaseConfig.memoryNamespace} --key "${path.basename(file)}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        );
      } catch {
        // Non-fatal
      }
    }
  }

  console.error(`  [RUFLO] Phase ${phaseConfig.phase} artifacts stored in swarm memory (${artifacts.length} files, ${timing}ms)`);
}

/**
 * Run quality review on phase output using both swarm agents and agentics services.
 *
 * Post-phase review dispatches:
 *   - Ruflo reviewer agent (swarm coordination)
 *   - Agentics quality/security agents (real validation)
 */
export async function reviewPhaseOutput(
  phaseConfig: SwarmPhaseConfig,
  traceId: string,
  runDir: string,
): Promise<AgenticsServiceResult[]> {
  const phaseDir = path.join(runDir, `phase${phaseConfig.phase}`);
  if (!fs.existsSync(phaseDir)) return [];

  // ── 1. Ruflo swarm reviewer ──
  if (isClaudeFlowAvailable()) {
    cfExec(
      `agent spawn -t reviewer --name "reviewer-p${phaseConfig.phase}" --task "Review Phase ${phaseConfig.phase} (${phaseConfig.label}) output at ${phaseDir} for quality and completeness"`,
      30000,
    );

    // Train neural patterns on successful phase completion
    cfExec(
      `hooks post-edit --file "${phaseDir}" --train-neural true`,
    );
  }

  // ── 2. Agentics quality/security review agents ──
  const reviewServices: AgenticsServiceCall[] = [
    { domain: 'test-bench', agent: 'quality', role: 'Quality reviewer' },
  ];

  // Phase 5 (code generation): add security scanning
  if (phaseConfig.phase === 5) {
    reviewServices.push(
      { domain: 'shield', agent: 'secrets', role: 'Post-build secrets scan' },
      { domain: 'shield', agent: 'pii', role: 'Post-build PII scan' },
    );
  }

  // Phase 4 (ADRs): add governance audit
  if (phaseConfig.phase === 4) {
    reviewServices.push(
      { domain: 'governance-dashboard', agent: 'audit', role: 'ADR audit review' },
    );
  }

  // Phase 6 (deploy): add deployment risk scoring
  if (phaseConfig.phase === 6) {
    reviewServices.push(
      { domain: 'platform', agent: 'risk-score', role: 'Deployment risk review' },
    );
  }

  // Build review prompt with phase artifact content
  let reviewPrompt = `Review Phase ${phaseConfig.phase} (${phaseConfig.label}) output for quality, completeness, and security.\n`;
  try {
    const entries = fs.readdirSync(phaseDir).slice(0, 10);
    reviewPrompt += `Artifacts: ${entries.join(', ')}\n`;

    // Include a sample of the first few artifact files for context
    for (const entry of entries.slice(0, 3)) {
      const filePath = path.join(phaseDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size < 5000) {
          const content = fs.readFileSync(filePath, 'utf-8');
          reviewPrompt += `\n--- ${entry} ---\n${content.slice(0, 1500)}\n`;
        }
      } catch {
        // Non-fatal
      }
    }
  } catch {
    // Non-fatal
  }

  const results = await dispatchAgenticsServices(reviewServices, reviewPrompt, traceId);

  for (const r of results) {
    const icon = r.status === 200 ? '[OK]' : '[!!]';
    console.error(`  [REVIEW] ${icon} ${r.domain}/${r.agent} (${r.role}) — ${r.timing}ms`);

    // Store review results in swarm memory
    if (isClaudeFlowAvailable() && r.status === 200) {
      const summary = typeof r.response === 'string'
        ? r.response.slice(0, 500)
        : JSON.stringify(r.response).slice(0, 500);
      cfExec(
        `memory store --namespace reviews --key "p${phaseConfig.phase}-${r.domain}-${r.agent}-${traceId}" --value "${summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      );
    }
  }

  return results;
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

  console.error('  [RUFLO] Shutting down swarm and persisting metrics...');

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

  console.error('  [RUFLO] Swarm shutdown complete');
}

/**
 * Get current swarm status including agentics service stats.
 */
export function getSwarmStatus(): SwarmStatus {
  if (!isClaudeFlowAvailable()) {
    return { initialized: false, available: false, agentCount: 0, agenticsServicesInvoked: 0, tasksCompleted: 0, memoryEntries: 0 };
  }

  const status = cfExec('swarm status');
  const agentList = cfExec('agent list');
  cfExec('memory stats');

  const agentCount = agentList ? (agentList.match(/agent/gi) ?? []).length : 0;

  return {
    initialized: status !== null,
    available: true,
    agentCount,
    agenticsServicesInvoked: 0,
    tasksCompleted: 0,
    memoryEntries: 0,
  };
}
