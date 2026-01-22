/**
 * DecisionEvent Emitter
 *
 * CONSTITUTION REFERENCE: PROMPT 0, PROMPT 2
 *
 * PURPOSE: Emit CLI UX-level DecisionEvents to ruvector-service.
 *
 * EMISSION RULES:
 * - At most ONE DecisionEvent per agent invocation
 * - Async, non-blocking emission only
 * - NEVER persists locally
 * - MAY fail silently (UX must not depend on emission)
 *
 * DATA RULES:
 * - Only emit UX telemetry and interaction data
 * - Never emit raw inputs or sensitive data
 * - Always use hashes for reproducibility
 */

import * as crypto from 'node:crypto';
import type {
  DecisionEvent,
  DecisionType,
  ConfidenceScore,
  ConstraintsApplied,
  DecisionOutputs,
  ExecutionReference,
  EnvironmentContext,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryData,
} from './types.js';
import {
  CLI_UX_AGENT_ID,
  CLI_UX_AGENT_VERSION,
} from './types.js';

// ============================================================================
// DecisionEvent Builder
// ============================================================================

export interface DecisionEventBuilderOptions {
  trace_id: string;
  command: string;
  subcommand?: string;
}

/**
 * Builder for constructing DecisionEvents.
 * Ensures all required fields are set before emission.
 */
export class DecisionEventBuilder {
  private readonly trace_id: string;
  private readonly command: string;
  private readonly subcommand?: string;

  private decision_type: DecisionType = 'cli_ux_orchestration';
  private inputs_hash: string = '';
  private result_type: 'success' | 'error' | 'guidance' = 'success';
  private artifact_ref?: string;
  private services_invoked: string[] = [];
  private confidence: ConfidenceScore = {
    value: 1.0,
    basis: 'command_resolution',
  };
  private constraints: ConstraintsApplied = {
    permissions: [],
    environment: {
      is_local: true,
      is_production: false,
      execution_gate_enabled: true,
      auth_present: false,
    },
    scope: [],
  };
  private execution_ref: ExecutionReference | null = null;

  constructor(options: DecisionEventBuilderOptions) {
    this.trace_id = options.trace_id;
    this.command = options.command;
    this.subcommand = options.subcommand;
  }

  /**
   * Set decision type.
   */
  withDecisionType(type: DecisionType): this {
    this.decision_type = type;
    return this;
  }

  /**
   * Set inputs hash from raw inputs.
   * Computes hash, never stores raw data.
   */
  withInputsHash(inputs: unknown): this {
    this.inputs_hash = this.computeHash(inputs);
    return this;
  }

  /**
   * Set result type.
   */
  withResultType(type: 'success' | 'error' | 'guidance'): this {
    this.result_type = type;
    return this;
  }

  /**
   * Set artifact reference.
   */
  withArtifactRef(ref: string): this {
    this.artifact_ref = ref;
    return this;
  }

  /**
   * Add services that were invoked.
   */
  withServicesInvoked(services: string[]): this {
    this.services_invoked = services;
    return this;
  }

  /**
   * Set confidence score.
   */
  withConfidence(confidence: ConfidenceScore): this {
    this.confidence = confidence;
    return this;
  }

  /**
   * Set constraints applied.
   */
  withConstraints(constraints: ConstraintsApplied): this {
    this.constraints = constraints;
    return this;
  }

  /**
   * Set environment context.
   */
  withEnvironment(env: EnvironmentContext): this {
    this.constraints = {
      ...this.constraints,
      environment: env,
    };
    return this;
  }

  /**
   * Set execution reference from downstream service.
   */
  withExecutionRef(ref: ExecutionReference): this {
    this.execution_ref = ref;
    return this;
  }

  /**
   * Build the DecisionEvent.
   */
  build(): DecisionEvent {
    const outputs: DecisionOutputs = {
      command: this.command,
      subcommand: this.subcommand,
      result_type: this.result_type,
      artifact_ref: this.artifact_ref,
      services_invoked: this.services_invoked,
    };

    return {
      agent_id: CLI_UX_AGENT_ID,
      agent_version: CLI_UX_AGENT_VERSION,
      decision_type: this.decision_type,
      inputs_hash: this.inputs_hash,
      outputs,
      confidence: this.confidence,
      constraints_applied: this.constraints,
      execution_ref: this.execution_ref,
      timestamp: new Date().toISOString(),
      trace_id: this.trace_id,
    };
  }

