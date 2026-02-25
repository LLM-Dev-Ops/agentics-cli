/**
 * Pipeline Types
 *
 * Type definitions for the prototype-to-production pipeline.
 * Supports two modes: 'autonomous' (end-to-end) and 'human-in-the-loop' (approval gates).
 */

// ============================================================================
// Pipeline Configuration
// ============================================================================

export type PipelineMode = 'autonomous' | 'human-in-the-loop';

export type PipelineStage =
  | 'prototype-decision'
  | 'deep-research'
  | 'sparc-development'
  | 'adr-ddd-generation'
  | 'prompt-generation'
  | 'ruvflow-execution';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ============================================================================
// Pipeline Context (shared state across stages)
// ============================================================================

export interface PipelineContext {
  /** Execution ID from ruvector or correlation ID */
  executionId: string;
  /** Original user query */
  query: string;
  /** Raw simulation result */
  simulationResult: unknown;
  /** Platform agent results (risk-score, executive-summary, decision-memo) */
  platformAnalysis: unknown[];
  /** Path to artifacts directory (~/.agentics/runs/<run-id>/) */
  artifactsDir: string;
  /** Pipeline mode: autonomous or human-in-the-loop */
  mode: PipelineMode;
  /** Accumulated outputs from completed stages */
  stageOutputs: Map<PipelineStage, StageOutput>;
  /** User feedback per stage (for revision loops in HITL mode) */
  userFeedback: Map<PipelineStage, string[]>;
  /** User-provided context from deep research questions */
  userContext: UserContext;
}

export interface UserContext {
  erpSystem?: string;
  techStack?: string[];
  teamSize?: string;
  timeline?: string;
  additionalNotes?: string;
  [key: string]: unknown;
}

// ============================================================================
// Stage Output
// ============================================================================

export interface StageOutput {
  stage: PipelineStage;
  status: StageStatus;
  data: unknown;
  /** File paths of artifacts written by this stage */
  artifacts: string[];
  timing: number;
  /** Human-readable summary for approval gate display */
  summary: string;
}

// ============================================================================
// Approval Gate
// ============================================================================

export interface ApprovalResult {
  approved: boolean;
  /** What needs to change (when not approved) */
  feedback?: string;
}

// ============================================================================
// Pipeline Result
// ============================================================================

export interface PipelineResult {
  executionId: string;
  mode: PipelineMode;
  stages: StageOutput[];
  finalStatus: StageStatus;
  outputDir: string;
  totalTiming: number;
}

// ============================================================================
// SPARC Types
// ============================================================================

export interface SPARCOutput {
  specification: {
    requirements: string[];
    constraints: string[];
    successCriteria: string[];
    scope: string;
  };
  pseudocode: {
    algorithms: string[];
    tddAnchors: string[];
    dataStructures: string[];
  };
  architecture: {
    services: ServiceDefinition[];
    boundaries: string[];
    dataFlow: string;
    apiContracts: string[];
  };
  refinement: {
    securityConsiderations: string[];
    performanceTargets: string[];
    testStrategy: string;
  };
  completion: {
    integrationPlan: string;
    documentation: string[];
    monitoringSetup: string[];
  };
}

export interface ServiceDefinition {
  name: string;
  responsibility: string;
  api: string[];
  dependencies: string[];
}

// ============================================================================
// ADR & DDD Types
// ============================================================================

export interface ADRRecord {
  id: string;
  title: string;
  status: 'proposed' | 'accepted' | 'deprecated';
  date: string;
  context: string;
  decision: string;
  alternatives: string[];
  consequences: string[];
}

export interface DDDBoundedContext {
  name: string;
  description: string;
  aggregates: AggregateDefinition[];
  domainEvents: string[];
  commands: string[];
  queries: string[];
}

export interface AggregateDefinition {
  name: string;
  root: string;
  entities: string[];
  valueObjects: string[];
}

export interface DomainModel {
  contexts: DDDBoundedContext[];
  contextMap: ContextRelation[];
}

export interface ContextRelation {
  upstream: string;
  downstream: string;
  type: 'partnership' | 'customer-supplier' | 'conformist' | 'anticorruption-layer';
}

// ============================================================================
// Implementation Prompt Types
// ============================================================================

export interface ImplementationPrompt {
  id: string;
  title: string;
  boundedContext: string;
  relatedADRs: string[];
  content: string;
  dependencies: string[];
  order: number;
}

export interface ExecutionPlan {
  prompts: ImplementationPrompt[];
  totalSteps: number;
  estimatedDuration: string;
}
