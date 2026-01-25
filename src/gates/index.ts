/**
 * Control Plane Hardening Gates Index
 *
 * Centralized execution control for the Agentics CLI.
 * This module contains all gate logic for controlling command execution.
 *
 * GATE ENFORCEMENT ORDER:
 * 1. Execution Gate - Kill-switch (entitlement check)
 * 2. Auth Session Gate - Requires authenticated session
 * 3. Service Health Gate - Validates Ruvector-backed service availability
 * 4. Output Format Gate - Enforces strict JSON output
 *
 * CRITICAL REQUIREMENTS MET:
 * - CLI requires Ruvector-backed services (Service Health Gate)
 * - CLI never executes agents locally (Localhost Safeguard in endpoints.ts)
 * - CLI fails loudly if services misconfigured (All gates fail-fast)
 * - Requires authenticated session (Auth Session Gate)
 * - Validates target service availability (Service Health Gate)
 * - Enforces strict JSON outputs (Output Format Gate)
 * - Never allows narrative output (Output Format Gate)
 */

// Execution Gate - Hard kill-switch
export {
  checkExecutionGate,
  enforceExecutionGate,
  isExecutionEnabled,
  getAllowedCommands,
  resolveEntitlement,
  EXECUTION_BLOCKED_EXIT_CODE,
  type ExecutionGateResult,
  type Entitlement,
} from './execution-gate.js';

// Auth Session Gate - Requires authenticated session
export {
  enforceAuthSessionGate,
  checkAuthSessionGate,
  requiresAuthentication,
  AUTH_REQUIRED_EXIT_CODE,
  AuthSessionRequiredError,
  type AuthSessionGateResult,
} from './auth-session-gate.js';

// Service Health Gate - Validates Ruvector-backed services
export {
  enforceServiceHealthGate,
  checkServiceHealthGate,
  requiresHealthCheck,
  SERVICE_UNAVAILABLE_EXIT_CODE,
  ServiceHealthError,
  type ServiceHealthResult,
  type ServiceHealthGateResult,
} from './service-health-gate.js';

// Output Format Gate - Enforces strict JSON output
export {
  enforceOutputFormatGate,
  checkOutputFormatGate,
  requiresStructuredOutput,
  getDefaultFormat,
  INVALID_FORMAT_EXIT_CODE,
  InvalidOutputFormatError,
  type OutputFormatGateResult,
} from './output-format-gate.js';
