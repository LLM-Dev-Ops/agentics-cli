/**
 * Error Handling Module (Module F)
 *
 * SPARC Architecture Reference: §2.7
 *
 * PURPOSE: Surface errors with context (no recovery)
 *
 * FORBIDDEN:
 * - Error Recovery (NO retry logic)
 * - Error Suppression (NO swallowing errors)
 * - Error Transformation (NO changing error semantics)
 * - Fallback Logic (NO alternative paths on error)
 */

import * as crypto from 'node:crypto';
import type {
  ErrorInfo,
  ErrorCategory,
  ContractViolation,
  ViolationType,
  ExitCode,
} from '../types/index.js';

// ============================================================================
// Base CLI Error Class
// ============================================================================

export class CLIError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details?: Record<string, unknown>;
  readonly timestamp: string;
  readonly module: string;
  readonly correlationId?: string;
  readonly recoverable: boolean;
  readonly exitCode: ExitCode;

  constructor(options: {
    code: string;
    category: ErrorCategory;
    message: string;
    details?: Record<string, unknown>;
    module: string;
    correlationId?: string;
    recoverable?: boolean;
    exitCode?: ExitCode;
    cause?: Error;
  }) {
    super(options.message);
    this.name = 'CLIError';
    this.code = options.code;
    this.category = options.category;
    this.details = options.details;
    this.timestamp = new Date().toISOString();
    this.module = options.module;
    this.correlationId = options.correlationId;
    this.recoverable = options.recoverable ?? false;
    this.exitCode = options.exitCode ?? 1;
    if (options.cause) {
      this.cause = options.cause;
    }
  }

  toErrorInfo(): ErrorInfo {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
      stack: this.stack,
      timestamp: this.timestamp,
      module: this.module,
      correlationId: this.correlationId,
    };
  }
}

// ============================================================================
// Specific Error Classes (SPARC_PSEUDOCODE §4.1)
// ============================================================================

export class ValidationError extends CLIError {
  constructor(options: {
    message: string;
    field?: string;
    expected?: string;
    actual?: string;
    correlationId?: string;
  }) {
    super({
      code: 'ECLI-ARG-002',
      category: 'INPUT_ERROR',
      message: options.message,
      details: {
        field: options.field,
        expected: options.expected,
        actual: options.actual,
      },
      module: 'validation',
      correlationId: options.correlationId,
      recoverable: false,
      exitCode: 100,
    });
    this.name = 'ValidationError';
  }
}

export class ReferenceValidationError extends CLIError {
  constructor(options: {
    refId: string;
    refType: string;
    repository: string;
    reason: string;
    correlationId?: string;
  }) {
    super({
      code: 'ECLI-ARG-003',
      category: 'INPUT_ERROR',
      message: `Reference validation failed: ${options.reason}`,
      details: {
        ref_id: options.refId,
        ref_type: options.refType,
        repository: options.repository,
      },
      module: 'validation',
      correlationId: options.correlationId,
      recoverable: false,
      exitCode: 100,
    });
    this.name = 'ReferenceValidationError';
  }
}

export class ServiceError extends CLIError {
  constructor(options: {
    service: string;
    operation: string;
    type: 'unavailable' | 'timeout' | 'internal_error';
    statusCode?: number;
    upstreamMessage?: string;
    correlationId?: string;
  }) {
    const exitCodes: Record<string, ExitCode> = {
      unavailable: 69,
      timeout: 75,
      internal_error: 140,
    };

    super({
      code: options.type === 'unavailable'
        ? 'ECLI-SVC-001'
        : options.type === 'timeout'
          ? 'ECLI-NET-002'
          : 'ECLI-SVC-002',
      category: options.type === 'timeout' ? 'NETWORK_ERROR' : 'DOWNSTREAM_ERROR',
      message: `Service '${options.service}' ${options.type}: ${options.upstreamMessage ?? 'unknown error'}`,
      details: {
        service: options.service,
        operation: options.operation,
        status_code: options.statusCode,
      },
      module: 'adapter',
      correlationId: options.correlationId,
      recoverable: options.type !== 'internal_error',
      exitCode: exitCodes[options.type] ?? 140,
    });
    this.name = 'ServiceError';
  }
}

export class ContractViolationError extends CLIError {
  readonly violation: ContractViolation;

  constructor(options: {
    service: string;
    expectedContract: string;
    actualResponse: unknown;
    violationType: ViolationType;
    correlationId?: string;
  }) {
    super({
      code: 'ECLI-SVC-003',
      category: 'DOWNSTREAM_ERROR',
      message: `Contract violation from service '${options.service}': ${options.violationType}`,
      details: {
        service: options.service,
        expected_contract: options.expectedContract,
        violation_type: options.violationType,
      },
      module: 'adapter',
      correlationId: options.correlationId,
      recoverable: false,
      exitCode: 140,
    });
    this.name = 'ContractViolationError';
    this.violation = {
      service: options.service,
      expected_contract: options.expectedContract,
      actual_response: options.actualResponse,
      violation_type: options.violationType,
    };
  }
}

export class ConfigError extends CLIError {
  constructor(options: {
    message: string;
    configPath?: string;
    missingKey?: string;
    correlationId?: string;
  }) {
    super({
      code: options.missingKey ? 'ECLI-CFG-003' : 'ECLI-CFG-002',
      category: 'CONFIG_ERROR',
      message: options.message,
      details: {
        config_path: options.configPath,
        missing_key: options.missingKey,
      },
      module: 'config',
      correlationId: options.correlationId,
      recoverable: false,
      exitCode: 78,
    });
    this.name = 'ConfigError';
  }
}

