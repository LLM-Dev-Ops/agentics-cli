/**
 * Enterprise 7-Pass Pipeline — Type Definitions (ADR-032)
 *
 * Canonical type system for the deterministic enterprise decision pipeline.
 * Every pipeline execution follows 7 sequential passes, each with defined
 * inputs, agents, outputs, and exit criteria.
 *
 * This module is additive — it does NOT modify any existing pipeline types.
 */

// ============================================================================
// Pipeline Pass Identifiers
// ============================================================================

/** The 7 canonical enterprise pipeline passes (ADR-032). */
export type EnterprisePass =
  | 'problem-intelligence'
  | 'simulation-scenario'
  | 'architecture-prototype'
  | 'governance-compliance-costops'
  | 'decision-artifacts'
  | 'erp-deployment'
  | 'observability-learning';

/** Numeric pass index (1-7). */
export type PassNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Map from pass number to pass identifier. */
export const PASS_ID_MAP: Readonly<Record<PassNumber, EnterprisePass>> = {
  1: 'problem-intelligence',
  2: 'simulation-scenario',
  3: 'architecture-prototype',
  4: 'governance-compliance-costops',
  5: 'decision-artifacts',
  6: 'erp-deployment',
  7: 'observability-learning',
} as const;

/** Reverse map from pass identifier to number. */
export const PASS_NUMBER_MAP: Readonly<Record<EnterprisePass, PassNumber>> = {
  'problem-intelligence': 1,
  'simulation-scenario': 2,
  'architecture-prototype': 3,
  'governance-compliance-costops': 4,
  'decision-artifacts': 5,
  'erp-deployment': 6,
  'observability-learning': 7,
} as const;

// ============================================================================
// Pass Status
// ============================================================================

/** Status of a pipeline pass. */
export type PassStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'degraded'
  | 'failed'
  | 'skipped';

// ============================================================================
// Pipeline Configuration
// ============================================================================

/** Enterprise pipeline execution modes. */
export type EnterprisePipelineMode = 'autonomous' | 'human-in-the-loop';

/** Options for running the enterprise pipeline. */
export interface EnterprisePipelineOptions {
  /** Pipeline execution mode. */
  readonly mode: EnterprisePipelineMode;
  /** Which passes to run (default: all 7). Example: [1,2,3,4,5] */
  readonly passes?: readonly PassNumber[];
  /** Single pass to run (requires prior pass outputs in DecisionGraph). */
  readonly singlePass?: PassNumber;
  /** Original user prompt. */
  readonly prompt: string;
  /** Correlation / trace ID. */
  readonly traceId: string;
  /** Artifacts output directory. */
  readonly outputDir: string;
  /** Verbose logging. */
  readonly verbose?: boolean;
  /** Per-pass timeout in ms (default: 300_000 = 5 min). */
  readonly passTimeoutMs?: number;
  /** Skip red team testing in Pass 2. */
  readonly skipRedTeam?: boolean;
}

// ============================================================================
// Agent References
// ============================================================================

/** Reference to an agent within a domain. */
export interface AgentRef {
  readonly domain: string;
  readonly agent: string;
  readonly role: string;
}

/**
 * ADR-094 Decision 6 — error detail captured when an agent invocation fails.
 * Persisted to `<runDir>/agent-errors.json` and surfaced in `status.json`
 * under `phase1.failed_agents[].error_excerpt`. Pre-094 these errors were
 * dropped on the floor — `autochain.log` recorded only "errored", which
 * made the originating run's 4 of 12 Phase-1 failures untriageable.
 */
export interface AgentInvocationError {
  /** Error class name (e.g. "TimeoutError", "Error"). */
  readonly type: string;
  /** Full error message. */
  readonly message: string;
  /** First 2KB of the stack trace (truncated to keep agent-errors.json small). */
  readonly stack_excerpt?: string;
  /** Tier the call was attempted on. cloud = remote service; local = fallback. */
  readonly tier: 'cloud' | 'local' | 'unknown';
  /** Time elapsed before the failure surfaced (ms). */
  readonly first_byte_ms?: number;
}

/** Service invocation result from an agentics agent. */
export interface AgentInvocationResult {
  readonly agent: AgentRef;
  readonly status: number;
  readonly response: unknown;
  readonly durationMs: number;
  readonly pass: PassNumber;
  readonly timestamp: string;
  /** ADR-094 D6 — populated when `status >= 400` or the call threw. */
  readonly error?: AgentInvocationError;
}

// ============================================================================
// Pass Output
// ============================================================================

/** Output produced by a single pipeline pass. */
export interface PassOutput {
  readonly pass: EnterprisePass;
  readonly passNumber: PassNumber;
  readonly status: PassStatus;
  readonly data: Record<string, unknown>;
  readonly artifacts: readonly string[];
  readonly agentResults: readonly AgentInvocationResult[];
  readonly durationMs: number;
  readonly summary: string;
  /** Reason for degradation (if status === 'degraded'). */
  readonly degradationReason?: string;
}

// ============================================================================
// Exit Criteria
// ============================================================================

/** Exit criteria check result. */
export interface ExitCriteriaResult {
  readonly passed: boolean;
  readonly criteria: readonly CriterionCheck[];
}

/** Individual criterion check. */
export interface CriterionCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

// ============================================================================
// Pipeline Result
// ============================================================================

