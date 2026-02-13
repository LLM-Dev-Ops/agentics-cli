/**
 * Simulate Command - CRUD Command for Simulation Management
 *
 * ARCHITECTURE:
 * - This module supports both orchestration commands AND local CRUD operations
 * - Local CRUD uses file-based persistence in .agentics/simulations/
 * - Has its own error handling and exit codes
 *
 * SUBCOMMANDS (Local CRUD):
 * - list      List all simulations
 * - inspect   Inspect a specific simulation by ID
 * - create    Create a new simulation record
 * - delete    Delete a simulation
 * - run       Execute simulation via agentics-simulation-runner
 *
 * ORCHESTRATION (External):
 * - Default command executes via agentics-simulation-runner
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CommandOptions,
  SimulationReference,
  PlanReference,
  FlexibleInput,
  NaturalLanguageInput,
  RuvectorAcceptanceResult,
  DownstreamSpanDescriptor,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { RunnerAdapter, SimulationEngineAdapter } from '../adapters/base-adapter.js';
import {
  blockUntilRuvectorAccepts,
  blockUntilLineageAccepted,
  buildRuvectorRootedGraph,
} from '../gates/ruvector-acceptance-gate.js';
import { isMetaSimulation, buildTier1Route } from '../gates/meta-simulation-detector.js';
import {
  createOrchestrationEngine,
  type OrchestrationStage,
} from '../modules/orchestration-engine.js';
import { createArtifactHandoff } from '../modules/artifact-handoff.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { failFast, toError, CLIError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import { resolveAttribution } from '../auth/identity-resolver.js';
import {
  createSimulationMemoryRecord,
  completeSimulationMemoryRecord,
  failSimulationMemoryRecord,
  createLineageRecord,
} from '../enterprise/lineage.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { SimulateRequestContract, ScenarioObject } from '../contracts/validator.js';
import { validateExecutionContext } from '../contracts/canonical.js';

// ============================================================================
// Simulate-Specific Exit Codes
// ============================================================================

export const SIMULATE_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  NOT_FOUND: 100,
  IO_ERROR: 74,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Simulation Record Types (Local CRUD)
// ============================================================================

export interface SimulationRecord {
  id: string;
  name: string;
  description: string;
  status: SimulationStatus;
  plan_id?: string;
  iterations: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  version: number;
  result?: SimulationResultData;
  metadata?: Record<string, unknown>;
}

export type SimulationStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SimulationResultData {
  success: boolean;
  duration_ms: number;
  summary?: string;
  metrics?: Record<string, unknown>;
}

// ============================================================================
// CRUD Input/Output Types
// ============================================================================

export interface SimulateCreateInput {
  name: string;
  description?: string;
  plan_id?: string;
  iterations?: number;
  metadata?: Record<string, unknown>;
}

export interface SimulateCreateResult {
  simulation: SimulationRecord;
  timing: number;
}

export interface SimulateInspectInput {
  id: string;
}

export interface SimulateInspectResult {
  simulation: SimulationRecord | null;
  found: boolean;
  timing: number;
}

export interface SimulateDeleteInput {
  id: string;
}

export interface SimulateDeleteResult {
  deleted: boolean;
  id: string;
  timing: number;
}

export interface SimulateRunInput {
  id: string;
}

export interface SimulateRunResult {
  simulation: SimulationRecord;
  previous_status: SimulationStatus;
  advisory: boolean;
  timing: number;
}

// ============================================================================
// Storage Configuration
// ============================================================================

function getSimulationsDir(): string {
  const baseDir = process.env['AGENTICS_DATA_DIR'] ?? process.cwd();
  return path.join(baseDir, '.agentics', 'simulations');
}

function ensureSimulationsDir(): void {
  const dir = getSimulationsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getSimulationPath(id: string): string {
  return path.join(getSimulationsDir(), `${id}.json`);
}

// ============================================================================
// Storage Operations
// ============================================================================

function loadSimulation(id: string): SimulationRecord | null {
  const filePath = getSimulationPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as SimulationRecord;
  } catch {
    return null;
  }
}

function saveSimulation(simulation: SimulationRecord): void {
  ensureSimulationsDir();
  const filePath = getSimulationPath(simulation.id);
  fs.writeFileSync(filePath, JSON.stringify(simulation, null, 2), 'utf-8');
}

function deleteSimulationRecord(id: string): boolean {
  const filePath = getSimulationPath(id);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

function listAllSimulations(): SimulationRecord[] {
  const dir = getSimulationsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const simulations: SimulationRecord[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      simulations.push(JSON.parse(content) as SimulationRecord);
    } catch {
      // Skip invalid files
    }
  }
  return simulations;
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * @deprecated Use ruvector-minted execution_id from requestRuvectorAcceptance() instead.
 * ADR-004: execution_id MUST be minted exclusively by ruvector-service.
 * Retained for backward compatibility only.
 */
