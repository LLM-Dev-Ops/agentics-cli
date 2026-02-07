/**
 * Prompt Templates for Decision-Grade Subcommands — ADR-007
 *
 * Each template is a function that takes PromptArgs and returns a prompt string.
 * Every template enforces JSON-only output and embeds the contract schema name.
 *
 * INVARIANTS:
 * - All templates produce valid, non-empty prompt strings (>50 characters)
 * - JSON-only output instruction is ALWAYS present
 * - Run-id and seed are ALWAYS embedded for determinism and traceability
 * - Contract schema name is ALWAYS stated
 * - Required output fields are ALWAYS enumerated
 * - User-provided arguments are sanitized (truncated, control chars removed)
 * - COMMITMENT_GRADE templates include commitment notice
 *
 * RULES:
 * - No prose, no markdown, no explanation in the requested output
 * - Output must be a single JSON object (not array, not wrapped in fences)
 */

import type {
  PromptArgs,
  PromptTemplate,
} from '../../contracts/adr-007-subcommand-synthesis-router.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for a user-provided argument before truncation */
const MAX_ARG_LENGTH = 2_000;

// ============================================================================
// Argument Sanitization
// ============================================================================

/**
 * Sanitize and truncate a user-provided positional argument.
 *
 * Defenses:
 * - Truncates to MAX_ARG_LENGTH to prevent prompt bloat
 * - Removes null bytes
 * - Removes control characters (except newline and tab)
 */
function sanitizeArg(arg: string | undefined, maxLength: number = MAX_ARG_LENGTH): string {
  if (!arg) return '';
  // Remove null bytes and control characters (keep \n=0x0A, \t=0x09)
  // eslint-disable-next-line no-control-regex
  let cleaned = arg.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength) + '...[truncated]';
  }
  return cleaned;
}

// ============================================================================
// Shared Preamble Components
// ============================================================================

/**
 * Standard preamble for all decision-grade prompts.
 * Embeds run-id, seed, command path, and contract schema.
 * Instructs JSON-only output with run_id echo for traceability.
 */
function preamble(args: PromptArgs): string {
  return [
    `You are an enterprise orchestration engine. run_id="${args.runId}" seed=${args.seed}.`,
    `Command: agentics ${args.command} ${args.subcommand}`,
    `Contract schema: ${args.contractSchemaName}`,
    '',
    'Respond ONLY with a single JSON object. No prose, no markdown, no explanation.',
    'Do not wrap in code fences. Output raw JSON only.',
    `Include "run_id": "${args.runId}" in your response for traceability.`,
    '',
  ].join('\n');
}

/**
 * Commitment-grade notice appended to COMMITMENT_GRADE templates.
 * Instructs Claude Code to verify resource IDs and include confirmation metadata.
 */
function commitmentNotice(command: string, subcommand: string, resourceId: string): string {
  return [
    '',
    'COMMITMENT-GRADE OPERATION:',
    `This is an irreversible "${command} ${subcommand}" action.`,
    `Resource ID: "${resourceId}"`,
    'Verify the resource ID is well-formed before generating output.',
    'Include "commitment_grade": true in the output.',
    '',
  ].join('\n');
}

// ============================================================================
// Simulation Templates
// ============================================================================