export class AuthError extends CLIError {
  constructor(options: {
    type: 'missing' | 'invalid' | 'expired' | 'insufficient' | 'denied' | 'network';
    message: string;
    correlationId?: string;
  }) {
    const codes: Record<string, string> = {
      missing: 'ECLI-AUTH-001',
      invalid: 'ECLI-AUTH-002',
      expired: 'ECLI-AUTH-003',
      insufficient: 'ECLI-AUTH-004',
      denied: 'ECLI-AUTH-005',
      network: 'ECLI-AUTH-006',
    };

    super({
      code: codes[options.type] ?? 'ECLI-AUTH-001',
      category: 'AUTH_ERROR',
      message: options.message,
      details: {
        type: options.type,
      },
      module: 'auth',
      correlationId: options.correlationId,
      recoverable: false,
      exitCode: 77,
    });
    this.name = 'AuthError';
  }
}

// ============================================================================
// Error Handler Interface (SPARC_ARCHITECTURE §2.7)
// ============================================================================

export interface IErrorHandler {
  handle(error: Error, context: ErrorContext): ErrorInfo;
  format(info: ErrorInfo, options: FormatOptions): string;
}

export interface ErrorContext {
  command?: string;
  phase?: string;
  inputs?: unknown;
  correlationId?: string;
}

export interface FormatOptions {
  format: 'json' | 'text';
  pretty?: boolean;
  includeStack?: boolean;
}

// ============================================================================
// Error Handler Implementation
// ============================================================================

export class ErrorHandler implements IErrorHandler {
  handle(error: Error, context: ErrorContext): ErrorInfo {
    if (error instanceof CLIError) {
      return error.toErrorInfo();
    }

    // Normalize unknown errors
    return {
      code: 'ECLI-INT-001',
      category: 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
      details: {
        command: context.command,
        phase: context.phase,
      },
      stack: error.stack,
      timestamp: new Date().toISOString(),
      module: 'unknown',
      correlationId: context.correlationId,
    };
  }

  format(info: ErrorInfo, options: FormatOptions): string {
    if (options.format === 'json') {
      const output = options.includeStack
        ? info
        : { ...info, stack: undefined };
      return options.pretty
        ? JSON.stringify(output, null, 2)
        : JSON.stringify(output);
    }

    // Text format
    let output = `Error [${info.code}]: ${info.message}`;
    if (info.details && Object.keys(info.details).length > 0) {
      output += `\n  Details: ${JSON.stringify(info.details)}`;
    }
    if (options.includeStack && info.stack) {
      output += `\n  Stack: ${info.stack}`;
    }
    return output;
  }
}

// ============================================================================
// Error Normalization Helper
// ============================================================================

/**
 * Convert any thrown value to a proper Error with a meaningful message.
 * Ensures we never produce [object Object] in error messages.
 */
export function toError(value: unknown): Error {
  // Already an Error - return as-is
  if (value instanceof Error) {
    return value;
  }

  // String - wrap in Error
  if (typeof value === 'string') {
    return new Error(value || 'Unknown error (empty string)');
  }

  // null/undefined
  if (value === null || value === undefined) {
    return new Error('Unknown error (null/undefined)');
  }

  // Object - try to extract message
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Check for message-like fields
    const messageFields = ['message', 'error', 'detail', 'reason', 'msg'] as const;
    for (const field of messageFields) {
      if (field in obj && typeof obj[field] === 'string' && obj[field]) {
        return new Error(obj[field] as string);
      }
    }

    // Try to stringify the object
    try {
      const str = JSON.stringify(obj);
      if (str.length > 500) {
        return new Error(str.slice(0, 500) + '... (truncated)');
      }
      return new Error(str);
    } catch {
      // Circular reference or other issue
      const keys = Object.keys(obj);
      return new Error(`Object with keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`);
    }
  }

  // Primitive (number, boolean, etc.)
  return new Error(String(value));
}

// ============================================================================
// Fail-Fast Implementation (SPARC_PSEUDOCODE §4.4)
// ============================================================================

export function failFast(options: {
  command: string;
  phase: string;
  upstreamError: Error;
  inputs: unknown;
  partialRefs?: { id: string }[];
  correlationId?: string;
}): never {
  const errorContext = {
    command: options.command,
    phase: options.phase,
    inputs_hash: hashInputs(options.inputs),
    upstream_error_code: options.upstreamError instanceof CLIError
      ? options.upstreamError.code
      : 'UNKNOWN',
    upstream_error_message: options.upstreamError.message,
    partial_refs: options.partialRefs?.map(r => r.id) ?? [],
    timestamp: new Date().toISOString(),
    trace_id: options.correlationId,
  };

  // Log failure for observability
  console.error(JSON.stringify({
    level: 'ERROR',
    category: 'COMMAND_FAILURE',
    context: errorContext,
  }));

  // Throw wrapped error
  throw new CLIError({
    code: 'COMMAND_FAILED',
    category: options.upstreamError instanceof CLIError
      ? options.upstreamError.category
      : 'INTERNAL_ERROR',
    message: `Command '${options.command}' failed at phase '${options.phase}': ${options.upstreamError.message}`,
    details: errorContext,
    module: 'orchestration',
    correlationId: options.correlationId,
    recoverable: options.upstreamError instanceof CLIError
      ? options.upstreamError.recoverable
      : false,
    cause: options.upstreamError,
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

function hashInputs(inputs: unknown): string {
  const canonical = JSON.stringify(inputs, Object.keys(inputs as object).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Singleton handler instance
export const errorHandler = new ErrorHandler();
