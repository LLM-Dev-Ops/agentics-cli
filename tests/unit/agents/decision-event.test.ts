/**
 * DecisionEvent Emitter Tests
 *
 * CONSTITUTION REFERENCE: PROMPT 2, PROMPT 3
 *
 * These tests verify that DecisionEvent emission:
 * 1. Is async and non-blocking
 * 2. Fails silently (never affects UX)
 * 3. Emits correct schema
 * 4. Respects emission rules
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  DecisionEventBuilder,
  DecisionEventEmitter,
  TelemetryEmitter,
  createDecisionEventBuilder,
  createDecisionEventEmitter,
  createTelemetryEmitter,
} from '../../../src/agents/decision-event.js';
import {
  CLI_UX_AGENT_ID,
  CLI_UX_AGENT_VERSION,
} from '../../../src/agents/types.js';
import type { DecisionEvent } from '../../../src/agents/types.js';

describe('DecisionEventBuilder', () => {
  let builder: DecisionEventBuilder;

  beforeEach(() => {
    builder = new DecisionEventBuilder({
      trace_id: 'test-trace-001',
      command: 'plan',
      subcommand: 'list',
    });
  });

  describe('Event Construction', () => {
    it('should build event with required fields', () => {
      const event = builder
        .withInputsHash({ test: 'input' })
        .build();

      expect(event.agent_id).toBe(CLI_UX_AGENT_ID);
      expect(event.agent_version).toBe(CLI_UX_AGENT_VERSION);
      expect(event.trace_id).toBe('test-trace-001');
      expect(event.outputs.command).toBe('plan');
      expect(event.outputs.subcommand).toBe('list');
      expect(event.timestamp).toBeTruthy();
    });

    it('should set decision type', () => {
      const event = builder
        .withDecisionType('service_routing')
        .build();

      expect(event.decision_type).toBe('service_routing');
    });

    it('should compute inputs hash', () => {
      const event1 = builder.withInputsHash({ a: 1, b: 2 }).build();
      const event2 = createDecisionEventBuilder({
        trace_id: 'test-trace-002',
        command: 'plan',
      }).withInputsHash({ a: 1, b: 2 }).build();

      // Same input should produce same hash
      expect(event1.inputs_hash).toBe(event2.inputs_hash);
    });

    it('should set result type', () => {
      const event = builder.withResultType('error').build();
      expect(event.outputs.result_type).toBe('error');
    });

    it('should set artifact reference', () => {
      const event = builder.withArtifactRef('plan-123').build();
      expect(event.outputs.artifact_ref).toBe('plan-123');
    });

    it('should set services invoked', () => {
      const event = builder
        .withServicesInvoked(['agentics-simulation-planner', 'ruvector-service'])
        .build();

      expect(event.outputs.services_invoked).toContain('agentics-simulation-planner');
      expect(event.outputs.services_invoked).toContain('ruvector-service');
    });

    it('should set confidence score', () => {
      const event = builder
        .withConfidence({
          value: 0.95,
          basis: 'command_resolution',
          components: [{ name: 'test', value: 0.95, weight: 1.0 }],
        })
        .build();

      expect(event.confidence.value).toBe(0.95);
      expect(event.confidence.basis).toBe('command_resolution');
    });

    it('should set constraints applied', () => {
      const event = builder
        .withConstraints({
          permissions: ['authenticated'],
          environment: {
            is_local: true,
            is_production: false,
            execution_gate_enabled: true,
            auth_present: true,
          },
          scope: [],
        })
        .build();

      expect(event.constraints_applied.permissions).toContain('authenticated');
      expect(event.constraints_applied.environment.is_local).toBe(true);
    });

    it('should set execution reference', () => {
      const event = builder
        .withExecutionRef({
          service: 'agentics-simulation-planner',
          execution_id: 'exec-123',
          trace_id: 'test-trace-001',
        })
        .build();

      expect(event.execution_ref?.service).toBe('agentics-simulation-planner');
      expect(event.execution_ref?.execution_id).toBe('exec-123');
    });
  });

  describe('Chaining', () => {
    it('should support method chaining', () => {
      const event = builder
        .withDecisionType('cli_ux_orchestration')
        .withInputsHash({ test: true })
        .withResultType('success')
        .withServicesInvoked(['test-service'])
        .withConfidence({ value: 1.0, basis: 'command_resolution' })
        .build();

      expect(event.decision_type).toBe('cli_ux_orchestration');
      expect(event.outputs.result_type).toBe('success');
    });
  });
});

describe('DecisionEventEmitter', () => {
  describe('Configuration', () => {
    it('should be disabled by default without URL', () => {
      const emitter = new DecisionEventEmitter();
      expect(emitter.isEnabled()).toBe(false);
    });

    it('should be enabled when URL is provided', () => {
      const emitter = new DecisionEventEmitter({
        ruvector_url: 'https://ruvector.example.com',
        enabled: true,
      });
      expect(emitter.isEnabled()).toBe(true);
    });
  });

  describe('Emission Behavior', () => {
    it('should return disabled result when not enabled', async () => {
      const emitter = new DecisionEventEmitter({ enabled: false });
      const event = createTestEvent();

      const result = await emitter.emit(event);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('emission_disabled');
    });

    it('should not throw on network error', async () => {
      const emitter = new DecisionEventEmitter({
        ruvector_url: 'https://invalid-url.example.com',
        enabled: true,
        timeout: 100,
      });
      const event = createTestEvent();

      // Should not throw
      const result = await emitter.emit(event);
      expect(result.success).toBe(false);
    });

    it('should handle timeout gracefully', async () => {
      const emitter = new DecisionEventEmitter({
        ruvector_url: 'https://slow-server.example.com',
        enabled: true,
        timeout: 1, // Very short timeout
      });
      const event = createTestEvent();

      const result = await emitter.emit(event);
      expect(result.success).toBe(false);
    });
  });

  describe('Async Emission', () => {
    it('should not block on emitAsync', () => {
      const emitter = new DecisionEventEmitter({
        ruvector_url: 'https://ruvector.example.com',
        enabled: true,
      });
      const event = createTestEvent();

      // Should complete immediately without awaiting
      expect(() => emitter.emitAsync(event)).not.toThrow();
    });

    it('should silently ignore emitAsync when disabled', () => {
      const emitter = new DecisionEventEmitter({ enabled: false });
      const event = createTestEvent();

      // Should not throw
      expect(() => emitter.emitAsync(event)).not.toThrow();
    });
  });
});

describe('TelemetryEmitter', () => {
  describe('Configuration', () => {
    it('should be disabled by default', () => {
      const emitter = new TelemetryEmitter();
      // Recording should be a no-op when disabled
      expect(() => {
        emitter.record('agent_invocation', 'test-agent', 'trace-001', {
          type: 'invocation',
          command: 'test',
          input_hash: 'abc123',
        });
      }).not.toThrow();
    });
  });

  describe('Recording', () => {
    it('should record telemetry events', () => {
      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: 'https://telemetry.example.com',
        batch_size: 10,
      });

      expect(() => {
        emitter.record('agent_invocation', CLI_UX_AGENT_ID, 'trace-001', {
          type: 'invocation',
          command: 'plan',
          subcommand: 'list',
          input_hash: 'abc123',
        });
      }).not.toThrow();

      emitter.stop();
    });

    it('should handle completion telemetry', () => {
      const emitter = new TelemetryEmitter({ enabled: true });

      expect(() => {
        emitter.record('agent_completion', CLI_UX_AGENT_ID, 'trace-001', {
          type: 'completion',
          success: true,
          duration_ms: 100,
          services_invoked: ['test-service'],
        });
      }).not.toThrow();

      emitter.stop();
    });
  });

  describe('Cleanup', () => {
    it('should stop flush timer', () => {
      const emitter = new TelemetryEmitter({
        enabled: true,
        endpoint: 'https://telemetry.example.com',
        flush_interval: 1000,
      });

      expect(() => emitter.stop()).not.toThrow();
    });
  });
});

describe('Factory Functions', () => {
  it('should create DecisionEventBuilder', () => {
    const builder = createDecisionEventBuilder({
      trace_id: 'test',
      command: 'plan',
    });
    expect(builder).toBeInstanceOf(DecisionEventBuilder);
  });

  it('should create DecisionEventEmitter', () => {
    const emitter = createDecisionEventEmitter();
    expect(emitter).toBeInstanceOf(DecisionEventEmitter);
  });

  it('should create TelemetryEmitter', () => {
    const emitter = createTelemetryEmitter();
    expect(emitter).toBeInstanceOf(TelemetryEmitter);
    emitter.stop();
  });
});

// ============================================================================
// Test Helpers
// ============================================================================

function createTestEvent(): DecisionEvent {
  return {
    agent_id: CLI_UX_AGENT_ID,
    agent_version: CLI_UX_AGENT_VERSION,
    decision_type: 'cli_ux_orchestration',
    inputs_hash: 'test-hash-123',
    outputs: {
      command: 'plan',
      subcommand: 'list',
      result_type: 'success',
      services_invoked: [],
    },
    confidence: {
      value: 1.0,
      basis: 'command_resolution',
    },
    constraints_applied: {
      permissions: ['anonymous'],
      environment: {
        is_local: true,
        is_production: false,
        execution_gate_enabled: true,
        auth_present: false,
      },
      scope: [],
    },
    execution_ref: null,
    timestamp: new Date().toISOString(),
    trace_id: 'test-trace-001',
  };
}
