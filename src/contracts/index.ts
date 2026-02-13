/**
 * Contract Exports
 *
 * PURPOSE: Re-export contract validation functionality.
 * All schemas now come from @agentics/contracts - the canonical source.
 *
 * PRINCIPLES:
 * - Contracts are the SOLE source of truth
 * - All validation uses canonical schemas from @agentics/contracts
 * - No fallback logic or guessing
 * - Invalid payloads fail immediately
 *
 * EXECUTION PROOF REQUIREMENTS:
 * All responses MUST include:
 * 1. execution_metadata - proves execution graph participation
 * 2. Multi-layer proof (layers_executed OR execution_graph)
 */

// Export validator and types
export {
  validateRequest,
  validateResponse,
  safeValidateRequest,
  safeValidateResponse,
  ContractValidationError,
  RequestSchemas,
  ResponseSchemas,
} from './validator.js';

export type {
  ValidationResult,
} from './validator.js';

// ADR-001: Command Argument Semantics & Synthesis Governance
export {
  COMMAND_REGISTRY,
  lookupCommand,
  getSubcommands,
  isSynthesisAllowed,
  isCommitmentGrade,
  classifyArgument,
  validateArgument,
  type ArgumentType,
  type SynthesisClass,
  type ArgumentSpec,
  type CommandSpec,
  ADR_SCHEMA_VERSION,
} from './adr-command-semantics.js';

// ADR-002: Operational Enforcement of CLI Governance
export {
  ADR_002_ID,
  ADR_002_TITLE,
  ADR_002_STATUS,
  ADR_002_DATE,
  GATE_PIPELINE,
  GATE_EXEMPT_COMMANDS,
  CI_CHECK_IDS,
} from './adr-002-operational-enforcement.js';

// ADR-003: Governance Architecture (conceptual — metadata only)
export {
  ADR_003_ID,
  ADR_003_TITLE,
  ADR_003_STATUS,
  ADR_003_DATE,
} from './adr-003-governance-architecture.js';

// ADR-004: Enterprise Integration & Memory Architecture (conceptual — metadata only)
export {
  ADR_004_ID,
  ADR_004_TITLE,
  ADR_004_STATUS,
  ADR_004_DATE,
} from './adr-004-enterprise-integration-memory.js';

// ADR-005: System Coherence, Drift Detection, and Self-Governance
export {
  // Metadata
  ADR_005_ID,
  ADR_005_TITLE,
  ADR_005_STATUS,
  ADR_005_DATE,
  // Types
  type CoherenceDomain,
  type DriftCategory,
  type CoherenceViolationType,
  type SelfManagementCapability,
  type ProhibitedAutonomy,
  type ActionBoundary,
  // Interfaces
  type CoherenceState,
  type CoherenceViolation,
  type DriftObservation,
  type ContextSnapshot,
  type ContextDifference,
  type DriftReport,
  type ActionClassification,
  type InvariantCheckResult,
  // Constants
  COHERENCE_INVARIANTS,
  COHERENCE_DOMAINS,
  DRIFT_CATEGORIES,
  SELF_MANAGEMENT_CAPABILITIES,
  PROHIBITED_AUTONOMY,
  ACTION_BOUNDARIES,
  // Functions
  classifyAction,
  isObservation,
  isAutonomous,
  isProhibitedAction,
  validateActionBoundary,
} from './adr-005-system-coherence-drift-self-governance.js';

// Re-export contract types from validator (request/response contracts)
export type {
  PlanRequestContract,
  ManifestsRequestContract,
  SimulateRequestContract,
  InspectRequestContract,
  QuantifyRequestContract,
  DeployRequestContract,
  ExportRequestContract,
  DiligenceRequestContract,
  ExecutionMetadata,
  LayerExecutionRecord,
} from './validator.js';

// Re-export canonical schemas from agentics-contracts (SOLE schema authority)
export {
  validateExecutionContext,
  validateResultPacket,
  executionContextSchema,
  resultPacketSchema,
  executionGraphSchema,
  simulationRequestSchema,
} from './canonical.js';

export type {
  ExecutionContext,
  SimulationRequest,
  ResultPacket,
  ExecutionGraph,
} from './canonical.js';