export function simulate_create(args: PromptArgs): string {
  const description = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    'Create a simulation plan for the following scenario:',
    `"${description}"`,
    '',
    'Required output fields:',
    '- id: string (use run_id prefix)',
    '- type: "SimulationReference"',
    '- repository: "agentics-simulation-runner"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- scenario: object with scenarioId, version, name, description, category, tags, preconditions, setup, steps, teardown, expectations',
    '- status: "pending"',
    '- iteration_count: integer >= 1',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'The scenario.steps array must have at least one step with stepId and action.',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function simulate_run(args: PromptArgs): string {
  const simulationId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    commitmentNotice('simulate', 'run', simulationId),
    `Execute simulation with ID: "${simulationId}"`,
    '',
    'Produce an execution plan that includes:',
    '- id: the simulation ID',
    '- type: "SimulationReference"',
    '- repository: "agentics-simulation-runner"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- status: "running"',
    '- started_at: ISO 8601 timestamp',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// Planning Templates
// ============================================================================

export function plan_create(args: PromptArgs): string {
  const description = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    'Create an enterprise plan for:',
    `"${description}"`,
    '',
    'Required output fields:',
    '- id: string (UUID format)',
    '- type: "PlanReference"',
    '- repository: "agentics-simulation-planner"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- plan: object with metadata (planId, createdAt, contentHash), phases array, milestones',
    '- execution_metadata: object with execution_id/request_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function plan_approve(args: PromptArgs): string {
  const planId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    commitmentNotice('plan', 'approve', planId),
    `Generate approval assessment for plan ID: "${planId}"`,
    '',
    'Required output fields:',
    '- id: the plan ID',
    '- type: "PlanReference"',
    '- repository: "agentics-simulation-planner"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- approval: object with status "approved", approved_by, approved_at, risk_assessment',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// Deployment Templates
// ============================================================================

export function deploy_preview(args: PromptArgs): string {
  const simulationId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Preview deployment for simulation ID: "${simulationId}"`,
    '',
    'Required output fields:',
    '- id: string (deployment intent ID)',
    '- type: "IntentReference"',
    '- repository: "agentics-deployment-intent"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- status: "pending"',
    '- preview: object with resources, estimated_cost, risk_level, dependencies',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function deploy_run(args: PromptArgs): string {
  const deploymentId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    commitmentNotice('deploy', 'run', deploymentId),
    `Execute deployment ID: "${deploymentId}"`,
    '',
    'Required output fields:',
    '- id: the deployment ID',
    '- type: "IntentReference"',
    '- repository: "agentics-deployment-intent"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- status: "approved"',
    '- execution_plan: object with steps, rollback_strategy, verification_checks',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function deploy_rollback(args: PromptArgs): string {
  const deploymentId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    commitmentNotice('deploy', 'rollback', deploymentId),
    `Generate rollback plan for deployment ID: "${deploymentId}"`,
    '',
    'Required output fields:',
    '- id: the deployment ID',
    '- type: "IntentReference"',
    '- repository: "agentics-deployment-intent"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- status: "pending"',
    '- rollback: object with steps, verification, estimated_duration',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// Export Templates
// ============================================================================

export function export_terraform(args: PromptArgs): string {
  const intentId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Export Terraform artifacts for deployment intent ID: "${intentId}"`,
    '',
    'Required output fields:',
    '- id: string (export reference ID)',
    '- type: "ExportReference"',
    '- repository: "agentics-deployment-exporters"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- format: "terraform"',
    '- artifact_location: string path',
    '- files: array of { path, content } objects with valid HCL',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function export_kubernetes(args: PromptArgs): string {
  const intentId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Export Kubernetes manifests for deployment intent ID: "${intentId}"`,
    '',
    'Required output fields:',
    '- id: string (export reference ID)',
    '- type: "ExportReference"',
    '- repository: "agentics-deployment-exporters"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- format: "kubernetes"',
    '- artifact_location: string path',
    '- files: array of { path, content } objects with valid YAML',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function export_erp(args: PromptArgs): string {
  const intentId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Export ERP integration artifacts for deployment intent ID: "${intentId}"`,
    '',
    'Required output fields:',
    '- id: string (export reference ID)',
    '- type: "ExportReference"',
    '- repository: "agentics-deployment-exporters"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- format: "erp"',
    '- artifact_location: string path',
    '- mappings: array of entity mapping objects',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// Policy Templates
// ============================================================================

export function policy_create(args: PromptArgs): string {
  const description = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    'Create an enterprise policy for:',
    `"${description}"`,
    '',
    'Required output fields:',
    '- id: string (policy ID)',
    '- type: "PolicyDefinition"',
    '- name: string',
    '- description: string',
    '- rules: array of rule objects with condition and action',
    '- scope: object defining where policy applies',
    '- enforcement: "advisory" or "mandatory"',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function policy_edit(args: PromptArgs): string {
  const policyId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Generate edit recommendations for policy ID: "${policyId}"`,
    '',
    'Required output fields:',
    '- id: the policy ID',
    '- type: "PolicyDefinition"',
    '- edits: array of { field, old_value, new_value, rationale }',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function policy_enable(args: PromptArgs): string {
  const policyId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    commitmentNotice('policy', 'enable', policyId),
    `Generate enablement assessment for policy ID: "${policyId}"`,
    '',
    'Required output fields:',
    '- id: the policy ID',
    '- type: "PolicyDefinition"',
    '- status: "enabled"',
    '- impact_assessment: object with affected_resources, risk_level, rollback_plan',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function policy_disable(args: PromptArgs): string {
  const policyId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Generate disablement plan for policy ID: "${policyId}"`,
    '',
    'Required output fields:',
    '- id: the policy ID',
    '- type: "PolicyDefinition"',
    '- status: "disabled"',
    '- impact_assessment: object with affected_resources, risk_level',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function policy_dryrun(args: PromptArgs): string {
  const policyId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Dry-run policy ID: "${policyId}" against current environment`,
    '',
    'Required output fields:',
    '- id: the policy ID',
    '- type: "PolicyDefinition"',
    '- dry_run_results: object with violations array, warnings array, passed_rules array',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// Quantify Templates
// ============================================================================

export function quantify_create(args: PromptArgs): string {
  const description = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    'Create ROI analysis for:',
    `"${description}"`,
    '',
    'Required output fields:',
    '- id: string (ROI report ID)',
    '- type: "ROIReport"',
    '- report: object with executive_summary, cost_analysis, benefit_analysis, timeline, risk_factors',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function quantify_compare(args: PromptArgs): string {
  const reportId1 = sanitizeArg(args.positionalArgs[0]);
  const reportId2 = sanitizeArg(args.positionalArgs[1]);
  return [
    preamble(args),
    commitmentNotice('quantify', 'compare', `${reportId1} vs ${reportId2}`),
    `Compare ROI reports: "${reportId1}" vs "${reportId2}"`,
    '',
    'Required output fields:',
    '- id: string (comparison report ID)',
    '- type: "ROIReport"',
    '- comparison: object with report_a_id, report_b_id, cost_delta, benefit_delta, recommendation',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// ERP Templates
// ============================================================================

export function erp_surface(args: PromptArgs): string {
  const planId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Surface ERP integration points for plan ID: "${planId}"`,
    '',
    'Required output fields:',
    '- id: string (surface analysis ID)',
    '- type: "ERPSurfaceAnalysis"',
    '- plan_id: the input plan ID',
    '- integration_points: array of { system, entity, operation, direction }',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function erp_map(args: PromptArgs): string {
  const planId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Map ERP entities for plan ID: "${planId}"`,
    '',
    'Required output fields:',
    '- id: string (mapping ID)',
    '- type: "ERPMapping"',
    '- plan_id: the input plan ID',
    '- mappings: array of { source_entity, target_entity, transformation, cardinality }',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

export function erp_export(args: PromptArgs): string {
  const planId = sanitizeArg(args.positionalArgs[0]);
  return [
    preamble(args),
    `Export ERP integration artifacts for plan ID: "${planId}"`,
    '',
    'Required output fields:',
    '- id: string (export reference ID)',
    '- type: "ExportReference"',
    '- repository: "agentics-deployment-exporters"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- format: "erp"',
    '- artifact_location: string path',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'layers_executed must include at least one layer name string.',
  ].join('\n');
}

// ============================================================================
// Template Registry
// ============================================================================

/**
 * Registry mapping (command.subcommand) to prompt template function.
 * Only decision-grade subcommands are registered here.
 *
 * INVARIANT: Every key in DECISION_GRADE_SUBCOMMANDS must have an entry.
 * INVARIANT: Every key in SYNTHESIS_SCHEMA_MAP must have an entry.
 * These invariants are validated by the build-time validation script.
 */
export const PROMPT_TEMPLATES: Readonly<Record<string, PromptTemplate>> = {
  'simulate.create': simulate_create,
  'simulate.run': simulate_run,
  'plan.create': plan_create,
  'plan.approve': plan_approve,
  'deploy.preview': deploy_preview,
  'deploy.run': deploy_run,
  'deploy.rollback': deploy_rollback,
  'export.terraform': export_terraform,
  'export.kubernetes': export_kubernetes,
  'export.erp': export_erp,
  'policy.create': policy_create,
  'policy.edit': policy_edit,
  'policy.enable': policy_enable,
  'policy.disable': policy_disable,
  'policy.dry-run': policy_dryrun,
  'quantify.create': quantify_create,
  'quantify.compare': quantify_compare,
  'erp.surface': erp_surface,
  'erp.map': erp_map,
  'erp.export': erp_export,
};
