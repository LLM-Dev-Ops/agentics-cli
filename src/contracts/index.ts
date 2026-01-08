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

// Re-export canonical types from @agentics/contracts
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
  ExecutionGraph,
} from './validator.js';
