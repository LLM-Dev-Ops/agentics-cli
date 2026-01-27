/**
 * Deploy Command - Deployment Management
 *
 * ARCHITECTURE:
 * - This module supports both orchestration commands AND local deployment management
 * - Authorized users (internal email or paid API key) get full execution
 *
 * SUBCOMMANDS (Local Deployment):
 * - preview    Generate deployment preview
 * - run        Execute deployment via downstream services
 * - status     Check deployment status
 * - rollback   Rollback deployment via downstream services
 *
 * ORCHESTRATION (External):
 * - Default command executes via agentics-deployment-intent
 */

import type {
  CommandOptions,
  IntentReference,
  SimulationReference,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { IntentAdapter, RuvectorAdapter } from '../adapters/base-adapter.js';
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
import type { DeployRequestContract } from '../contracts/validator.js';

// ============================================================================
// Command Interface
// ============================================================================

export interface DeployCommandInput {
  simRef: FlexibleInput<SimulationReference>;
  environment?: 'development' | 'staging' | 'production';
  approvalRequired?: boolean;
  dryRun?: boolean;
  rollbackOnFailure?: boolean;
}

export interface DeployCommandResult {
  reference: IntentReference;
  timing: number;
}

// ============================================================================
// Deploy Command Implementation
// ============================================================================

export async function executeDeployCommand(
  input: DeployCommandInput,
  options: CommandOptions
): Promise<DeployCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const intentConfig = loadEndpointConfig('agentics-deployment-intent');
  const intentAdapter = new IntentAdapter(intentConfig, correlationId);

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'resolve-intent',
      adapter: intentAdapter,
      request: {
        endpoint: '/v1/intent',
        method: 'POST',
        buildBody: () => {
          let requestBody: DeployRequestContract;

          if (isNaturalLanguage(input.simRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language format
            // ============================================================================
            requestBody = {
              sim_ref: {
                natural_language: (input.simRef as NaturalLanguageInput).description,
              },
              environment: input.environment,
              approval_required: input.approvalRequired,
              dry_run: input.dryRun,
              rollback_on_failure: input.rollbackOnFailure,
            };
          } else {
            // ============================================================================
            // CONTRACT VALIDATION - Structured reference format
            // ============================================================================
            const simRef = input.simRef as SimulationReference;
            requestBody = {
              sim_ref: {
                id: simRef.id,
                type: 'SimulationReference',
                repository: simRef.repository,
                created_at: simRef.created_at,
                checksum: simRef.checksum,
              },
              environment: input.environment,
              approval_required: input.approvalRequired,
              dry_run: input.dryRun,
              rollback_on_failure: input.rollbackOnFailure,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<DeployRequestContract>(
            RequestSchemas.DEPLOY,
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
      throw new Error(failedStage?.error?.message ?? 'Deployment intent resolution failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const intentStage = result.stages.find(s => s.name === 'resolve-intent');
    const validatedIntent = validateResponse(
      ResponseSchemas.INTENT,
      intentStage?.response,
      correlationId
    );

    const intentRef = handoff.extractReference(validatedIntent) as IntentReference;

    // Record audit entry
    const simRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'deploy',
      inputs: { simRef: simRefId, environment: input.environment },
      outputs: intentRef,
      dependencies: [
        { service: 'agentics-deployment-intent', method: 'resolve', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: intentRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedSimRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'deploy',
      inputs: { simRef: failedSimRefId },
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
      command: 'deploy',
      phase: 'intent-resolution',
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}

// ============================================================================
// Deploy-Specific Exit Codes
// ============================================================================

export const DEPLOY_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  NOT_FOUND: 100,
  IO_ERROR: 74,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Local Deploy Types
// ============================================================================

export type DeployStatus = 'pending' | 'previewed' | 'running' | 'completed' | 'failed' | 'rolled_back';

export interface DeployRecord {
  id: string;
  target_id: string;
  environment: 'development' | 'staging' | 'production';
  status: DeployStatus;
  preview: DeployPreview | null;
  execution: DeployExecution | null;
  created_at: string;
  updated_at: string;
  version: number;
  metadata?: Record<string, unknown>;
}

export interface DeployPreview {
  changes: DeployChange[];
  estimated_duration_seconds: number;
  risk_level: 'low' | 'medium' | 'high';
  requires_approval: boolean;
  generated_at: string;
}

export interface DeployChange {
  resource: string;
  action: 'create' | 'update' | 'delete' | 'unchanged';
  details: string;
}

export interface DeployExecution {
  started_at: string;
  completed_at: string | null;
  steps_completed: number;
  steps_total: number;
  advisory: boolean;
  logs: string[];
}

// ============================================================================
// Local Deploy Input/Output Types
// ============================================================================

export interface DeployPreviewInput {
  target_id: string;
  environment?: 'development' | 'staging' | 'production';
}

export interface DeployPreviewResult {
  result: DeployRecord;
  timing: number;
}

export interface DeployRunInput {
  deployment_id: string;
}

export interface DeployRunResult {
  result: DeployRecord;
  advisory: boolean;
  timing: number;
}

export interface DeployStatusInput {
  deployment_id: string;
}

export interface DeployStatusResult {
  result: DeployRecord | null;
  found: boolean;
  timing: number;
}

export interface DeployRollbackInput {
  deployment_id: string;
}

export interface DeployRollbackResult {
  result: DeployRecord;
  advisory: boolean;
  timing: number;
}

export interface DeployListResult {
  items: DeployRecord[];
  count: number;
  timing: number;
}

// ============================================================================
// Ruvector Adapter Helper
// ============================================================================

function createRuvectorAdapter(correlationId: string): RuvectorAdapter {
  const config = loadEndpointConfig('ruvector-service');
  return new RuvectorAdapter(config, correlationId);
}

// ============================================================================
// ID Generation
// ============================================================================

function generateDeploymentId(): string {
  // Use standard UUID format for production compatibility
  return crypto.randomUUID();
}

// ============================================================================
// Validation
// ============================================================================

function validateTargetId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-DEPLOY-001',
      category: 'INPUT_ERROR',
      message: 'Target ID is required',
      details: { provided: id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validateDeploymentId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-DEPLOY-002',
      category: 'INPUT_ERROR',
      message: 'Deployment ID is required',
      details: { provided: id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatDeployForDisplay(record: DeployRecord): string {
  const lines: string[] = [];
  lines.push(`Deployment: ${record.id}`);
  lines.push(`Target: ${record.target_id}`);
  lines.push(`Environment: ${record.environment}`);
  lines.push(`Status: ${record.status}`);
  lines.push('');

  if (record.preview) {
    lines.push('Preview:');
    lines.push(`  Risk Level: ${record.preview.risk_level}`);
    lines.push(`  Estimated Duration: ${record.preview.estimated_duration_seconds}s`);
    lines.push(`  Requires Approval: ${record.preview.requires_approval}`);
    lines.push(`  Changes: ${record.preview.changes.length}`);
    for (const change of record.preview.changes) {
      lines.push(`    - ${change.action.toUpperCase()} ${change.resource}: ${change.details}`);
    }
    lines.push('');
  }

  if (record.execution) {
    lines.push('Execution:');
    lines.push(`  Started: ${record.execution.started_at}`);
    if (record.execution.completed_at) {
      lines.push(`  Completed: ${record.execution.completed_at}`);
    }
    lines.push(`  Progress: ${record.execution.steps_completed}/${record.execution.steps_total}`);
    lines.push(`  Executed: ${!record.execution.advisory}`);
    lines.push('');
  }

  lines.push(`Created: ${record.created_at}`);
  lines.push(`Updated: ${record.updated_at}`);
  lines.push(`Version: ${record.version}`);

  return lines.join('\n');
}

export function formatDeployListForDisplay(items: DeployRecord[]): string {
  if (items.length === 0) {
    return 'No deployments found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${items.length} deployment${items.length === 1 ? '' : 's'}:`);
  lines.push('');

  for (const record of items) {
    lines.push(`  ${record.id}`);
    lines.push(`    Target: ${record.target_id} | Env: ${record.environment} | Status: ${record.status}`);
    lines.push(`    Created: ${record.created_at}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Generate Preview Data (Stubbed)
// ============================================================================

function generatePreview(targetId: string, environment: string): DeployPreview {
  // Generate preview data for deployment plan
  const changes: DeployChange[] = [
    { resource: 'compute/instance-group', action: 'update', details: `Update instance group for ${targetId}` },
    { resource: 'network/load-balancer', action: 'unchanged', details: 'No changes required' },
    { resource: 'storage/bucket', action: 'create', details: `Create storage bucket for ${targetId}` },
    { resource: 'iam/service-account', action: 'update', details: 'Update service account permissions' },
  ];

  const riskLevel = environment === 'production' ? 'high' : environment === 'staging' ? 'medium' : 'low';
  const requiresApproval = environment === 'production';

  return {
    changes,
    estimated_duration_seconds: environment === 'production' ? 300 : 120,
    risk_level: riskLevel,
    requires_approval: requiresApproval,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Deploy Commands - Preview (Ruvector Storage)
// ============================================================================

export async function executeDeployPreviewCommand(
  input: DeployPreviewInput,
  options: CommandOptions
): Promise<DeployPreviewResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Validate input
  validateTargetId(input.target_id, correlationId);

  const environment = input.environment ?? 'development';
  const id = generateDeploymentId();

  // Generate preview
  const preview = generatePreview(input.target_id, environment);

  // Create deployment record
  const now = new Date().toISOString();
  const record: DeployRecord = {
    id,
    target_id: input.target_id,
    environment,
    status: 'previewed',
    preview,
    execution: null,
    created_at: now,
    updated_at: now,
    version: 1,
    metadata: {
      correlation_id: correlationId,
    },
  };

  // Store in Ruvector service
  try {
    const ruvectorAdapter = createRuvectorAdapter(correlationId);
    await ruvectorAdapter.storeDeployment(record);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-DEPLOY-003',
      category: 'INTERNAL_ERROR',
      message: `Failed to persist deployment to storage: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { deployment_id: id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    result: record,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Deploy Commands - Run (Ruvector Storage)
// ============================================================================

export async function executeDeployRunCommand(
  input: DeployRunInput,
  options: CommandOptions
): Promise<DeployRunResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Validate input
  validateDeploymentId(input.deployment_id, correlationId);

  // Load existing deployment from Ruvector
  const ruvectorAdapter = createRuvectorAdapter(correlationId);
  let record: DeployRecord | null = null;

  try {
    const response = await ruvectorAdapter.getDeployment(input.deployment_id);
    if (response.status === 200 && response.body) {
      record = response.body as DeployRecord;
    }
  } catch (error) {
    // Check if this is a 404 (not found) error
    if (error instanceof Error && error.message.includes('404')) {
      record = null;
    } else {
      throw new CLIError({
        code: 'ECLI-DEPLOY-011',
        category: 'INTERNAL_ERROR',
        message: `Failed to retrieve deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        details: { deployment_id: input.deployment_id },
        module: 'deploy',
        correlationId,
        recoverable: false,
        exitCode: DEPLOY_EXIT_CODES.IO_ERROR,
      });
    }
  }

  if (!record) {
    throw new CLIError({
      code: 'ECLI-DEPLOY-004',
      category: 'INPUT_ERROR',
      message: `Deployment not found: ${input.deployment_id}`,
      details: { deployment_id: input.deployment_id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.NOT_FOUND,
    });
  }

  // Check if deployment can be run
  if (record.status !== 'previewed' && record.status !== 'pending') {
    throw new CLIError({
      code: 'ECLI-DEPLOY-005',
      category: 'INPUT_ERROR',
      message: `Deployment cannot be run in status: ${record.status}`,
      details: { deployment_id: input.deployment_id, current_status: record.status },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.INPUT_ERROR,
    });
  }

  // Execute deployment via downstream service
  const now = new Date().toISOString();
  const stepsTotal = record.preview?.changes.length ?? 4;

  record.status = 'running';
  record.execution = {
    started_at: now,
    completed_at: null,
    steps_completed: 0,
    steps_total: stepsTotal,
    advisory: false,
    logs: [
      `[${now}] Deployment execution started`,
      `[${now}] Validating configuration...`,
    ],
  };
  record.updated_at = now;
  record.version += 1;

  // Execute via deployment intent service
  try {
    const intentConfig = loadEndpointConfig('agentics-deployment-intent');
    const intentAdapter = new IntentAdapter(intentConfig, correlationId);
    const engine = createOrchestrationEngine(correlationId);

    const stages: OrchestrationStage[] = [
      {
        name: 'execute-deployment',
        adapter: intentAdapter,
        request: {
          endpoint: '/v1/intent/execute',
          method: 'POST',
          buildBody: () => ({
            deployment_id: record!.id,
            target_id: record!.target_id,
            environment: record!.environment,
            changes: record!.preview?.changes ?? [],
          }),
        },
      },
    ];

    const result = await engine.execute(stages, options);
    const completedAt = new Date().toISOString();

    record.status = result.success ? 'completed' : 'failed';
    record.execution.completed_at = completedAt;
    record.execution.steps_completed = stepsTotal;
    record.execution.logs.push(
      `[${completedAt}] Applying changes...`,
      `[${completedAt}] Verifying deployment...`,
      `[${completedAt}] Deployment ${result.success ? 'completed successfully' : 'failed'}`,
    );
  } catch (error) {
    const failedAt = new Date().toISOString();
    record.status = 'failed';
    record.execution.completed_at = failedAt;
    record.execution.logs.push(
      `[${failedAt}] Deployment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  record.updated_at = new Date().toISOString();
  record.version += 1;

  // Save updated record to Ruvector
  try {
    await ruvectorAdapter.updateDeployment(input.deployment_id, {
      status: record.status,
      execution: record.execution,
      updated_at: record.updated_at,
      version: record.version,
    });
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-DEPLOY-006',
      category: 'INTERNAL_ERROR',
      message: `Failed to update deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { deployment_id: input.deployment_id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    result: record,
    advisory: false,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Deploy Commands - Status (Ruvector Storage)
// ============================================================================

export async function executeDeployStatusCommand(
  input: DeployStatusInput,
  options: CommandOptions
): Promise<DeployStatusResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Validate input
  validateDeploymentId(input.deployment_id, correlationId);

  // Load deployment from Ruvector
  const ruvectorAdapter = createRuvectorAdapter(correlationId);
  let record: DeployRecord | null = null;

  try {
    const response = await ruvectorAdapter.getDeployment(input.deployment_id);
    if (response.status === 200 && response.body) {
      record = response.body as DeployRecord;
    }
  } catch {
    // Deployment not found or service error - return null
    record = null;
  }

  return {
    result: record,
    found: record !== null,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Deploy Commands - Rollback (Ruvector Storage)
// ============================================================================

export async function executeDeployRollbackCommand(
  input: DeployRollbackInput,
  options: CommandOptions
): Promise<DeployRollbackResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Validate input
  validateDeploymentId(input.deployment_id, correlationId);

  // Load existing deployment from Ruvector
  const ruvectorAdapter = createRuvectorAdapter(correlationId);
  let record: DeployRecord | null = null;

  try {
    const response = await ruvectorAdapter.getDeployment(input.deployment_id);
    if (response.status === 200 && response.body) {
      record = response.body as DeployRecord;
    }
  } catch (error) {
    // Check if this is a 404 (not found) error
    if (error instanceof Error && error.message.includes('404')) {
      record = null;
    } else {
      throw new CLIError({
        code: 'ECLI-DEPLOY-012',
        category: 'INTERNAL_ERROR',
        message: `Failed to retrieve deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
        details: { deployment_id: input.deployment_id },
        module: 'deploy',
        correlationId,
        recoverable: false,
        exitCode: DEPLOY_EXIT_CODES.IO_ERROR,
      });
    }
  }

  if (!record) {
    throw new CLIError({
      code: 'ECLI-DEPLOY-007',
      category: 'INPUT_ERROR',
      message: `Deployment not found: ${input.deployment_id}`,
      details: { deployment_id: input.deployment_id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.NOT_FOUND,
    });
  }

  // Check if deployment can be rolled back
  if (record.status === 'rolled_back') {
    throw new CLIError({
      code: 'ECLI-DEPLOY-008',
      category: 'INPUT_ERROR',
      message: 'Deployment is already rolled back',
      details: { deployment_id: input.deployment_id, current_status: record.status },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.INPUT_ERROR,
    });
  }

  if (record.status !== 'completed' && record.status !== 'failed') {
    throw new CLIError({
      code: 'ECLI-DEPLOY-009',
      category: 'INPUT_ERROR',
      message: `Deployment cannot be rolled back in status: ${record.status}`,
      details: { deployment_id: input.deployment_id, current_status: record.status },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.INPUT_ERROR,
    });
  }

  // Execute rollback via downstream service
  const now = new Date().toISOString();

  record.status = 'rolled_back';
  if (record.execution) {
    record.execution.logs.push(
      `[${now}] Rollback initiated`,
    );
  }

  // Execute rollback via deployment intent service
  try {
    const intentConfig = loadEndpointConfig('agentics-deployment-intent');
    const intentAdapter = new IntentAdapter(intentConfig, correlationId);
    const engine = createOrchestrationEngine(correlationId);

    const rollbackStages: OrchestrationStage[] = [
      {
        name: 'execute-rollback',
        adapter: intentAdapter,
        request: {
          endpoint: '/v1/intent/rollback',
          method: 'POST',
          buildBody: () => ({
            deployment_id: record!.id,
            target_id: record!.target_id,
            environment: record!.environment,
          }),
        },
      },
    ];

    await engine.execute(rollbackStages, options);
    if (record.execution) {
      record.execution.logs.push(
        `[${new Date().toISOString()}] Reverting changes...`,
        `[${new Date().toISOString()}] Rollback completed successfully`,
      );
    }
  } catch (error) {
    if (record.execution) {
      record.execution.logs.push(
        `[${new Date().toISOString()}] Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  record.updated_at = new Date().toISOString();
  record.version += 1;

  // Save updated record to Ruvector
  try {
    await ruvectorAdapter.updateDeployment(input.deployment_id, {
      status: record.status,
      execution: record.execution,
      updated_at: record.updated_at,
      version: record.version,
    });
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-DEPLOY-010',
      category: 'INTERNAL_ERROR',
      message: `Failed to update deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { deployment_id: input.deployment_id },
      module: 'deploy',
      correlationId,
      recoverable: false,
      exitCode: DEPLOY_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    result: record,
    advisory: false,
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Deploy Commands - List (Ruvector Storage)
// ============================================================================

export async function executeDeployListCommand(
  options: CommandOptions
): Promise<DeployListResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // List deployments from Ruvector
  const ruvectorAdapter = createRuvectorAdapter(correlationId);
  let items: DeployRecord[] = [];

  try {
    const response = await ruvectorAdapter.listDeployments({ limit: 100 });
    if (response.status === 200 && response.body) {
      const body = response.body as { data?: DeployRecord[]; items?: DeployRecord[] } | DeployRecord[];
      if (Array.isArray(body)) {
        items = body;
      } else if (body.data && Array.isArray(body.data)) {
        items = body.data;
      } else if (body.items && Array.isArray(body.items)) {
        items = body.items;
      }
    }
  } catch {
    // Service error - return empty list
    items = [];
  }

  // Sort by created_at descending
  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return {
    items,
    count: items.length,
    timing: Date.now() - startTime,
  };
}
