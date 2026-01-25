/**
 * Output Format Gate Module
 *
 * CONTROL PLANE HARDENING
 *
 * PURPOSE: Enforce strict JSON-only output for CLI operations.
 *          CLI MUST NOT produce narrative output for operational commands.
 *
 * CRITICAL REQUIREMENTS:
 * - Enforce strict JSON outputs
 * - Never allow narrative output
 * - Validate output format before rendering
 *
 * FORBIDDEN:
 * - Narrative/prose output
 * - Unstructured text responses
 * - Human-readable summaries (for operational commands)
 */

import { EXIT_CODES, type OutputFormat } from '../types/index.js';

// ============================================================================
// Output Format Gate Configuration
// ============================================================================

/**
 * Allowed output formats for operational commands.
 * Only structured formats are permitted.
 */
const ALLOWED_STRUCTURED_FORMATS: ReadonlySet<OutputFormat> = new Set([
  'json',
  'yaml',
]);

/**
 * Exit code for invalid output format.
 */
export const INVALID_FORMAT_EXIT_CODE = EXIT_CODES.DATA_FORMAT_ERROR;

// ============================================================================
// Output Format Gate Error
// ============================================================================

export class InvalidOutputFormatError extends Error {
  readonly requestedFormat: string;
  readonly allowedFormats: string[];

  constructor(requestedFormat: string, allowedFormats: string[]) {
    super(
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  INVALID OUTPUT FORMAT\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `\n` +
      `  Requested format: ${requestedFormat}\n` +
      `  Allowed formats:  ${allowedFormats.join(', ')}\n` +
      `\n` +
      `  The CLI enforces strict JSON output for operational commands.\n` +
      `  Narrative output formats are not permitted.\n` +
      `\n` +
      `  TO FIX:\n` +
      `\n` +
      `  Use --format json (default) or --format yaml\n` +
      `\n` +
      `  Example:\n` +
      `    agentics plan "my plan" --format json\n` +
      `\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
    );
    this.name = 'InvalidOutputFormatError';
    this.requestedFormat = requestedFormat;
    this.allowedFormats = allowedFormats;
  }
}

// ============================================================================
// Output Format Gate Interface
// ============================================================================

export interface OutputFormatGateResult {
  valid: boolean;
  format: OutputFormat;
  exitCode?: number;
  message?: string;
}

// ============================================================================
// Output Format Gate Implementation
// ============================================================================

/**
 * Validate the requested output format.
 * Only structured formats (json, yaml) are allowed for operational commands.
 */
export function checkOutputFormatGate(
  requestedFormat: OutputFormat | undefined,
  command: string
): OutputFormatGateResult {
  // Default to JSON if no format specified
  const format: OutputFormat = requestedFormat ?? 'json';

  // Check if format is allowed
  if (requiresStructuredOutput(command) && !ALLOWED_STRUCTURED_FORMATS.has(format)) {
    const allowedFormats = Array.from(ALLOWED_STRUCTURED_FORMATS);
    return {
      valid: false,
      format,
      exitCode: INVALID_FORMAT_EXIT_CODE,
      message: new InvalidOutputFormatError(format, allowedFormats).message,
    };
  }

  return {
    valid: true,
    format,
  };
}

/**
 * Enforce the output format gate.
 * Exits the process if an invalid format is requested.
 */
export function enforceOutputFormatGate(
  requestedFormat: OutputFormat | undefined,
  command: string
): OutputFormat {
  const result = checkOutputFormatGate(requestedFormat, command);

  if (!result.valid) {
    console.error(result.message);
    process.exit(result.exitCode);
  }

  return result.format;
}

/**
 * Commands that require structured (JSON/YAML) output.
 * All operational commands require structured output.
 * Identity and meta commands can use any format.
 */
const STRUCTURED_OUTPUT_COMMANDS = new Set([
  'plan',
  'simulate',
  'inspect',
  'quantify',
  'deploy',
  'export',
  'diligence',
  'usage',
  'policy',
  'erp',
]);

/**
 * Check if a command requires structured output.
 */
export function requiresStructuredOutput(command: string): boolean {
  return STRUCTURED_OUTPUT_COMMANDS.has(command);
}

/**
 * Get the default output format for a command.
 * Always returns 'json' for operational commands.
 */
export function getDefaultFormat(command: string): OutputFormat {
  if (requiresStructuredOutput(command)) {
    return 'json';
  }
  return 'text';
}
