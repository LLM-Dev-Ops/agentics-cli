/**
 * Phase 2 Pipeline Type Definitions
 *
 * Complete type system for the Phase 2 pipeline: research-dossier compilation,
 * SPARC development (with dossier cross-refs), ADR generation, DDD modeling,
 * and London-School TDD plan generation.
 *
 * All types are designed for strict TypeScript (strict: true, ES2022 target,
 * NodeNext modules). Interfaces use index signatures where extensibility is
 * required and literal union types where values are constrained.
 */

// ============================================================================
// Phase 1 Input Types (loaded from disk)
// ============================================================================

/**
 * Manifest written by Phase 1, describing the run and its outputs.
 */
export interface Phase1Manifest {
  readonly run_id: string;
  readonly execution_id: string;
  readonly correlation_id: string;
  readonly query: string;
  readonly created_at: string;
  readonly timing_ms: number;
  readonly agents_invoked: ReadonlyArray<{
    domain: string;
    agent: string;
    status: string;
  }>;
  readonly artifacts: string[];
  readonly schema_version: string;
}

/**
 * Scenario artifact produced by Phase 1 simulation agents.
 */
export interface ScenarioArtifact {
  readonly query: string;
  readonly scenario_type?: string;
  readonly stakeholders?: string[];
  readonly constraints?: string[];
  readonly timeline?: string;
  readonly success_criteria?: string[];
  [key: string]: unknown;
}

/**
 * Roadmap artifact produced by Phase 1 planning agents.
 */