/** Final result of the enterprise pipeline execution. */
export interface EnterprisePipelineResult {
  readonly executionId: string;
  readonly prompt: string;
  readonly mode: EnterprisePipelineMode;
  readonly passOutputs: readonly PassOutput[];
  readonly finalStatus: 'completed' | 'completed-degraded' | 'failed' | 'cancelled';
  readonly outputDir: string;
  readonly totalDurationMs: number;
  readonly passesExecuted: number;
  readonly passesDegraded: number;
  readonly passesFailed: number;
  readonly timestamp: string;
}

// ============================================================================
// DecisionGraph Node Types (ADR-033)
// ============================================================================

/** All node types in the DecisionGraph. */
export type DecisionNodeType =
  // Pass 1 — Problem Intelligence
  | 'problem_definition'
  | 'business_context'
  | 'technical_scope'
  | 'architecture_hypothesis'
  | 'execution_plan'
  | 'decision_lineage'
  // Pass 2 — Simulation
  | 'scenario'
  | 'risk_signal'
  | 'reliability_report'
  // Pass 3 — Architecture
  | 'system_architecture'
  | 'integration_map'
  | 'data_flow'
  | 'service_boundary'
  | 'prototype'
  | 'api_contract'
  | 'sdk_interface'
  // Pass 4 — Governance
  | 'security_analysis'
  | 'compliance_report'
  | 'cost_model'
  | 'governance_report'
  | 'policy_analysis'
  // Pass 5 — Decision Artifacts
  | 'executive_memo'
  | 'executive_summary'
  | 'risk_assessment'
  | 'implementation_roadmap'
  | 'org_impact'
  | 'stakeholder_map'
  | 'kpi_definition'
  | 'okr_alignment'
  | 'raid_log'
  | 'confidence_score'
  // Pass 6 — Deployment
  | 'deployment_endpoint'
  | 'integration_result'
  // Pass 7 — Observability
  | 'telemetry_config'
  | 'health_check'
  | 'learned_pattern'
  // Cross-cutting
  | 'provenance_manifest';

/** Edge relation types in the DecisionGraph. */
export type EdgeRelation =
  | 'derived_from'
  | 'informs'
  | 'validates'
  | 'supersedes'
  | 'aggregates';

/** A node in the DecisionGraph. */
export interface DecisionGraphNode {
  readonly id: string;
  readonly type: DecisionNodeType;
  readonly name: string;
  readonly content: Record<string, unknown>;
  readonly summary: string;
  readonly producedBy: AgentRef;
  readonly pass: PassNumber;
  readonly derivedFrom: readonly string[];
  readonly timestamp: string;
  readonly confidence: number;
  readonly status: 'complete' | 'partial' | 'degraded' | 'failed';
  readonly tags: readonly string[];
  readonly version: number;
}

/** An edge in the DecisionGraph. */
export interface DecisionGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: EdgeRelation;
}

// ============================================================================
// Provenance Tracing (ADR-039)
// ============================================================================

/** Runtime trace record for a single agent invocation. */
export interface TraceRecord {
  readonly traceId: string;
  readonly executionId: string;
  readonly agent: AgentRef & { readonly agentId: string; readonly version: string };
  readonly pass: PassNumber;
  readonly passName: string;
  readonly workstream: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly codeProvenance: CodeProvenance;
  readonly inputs: {
    readonly decisionGraphNodes: readonly string[];
    readonly parameters: Record<string, unknown>;
  };
  readonly outputs: {
    readonly decisionGraphNodes: readonly string[];
    readonly artifactNumbers: readonly number[];
    readonly status: 'success' | 'partial' | 'failed';
    readonly confidence: number;
  };
  readonly resources: {
    readonly tokensUsed: number;
    readonly modelUsed: string;
    readonly estimatedCost: number;
  };
}

/** Code provenance for an agent invocation. */
export interface CodeProvenance {
  readonly package: string;
  readonly version: string;
  readonly entryPoint: string;
  readonly repository: string;
  readonly commitHash: string;
  readonly dependencies: readonly string[];
}

// ============================================================================
// Pass Agent Configuration
// ============================================================================

/** Configuration for agents in a specific pipeline pass. */
export interface PassAgentConfig {
  readonly pass: PassNumber;
  readonly passName: EnterprisePass;
  readonly label: string;
  readonly description: string;
  readonly agenticsServices: readonly AgentRef[];
  readonly memoryNamespace: string;
  readonly hasApprovalGate: boolean;
}

// ============================================================================
// Artifact Package (ADR-034)
// ============================================================================

/** The 15 deterministic enterprise artifacts. */
export type ArtifactNumber =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/** Artifact status in the decision package. */
export type ArtifactStatus = 'complete' | 'degraded' | 'not_generated';

/** Entry in the decision package index. */
export interface ArtifactEntry {
  readonly number: ArtifactNumber;
  readonly name: string;
  readonly filename: string;
  readonly status: ArtifactStatus;
  readonly producingPass: PassNumber;
  readonly producingAgent: string;
  readonly degradationReason?: string;
}

/** The full decision package metadata. */
export interface DecisionPackage {
  readonly executionId: string;
  readonly timestamp: string;
  readonly prompt: string;
  readonly confidenceScore: number;
  readonly recommendation: 'proceed' | 'proceed-with-conditions' | 'investigate-further' | 'do-not-proceed';
  readonly artifacts: readonly ArtifactEntry[];
  readonly passesExecuted: number;
  readonly passesDegraded: readonly PassNumber[];
  readonly totalAgentsInvoked: number;
  readonly totalDurationMs: number;
}