export function generateSimulationId(): string {
  process.stderr.write('[WARN] generateSimulationId() called — should use ruvector-minted ID\n');
  return crypto.randomUUID();
}

// ============================================================================
// Ruvector-First Acceptance (ADR-004: ruvector authority)
// ============================================================================

/**
 * Request execution acceptance from ruvector-service BEFORE any local
 * persistence or downstream orchestration.
 *
 * ADR-004 Invariant: ruvector_span_id IS the execution_id.
 * No local UUID generation. No fallback. No best-effort.
 *
 * @returns RuvectorAcceptanceResult containing the ruvector-minted execution_id
 * @throws CLIError (ECLI-RUVECTOR-001) with exit code 141 if ruvector rejects
 */
async function requestRuvectorAcceptance(
  intent: string,
  correlationId: string,
): Promise<RuvectorAcceptanceResult> {
  const attribution = await resolveAttribution();
  const placeholderId = `pending-${crypto.randomUUID()}`;
  const memoryRecord = createSimulationMemoryRecord(
    placeholderId,
    intent,
    attribution,
  );
  return blockUntilRuvectorAccepts(placeholderId, memoryRecord, correlationId);
}

// ============================================================================
// Validation
// ============================================================================

function validateSimulationId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-SIMULATE-001',
      category: 'INPUT_ERROR',
      message: 'Simulation ID is required',
      details: { provided: id },
      module: 'simulate',
      correlationId,
      recoverable: false,
      exitCode: SIMULATE_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validateSimulationName(name: string, correlationId?: string): void {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new CLIError({
      code: 'ECLI-SIMULATE-002',
      category: 'INPUT_ERROR',
      message: 'Simulation name is required',
      details: { provided: name },
      module: 'simulate',
      correlationId,
      recoverable: false,
      exitCode: SIMULATE_EXIT_CODES.INPUT_ERROR,
    });
  }
  if (name.length > 256) {
    throw new CLIError({
      code: 'ECLI-SIMULATE-003',
      category: 'INPUT_ERROR',
      message: 'Simulation name cannot exceed 256 characters',
      details: { provided_length: name.length, max_length: 256 },
      module: 'simulate',
      correlationId,
      recoverable: false,
      exitCode: SIMULATE_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatSimulationForDisplay(simulation: SimulationRecord): string {
  const lines: string[] = [];
  const statusIcon = simulation.status === 'completed' ? '[OK]'
    : simulation.status === 'failed' ? '[FAIL]'
    : simulation.status === 'running' ? '[...]'
    : '[WAIT]';

  lines.push(`${statusIcon} ${simulation.id}`);
  lines.push(`   Name:        ${simulation.name}`);
  lines.push(`   Status:      ${simulation.status}`);
  lines.push(`   Description: ${simulation.description || '(none)'}`);
  if (simulation.plan_id) {
    lines.push(`   Plan ID:     ${simulation.plan_id}`);
  }
  lines.push(`   Iterations:  ${simulation.iterations}`);
  lines.push(`   Version:     ${simulation.version}`);
  lines.push(`   Created:     ${new Date(simulation.created_at).toLocaleString()}`);
  lines.push(`   Updated:     ${new Date(simulation.updated_at).toLocaleString()}`);
  if (simulation.completed_at) {
    lines.push(`   Completed:   ${new Date(simulation.completed_at).toLocaleString()}`);
  }
  if (simulation.result) {
    lines.push(`   Result:      ${simulation.result.success ? 'Success' : 'Failed'} (${simulation.result.duration_ms}ms)`);
  }

  return lines.join('\n');
}

// ============================================================================
// Scenario Builder - Converts natural language input to structured scenario
// ============================================================================

/**
 * Builds a valid ScenarioObject from natural language description.
 * Generates deterministic IDs and provides reasonable defaults for all required fields.
 */
function buildScenarioFromDescription(description: string): ScenarioObject {
  // Generate deterministic scenarioId from description + timestamp
  const timestamp = Date.now();
  const hash = description.split('').reduce((acc, char) => ((acc << 5) - acc) + char.charCodeAt(0), 0);
  const scenarioId = `scenario-${Math.abs(hash).toString(36)}-${timestamp.toString(36)}`;

  // Parse description to extract meaningful parts
  const normalizedDesc = description.trim().toLowerCase();

  // Determine category from description keywords
  let category = 'general';
  if (normalizedDesc.includes('erp') || normalizedDesc.includes('enterprise')) {
    category = 'enterprise';
  } else if (normalizedDesc.includes('api') || normalizedDesc.includes('endpoint')) {
    category = 'api';
  } else if (normalizedDesc.includes('load') || normalizedDesc.includes('performance')) {
    category = 'performance';
  } else if (normalizedDesc.includes('integration') || normalizedDesc.includes('connect')) {
    category = 'integration';
  } else if (normalizedDesc.includes('cost') || normalizedDesc.includes('optimization')) {
    category = 'optimization';
  }

  // Extract tags from description
  const potentialTags = ['cli', category];
  const tagKeywords = ['test', 'simulation', 'production', 'staging', 'development', 'enterprise', 'erp', 'api', 'load'];
  for (const keyword of tagKeywords) {
    if (normalizedDesc.includes(keyword) && !potentialTags.includes(keyword)) {
      potentialTags.push(keyword);
    }
  }

  // Build the scenario name from description (first 50 chars, title case)
  const scenarioName = description.length > 50
    ? description.slice(0, 47) + '...'
    : description;

  return {
    scenarioId,
    version: '1.0.0',
    name: scenarioName,
    description: description,
    category,
    tags: potentialTags,
    preconditions: [
      'System is in operational state',
      'Required services are available',
    ],
    setup: {
      environment: {
        mode: 'simulation',
        target: 'default',
      },
      fixtures: [],
    },
    steps: [
      {
        stepId: `${scenarioId}-step-1`,
        action: 'execute_simulation',
        params: {
          description: description,
          category: category,
        },
        expected: 'Simulation executes successfully',
      },
    ],
    teardown: {
      cleanup: ['Reset simulation state'],
    },
    expectations: {
      success_criteria: [
        'Simulation completes without errors',
        'Results are generated successfully',
      ],
      metrics: {
        target_success_rate: 0.95,
        max_duration_ms: 300000,
      },
    },
  };
}

// ============================================================================
// Command Interface
// ============================================================================

export interface SimulateCommandInput {
  planRef: FlexibleInput<PlanReference>;
  config?: Record<string, unknown>;
  iterations?: number;
}

export interface SimulateCommandResult {
  reference: SimulationReference;
  timing: number;
}

// ============================================================================
// Simulate List Types (Read-only subcommand)
// ============================================================================

export interface SimulateListInput {
  status?: 'running' | 'completed' | 'failed' | 'pending';
  limit?: number;
}

export interface SimulateListResult {
  simulations: SimulationSummary[];
  count: number;
  timing: number;
}

export interface SimulationSummary {
  id: string;
  plan_id: string;
  status: string;
  created_at: string;
  completed_at?: string;
  iterations?: number;
}

// ============================================================================
// Simulate Command Implementation
// ============================================================================

export async function executeSimulateCommand(
  input: SimulateCommandInput,
  options: CommandOptions
): Promise<SimulateCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // ========================================================================
  // ADR-004: Request ruvector acceptance FIRST.
  // No orchestration proceeds without ruvector authority.
  // If ruvector is unavailable, this throws ECLI-RUVECTOR-001 (exit 141).
  // ========================================================================
  const intent = isNaturalLanguage(input.planRef)
    ? (input.planRef as NaturalLanguageInput).description
    : (input.planRef as PlanReference).id;
  const acceptance = await requestRuvectorAcceptance(intent, correlationId);
  const executionId = acceptance.ruvector_span_id;
  const parentSpanId = acceptance.ruvector_span_id;

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter - use simulation engine for natural language, runner for structured refs
  const simulationConfig = loadEndpointConfig('agentics-simulation-engine');
  const runnerConfig = loadEndpointConfig('agentics-simulation-runner');

  // Choose adapter based on input type
  const useSimulationEngine = isNaturalLanguage(input.planRef);

  // Meta-simulation detection: Tier-1 routing for simulation-of-simulations
  if (useSimulationEngine) {
    const nlInput = input.planRef as NaturalLanguageInput;
    if (isMetaSimulation(nlInput.description)) {
      // Meta-simulations MUST route to Tier-1 simulator.
      // buildTier1Route throws ECLI-METASIM-001 if routing fails — no fallback.
      const tier1Route = buildTier1Route(nlInput.description, correlationId);
      process.stderr.write(
        `[simulate] meta-simulation detected: routing to Tier-1 simulator ` +
        `(confidence=${tier1Route.confidence.toFixed(2)}, signals=${tier1Route.detectedSignals.length})\n`
      );
    }
  }

  const adapter = useSimulationEngine
    ? new SimulationEngineAdapter(simulationConfig, correlationId)
    : new RunnerAdapter(runnerConfig, correlationId);

  // Select endpoint based on adapter type:
  // - SimulationEngine uses /v1/simulate for natural language scenarios
  // - Runner uses /v1/runner for structured plan references
  const endpoint = useSimulationEngine ? '/v1/simulate' : '/v1/runner';
  const downstreamService = useSimulationEngine
    ? 'agentics-simulation-engine'
    : 'agentics-simulation-runner';

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'execute-simulation',
      adapter: adapter,
      request: {
        endpoint,
        method: 'POST',
        buildBody: () => {
          let requestBody: SimulateRequestContract;

          // ============================================================================
          // STRICT EXECUTION CONTEXT — all fields REQUIRED, no implicit defaults
          // Fields: execution_id, parent_span_id, simulation_resolution, repo_name
          // ============================================================================
          const simulationResolution = (input.config?.['simulation_resolution'] as string | undefined)
            ?? process.env['AGENTICS_SIMULATION_RESOLUTION'];
          const repoName = (input.config?.['repo_name'] as string | undefined)
            ?? process.env['AGENTICS_REPO_NAME'];

          const executionContext: Record<string, unknown> = {
            execution_id: executionId,
            parent_span_id: parentSpanId,
            simulation_resolution: simulationResolution,
            repo_name: repoName,
          };

          // Validate execution context — throws if any required field is missing
          validateExecutionContext(executionContext, correlationId);

          if (isNaturalLanguage(input.planRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language scenario format
            // Build a full scenario object from the description
            // ============================================================================
            const nlInput = input.planRef as NaturalLanguageInput;
            const scenario = buildScenarioFromDescription(nlInput.description);
            requestBody = {
              scenario,
              config: input.config ?? {},
              iterations: input.iterations ?? 1,
              execution_context: executionContext,
            };
          } else {
            // ============================================================================
            // CONTRACT VALIDATION - Structured plan reference format
            // ============================================================================
            const planRef = input.planRef as PlanReference;
            requestBody = {
              plan_ref: {
                id: planRef.id,
                type: 'PlanReference',
                repository: planRef.repository,
                created_at: planRef.created_at,
                checksum: planRef.checksum,
              },
              config: input.config ?? {},
              iterations: input.iterations ?? 1,
              execution_context: executionContext,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<SimulateRequestContract>(
            RequestSchemas.SIMULATE,
            requestBody,
            correlationId
          );

          return requestBody;
        },
      },
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'Simulation failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const simStage = result.stages.find(s => s.name === 'execute-simulation');
    const validatedSimulation = validateResponse(
      ResponseSchemas.SIMULATION,
      simStage?.response,
      correlationId
    );

    const simRef = handoff.extractReference(validatedSimulation) as SimulationReference;

    // ============================================================================
    // ADR-004: Build ruvector-rooted execution graph
    // ============================================================================
    const downstreamSpans: DownstreamSpanDescriptor[] = [
      {
        service: downstreamService,
        operation: 'execute-simulation',
        status: 'completed',
        started_at: result.timing.started_at,
        completed_at: result.timing.completed_at,
        duration_ms: result.timing.total,
      },
    ];
    buildRuvectorRootedGraph(executionId, downstreamSpans);

    // Record audit entry
    const planRefId = isNaturalLanguage(input.planRef)
      ? `nl:${(input.planRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.planRef as PlanReference).id;
    audit.record({
      command: 'simulate',
      inputs: { planRef: planRefId, config: input.config, iterations: input.iterations, execution_id: executionId },
      outputs: simRef,
      dependencies: [
        { service: downstreamService, method: 'execute', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: simRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedPlanRefId = isNaturalLanguage(input.planRef)
      ? `nl:${(input.planRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.planRef as PlanReference).id;
    audit.record({
      command: 'simulate',
      inputs: { planRef: failedPlanRefId, config: input.config, execution_id: executionId },
      outputs: null,
      dependencies: [],
      duration_ms: Date.now() - startTime,
      status: 'FAILED',
      error_code: error instanceof Error ? error.name : 'UNKNOWN',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      trace_id: correlationId,
    });

    // Fail fast
    failFast({
      command: 'simulate',
      phase: 'execution',
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}

// ============================================================================
// Simulate List Command Implementation (Local Storage)
// ============================================================================

/**
 * List simulations from local storage
 */
export async function executeSimulateListCommand(
  input: SimulateListInput,
  _options: CommandOptions
): Promise<SimulateListResult> {
  const startTime = Date.now();

  let simulations = listAllSimulations();

  // Apply filters
  if (input.status) {
    simulations = simulations.filter(s => s.status === input.status);
  }

  // Sort by updated_at descending
  simulations.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  // Apply limit
  if (input.limit && input.limit > 0) {
    simulations = simulations.slice(0, input.limit);
  }

  // Map to SimulationSummary for backward compatibility
  const summaries: SimulationSummary[] = simulations.map(s => ({
    id: s.id,
    plan_id: s.plan_id ?? '',
    status: s.status,
    created_at: s.created_at,
    completed_at: s.completed_at,
    iterations: s.iterations,
  }));

  return {
    simulations: summaries,
    count: summaries.length,
    timing: Date.now() - startTime,
  };
}

/**
 * Format simulations list for human-readable display
 */
export function formatSimulationsListForDisplay(simulations: SimulationSummary[]): string {
  if (simulations.length === 0) {
    return 'No simulations found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${simulations.length} simulation${simulations.length === 1 ? '' : 's'}:`);
  lines.push('');

  for (const sim of simulations) {
    const statusIcon = sim.status === 'completed' ? '[OK]'
      : sim.status === 'failed' ? '[FAIL]'
      : sim.status === 'running' ? '[...]'
      : '[WAIT]';
    lines.push(`${statusIcon} ${sim.id}`);
    if (sim.plan_id) {
      lines.push(`    Plan: ${sim.plan_id}`);
    }
    lines.push(`    Status: ${sim.status}`);
    lines.push(`    Created: ${new Date(sim.created_at).toLocaleString()}`);
    if (sim.completed_at) {
      lines.push(`    Completed: ${new Date(sim.completed_at).toLocaleString()}`);
    }
    if (sim.iterations) {
      lines.push(`    Iterations: ${sim.iterations}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// CRUD Command Implementations
// ============================================================================

/**
 * Create a new simulation record
 */
export async function executeSimulateCreateCommand(
  input: SimulateCreateInput,
  options: CommandOptions
): Promise<SimulateCreateResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateSimulationName(input.name, correlationId);

  // ========================================================================
  // ADR-004: Request ruvector acceptance FIRST.
  // The ruvector_span_id IS the execution_id. No local UUID generation.
  // If ruvector is unavailable, this throws ECLI-RUVECTOR-001 (exit 141).
  // The simulation MUST NOT be created locally until ruvector accepts.
  // ========================================================================
  const acceptance = await requestRuvectorAcceptance(input.name, correlationId);
  const executionId = acceptance.ruvector_span_id;

  const now = new Date().toISOString();
  const simulation: SimulationRecord = {
    id: executionId,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    status: 'pending',
    plan_id: input.plan_id,
    iterations: input.iterations ?? 1,
    created_at: now,
    updated_at: now,
    version: 1,
    metadata: input.metadata,
  };

  try {
    saveSimulation(simulation);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-SIMULATE-IO-001',
      category: 'INTERNAL_ERROR',
      message: 'Failed to save simulation',
      details: { error: error instanceof Error ? error.message : String(error) },
      module: 'simulate',
      correlationId,
      recoverable: false,
      exitCode: SIMULATE_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    simulation,
    timing: Date.now() - startTime,
  };
}

/**
 * Inspect a specific simulation by ID
 */
export async function executeSimulateInspectCommand(
  input: SimulateInspectInput,
  options: CommandOptions
): Promise<SimulateInspectResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateSimulationId(input.id, correlationId);

  const simulation = loadSimulation(input.id);

  return {
    simulation,
    found: simulation !== null,
    timing: Date.now() - startTime,
  };
}

/**
 * Delete a simulation
 */
export async function executeSimulateDeleteCommand(
  input: SimulateDeleteInput,
  options: CommandOptions
): Promise<SimulateDeleteResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateSimulationId(input.id, correlationId);

  const deleted = deleteSimulationRecord(input.id);

  if (!deleted) {
    throw new CLIError({
      code: 'ECLI-SIMULATE-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `Simulation not found: ${input.id}`,
      details: { id: input.id },
      module: 'simulate',
      correlationId,
      recoverable: false,
      exitCode: SIMULATE_EXIT_CODES.NOT_FOUND,
    });
  }

  return {
    deleted: true,
    id: input.id,
    timing: Date.now() - startTime,
  };
}

/**
 * Run a simulation - executes the simulation via downstream services.
 * For authorized users (internal email or paid API key), this performs real execution.
 */
export async function executeSimulateRunCommand(
  input: SimulateRunInput,
  options: CommandOptions
): Promise<SimulateRunResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateSimulationId(input.id, correlationId);

  // ====================================================================
  // ADR-004: Request ruvector acceptance FIRST — before any local state mutation.
  // If ruvector is unavailable, the simulation MUST NOT start.
  // ====================================================================
  const acceptance = await requestRuvectorAcceptance(input.id, correlationId);
  const executionId = acceptance.ruvector_span_id;

  let existing = loadSimulation(input.id);
  if (!existing) {
    // No local record found. The user passed a name/description, not a stored ID.
    // Create a real simulation record, persist it, and proceed to execution.
    const createdNow = new Date().toISOString();
    const newId = executionId;
    existing = {
      id: newId,
      name: input.id,
      description: '',
      status: 'pending',
      iterations: 1,
      created_at: createdNow,
      updated_at: createdNow,
      version: 1,
    };
    saveSimulation(existing);
  }

  const previousStatus = existing.status;
  const now = new Date().toISOString();

  // Mark as running
  const running: SimulationRecord = {
    ...existing,
    status: 'running',
    updated_at: now,
    version: existing.version + 1,
  };
  saveSimulation(running);

  // Execute simulation via downstream service
  try {
    const simulationConfig = loadEndpointConfig('agentics-simulation-runner');
    const adapter = new RunnerAdapter(simulationConfig, correlationId);
    const engine = createOrchestrationEngine(correlationId);

    const stages: OrchestrationStage[] = [
      {
        name: 'run-simulation',
        adapter: adapter,
        request: {
          endpoint: '/v1/runner',
          method: 'POST',
          buildBody: () => {
            // STRICT EXECUTION CONTEXT — all fields REQUIRED
            const runSimResolution = (existing.metadata?.['simulation_resolution'] as string | undefined)
              ?? process.env['AGENTICS_SIMULATION_RESOLUTION'];
            const runRepoName = (existing.metadata?.['repo_name'] as string | undefined)
              ?? process.env['AGENTICS_REPO_NAME'];

            const runExecutionContext: Record<string, unknown> = {
              execution_id: executionId,
              parent_span_id: executionId,
              simulation_resolution: runSimResolution,
              repo_name: runRepoName,
            };

            validateExecutionContext(runExecutionContext, correlationId);

            return {
              simulation_id: existing.id,
              name: existing.name,
              description: existing.description,
              plan_id: existing.plan_id,
              iterations: existing.iterations,
              metadata: existing.metadata,
              execution_context: runExecutionContext,
            };
          },
        },
      },
    ];

    const result = await engine.execute(stages, options);

    const completedNow = new Date().toISOString();
    const updated: SimulationRecord = {
      ...running,
      status: result.success ? 'completed' : 'failed',
      completed_at: completedNow,
      updated_at: completedNow,
      version: running.version + 1,
      result: {
        success: result.success,
        duration_ms: Date.now() - startTime,
        summary: result.success ? 'Simulation executed successfully' : 'Simulation execution failed',
        metrics: {
          executed_at: completedNow,
          stages_completed: result.stages.filter(s => s.status === 'complete').length,
          total_stages: result.stages.length,
        },
      },
    };

    saveSimulation(updated);

    // ============================================================================
    // ADR-004: Build ruvector-rooted execution graph
    // ============================================================================
    const runnerStartedAt = new Date(startTime).toISOString();
    const downstreamSpans: DownstreamSpanDescriptor[] = [
      {
        service: 'agentics-simulation-runner',
        operation: 'run-simulation',
        status: result.success ? 'completed' : 'failed',
        started_at: runnerStartedAt,
        completed_at: completedNow,
        duration_ms: Date.now() - startTime,
      },
    ];
    buildRuvectorRootedGraph(executionId, downstreamSpans);

    // ====================================================================
    // ADR-004: Persist simulation completion + lineage to Ruvector
    // MANDATORY blocking — no fallback, no best-effort.
    // ====================================================================
    const attribution = await resolveAttribution();
    const memoryRecord = createSimulationMemoryRecord(
      updated.id,
      updated.name,
      attribution,
    );
    const completedRecord = completeSimulationMemoryRecord(
      memoryRecord,
      updated.result,
      [],
    );
    await blockUntilRuvectorAccepts(updated.id, completedRecord, correlationId);

    // Store lineage record for the simulation artifact itself
    const lineageRecord = createLineageRecord(
      updated.id,
      'simulation',
      updated.id,
      updated.name,
      attribution,
      updated.plan_id,
    );
    await blockUntilLineageAccepted(lineageRecord, correlationId);

    return {
      simulation: updated,
      previous_status: previousStatus,
      advisory: false,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // On failure, mark simulation as failed
    const failedNow = new Date().toISOString();
    const failed: SimulationRecord = {
      ...running,
      status: 'failed',
      completed_at: failedNow,
      updated_at: failedNow,
      version: running.version + 1,
      result: {
        success: false,
        duration_ms: Date.now() - startTime,
        summary: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
    saveSimulation(failed);

    // ADR-004: Persist failure to Ruvector — MANDATORY blocking.
    // Even failure records must be persisted. No fallback.
    const failAttribution = await resolveAttribution();
    const failMemoryRecord = createSimulationMemoryRecord(
      failed.id,
      failed.name,
      failAttribution,
    );
    const failedRecord = failSimulationMemoryRecord(
      failMemoryRecord,
      failed.result?.summary ?? 'Unknown failure',
    );
    await blockUntilRuvectorAccepts(failed.id, failedRecord, correlationId);

    return {
      simulation: failed,
      previous_status: previousStatus,
      advisory: false,
      timing: Date.now() - startTime,
    };
  }
}
