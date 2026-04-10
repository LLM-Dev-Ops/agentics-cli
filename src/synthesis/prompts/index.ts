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
import {
  resolveSimulationProfile,
  generatePromptContext,
  resolveCommandProfile,
} from '../dynamic-router.js';

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

  // Dynamic routing: analyze the description to determine which
  // downstream repos, agents, and platform layers are relevant
  const profile = resolveSimulationProfile(description);
  const routingContext = generatePromptContext(profile);

  return [
    preamble(args),
    'You are simulating an enterprise implementation scenario. Produce a DEEP, ACTIONABLE analysis.',
    'The platform has dynamically routed this request based on the scenario description.',
    '',
    `SCENARIO: "${description}"`,
    '',
    routingContext,
    '',
    'Produce a comprehensive JSON output with these sections:',
    '',
    '1. routing: object with category, confidence, industry, scale, services[] (name + purpose), agents[] (type + role), layers[]',
    '',
    '2. scenario: object containing:',
    '   - scenarioId, version ("1.0.0"), name, description, category, tags[]',
    '   - preconditions[]: what must be true before implementation begins',
    '   - constraints[]: budget, regulatory, technical, organizational limits',
    '',
    '3. phases[]: array of implementation phases, each with:',
    '   - phaseId, name, duration, dependencies[], parallel_tracks[]',
    '   - objectives[]: specific measurable outcomes',
    '   - workstreams[]: each with name, owner_role, tasks[], deliverables[], risks[]',
    '   - agents_deployed[]: MUST use agent types from the AGENTS TO DEPLOY list above',
    '     Each agent: { type, role, downstream_repo, integration_points[], outputs[] }',
    '   - downstream_services[]: which platform repos are invoked in this phase',
    '   - success_criteria[]: how to measure phase completion',
    '   - gate_review: what must pass before next phase',
    '',
    '4. financial_model: object with:',
    '   - total_investment, annual_opex, roi_months, npv_5yr',
    '   - cost_breakdown: { infrastructure, licensing, talent, change_management, contingency }',
    '   - savings_breakdown: { labor_automation, error_reduction, speed_improvement, compliance_cost }',
    '   - year_by_year[]: { year, investment, savings, cumulative_roi }',
    '',
    '5. risk_matrix[]: array of risks, each with:',
    '   - risk_id, category (technical|organizational|regulatory|financial|security)',
    '   - description, likelihood (1-5), impact (1-5), risk_score',
    '   - mitigation_strategy, contingency_plan, owner_role',
    '',
    '6. organizational_impact: object with:',
    '   - roles_affected[]: { role, headcount, impact_type (augmented|displaced|created), transition_plan }',
    '   - training_programs[]: { name, target_audience, duration, format }',
    '   - change_management: { approach, timeline, key_stakeholders[], communication_plan }',
    '',
    '7. technology_architecture: object with:',
    '   - platforms[]: MUST include activated downstream repos from routing above',
    '     Each: { name, repo, purpose, integration_type, api_endpoints[] }',
    '   - data_flows[]: { source, destination, data_type, volume, frequency }',
    '   - security_controls[]: { control, layer, standard }',
    '   - compliance_frameworks[]: { framework, requirements[], gaps[] }',
    '',
    '8. kpi_framework[]: array of KPIs, each with:',
    '   - kpi_id, name, category, baseline, target, measurement_method, frequency',
    '',
    '9. execution_metadata: { execution_id, timestamp, service: "agentics-simulation-engine", layers_executed[] }',
    '',
    '10. competitive_analysis: object with (ADR-PIPELINE-062 — extends ADR-PIPELINE-057 §3):',
    '    - peer_firms[]: { name, industry_position, public_evidence_source }',
    '      MUST contain at least 3 REAL companies operating in the same industry as the scenario.',
    '      Each public_evidence_source MUST cite a specific published report, sustainability disclosure,',
    '      or technology keynote (not "internal estimate").',
    '    - capability_maturity[]: { capability, current_level, peer_levels: { [peerName]: level },',
    '      post_pilot_level }',
    '      Levels MUST be one of: "none" | "manual" | "rule_based" | "automated" | "ai_optimized".',
    '      MUST contain at least 4 capability rows. Every peer in peer_firms MUST appear in every',
    '      row\'s peer_levels map. post_pilot_level MUST be equal to or higher than current_level.',
    '    - gap_to_close[]: { capability, from, to, levels_jumped, vs_top_peer }',
    '      One entry per capability_maturity row. levels_jumped = MATURITY_RANK[to] - MATURITY_RANK[from].',
    '      vs_top_peer MUST be one of: "Matches or exceeds top peer" | "Reaches peer median" | "Closes gap to trailing peer".',
    '    - risks_of_inaction[]: { risk, driver, timeframe }',
    '      MUST contain at least 2 risks. If the scenario touches any regulated domain (ESG, finance,',
    '      healthcare, pharma, data privacy), at least one risk MUST reference a named regulatory framework.',
    '    - sources[]: array of citation strings for peer evidence and regulations',
    '    Required because the executive summary renderer will ALWAYS include a "Competitive Position"',
    '    section. If competitive_analysis is missing or malformed, the pipeline will substitute a',
    '    deterministic fallback — but LLM-generated analysis is preferred because it can tailor peer',
    '    selection to the specific industry context beyond the static fallback map.',
    '',
    'CRITICAL REQUIREMENTS:',
    '- Generate SYNTHETIC DATA throughout: realistic but fictional company names, supplier names,',
    '  dollar amounts, headcounts, timelines, metrics, KPIs, and financial projections.',
    '  All numbers must be plausible for the described industry and scale.',
    '- Be SPECIFIC with numbers, timelines, dollar amounts, and percentages — never use placeholder ranges',
    '- Include synthetic sample datasets: example records, transactions, API payloads, and test fixtures',
    '  that demonstrate how the system would process real data',
    '- Every phase MUST reference specific downstream repos being invoked',
    '- Every phase MUST list agents_deployed from the routing agent list',
    '- technology_architecture.platforms MUST include the activated repos',
    '- The "routing" section MUST reflect the dynamic routing above',
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

  // Dynamic routing based on plan description
  const profile = resolveCommandProfile('plan', 'create', description);
  const routingContext = profile ? generatePromptContext(profile) : '';

  return [
    preamble(args),
    'Create a comprehensive enterprise plan. The platform has dynamically routed this request.',
    '',
    `OBJECTIVE: "${description}"`,
    '',
    routingContext,
    '',
    'Required output fields:',
    '- id: string (UUID format)',
    '- type: "PlanReference"',
    '- repository: "agentics-simulation-planner"',
    '- created_at: ISO 8601 timestamp',
    '- checksum: SHA-256 hex string',
    '- plan: object with metadata (planId, createdAt, contentHash), phases array, milestones',
    '  - Each phase must reference downstream repos and agents from the routing context above',
    '  - phases[].agents_deployed[]: agent types, roles, and outputs',
    '  - phases[].downstream_services[]: which platform repos are invoked',
    routingContext ? '- routing: object reflecting the dynamic routing (category, services[], agents[], layers[])' : '',
    '- execution_metadata: object with execution_id/request_id, timestamp, service, layers_executed array',
    '',
    'Be SPECIFIC with timelines, resource requirements, and deliverables.',
    'All artifacts persisted to ruvector-service. All outputs validated against agentics-contracts schemas.',
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

  // Dynamic routing with financial emphasis
  const profile = resolveCommandProfile('quantify', 'create', description);
  const routingContext = profile ? generatePromptContext(profile) : '';

  return [
    preamble(args),
    'Create a comprehensive ROI analysis. The platform has dynamically routed this via enterprise-roi-engine.',
    '',
    `SCENARIO: "${description}"`,
    '',
    routingContext,
    '',
    'Required output fields:',
    '- id: string (ROI report ID)',
    '- type: "ROIReport"',
    '- report: object with:',
    '  - executive_summary: string (2-3 paragraph analysis)',
    '  - cost_analysis: { total_investment, year_1, year_2, year_3, breakdown_by_category{} }',
    '  - benefit_analysis: { total_savings_3yr, revenue_impact, efficiency_gains[], intangible_benefits[] }',
    '  - financial_metrics: { roi_percentage, npv, irr, payback_months }',
    '  - timeline: { phases[], milestones[], critical_path }',
    '  - risk_factors: { risks[], sensitivity_analysis, monte_carlo_range }',
    '  - downstream_services_used[]: which platform repos contributed to this analysis',
    routingContext ? '- routing: object reflecting the dynamic routing (category, services[], agents[], layers[])' : '',
    '- execution_metadata: object with execution_id, timestamp, service, layers_executed array',
    '',
    'Use SPECIFIC dollar amounts, percentages, and timelines. Not ranges or placeholders.',
    'All outputs validated against agentics-contracts/roi-report/v1 schema.',
    'All artifacts persisted to ruvector-service.',
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
