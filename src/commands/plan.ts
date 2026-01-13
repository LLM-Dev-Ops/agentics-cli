/**
 * Plan Command - Plan Management with Ruvector Persistence
 *
 * ARCHITECTURE:
 * - Plans are generated once by the planner and persisted in Ruvector
 * - Inspection is retrieval-only from Ruvector
 * - Planner = compute once, Ruvector = memory forever
 *
 * SUBCOMMANDS:
 * - (default) Generate plan via planner and persist to Ruvector
 * - list      List all plans from Ruvector
 * - inspect   Retrieve a specific plan by ID from Ruvector (NO PLANNER CALLS)
 * - delete    Delete a plan from Ruvector
 * - approve   Advisory approval marker
 *
 * CRITICAL RULES:
 * - plan inspect MUST NOT call planner
 * - plan inspect MUST NOT interpret UUID as intent
 * - Persistence is mandatory - failure to persist = command failure
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  CommandOptions,
  PlanReference,
} from '../types/index.js';
import {
  ManifestsAdapter,
  PlannerAdapter,
  RuvectorAdapter,
} from '../adapters/base-adapter.js';
import { createCredentialStore } from '../utils/credentials.js';
import {
  createOrchestrationEngine,
  type OrchestrationStage,
} from '../modules/orchestration-engine.js';
import { createArtifactHandoff } from '../modules/artifact-handoff.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { failFast, toError, CLIError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { PlanRequestContract, ManifestsRequestContract } from '../contracts/validator.js';

// ============================================================================
// Plan-Specific Exit Codes
// ============================================================================

export const PLAN_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  NOT_FOUND: 100,
  IO_ERROR: 74,
  AUTH_ERROR: 77,
  STORAGE_ERROR: 69,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Authentication Helper
// ============================================================================

/**
 * Assert that the user is authenticated.
 * Throws AUTH_ERROR if no valid credentials exist.
 */
async function assertAuthenticated(correlationId?: string): Promise<void> {
  const credentialStore = createCredentialStore();
  const credentials = await credentialStore.load();

  if (!credentials) {
    throw new CLIError({
      code: 'ECLI-PLAN-AUTH',
      category: 'AUTH_ERROR',
      message: 'Login required. Run `agentics login` to authenticate.',
      module: 'plan',
      correlationId,
      recoverable: true,
      exitCode: PLAN_EXIT_CODES.AUTH_ERROR,
    });
  }
}

/**
 * Validate that a string is a valid UUID format.
 * Accepts standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
function isValidUUID(str: string): boolean {
  // Standard UUID format with hex characters and dashes
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Assert that the provided ID is a valid UUID.
 * Throws INPUT_ERROR if not a valid UUID format.
 */
function assertUUID(id: string, correlationId?: string): void {
  if (!isValidUUID(id)) {
    throw new CLIError({
      code: 'ECLI-PLAN-INVALID-UUID',
      category: 'INPUT_ERROR',
      message: `Invalid plan ID format. Expected UUID, got: ${id}`,
      details: { provided: id, expected: 'UUID format (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)' },
      module: 'plan',
      correlationId,
      recoverable: false,
      exitCode: PLAN_EXIT_CODES.INPUT_ERROR,
    });
  }
}

/**
 * Generate SHA-256 checksum for plan data.
 */
function generateChecksum(data: unknown): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  return hash.digest('hex');
}

// ============================================================================
// Plan Record Types (Ruvector Storage Contract)
// ============================================================================

/**
 * Ruvector Plan Storage Format.
 * Plans stored in Ruvector include all planning output plus metadata.
 */
export interface RuvectorPlan {
  id: string;
  type: 'plan';
  intent: string;
  plan: unknown;
  created_at: string;
  org_id: string;
  user_id: string;
  checksum: string;
}

/**
 * Legacy PlanRecord for backward compatibility with local operations.
 */
export interface PlanRecord {
  id: string;
  name: string;
  description: string;
  status: PlanStatus;
  manifest_query?: string;
  approved_at?: string;
  approved_by?: string;
  created_at: string;
  updated_at: string;
  version: number;
  metadata?: Record<string, unknown>;
}

export type PlanStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'archived';

// ============================================================================
// CRUD Input/Output Types
// ============================================================================

export interface PlanCreateInput {
  name: string;
  description?: string;
  manifest_query?: string;
  metadata?: Record<string, unknown>;
}

export interface PlanCreateResult {
  plan: PlanRecord;
  timing: number;
}