export interface RoadmapArtifact {
  readonly phases: ReadonlyArray<{
    name: string;
    duration?: string;
    deliverables?: string[];
    dependencies?: string[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Risk assessment artifact produced by Phase 1 platform agents.
 */
export interface RiskAssessmentArtifact {
  readonly risk_factors: ReadonlyArray<{
    id: string;
    category: string;
    description: string;
    severity: string;
    likelihood: string;
    mitigation: string;
    [key: string]: unknown;
  }>;
  readonly overall_risk_level: string;
  [key: string]: unknown;
}

/**
 * Aggregated set of Phase 1 artifacts consumed by the Phase 2 pipeline.
 */
export interface Phase1Artifacts {
  readonly manifest: Phase1Manifest;
  readonly scenario: ScenarioArtifact;
  readonly roadmap: RoadmapArtifact;
  readonly executiveSummary: string;
  readonly riskAssessment: RiskAssessmentArtifact;
  readonly decisionMemo: string;
}

// ============================================================================
// Research Dossier Types
// ============================================================================

/** Source artifact from which a dossier item was extracted. */
export type DossierItemSource =
  | 'scenario'
  | 'roadmap'
  | 'executive-summary'
  | 'risk-assessment'
  | 'decision-memo';

/** Semantic category for a dossier item. */
export type DossierItemCategory =
  | 'requirement'
  | 'constraint'
  | 'risk'
  | 'stakeholder'
  | 'timeline'
  | 'success-criterion'
  | 'recommendation'
  | 'decision-rationale';

/**
 * A single extracted item in the research dossier.
 * IDs follow the format RD-001, RD-002, etc.
 */
export interface DossierItem {
  /** Unique identifier in RD-NNN format (e.g. RD-001). */
  readonly id: string;
  readonly source: DossierItemSource;
  readonly category: DossierItemCategory;
  readonly title: string;
  readonly content: string;
  readonly severity?: string;
  readonly phase?: string;
}

/**
 * A directional cross-reference between two dossier items.
 */
export interface DossierCrossReference {
  readonly fromId: string;
  readonly toId: string;
  readonly relationship:
    | 'mitigates'
    | 'depends-on'
    | 'constrains'
    | 'supports'
    | 'conflicts-with';
}

/**
 * Statistical summary of the research dossier.
 */
export interface DossierSummary {
  readonly totalItems: number;
  readonly bySource: Record<string, number>;
  readonly byCategory: Record<string, number>;
  readonly keyRisks: string[];
  readonly criticalConstraints: string[];
}

/**
 * The complete research dossier compiled from Phase 1 artifacts.
 * Serves as the single source of truth for downstream SPARC, ADR,
 * DDD, and TDD generation stages.
 */
export interface ResearchDossier {
  readonly id: string;
  readonly traceId: string;
  readonly generatedFrom: string;
  readonly items: DossierItem[];
  readonly crossReferences: DossierCrossReference[];
  readonly summary: DossierSummary;
}

// ============================================================================
// SPARC Types (enhanced with dossier cross-references)
// ============================================================================

/**
 * A requirement extracted during the Specification phase.
 * IDs follow the format SPEC-REQ-NNN.
 */
export interface Phase2Requirement {
  readonly id: string;
  readonly text: string;
  readonly dossierItemRefs: string[];
  readonly priority: 'must' | 'should' | 'could';
}

/** A constraint identified during the Specification phase. */
export interface Phase2Constraint {
  readonly id: string;
  readonly text: string;
  readonly dossierItemRefs: string[];
}

/** A measurable success criterion for the Specification phase. */
export interface Phase2SuccessCriterion {
  readonly id: string;
  readonly text: string;
  readonly dossierItemRefs: string[];
  readonly measurable: boolean;
}

/**
 * SPARC Specification output with dossier traceability.
 */
export interface Phase2Specification {
  readonly requirements: Phase2Requirement[];
  readonly constraints: Phase2Constraint[];
  readonly successCriteria: Phase2SuccessCriterion[];
  readonly scope: string;
  /** Fraction of dossier items referenced (0.0 - 1.0). */
  readonly dossierCoverage: number;
}

/**
 * A pseudocode module describing algorithms and data structures.
 * IDs follow the format PC-MOD-NNN.
 */
export interface Phase2PseudocodeModule {
  readonly id: string;
  readonly name: string;
  readonly algorithms: string[];
  /** Fenced pseudocode block with real control flow, types, and error handling. */
  readonly markdown: string;
  readonly tddAnchors: string[];
  readonly dataStructures: string[];
  readonly dossierItemRefs: string[];
}

/** SPARC Pseudocode output. */
export interface Phase2Pseudocode {
  readonly modules: Phase2PseudocodeModule[];
}

/**
 * A service definition for the Architecture phase.
 * IDs follow the format SVC-NNN.
 */
export interface Phase2ServiceDefinition {
  readonly id: string;
  readonly name: string;
  readonly responsibility: string;
  readonly api: string[];
  readonly dependencies: string[];
  readonly dossierItemRefs: string[];
}

/**
 * SPARC Architecture output with service boundaries, data flow,
 * API contracts, and security boundaries.
 */
export interface Phase2Architecture {
  readonly services: Phase2ServiceDefinition[];
  readonly boundaries: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    dossierItemRefs: string[];
  }>;
  readonly dataFlow: string;
  readonly apiContracts: string[];
  readonly securityBoundaries: string[];
}

/** SPARC Refinement output with security and performance cross-refs. */
export interface Phase2Refinement {
  readonly securityConsiderations: ReadonlyArray<{
    id: string;
    text: string;
    dossierItemRefs: string[];
  }>;
  readonly performanceTargets: ReadonlyArray<{
    id: string;
    text: string;
    dossierItemRefs: string[];
  }>;
  readonly testStrategy: string;
}

/** SPARC Completion output with integration, docs, and monitoring. */
export interface Phase2Completion {
  readonly integrationPlan: string;
  readonly documentation: string[];
  readonly monitoringSetup: string[];
}

/**
 * Full SPARC output for Phase 2, covering all five phases:
 * Specification, Pseudocode, Architecture, Refinement, Completion.
 */
export interface Phase2SPARCOutput {
  readonly specification: Phase2Specification;
  readonly pseudocode: Phase2Pseudocode;
  readonly architecture: Phase2Architecture;
  readonly refinement: Phase2Refinement;
  readonly completion: Phase2Completion;
}

// ============================================================================
// ADR Types (enhanced with cross-references)
// ============================================================================

/** An alternative considered in an ADR. */
export interface Phase2ADRAlternative {
  readonly option: string;
  readonly rationale: string;
  readonly rejected: boolean;
}

/** A consequence of adopting an ADR decision. */
export interface Phase2ADRConsequence {
  readonly description: string;
  readonly type: 'positive' | 'negative' | 'neutral';
}

/**
 * An Architecture Decision Record for Phase 2.
 * IDs follow the format ADR-P2-NNN.
 *
 * ADR-PIPELINE-100 (markdown-direct ADRs):
 *   `rawMarkdown` is the canonical form when the LLM emits markdown directly.
 *   Structured fields (title, context, decision, alternatives, consequences)
 *   are best-effort extracts for downstream consumers that still expect them.
 *   When `rawMarkdown` is non-empty the renderer writes it verbatim instead of
 *   re-serialising from the structured fields.
 */
export interface Phase2ADRRecord {
  readonly id: string;
  readonly title: string;
  readonly status: 'proposed' | 'accepted' | 'deprecated' | 'failed';
  readonly date: string;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: Phase2ADRAlternative[];
  readonly consequences: Phase2ADRConsequence[];
  /** References to SPARC sections that informed this decision. */
  readonly sparcSectionRefs: string[];
  /** References to research dossier items that informed this decision. */
  readonly researchDossierItemRefs: string[];
  /** ID of the ADR this record supersedes, if any. */
  readonly supersedes?: string;
  /** Originating simulation ID for lineage tracing (ADR-PIPELINE-018). */
  readonly simulationId?: string;
  /**
   * Full markdown body of the ADR (ADR-PIPELINE-100 §D1).
   * When set, this is the canonical artifact written to disk; the structured
   * fields above become best-effort metadata extracted from it.
   */
  readonly rawMarkdown?: string;
  /**
   * Build-phase tags driving phase-aware ADR injection in implementation
   * prompts (ADR-PIPELINE-100 §D4). Common values: 'foundation', 'domain',
   * 'integration', 'api', 'deployment', 'operations', 'cross-cutting'.
   */
  readonly phaseTags?: string[];
}

// ============================================================================
// DDD Types (with ubiquitous language)
// ============================================================================

/** An entity within an aggregate. */
export interface Phase2Entity {
  readonly name: string;
  readonly description: string;
}

/** A value object within an aggregate, including its invariants. */
export interface Phase2ValueObject {
  readonly name: string;
  readonly description: string;
  readonly invariants: string[];
}

/** An aggregate definition including its root, entities, and value objects. */
export interface Phase2AggregateDefinition {
  readonly name: string;
  readonly root: string;
  readonly entities: Phase2Entity[];
  readonly valueObjects: Phase2ValueObject[];
  readonly invariants: string[];
}

/** A domain event that signals something meaningful happened. */
export interface Phase2DomainEvent {
  readonly name: string;
  readonly description: string;
  readonly payload: string[];
  readonly triggeredBy: string;
}

/** A command that expresses intent to change domain state. */
export interface Phase2Command {
  readonly name: string;
  readonly description: string;
  readonly input: string[];
  readonly preconditions: string[];
  readonly postconditions: string[];
}

/** A query that retrieves domain state without side effects. */
export interface Phase2Query {
  readonly name: string;
  readonly description: string;
  readonly parameters: string[];
  readonly returns: string;
}

/** A term in the ubiquitous language glossary for a bounded context. */
export interface UbiquitousLanguageTerm {
  readonly term: string;
  readonly definition: string;
  readonly context: string;
  readonly aliases: string[];
}

/**
 * A DDD bounded context containing aggregates, events, commands,
 * queries, and a ubiquitous language glossary.
 */
/** DDD subdomain classification for a bounded context. */
export type SubdomainType = 'core' | 'supporting' | 'generic';

export interface Phase2DDDBoundedContext {
  readonly name: string;
  readonly description: string;
  readonly aggregates: Phase2AggregateDefinition[];
  readonly domainEvents: Phase2DomainEvent[];
  readonly commands: Phase2Command[];
  readonly queries: Phase2Query[];
  readonly ubiquitousLanguage: UbiquitousLanguageTerm[];
  /** References to ADRs relevant to this bounded context. */
  readonly adrRefs: string[];
  /** Subdomain classification: core, supporting, or generic. */
  readonly subdomain?: SubdomainType;
  /** Context type: 'intelligence' for ML/analytics contexts, 'crud' for standard data management. */
  readonly contextType?: 'intelligence' | 'crud';
}

/**
 * A relationship between two bounded contexts in the context map.
 */
export interface Phase2ContextRelation {
  readonly upstream: string;
  readonly downstream: string;
  readonly type:
    | 'partnership'
    | 'customer-supplier'
    | 'conformist'
    | 'anticorruption-layer'
    | 'open-host-service'
    | 'shared-kernel'
    | 'published-language';
  readonly description: string;
  /** Integration pattern used at this boundary (e.g. ACL, OHS, event-driven). */
  readonly integration_pattern?: string;
  /** Events/commands that cross this context boundary. */
  readonly data_flows?: string[];
  /** Anti-corruption strategy when applicable. */
  readonly anti_corruption_strategy?: string;
}

/**
 * The complete DDD domain model for Phase 2, including bounded contexts,
 * context map, and a project-wide ubiquitous language glossary.
 */
export interface Phase2DomainModel {
  readonly contexts: Phase2DDDBoundedContext[];
  readonly contextMap: Phase2ContextRelation[];
  readonly ubiquitousLanguageGlossary: UbiquitousLanguageTerm[];
  /** Full user scenario query — preserved for Ruflo swarm domain extraction. */
  readonly scenarioQuery?: string;
}

// ============================================================================
// TDD Types (London School)
// ============================================================================

/** Count and percentage for a single test pyramid level. */
export interface TestPyramidLevel {
  readonly count: number;
  readonly percentage: number;
}

/** Distribution of tests across the testing pyramid. */
export interface TestPyramid {
  readonly unit: TestPyramidLevel;
  readonly integration: TestPyramidLevel;
  readonly acceptance: TestPyramidLevel;
  readonly e2e: TestPyramidLevel;
}

/**
 * A single test case following Given-When-Then structure.
 * IDs follow the format TC-NNN.
 */
export interface TDDTestCase {
  readonly id: string;
  readonly name: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly mockSetup: string[];
  readonly assertionType: 'behavior' | 'interaction' | 'state';
}

/**
 * A test suite grouping related test cases by bounded context and layer.
 * IDs follow the format TS-NNN.
 */
export interface TDDTestSuite {
  readonly id: string;
  readonly boundedContext: string;
  readonly layer: 'unit' | 'integration' | 'acceptance' | 'e2e';
  readonly name: string;
  readonly description: string;
  readonly tests: TDDTestCase[];
  readonly mockDependencies: string[];
  /** References to ADRs that drove this test suite. */
  readonly adrRefs: string[];
}

/** A method on a mock contract interface. */
export interface MockContractMethod {
  readonly name: string;
  readonly input: string;
  readonly output: string;
  readonly behavior: string;
}

/**
 * A mock contract defining the interface boundary for a dependency.
 * IDs follow the format MC-NNN.
 */
export interface MockContract {
  readonly id: string;
  readonly name: string;
  readonly boundedContext: string;
  readonly targetService: string;
  readonly interfaceName: string;
  readonly methods: MockContractMethod[];
}

/**
 * A seam definition describing the boundary between two components
 * and how it should be tested.
 * IDs follow the format SEAM-NNN.
 */
export interface SeamDefinition {
  readonly id: string;
  readonly name: string;
  readonly between: readonly [string, string];
  readonly contractType:
    | 'sync-request-response'
    | 'async-event'
    | 'shared-data';
  readonly mockBoundary: string;
  readonly integrationTestApproach: string;
}

/**
 * The complete TDD plan for Phase 2, following London School (mockist)
 * test-driven development principles.
 */
export interface TDDPlan {
  readonly approach: 'london-school';
  readonly testPyramid: TestPyramid;
  readonly testSuites: TDDTestSuite[];
  readonly mockContracts: MockContract[];
  readonly seamDefinitions: SeamDefinition[];
  /** Ordered list of test suite IDs for execution sequencing. */
  readonly executionOrder: string[];
}

// ============================================================================
// Pipeline Context Types
// ============================================================================

/** The stages that the Phase 2 pipeline executes in order. */
export type Phase2Stage =
  | 'artifact-loading'
  | 'research-dossier'
  | 'sparc-specification'
  | 'adr-generation'
  | 'ddd-generation'
  | 'tdd-plan-generation'
  | 'prompt-generation';

/** Output produced by a single Phase 2 pipeline stage. */
export interface Phase2StageOutput {
  readonly stage: Phase2Stage;
  readonly status: 'completed' | 'failed';
  readonly data: unknown;
  readonly artifacts: string[];
  readonly timing: number;
  readonly summary: string;
}

/**
 * An OpenTelemetry-inspired span for tracking Phase 2 pipeline operations.
 */
export interface TelemetrySpan {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly stage: string;
  readonly operation: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly durationMs?: number;
  readonly status: 'ok' | 'error';
  readonly attributes: Record<string, string | number | boolean>;
}

/**
 * Mutable pipeline context threaded through all Phase 2 stages.
 * Accumulates stage outputs and telemetry as the pipeline progresses.
 */
export interface Phase2Context {
  readonly traceId: string;
  readonly phase1Dir: string;
  readonly phase2Dir: string;
  readonly phase1Artifacts: Phase1Artifacts;
  readonly stageOutputs: Map<Phase2Stage, Phase2StageOutput>;
  readonly telemetrySpans: TelemetrySpan[];
}

/** A hashed artifact reference in the Phase 2 manifest. */
export interface Phase2ManifestArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

/** Summary of a single stage in the Phase 2 manifest. */
export interface Phase2ManifestStage {
  readonly stage: Phase2Stage;
  readonly status: string;
  readonly timing_ms: number;
  readonly artifact_count: number;
}

/**
 * The Phase 2 manifest written to disk at the end of a successful run.
 * Provides a complete record of all stages, artifacts, and timings.
 */
export interface Phase2Manifest {
  readonly schema_version: '2.0.0';
  readonly trace_id: string;
  readonly phase1_run_id: string;
  readonly generated_at: string;
  readonly pipeline_version: string;
  readonly stages: Phase2ManifestStage[];
  readonly artifacts: Phase2ManifestArtifact[];
  readonly total_timing_ms: number;
  readonly deterministic: boolean;
}

/**
 * The final result returned by the Phase 2 pipeline after all stages
 * have completed (or the first stage has failed).
 */
export interface Phase2PipelineResult {
  readonly traceId: string;
  readonly phase2Dir: string;
  readonly manifest: Phase2Manifest;
  readonly stageResults: Phase2StageOutput[];
  readonly totalTiming: number;
}
