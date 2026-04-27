/**
 * Pipeline Types
 *
 * Type definitions for the prototype-to-production pipeline.
 * Supports two modes: 'autonomous' (end-to-end) and 'human-in-the-loop' (approval gates).
 */

import { z } from 'zod';

// ============================================================================
// ADR-PIPELINE-066: Unit Economics Manifest
// ============================================================================
//
// Schema for `.agentics/runs/<run-id>/unit-economics.json`, the machine-
// readable contract between the generated prototype and the executive
// renderer. When present, renderers MUST prefer these numbers over
// per-employee heuristics.

export const DomainUnitSchema = z.object({
  label: z.string().min(1),  // "occupied room night"
  abbrev: z.string().min(1), // "orn"
});
export type DomainUnit = z.infer<typeof DomainUnitSchema>;

export const UnitEconomicsScopeSchema = z.object({
  properties: z.number().int().nonnegative().optional(),
  rooms: z.number().int().nonnegative().optional(),
  sqft: z.number().nonnegative().optional(),
  vehicles: z.number().int().nonnegative().optional(),
  beds: z.number().int().nonnegative().optional(),
  agents: z.number().int().nonnegative().optional(),
  units: z.number().nonnegative().optional(),
  employees: z.number().int().nonnegative().optional(),
  region_mix: z.array(z.enum(['NA', 'EMEA', 'APAC', 'LATAM', 'MEA'])).default([]),
});
export type UnitEconomicsScope = z.infer<typeof UnitEconomicsScopeSchema>;

export const UnitSavingsSchema = z.record(z.string(), z.number());
export type UnitSavings = z.infer<typeof UnitSavingsSchema>;

export const UnitEconomicsConfidenceSchema = z.object({
  directional: z.number().min(0).max(1),
  precision: z.number().min(0).max(1),
});
export type UnitEconomicsConfidence = z.infer<typeof UnitEconomicsConfidenceSchema>;

export const UnitEconomicsSchema = z.object({
  run_id: z.string().min(1),
  sector: z.string().min(1),
  domain_unit: DomainUnitSchema,
  measured_scope: UnitEconomicsScopeSchema,
  enterprise_scope: UnitEconomicsScopeSchema,
  unit_savings: UnitSavingsSchema,
  annual_measured_savings_usd: z.number().nonnegative(),
  annual_extrapolated_savings_usd: z.number().nonnegative(),
  extrapolation_method: z.string().min(1),
  confidence: UnitEconomicsConfidenceSchema,
  generated_at: z.string().optional(),
  /**
   * ADR-PIPELINE-072: two valid sources. `prototype-preview` is written by
   * the pre-render pass BEFORE the coding agent builds the real prototype,
   * so the executive renderer's ADR-066 tier-1 path fires on every run.
   * The real prototype overwrites with `prototype` when its demo runs; a
   * reconciler (ADR-072 §5) compares the two and emits a drift warning if
   * they disagree by more than ±25%.
   */
  source: z.enum(['prototype-preview', 'prototype']).default('prototype'),
});
export type UnitEconomics = z.infer<typeof UnitEconomicsSchema>;

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
  status: 'proposed' | 'accepted' | 'deprecated' | 'failed';
  date: string;
  context: string;
  decision: string;
  alternatives: string[];
  consequences: string[];
  /**
   * Build-phase tags driving phase-aware ADR injection in implementation
   * prompts (ADR-PIPELINE-100 §D4). Common values: 'foundation', 'domain',
   * 'integration', 'api', 'deployment', 'operations', 'cross-cutting'.
   */
  phaseTags?: string[];
  /**
   * Relative path (from the run directory) to the canonical ADR markdown
   * file (ADR-PIPELINE-100 §D4). Implementation prompts cite ADRs by this
   * path so downstream code generation reads source-of-truth instead of
   * paraphrased copies.
   */
  filePath?: string;
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