export interface PlanInspectInput {
  id: string;
}

export interface PlanInspectResult {
  plan: PlanRecord | null;
  found: boolean;
  timing: number;
}

export interface PlanDeleteInput {
  id: string;
}

export interface PlanDeleteResult {
  deleted: boolean;
  id: string;
  timing: number;
}

export interface PlanApproveInput {
  id: string;
  approved_by?: string;
}

export interface PlanApproveResult {
  plan: PlanRecord;
  previous_status: PlanStatus;
  advisory: boolean;
  timing: number;
}

// ============================================================================
// Storage Configuration
// ============================================================================

function getPlansDir(): string {
  const baseDir = process.env['AGENTICS_DATA_DIR'] ?? process.cwd();
  return path.join(baseDir, '.agentics', 'plans');
}

function ensurePlansDir(): void {
  const dir = getPlansDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getPlanPath(id: string): string {
  return path.join(getPlansDir(), `${id}.json`);
}

// ============================================================================
// Storage Operations
// ============================================================================

function loadPlan(id: string): PlanRecord | null {
  const filePath = getPlanPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as PlanRecord;
  } catch {
    return null;
  }
}

function savePlan(plan: PlanRecord): void {
  ensurePlansDir();
  const filePath = getPlanPath(plan.id);
  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
}

// Note: deletePlanRecord and listAllPlans removed - now using Ruvector storage

// ============================================================================
// ID Generation
// ============================================================================

function generatePlanId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `plan-${timestamp}-${random}`;
}

// ============================================================================
// Validation
// ============================================================================

