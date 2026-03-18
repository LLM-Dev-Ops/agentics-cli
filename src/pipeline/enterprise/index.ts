/**
 * Enterprise 7-Pass Pipeline — Public API (ADR-032, ADR-033)
 *
 * This module exports the complete enterprise pipeline implementation.
 * It is ADDITIVE to the existing pipeline — no existing exports are modified.
 *
 * Usage:
 *   import { executeEnterprisePipeline } from './pipeline/enterprise/index.js';
 *   import { DecisionGraph, DecisionGraphClient, createDecisionGraphClient } from './pipeline/enterprise/index.js';
 */

// ── Main Orchestrator ──
export { executeEnterprisePipeline } from './pipeline-orchestrator.js';

// ── DecisionGraph (ADR-033) ──
export { DecisionGraph } from './decision-graph.js';
export {
  DECISION_NODE_TYPES,
  VALID_NODE_TYPES,
  EDGE_RELATIONS,
  VALID_EDGE_RELATIONS,
} from './decision-graph.js';
export type {
  GraphLifecycle,
  NodeVersionEntry,
  NodeQuery,
  PaginationOptions,
  PaginatedResult,
  GraphStatistics,
  NodeValidationError,
} from './decision-graph.js';

// ── DecisionGraphClient (ADR-033) ──
export { DecisionGraphClient, createDecisionGraphClient } from './decision-graph-client.js';
export type {
  WriteNodeParams,
  UpdateNodeParams,
  ReadResult,
  QueryResult,
} from './decision-graph-client.js';

// ── DecisionGraph Memory Backend (ADR-033) ──
export {
  memoryKey,
  memoryTags,
  pushToMemory,
  pullFromMemory,
  searchMemory,
  buildMemoryQuery,
} from './decision-graph-memory.js';
export type {
  PushResult,
  PullResult,
  SearchResult,
} from './decision-graph-memory.js';

// ── Provenance Tracker (ADR-039) ──
export { ProvenanceTracker, provenanceKey, provenanceTags } from './provenance-tracker.js';
export type { AuditWho, AuditWhat, AuditReproducibility, ProvenanceStatistics } from './provenance-tracker.js';

// ── Code Resolver (ADR-039) ──
export {
  resolveCodeProvenance,
  resolveCodeProvenanceBatch,
  resolveGitCommit,
  resolveCLIVersion,
  detectVersionDiscrepancies,
  getPackageForDomain,
  getAllDomainPackages,
} from './code-resolver.js';

// ── Trace Middleware (ADR-039) ──
export { createTracingInvoker, createFullTracingInvoker } from './trace-middleware.js';
export type { AgentInvoker } from './trace-middleware.js';

// ── Pass Executor ──
export { executePass } from './pass-executor.js';

// ── Pass 2: Simulation & Scenario Modeling (ADR-035) ──
export { executePass2, WORKSTREAM_CONFIGS } from './pass2-simulation.js';
export type {
  Scenario,
  ScenarioType,
  ScenarioMetrics,
  RiskSignal,
  RiskCategory,
  ReliabilityReport,
  ReliabilityRecommendation,
  ScenarioMatrix,
  ScenarioCrossReference,
  WorkstreamConfig,
  WorkstreamId,
  WorkstreamResult,
  Pass2Result,
  ProbabilityLevel,
  ImpactLevel,
  SeverityLevel,
} from './pass2-simulation.js';

// ── Pass 4: Governance, Compliance & CostOps (ADR-036) ──
export { executePass4, PASS4_WORKSTREAM_CONFIGS } from './pass4-governance.js';
export type {
  SecurityAnalysis,
  PolicyAnalysis,
  CostModel,
  GovernanceReport,
  GovernanceConvergence,
  Pass4WorkstreamConfig,
  Pass4WorkstreamId,
  Pass4WorkstreamResult,
  Pass4Result,
  RiskLevel,
  ComplianceStatus,
  ReadinessScore,
  ConfidenceLevel,
  DataExposure,
  RemediationPriority,
  RegulatoryFramework,
  AIGovernance,
  ApprovalRoute,
  InfrastructureCost,
  IntegrationCost,
  OperationalCost,
  TCOProjection,
  ROIProjection,
  ScenarioVariant,
  BudgetRisk,
  AuditTrailEntry,
  ChangeImpactEntry,
  GovernanceReadiness,
} from './pass4-governance.js';

// ── Pass 5: Apex Decision Layer (ADR-037) ──
export { executePass5, PHASE1_GROUP_CONFIGS } from './pass5-decision.js';
export type {
  ConfidenceScoreBreakdown,
  ConfidenceComponent,
  ConfidenceRecommendation,
  Phase1GroupConfig,
  Phase1GroupId,
  Phase1GroupResult,
  Pass5Result,
} from './pass5-decision.js';

// ── Pass 7: Observability & Continuous Learning (ADR-038) ──
export { executePass7, PASS7_WORKSTREAM_CONFIGS } from './pass7-observability.js';
export type {
  HealthCheck,
  HealthStatus,
  TelemetryConfig,
  TelemetryMetric,
  MetricCategory,
  DashboardSpec,
  DashboardPanel,
  AlertRule,
  AlertSeverity,
  DiagnosticReport,
  PostMortem,
  Incident,
  IncidentSeverity,
  LearnedPattern,
  PatternType,
  Verdict,
  FeedbackEntry,
  FeedbackType,
  LearningCycleResult,
  LearningStep,
  Pass7Phase,
  Pass7WorkstreamConfig,
  Pass7WorkstreamId,
  Pass7WorkstreamResult,
  Pass7Result,
} from './pass7-observability.js';

// ── Artifact Assembler (ADR-034) ──
export { ArtifactAssembler, ARTIFACT_DEFINITIONS } from './artifact-assembler.js';
export type { ArtifactDefinition, AssembleOptions } from './artifact-assembler.js';

// ── Artifact Renderers (ADR-034) ──
export { ARTIFACT_RENDERERS } from './artifact-renderers.js';
export type { RenderContext, ArtifactRenderer } from './artifact-renderers.js';

// ── Pass Registry ──
export {
  ENTERPRISE_PASS_CONFIGS,
  getPassConfig,
  getAllPassConfigs,
  getTotalUniqueAgents,
  getAllUniqueAgents,
} from './pass-registry.js';

// ── Types ──
export type {
  // Pipeline
  EnterprisePass,
  PassNumber,
  PassStatus,
  EnterprisePipelineMode,
  EnterprisePipelineOptions,
  EnterprisePipelineResult,
  PassOutput,
  ExitCriteriaResult,
  CriterionCheck,
  // Agents
  AgentRef,
  AgentInvocationResult,
  // DecisionGraph
  DecisionNodeType,
  EdgeRelation,
  DecisionGraphNode,
  DecisionGraphEdge,
  // Provenance
  TraceRecord,
  CodeProvenance,
  // Pass Config
  PassAgentConfig,
  // Artifacts
  ArtifactNumber,
  ArtifactStatus,
  ArtifactEntry,
  DecisionPackage,
} from './types.js';

export { PASS_ID_MAP, PASS_NUMBER_MAP } from './types.js';
