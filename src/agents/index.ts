/**
 * Agent Module Exports
 *
 * CONSTITUTION REFERENCE: PROMPT 0, PROMPT 3
 *
 * This module provides the public API for CLI UX Agent infrastructure.
 *
 * ARCHITECTURE:
 * - types.ts: All type definitions including DecisionEvent schema
 * - decision-event.ts: DecisionEvent and telemetry emission
 * - cli-ux-agent.ts: CLI UX Agent implementation
 */

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Agent Identity
  AgentClassification,
  AgentIdentifier,

  // DecisionEvent Schema
  DecisionType,
  ConfidenceScore,
  ConfidenceBasis,
  ConfidenceComponent,
  ConstraintsApplied,
  EnvironmentContext,
  ScopeLimitation,
  DecisionEvent,
  DecisionOutputs,
  ExecutionReference,

  // CLI UX Agent Contract
  CLIUXAgentInput,
  CLIUXAgentOutput,
  ParsedCommand,
  AgentContext,
  OutputFormat,
  AgentResult,
  SuccessResult,
  ErrorResult,
  GuidanceResult,
  GuidanceOption,
  TimingInfo,

  // Agent Registry
  AgentRegistration,
  FailureMode,

  // Telemetry
  TelemetryEvent,
  TelemetryEventType,
  TelemetryData,
  InvocationTelemetry,
  CompletionTelemetry,
  ServiceCallTelemetry,
  ValidationTelemetry,
  ErrorTelemetry,
} from './types.js';

// ============================================================================
// Constant Exports
// ============================================================================

export {
  CLI_UX_AGENT_ID,
  CLI_UX_AGENT_VERSION,
  CLI_UX_AGENT_CLASSIFICATION,
  INVOCABLE_SERVICES,
  NON_RESPONSIBILITIES,
} from './types.js';

// ============================================================================
// Type Guard Exports
// ============================================================================

export {
  isSuccessResult,
  isErrorResult,
  isGuidanceResult,
} from './types.js';

// ============================================================================
// DecisionEvent Exports
// ============================================================================

export type {
  DecisionEventBuilderOptions,
  DecisionEventEmitterConfig,
  EmissionResult,
  TelemetryEmitterConfig,
} from './decision-event.js';

export {
  DecisionEventBuilder,
  DecisionEventEmitter,
  TelemetryEmitter,
  createDecisionEventBuilder,
  createDecisionEventEmitter,
  createTelemetryEmitter,
} from './decision-event.js';

// ============================================================================
// CLI UX Agent Exports
// ============================================================================

export type {
  ICLIUXAgent,
  CLIUXAgentConfig,
  ValidationResult,
  ValidationError,
} from './cli-ux-agent.js';

export {
  CLIUXAgent,
  CLI_UX_AGENT_REGISTRATION,
  createCLIUXAgent,
  getCLIUXAgentRegistration,
} from './cli-ux-agent.js';