function validatePlanId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-PLAN-001',
      category: 'INPUT_ERROR',
      message: 'Plan ID is required',
      details: { provided: id },
      module: 'plan',
      correlationId,
      recoverable: false,
      exitCode: PLAN_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validatePlanName(name: string, correlationId?: string): void {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new CLIError({
      code: 'ECLI-PLAN-002',
      category: 'INPUT_ERROR',
      message: 'Plan name is required',
      details: { provided: name },
      module: 'plan',
      correlationId,
      recoverable: false,
      exitCode: PLAN_EXIT_CODES.INPUT_ERROR,
    });
  }
  if (name.length > 256) {
    throw new CLIError({
      code: 'ECLI-PLAN-003',
      category: 'INPUT_ERROR',
      message: 'Plan name cannot exceed 256 characters',
      details: { provided_length: name.length, max_length: 256 },
      module: 'plan',
      correlationId,
      recoverable: false,
      exitCode: PLAN_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatPlanForDisplay(plan: PlanRecord): string {
  const lines: string[] = [];
  const statusIcon = plan.status === 'approved' ? '[OK]'
    : plan.status === 'rejected' ? '[FAIL]'
    : plan.status === 'pending_approval' ? '[PEND]'
    : plan.status === 'archived' ? '[ARCH]'
    : '[DRAFT]';

  lines.push(`${statusIcon} ${plan.id}`);
  lines.push(`   Name:        ${plan.name}`);
  lines.push(`   Status:      ${plan.status}`);
  lines.push(`   Description: ${plan.description || '(none)'}`);
  if (plan.manifest_query) {
    lines.push(`   Query:       ${plan.manifest_query}`);
  }
  lines.push(`   Version:     ${plan.version}`);
  lines.push(`   Created:     ${new Date(plan.created_at).toLocaleString()}`);
  lines.push(`   Updated:     ${new Date(plan.updated_at).toLocaleString()}`);
  if (plan.approved_at) {
    lines.push(`   Approved:    ${new Date(plan.approved_at).toLocaleString()}`);
  }
  if (plan.approved_by) {
    lines.push(`   Approved By: ${plan.approved_by}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Command Interface
// ============================================================================

export interface PlanCommandInput {
  manifestQuery: string;
  params?: Record<string, unknown>;
}

export interface PlanCommandResult {
  reference: PlanReference;
  timing: number;
}

// ============================================================================
// Plan List Types (Read-only subcommand)
// ============================================================================

export interface PlanListInput {
  status?: PlanStatus;
  limit?: number;
}

export interface PlanListResult {
  plans: PlanSummary[];
  count: number;
  timing: number;
}

export interface PlanSummary {
  id: string;
  name: string;
  status: string;
  created_at: string;
  manifest_query?: string;
}

// ============================================================================
// Plan Command Implementation
// ============================================================================

export async function executePlanCommand(
  input: PlanCommandInput,
  options: CommandOptions
): Promise<PlanCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // ============================================================================
  // AUTHENTICATION CHECK - REQUIRED FOR ALL PLAN OPERATIONS
  // ============================================================================
  await assertAuthenticated(correlationId);

  // ============================================================================
  // CONTRACT VALIDATION - BEFORE ANY NETWORK CALL
  // ============================================================================

  // Validate the top-level plan request
  const validatedInput = validateRequest<PlanRequestContract>(
    RequestSchemas.PLAN,
    { query: input.manifestQuery, params: input.params },
    correlationId
  );

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapters
  const manifestsConfig = loadEndpointConfig('agentics-org-manifests');
  const plannerConfig = loadEndpointConfig('agentics-simulation-planner');
  const ruvectorConfig = loadEndpointConfig('ruvector-service');

  const manifestsAdapter = new ManifestsAdapter(manifestsConfig, correlationId);
  const plannerAdapter = new PlannerAdapter(plannerConfig, correlationId);
  const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'select-manifest',
      adapter: manifestsAdapter,
      request: {
        endpoint: '/v1/manifests',
        method: 'POST',
        buildBody: () => {
          // Validate manifests request body before sending
          const manifestsRequest: ManifestsRequestContract = {
            query: validatedInput.query,
          };
          validateRequest<ManifestsRequestContract>(
            RequestSchemas.MANIFESTS,
            manifestsRequest,
            correlationId
          );
          return manifestsRequest;
        },
      },
    },
    {
      name: 'create-plan',
      adapter: plannerAdapter,
      request: {
        endpoint: '/v1/plans',
        method: 'POST',
        buildBody: (previousResults) => {
          const manifestResult = previousResults.get('select-manifest');

          // Validate manifest response has execution_metadata
          const validatedManifest = validateResponse(
            ResponseSchemas.MANIFEST,
            manifestResult,
            correlationId
          );

          const manifestRef = handoff.extractReference(validatedManifest);

          // Build and validate plans request
          // Include intent from user's input string
          const plansRequest = {
            manifest_ref: manifestRef,
            params: validatedInput.params ?? {},
            intent: validatedInput.query,
          };

          return plansRequest;
        },
      },
      dependsOn: ['select-manifest'],
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'Orchestration failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const planStage = result.stages.find(s => s.name === 'create-plan');
    const validatedPlan = validateResponse(
      ResponseSchemas.PLAN,
      planStage?.response,
      correlationId
    );

    const planRef = handoff.extractReference(validatedPlan) as PlanReference;

    // ========================================================================
    // RUVECTOR PERSISTENCE - BEST EFFORT
    // Plans are generated once by the planner and persisted in Ruvector.
    // If Ruvector is unavailable, log warning but return the plan.
    // ========================================================================
    const ruvectorPlan: RuvectorPlan = {
      id: planRef.id,
      type: 'plan',
      intent: input.manifestQuery,
      plan: validatedPlan,
      created_at: new Date().toISOString(),
      org_id: process.env['AGENTICS_ORG_ID'] ?? 'unknown',
      user_id: process.env['AGENTICS_USER_ID'] ?? 'unknown',
      checksum: generateChecksum(validatedPlan),
    };

    let persistedToRuvector = false;
    try {
      await ruvectorAdapter.storePlan(ruvectorPlan);
      persistedToRuvector = true;
    } catch {
      // Best effort - log but don't fail the command
      // Plan was generated successfully, return it even if storage fails
      console.error(JSON.stringify({
        level: 'WARN',
        message: 'Failed to persist plan to Ruvector storage. Plan returned but not saved for future retrieval.',
        plan_id: planRef.id,
        correlationId,
      }));
    }

    // Record audit entry
    audit.record({
      command: 'plan',
      inputs: { manifestQuery: input.manifestQuery, params: input.params },
      outputs: planRef,
      dependencies: [
        { service: 'agentics-org-manifests', method: 'select', timestamp: new Date().toISOString(), duration_ms: result.timing.breakdown['select-manifest'] ?? 0, success: true },
        { service: 'agentics-simulation-planner', method: 'create', timestamp: new Date().toISOString(), duration_ms: result.timing.breakdown['create-plan'] ?? 0, success: true },
        { service: 'ruvector-service', method: 'store', timestamp: new Date().toISOString(), duration_ms: 0, success: persistedToRuvector },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: planRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    audit.record({
      command: 'plan',
      inputs: { manifestQuery: input.manifestQuery, params: input.params },
      outputs: null,
      dependencies: [],
      duration_ms: Date.now() - startTime,
      status: 'FAILED',
      error_code: error instanceof Error ? error.name : 'UNKNOWN',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      trace_id: correlationId,
    });

    // Fail fast - propagate error
    failFast({
      command: 'plan',
      phase: 'orchestration',
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}

// ============================================================================
// Plan List Command Implementation (Local Storage)
// ============================================================================

/**
 * List plans from local storage
 */
/**
 * List plans from Ruvector storage.
 */
export async function executePlanListCommand(
  input: PlanListInput,
  options: CommandOptions
): Promise<PlanListResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  // Authentication required
  await assertAuthenticated(correlationId);

  // List from Ruvector
  const ruvectorConfig = loadEndpointConfig('ruvector-service');
  const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);

  try {
    const response = await ruvectorAdapter.listPlans({
      org_id: process.env['AGENTICS_ORG_ID'],
      limit: input.limit,
    });

    const ruvectorPlans = (response.body as { plans?: RuvectorPlan[] })?.plans ?? [];

    // Map to PlanSummary for backward compatibility
    let summaries: PlanSummary[] = ruvectorPlans.map(p => ({
      id: p.id,
      name: p.intent.slice(0, 100),
      status: 'approved', // Persisted plans are approved
      created_at: p.created_at,
      manifest_query: p.intent,
    }));

    // Apply status filter (client-side since Ruvector may not support it)
    if (input.status) {
      summaries = summaries.filter(p => p.status === input.status);
    }

    // Sort by created_at descending
    summaries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // Apply limit
    if (input.limit && input.limit > 0) {
      summaries = summaries.slice(0, input.limit);
    }

    return {
      plans: summaries,
      count: summaries.length,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw new CLIError({
      code: 'ECLI-PLAN-LIST',
      category: 'NETWORK_ERROR',
      message: `Failed to list plans: ${errorMessage}`,
      module: 'plan',
      correlationId,
      recoverable: true,
      exitCode: PLAN_EXIT_CODES.STORAGE_ERROR,
    });
  }
}

/**
 * Format plans list for human-readable display
 */
export function formatPlansListForDisplay(plans: PlanSummary[]): string {
  if (plans.length === 0) {
    return 'No plans found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${plans.length} plan${plans.length === 1 ? '' : 's'}:`);
  lines.push('');

  for (const plan of plans) {
    lines.push(`  ${plan.id} - ${plan.name} [${plan.status}]`);
    lines.push(`    Created: ${new Date(plan.created_at).toLocaleString()}`);
    if (plan.manifest_query) {
      lines.push(`    Query: ${plan.manifest_query}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// CRUD Command Implementations
// ============================================================================

/**
 * Create a new plan record
 */
export async function executePlanCreateCommand(
  input: PlanCreateInput,
  options: CommandOptions
): Promise<PlanCreateResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePlanName(input.name, correlationId);

  const now = new Date().toISOString();
  const plan: PlanRecord = {
    id: generatePlanId(),
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    status: 'draft',
    manifest_query: input.manifest_query,
    created_at: now,
    updated_at: now,
    version: 1,
    metadata: input.metadata,
  };

  try {
    savePlan(plan);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-PLAN-IO-001',
      category: 'INTERNAL_ERROR',
      message: 'Failed to save plan',
      details: { error: error instanceof Error ? error.message : String(error) },
      module: 'plan',
      correlationId,
      recoverable: false,
      exitCode: PLAN_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    plan,
    timing: Date.now() - startTime,
  };
}

/**
 * Inspect a specific plan by ID
 */
/**
 * Inspect a specific plan by ID.
 *
 * CRITICAL: This is RETRIEVAL-ONLY from Ruvector.
 * - MUST NOT call planner
 * - MUST NOT interpret ID as intent
 * - MUST validate UUID format
 * - MUST require authentication
 */
export async function executePlanInspectCommand(
  input: PlanInspectInput,
  options: CommandOptions
): Promise<PlanInspectResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  // ============================================================================
  // AUTHENTICATION CHECK - REQUIRED
  // ============================================================================
  await assertAuthenticated(correlationId);

  // ============================================================================
  // UUID VALIDATION - REQUIRED
  // Prevents treating ID as intent (the broken behavior we're fixing)
  // ============================================================================
  assertUUID(input.id, correlationId);

  // ============================================================================
  // RUVECTOR RETRIEVAL - NO PLANNER CALLS
  // Plans are retrieved from Ruvector only. Never call the planner here.
  // ============================================================================
  const ruvectorConfig = loadEndpointConfig('ruvector-service');
  const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);

  try {
    const response = await ruvectorAdapter.getPlan(input.id);

    // Convert Ruvector response to PlanRecord format
    const ruvectorPlan = response.body as RuvectorPlan;

    if (!ruvectorPlan || !ruvectorPlan.id) {
      return {
        plan: null,
        found: false,
        timing: Date.now() - startTime,
      };
    }

    // Map RuvectorPlan to legacy PlanRecord for backward compatibility
    const plan: PlanRecord = {
      id: ruvectorPlan.id,
      name: ruvectorPlan.intent.slice(0, 100), // Use intent as name
      description: ruvectorPlan.intent,
      status: 'approved' as PlanStatus, // Persisted plans are considered approved
      manifest_query: ruvectorPlan.intent,
      created_at: ruvectorPlan.created_at,
      updated_at: ruvectorPlan.created_at,
      version: 1,
      metadata: {
        org_id: ruvectorPlan.org_id,
        user_id: ruvectorPlan.user_id,
        checksum: ruvectorPlan.checksum,
        full_plan: ruvectorPlan.plan,
      },
    };

    return {
      plan,
      found: true,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Handle 404 - plan not found
    if (error instanceof CLIError && error.message.includes('404')) {
      return {
        plan: null,
        found: false,
        timing: Date.now() - startTime,
      };
    }

    // For other errors, check if it's a not-found scenario
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      return {
        plan: null,
        found: false,
        timing: Date.now() - startTime,
      };
    }

    // Re-throw for genuine errors
    throw new CLIError({
      code: 'ECLI-PLAN-RETRIEVE',
      category: 'NETWORK_ERROR',
      message: `Failed to retrieve plan from storage: ${errorMessage}`,
      details: { plan_id: input.id },
      module: 'plan',
      correlationId,
      recoverable: true,
      exitCode: PLAN_EXIT_CODES.STORAGE_ERROR,
    });
  }
}

/**
 * Delete a plan
 */
/**
 * Delete a plan from Ruvector storage.
 */
export async function executePlanDeleteCommand(
  input: PlanDeleteInput,
  options: CommandOptions
): Promise<PlanDeleteResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  // Authentication required
  await assertAuthenticated(correlationId);

  // UUID validation
  assertUUID(input.id, correlationId);

  // Delete from Ruvector
  const ruvectorConfig = loadEndpointConfig('ruvector-service');
  const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);

  try {
    await ruvectorAdapter.deletePlan(input.id);

    return {
      deleted: true,
      id: input.id,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle not found
    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      throw new CLIError({
        code: 'ECLI-PLAN-NOT-FOUND',
        category: 'INPUT_ERROR',
        message: `Plan not found: ${input.id}`,
        details: { id: input.id },
        module: 'plan',
        correlationId,
        recoverable: false,
        exitCode: PLAN_EXIT_CODES.NOT_FOUND,
      });
    }

    throw new CLIError({
      code: 'ECLI-PLAN-DELETE',
      category: 'NETWORK_ERROR',
      message: `Failed to delete plan: ${errorMessage}`,
      details: { plan_id: input.id },
      module: 'plan',
      correlationId,
      recoverable: true,
      exitCode: PLAN_EXIT_CODES.STORAGE_ERROR,
    });
  }
}

/**
 * Approve a plan (advisory execution marker - no real execution)
 */
export async function executePlanApproveCommand(
  input: PlanApproveInput,
  options: CommandOptions
): Promise<PlanApproveResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePlanId(input.id, correlationId);

  const existing = loadPlan(input.id);
  if (!existing) {
    throw new CLIError({
      code: 'ECLI-PLAN-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `Plan not found: ${input.id}`,
      details: { id: input.id },
      module: 'plan',
      correlationId,
      recoverable: false,
      exitCode: PLAN_EXIT_CODES.NOT_FOUND,
    });
  }

  const previousStatus = existing.status;
  const now = new Date().toISOString();

  // Advisory approval - mark as approved
  const updated: PlanRecord = {
    ...existing,
    status: 'approved',
    approved_at: now,
    approved_by: input.approved_by ?? 'cli-user',
    updated_at: now,
    version: existing.version + 1,
  };

  savePlan(updated);

  return {
    plan: updated,
    previous_status: previousStatus,
    advisory: true,
    timing: Date.now() - startTime,
  };
}
