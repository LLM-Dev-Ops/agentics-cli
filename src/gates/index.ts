/**
 * Gates Module
 *
 * Centralized execution control for the Agentics CLI.
 * This module contains all gate logic for controlling command execution.
 */

export {
  checkExecutionGate,
  enforceExecutionGate,
  isExecutionEnabled,
  getAllowedCommands,
  EXECUTION_BLOCKED_EXIT_CODE,
  type ExecutionGateResult,
} from './execution-gate.js';