  /**
   * Compute hash of inputs for reproducibility.
   */
  private computeHash(inputs: unknown): string {
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
}

// ============================================================================
// DecisionEvent Emitter
// ============================================================================

export interface DecisionEventEmitterConfig {
  /** RuVector service URL */
  ruvector_url?: string;
  /** Enable emission (default: true if ruvector_url set) */
  enabled?: boolean;
  /** Timeout for emission in ms */
  timeout?: number;
  /** Auth token for ruvector-service */
  auth_token?: string;
}

/**
 * Emits DecisionEvents to ruvector-service.
 *
 * CRITICAL: Emission is async and non-blocking.
 * Failures are logged but do not affect UX flow.
 */
export class DecisionEventEmitter {
  private readonly config: Required<DecisionEventEmitterConfig>;

  constructor(config: DecisionEventEmitterConfig = {}) {
    this.config = {
      ruvector_url: config.ruvector_url ?? process.env['RUVECTOR_SERVICE_URL'] ?? '',
      enabled: config.enabled ?? !!config.ruvector_url,
      timeout: config.timeout ?? 5000,
      auth_token: config.auth_token ?? '',
    };
  }

  /**
   * Check if emission is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.ruvector_url;
  }

  /**
   * Emit a DecisionEvent.
   *
   * RULES:
   * - Async, non-blocking
   * - Never throws - failures are silent
   * - Only one event per invocation should be emitted
   */
  async emit(event: DecisionEvent): Promise<EmissionResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        reason: 'emission_disabled',
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Trace-ID': event.trace_id,
        'X-Agent-ID': event.agent_id,
        'X-Agent-Version': event.agent_version,
      };

      if (this.config.auth_token) {
        headers['Authorization'] = `Bearer ${this.config.auth_token}`;
      }

      const response = await fetch(`${this.config.ruvector_url}/v1/decision-events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          reason: 'http_error',
          status_code: response.status,
        };
      }

      return {
        success: true,
        event_id: event.trace_id,
      };
    } catch (error) {
      // Silent failure - emission must not affect UX
      return {
        success: false,
        reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
      };
    }
  }

  /**
   * Emit without waiting (fire and forget).
   * Use when you don't care about the result.
   */
  emitAsync(event: DecisionEvent): void {
    if (!this.isEnabled()) {
      return;
    }

    // Fire and forget - don't await
    this.emit(event).catch(() => {
      // Silently ignore emission failures
    });
  }
}

export interface EmissionResult {
  success: boolean;
  event_id?: string;
  reason?: 'emission_disabled' | 'http_error' | 'timeout' | 'network_error';
  status_code?: number;
}

// ============================================================================
// Telemetry Emitter (LLM-Observatory Compatible)
// ============================================================================

export interface TelemetryEmitterConfig {
  /** Enable telemetry emission */
  enabled?: boolean;
  /** Telemetry endpoint */
  endpoint?: string;
  /** Batch size before flush */
  batch_size?: number;
  /** Flush interval in ms */
  flush_interval?: number;
}

/**
 * Emits telemetry events compatible with LLM-Observatory.
 */
export class TelemetryEmitter {
  private readonly config: Required<TelemetryEmitterConfig>;
  private readonly buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TelemetryEmitterConfig = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      endpoint: config.endpoint ?? '',
      batch_size: config.batch_size ?? 10,
      flush_interval: config.flush_interval ?? 5000,
    };

    if (this.config.enabled && this.config.endpoint) {
      this.startFlushTimer();
    }
  }

  /**
   * Record a telemetry event.
   */
  record(
    event_type: TelemetryEventType,
    agent_id: string,
    trace_id: string,
    data: TelemetryData
  ): void {
    if (!this.config.enabled) {
      return;
    }

    const event: TelemetryEvent = {
      event_type,
      agent_id,
      timestamp: new Date().toISOString(),
      trace_id,
      data,
    };

    this.buffer.push(event);

    if (this.buffer.length >= this.config.batch_size) {
      this.flush();
    }
  }

  /**
   * Flush buffered events.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.config.endpoint) {
      return;
    }

    const events = this.buffer.splice(0, this.buffer.length);

    try {
      await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
    } catch {
      // Silent failure for telemetry
    }
  }

  /**
   * Stop the flush timer.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flush_interval);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a DecisionEvent builder.
 */
export function createDecisionEventBuilder(
  options: DecisionEventBuilderOptions
): DecisionEventBuilder {
  return new DecisionEventBuilder(options);
}

/**
 * Create a DecisionEvent emitter.
 */
export function createDecisionEventEmitter(
  config?: DecisionEventEmitterConfig
): DecisionEventEmitter {
  return new DecisionEventEmitter(config);
}

/**
 * Create a telemetry emitter.
 */
export function createTelemetryEmitter(
  config?: TelemetryEmitterConfig
): TelemetryEmitter {
  return new TelemetryEmitter(config);
}
