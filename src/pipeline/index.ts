/**
 * Pipeline — Prototype-to-Production Pipeline
 *
 * Public API for the 6-stage pipeline:
 *   1. Decision Gate (proceed to prototype?)
 *   2. Deep Research (tech stack questions + agent research)
 *   3. SPARC Development (Specification, Pseudocode, Architecture, Refinement, Completion)
 *   4. ADR & DDD Generation
 *   5. Prompt Generation (from ADRs + DDDs)
 *   6. RuvFlow Execution (implement prompts via Claude-Flow)
 *
 * Supports two modes:
 *   - 'autonomous': end-to-end without stopping
 *   - 'human-in-the-loop': approval gates at each stage with revision loops
 */

export { executePipeline } from './pipeline-coordinator.js';
export type {
  PipelineContext,
  PipelineResult,
  PipelineMode,
  PipelineStage,
  StageOutput,
  ApprovalResult,
  UserContext,
} from './types.js';

export {
  initSwarm,
  dispatchPhaseAgents,
  storePhaseArtifacts,
  reviewPhaseOutput,
  recordPhaseFailure,
  shutdownSwarm,
  getSwarmStatus,
  isClaudeFlowAvailable,
  PHASE_AGENTS,
} from './swarm-orchestrator.js';
export type { SwarmConfig, SwarmPhaseConfig, PhaseAgent, SwarmStatus, AgenticsServiceCall, AgenticsServiceResult } from './swarm-orchestrator.js';
