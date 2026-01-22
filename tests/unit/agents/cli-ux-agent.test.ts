/**
 * CLI UX Agent Tests
 *
 * CONSTITUTION REFERENCE: PROMPT 3 (Verification)
 *
 * These tests verify that the CLI UX Agent:
 * 1. Correctly validates commands
 * 2. Produces valid DecisionEvents
 * 3. Follows all constitutional constraints
 * 4. Does NOT violate non-responsibilities
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  CLIUXAgent,
  createCLIUXAgent,
  getCLIUXAgentRegistration,
  CLI_UX_AGENT_ID,
  CLI_UX_AGENT_VERSION,
  NON_RESPONSIBILITIES,
  INVOCABLE_SERVICES,
} from '../../../src/agents/index.js';
import type {
  CLIUXAgentInput,
  ParsedCommand,
} from '../../../src/agents/types.js';

describe('CLI UX Agent', () => {
  let agent: CLIUXAgent;

  beforeEach(() => {
    agent = new CLIUXAgent({
      emit_decisions: false, // Disable emission for tests
      emit_telemetry: false,
    });
  });

  // ========================================================================
  // Agent Identity Tests
  // ========================================================================

  describe('Agent Identity', () => {
    it('should have correct agent ID', () => {
      const identifier = agent.getIdentifier();
      expect(identifier.agent_id).toBe(CLI_UX_AGENT_ID);
    });

    it('should have correct agent version', () => {
      const identifier = agent.getIdentifier();
      expect(identifier.agent_version).toBe(CLI_UX_AGENT_VERSION);
    });

    it('should have CLI_UX_ORCHESTRATION classification', () => {
      const identifier = agent.getIdentifier();
      expect(identifier.classification).toBe('CLI_UX_ORCHESTRATION');
    });
  });

  // ========================================================================
  // Agent Registration Tests
  // ========================================================================

  describe('Agent Registration', () => {
    it('should have complete registration metadata', () => {
      const registration = getCLIUXAgentRegistration();

      expect(registration.identifier).toBeDefined();
      expect(registration.purpose).toBeTruthy();
      expect(registration.inputs_schema_ref).toBeTruthy();
      expect(registration.outputs_schema_ref).toBeTruthy();
      expect(registration.decision_event_schema_ref).toBeTruthy();
      expect(registration.invocable_services).toBeInstanceOf(Array);
      expect(registration.non_responsibilities).toBeInstanceOf(Array);
      expect(registration.failure_modes).toBeInstanceOf(Array);
    });

    it('should list all invocable services', () => {
      const registration = getCLIUXAgentRegistration();

      expect(registration.invocable_services).toContain('agentics-org-manifests');
      expect(registration.invocable_services).toContain('agentics-simulation-planner');
      expect(registration.invocable_services).toContain('ruvector-service');
    });

    it('should explicitly list non-responsibilities', () => {
      const registration = getCLIUXAgentRegistration();

      expect(registration.non_responsibilities).toContain('Execute inference');
      expect(registration.non_responsibilities).toContain('Execute workflows');
      expect(registration.non_responsibilities).toContain('Modify upstream state directly');
      expect(registration.non_responsibilities).toContain('Connect directly to databases');
    });

    it('should define failure modes with exit codes', () => {
      const registration = getCLIUXAgentRegistration();

      expect(registration.failure_modes.length).toBeGreaterThan(0);
      registration.failure_modes.forEach(mode => {
        expect(mode.code).toMatch(/^ECLI-AGENT-\d{3}$/);
        expect(typeof mode.exit_code).toBe('number');
        expect(typeof mode.recoverable).toBe('boolean');
      });
    });
  });

  // ========================================================================
  // Command Validation Tests
  // ========================================================================

  describe('Command Validation', () => {
    it('should validate known commands', () => {
      const command: ParsedCommand = {
        command: 'plan',
        subcommand: 'create',
        flags: {},
        options: {},
        positionalArgs: [],
      };

      const result = agent.validateCommand(command);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject unknown commands', () => {
      const command: ParsedCommand = {
        command: 'foobar',
        flags: {},
        options: {},
        positionalArgs: [],
      };

      const result = agent.validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.code).toBe('ECLI-VAL-002');
    });

    it('should reject empty command', () => {
      const command: ParsedCommand = {
        command: '',
        flags: {},
        options: {},
        positionalArgs: [],
      };

      const result = agent.validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.code).toBe('ECLI-VAL-001');
    });

    it('should require subcommand for certain commands', () => {
      const command: ParsedCommand = {
        command: 'plan',
        flags: {},
        options: {},
        positionalArgs: [],
      };

      const result = agent.validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.code).toBe('ECLI-VAL-003');
    });
  });

  // ========================================================================
  // Agent Processing Tests
  // ========================================================================

  describe('Agent Processing', () => {
    it('should process valid command input', async () => {
      const input: CLIUXAgentInput = {
        args: ['plan', 'list'],
        command: {
          command: 'plan',
          subcommand: 'list',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: true,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-001',
      };

      const output = await agent.process(input);

      expect(output.success).toBe(true);
      expect(output.result.type).toBe('success');
      expect(output.timing.total_ms).toBeGreaterThanOrEqual(0);
      expect(output.timing.started_at).toBeTruthy();
      expect(output.timing.completed_at).toBeTruthy();
    });

    it('should return error for invalid command', async () => {
      const input: CLIUXAgentInput = {
        args: ['invalid'],
        command: {
          command: 'invalid',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: false,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-002',
      };

      const output = await agent.process(input);

      expect(output.success).toBe(false);
      expect(output.result.type).toBe('error');
    });

    it('should return guidance for help command', async () => {
      const input: CLIUXAgentInput = {
        args: ['help'],
        command: {
          command: 'help',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: false,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-003',
      };

      const output = await agent.process(input);

      expect(output.success).toBe(true);
      expect(output.result.type).toBe('guidance');
    });
  });

  // ========================================================================
  // DecisionEvent Tests
  // ========================================================================

  describe('DecisionEvent Generation', () => {
    it('should generate DecisionEvent with required fields', async () => {
      const input: CLIUXAgentInput = {
        args: ['plan', 'list'],
        command: {
          command: 'plan',
          subcommand: 'list',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: true,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-004',
      };

      const output = await agent.process(input);

      expect(output.decision_event).toBeDefined();
      const event = output.decision_event!;

      // Required fields per constitution
      expect(event.agent_id).toBe(CLI_UX_AGENT_ID);
      expect(event.agent_version).toBe(CLI_UX_AGENT_VERSION);
      expect(event.decision_type).toBeTruthy();
      expect(event.inputs_hash).toBeTruthy();
      expect(event.outputs).toBeDefined();
      expect(event.confidence).toBeDefined();
      expect(event.constraints_applied).toBeDefined();
      expect(event.timestamp).toBeTruthy();
      expect(event.trace_id).toBe('test-trace-004');
    });

    it('should include confidence score with components', async () => {
      const input: CLIUXAgentInput = {
        args: ['simulate', 'run'],
        command: {
          command: 'simulate',
          subcommand: 'run',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: true,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-005',
      };

      const output = await agent.process(input);
      const event = output.decision_event!;

      expect(event.confidence.value).toBeGreaterThanOrEqual(0);
      expect(event.confidence.value).toBeLessThanOrEqual(1);
      expect(event.confidence.basis).toBeTruthy();
    });

    it('should include constraints applied', async () => {
      const input: CLIUXAgentInput = {
        args: ['plan', 'list'],
        command: {
          command: 'plan',
          subcommand: 'list',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: false,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-006',
      };

      const output = await agent.process(input);
      const event = output.decision_event!;

      expect(event.constraints_applied.permissions).toContain('anonymous');
      expect(event.constraints_applied.environment).toBeDefined();
      expect(event.constraints_applied.scope).toBeInstanceOf(Array);
    });
  });

  // ========================================================================
  // Context Resolution Tests
  // ========================================================================

  describe('Context Resolution', () => {
    it('should resolve context from arguments', () => {
      const args = ['plan', 'list', '--format=yaml', '--verbose', '--timeout=60000'];
      const context = agent.resolveContext(args);

      expect(context.cwd).toBeTruthy();
      expect(typeof context.authenticated).toBe('boolean');
      expect(typeof context.execution_gate_enabled).toBe('boolean');
    });
  });

  // ========================================================================
  // Confidence Calculation Tests
  // ========================================================================

  describe('Confidence Calculation', () => {
    it('should calculate confidence for known command', () => {
      const input: CLIUXAgentInput = {
        args: ['plan', 'list'],
        command: {
          command: 'plan',
          subcommand: 'list',
          flags: {},
          options: {},
          positionalArgs: [],
        },
        context: {
          cwd: '/test',
          authenticated: true,
          execution_gate_enabled: true,
          output_format: 'json',
          verbose: false,
          timeout: 30000,
        },
        trace_id: 'test-trace-007',
      };

      const result = { type: 'success' as const, data: {}, services_invoked: [] };
      const confidence = agent.calculateConfidence(input, result);

      expect(confidence.value).toBeGreaterThan(0.5);
      expect(confidence.components).toBeDefined();
    });
  });

  // ========================================================================
  // Factory Function Tests
  // ========================================================================

  describe('Factory Functions', () => {
    it('should create agent via factory function', () => {
      const newAgent = createCLIUXAgent();
      expect(newAgent).toBeInstanceOf(CLIUXAgent);
    });

    it('should create agent with custom config', () => {
      const newAgent = createCLIUXAgent({
        emit_decisions: false,
        default_output_format: 'yaml',
      });
      expect(newAgent).toBeInstanceOf(CLIUXAgent);
    });
  });

  // ========================================================================
  // Constitutional Compliance Tests
  // ========================================================================

  describe('Constitutional Compliance', () => {
    it('should list all required non-responsibilities', () => {
      const requiredNonResponsibilities = [
        'Execute inference',
        'Execute workflows',
        'Modify upstream state directly',
        'Apply optimizations',
        'Enforce governance or policy decisions',
        'Trigger retries or automation implicitly',
        'Persist business state',
        'Connect directly to databases',
        'Execute SQL',
      ];

      requiredNonResponsibilities.forEach(responsibility => {
        expect(NON_RESPONSIBILITIES).toContain(responsibility);
      });
    });

    it('should list all allowed invocable services', () => {
      const allowedServices = [
        'agentics-org-manifests',
        'agentics-simulation-planner',
        'agentics-simulation-runner',
        'agentics-simulation-engine',
        'enterprise-roi-engine',
        'agentics-deployment-intent',
        'agentics-deployment-exporters',
        'diligence-artifacts',
        'ruvector-service',
      ];

      allowedServices.forEach(service => {
        expect(INVOCABLE_SERVICES).toContain(service);
      });
    });

    it('should have CLI_UX_ORCHESTRATION as only classification', () => {
      const registration = getCLIUXAgentRegistration();
      expect(registration.identifier.classification).toBe('CLI_UX_ORCHESTRATION');
    });
  });
});

describe('CLI UX Agent Non-Responsibilities Verification', () => {
  /**
   * These tests verify that the agent does NOT have the capabilities
   * it is forbidden from having per the constitution.
   */

  it('should NOT have inference execution capability', () => {
    const agent = new CLIUXAgent();
    // Verify no inference methods exist
    expect((agent as any).executeInference).toBeUndefined();
    expect((agent as any).runModel).toBeUndefined();
  });

  it('should NOT have workflow execution capability', () => {
    const agent = new CLIUXAgent();
    // Verify no workflow execution methods exist
    expect((agent as any).executeWorkflow).toBeUndefined();
    expect((agent as any).runWorkflow).toBeUndefined();
  });

  it('should NOT have state modification capability', () => {
    const agent = new CLIUXAgent();
    // Verify no state modification methods exist
    expect((agent as any).modifyState).toBeUndefined();
    expect((agent as any).setState).toBeUndefined();
    expect((agent as any).updateState).toBeUndefined();
  });

  it('should NOT have database connection capability', () => {
    const agent = new CLIUXAgent();
    // Verify no database methods exist
    expect((agent as any).connectDatabase).toBeUndefined();
    expect((agent as any).executeSql).toBeUndefined();
    expect((agent as any).query).toBeUndefined();
  });

  it('should NOT have policy enforcement capability', () => {
    const agent = new CLIUXAgent();
    // Verify no policy enforcement methods exist
    expect((agent as any).enforcePolicy).toBeUndefined();
    expect((agent as any).applyPolicy).toBeUndefined();
  });
});
