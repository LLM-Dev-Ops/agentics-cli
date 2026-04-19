/**
 * Ecosystem Capability Graph Routing (ADR-030 + ADR-031)
 *
 * Barrel export for the routing subsystem.
 *
 * Usage:
 *   import { routeQuery } from '../routing/index.js';
 *   const result = routeQuery(userPrompt);
 */

// ============================================================================
// ADR-030: Core Graph Routing
// ============================================================================

export {
  loadEcosystemGraph,
  clearGraphCache,
  resolveGraphPath,
  getCapabilityByName,
  getCapabilitiesByTag,
  getCapabilitiesByStage,
  resolveDependencies,
} from './graph-loader.js';

export type {
  EcosystemGraph,
  CapabilityEntry,
  StageName,
  GraphValidationError,
} from './graph-loader.js';

export {
  classifyCapabilities,
  extractCapabilityNames,
} from './capability-classifier.js';

export type {
  ClassifiedCapability,
  ClassificationResult,
} from './capability-classifier.js';

export {
  routeCapabilities,
  resolveAgentRef,
  toDomainAgentList,
} from './graph-router.js';

export type {
  RoutedAgent,
  StageGroup,
  RoutingResult,
  AgentBudget,
  DomainAgentRef,
} from './graph-router.js';

// ============================================================================
// ADR-031 Phase 1: Weighted Edges
// ============================================================================

export {
  normalizeAgent,
  normalizeAgents,
  getAgentName,
  selectWeightedAgents,
  validateAgentInput,
  isWeightedAgent,
} from './weighted-resolver.js';

export type {
  WeightedAgent,
  AgentInput,
  AgentRole,
  WeightedSelectionOptions,
} from './weighted-resolver.js';

// ============================================================================
// ADR-031 Phase 2: Telemetry Feedback
// ============================================================================

export {
  recordOutcome,
  buildOutcomeRecord,
  loadOutcomes,
  loadRecentOutcomes,
  rotateOutcomes,
  getOutcomesFilePath,
} from './outcome-recorder.js';

export type {
  OutcomeRecord,
  OutcomeStatus,
  AgentContribution,
} from './outcome-recorder.js';

export {
  calculateAdjustedWeights,
  writeWeightOverlay,
  loadWeightOverlay,
  applyWeightOverlay,
  formatAdjustmentReport,
} from './weight-adjuster.js';

export type {
  WeightOverlay,
  WeightAdjustment,
} from './weight-adjuster.js';

// ============================================================================
// ADR-031 Phase 3: Composition Rules
// ============================================================================

export {
  applyCompositions,
  validateCompositionRules,
  detectCompositionCycles,
  formatCompositionExplanation,
} from './composition-engine.js';

export type {
  CompositionRule,
  CompositionOperator,
  CompositionPriority,
  CompositionResult,
  CompositionOptions,
  FiredRule,
} from './composition-engine.js';

// ============================================================================
// ADR-031 Phase 4: Multi-Graph Federation
// ============================================================================

export {
  isFederatedGraph,
  loadFragments,
  federateGraph,
  fragmentToCapabilityEntry,
} from './graph-federation.js';

export type {
  CapabilityFragment,
  FederatedRootGraph,
  FragmentOverride,
  FederationResult,
} from './graph-federation.js';

// ============================================================================
// ADR-031 Phase 5: CI Validation
// ============================================================================

export {
  validateTier1,
  validateTier3,
  formatValidationReport,
} from './graph-validator.js';

export type {
  ValidationTier,
  ValidationSeverity,
  ValidationResult,
  ValidationReport,
} from './graph-validator.js';

// ============================================================================
// ADR-PIPELINE-082: Domain Boundary Resolution
// ============================================================================

export {
  DISAMBIGUATION_RULES,
  TIE_BREAK_RULES,
  resolveDomainBoundary,
  isDomainSuppressed,
  routeKeyword,
} from './domain-boundary.js';

export type {
  DisambiguationRule,
  TieBreakRule,
  BoundaryResolution,
} from './domain-boundary.js';

// ============================================================================
// Convenience: one-call routing
// ============================================================================

import { loadEcosystemGraph } from './graph-loader.js';
import { classifyCapabilities } from './capability-classifier.js';
import { routeCapabilities, toDomainAgentList } from './graph-router.js';
import type { RoutingResult, DomainAgentRef } from './graph-router.js';

export interface RouteQueryResult {
  /** Full routing result with classification, pipeline, and explanation. */
  readonly routing: RoutingResult;
  /** Flat list of domain/agent refs ready for dispatch. */
  readonly agents: readonly DomainAgentRef[];
  /** Whether any capabilities were matched. If false, caller should fall back. */
  readonly matched: boolean;
}

/**
 * Route a natural language query through the ecosystem capability graph.
 *
 * This is the primary entry point for graph-based routing. It:
 * 1. Loads the graph (cached after first load)
 * 2. Classifies the prompt into capabilities
 * 3. Applies composition rules (ADR-031 Phase 3)
 * 4. Resolves dependencies
 * 5. Builds a stage-ordered agent pipeline with weighted selection (ADR-031 Phase 1)
 * 6. Returns domain/agent refs for dispatch
 *
 * If no capabilities match, returns { matched: false } so the caller
 * can fall back to full-fleet dispatch.
 */
export function routeQuery(prompt: string, graphPath?: string): RouteQueryResult {
  const graph = loadEcosystemGraph({ graphPath });
  const classification = classifyCapabilities(prompt, graph);
  const routing = routeCapabilities(classification, graph);
  const agents = toDomainAgentList(routing);

  return {
    routing,
    agents,
    matched: routing.totalAgents > 0,
  };
}
