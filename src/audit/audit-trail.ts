/**
 * Audit Trail Module
 *
 * SPARC Architecture Reference: §6.1 (SPARC_PSEUDOCODE)
 *
 * PURPOSE: Record CLI operations for compliance and debugging
 *
 * FORBIDDEN:
 * - State Modification (audit is append-only)
 * - Error Recovery (errors recorded but not handled)
 * - Data Transformation (raw data recorded)
 */

import type {
  AuditEntry,
  BaseReference,
  DownstreamCall,
} from '../types/index.js';
import * as crypto from 'node:crypto';

// ============================================================================
// Interface Definition
// ============================================================================

export interface IAuditTrail {
  /**
   * Record a command execution
   */
  record(entry: AuditEntryInput): AuditEntry;

  /**
   * Get audit entries for a trace
   */
  getByTraceId(traceId: string): AuditEntry[];

  /**
   * Format audit entry for output
   */
  format(entry: AuditEntry): string;
}

export interface AuditEntryInput {
  command: string;
  inputs: unknown;
  outputs: BaseReference | null;
  dependencies: DownstreamCall[];
  duration_ms: number;
  status: 'SUCCESS' | 'FAILED';
  error_code?: string;
  error_message?: string;
  trace_id: string;
  parent_id?: string;
}

// ============================================================================
// Audit Trail Implementation
// ============================================================================

export class AuditTrail implements IAuditTrail {
  private readonly version: string = '1.3.2';
  private readonly entries: Map<string, AuditEntry[]> = new Map();

  /**
   * Record a command execution
   * SPARC: Append-only, no modification of existing entries
   */
  record(input: AuditEntryInput): AuditEntry {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // Compute inputs hash for reproducibility
    const inputsHash = this.hashInputs(input.inputs);

    // Redact sensitive fields from inputs
    const inputsRedacted = this.redactSensitive(input.inputs);

    // Compute checksum for entry integrity
    const entryData = {
      id,
      version: this.version,
      command: input.command,
      inputs_hash: inputsHash,
      outputs: input.outputs,
      dependencies: input.dependencies.map(d => d.service),
      timestamp,
      duration_ms: input.duration_ms,
      status: input.status,
      error_code: input.error_code,
      error_message: input.error_message,
      trace_id: input.trace_id,
      parent_id: input.parent_id,
    };

    const checksum = this.computeChecksum(entryData);

    const entry: AuditEntry = {
      id,
      version: this.version,
      command: input.command,
      inputs_hash: inputsHash,
      inputs_redacted: inputsRedacted,
      outputs: input.outputs,
      dependencies: input.dependencies.map(d => d.service),
      timestamp,
      duration_ms: input.duration_ms,
      status: input.status,
      error_code: input.error_code,
      error_message: input.error_message,
      trace_id: input.trace_id,
      parent_id: input.parent_id,
      checksum,
    };

    // Store by trace_id for retrieval
    const traceEntries = this.entries.get(input.trace_id) ?? [];
    traceEntries.push(entry);
    this.entries.set(input.trace_id, traceEntries);

    return entry;
  }

  /**
   * Get audit entries for a trace
   */
  getByTraceId(traceId: string): AuditEntry[] {
    return this.entries.get(traceId) ?? [];
  }

  /**
   * Format audit entry for output (JSON format)
   */
  format(entry: AuditEntry): string {
    return JSON.stringify(entry, null, 2);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private hashInputs(inputs: unknown): string {
    const canonical = JSON.stringify(inputs, this.sortKeys);
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  private sortKeys(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value as object)
        .sort()
        .reduce((sorted, key) => {
          (sorted as Record<string, unknown>)[key] = (value as Record<string, unknown>)[key];
          return sorted;
        }, {} as Record<string, unknown>);
    }
    return value;
  }

  private redactSensitive(inputs: unknown): unknown {
    if (!inputs || typeof inputs !== 'object') {
      return inputs;
    }

    const sensitivePatterns = [
      /token/i,
      /password/i,
      /secret/i,
      /key/i,
      /auth/i,
      /credential/i,
    ];

    const redact = (obj: unknown): unknown => {
      if (!obj || typeof obj !== 'object') {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(redact);
      }

      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const isSensitive = sensitivePatterns.some(pattern => pattern.test(key));
        if (isSensitive && typeof value === 'string') {
          result[key] = '[REDACTED]';
        } else if (typeof value === 'object') {
          result[key] = redact(value);
        } else {
          result[key] = value;
        }
      }
      return result;
    };

    return redact(inputs);
  }

  private computeChecksum(data: unknown): string {
    const canonical = JSON.stringify(data, this.sortKeys);
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }
}

// ============================================================================
// Audit Logger (Console output for audit trail)
// ============================================================================

export class AuditLogger {
  private readonly destination: 'stdout' | 'stderr';

  constructor(destination: 'stdout' | 'stderr' = 'stderr') {
    this.destination = destination;
  }

  log(entry: AuditEntry): void {
    const output = JSON.stringify({
      level: 'AUDIT',
      ...entry,
    });

    if (this.destination === 'stdout') {
      console.log(output);
    } else {
      console.error(output);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createAuditTrail(): IAuditTrail {
  return new AuditTrail();
}

export function createAuditLogger(destination?: 'stdout' | 'stderr'): AuditLogger {
  return new AuditLogger(destination);
}
