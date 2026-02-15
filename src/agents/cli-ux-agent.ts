/**
 * CLI UX Agent Implementation
 *
 * CONSTITUTION REFERENCE: PROMPT 0, PROMPT 1, PROMPT 2
 *
 * AGENT NAME: CLI UX Agent
 * CLASSIFICATION: CLI_UX_ORCHESTRATION
 *
 * PURPOSE:
 * Provide a consistent, guided, and contract-validated command-line user
 * experience for interacting with the Agentics Dev platform.
 *
 * SCOPE:
 * - Parse and validate CLI commands
 * - Guide users through workflows
 * - Orchestrate calls to Agentics services
 * - Normalize and present outputs
 * - Emit UX-level interaction signals
 *
 * NON-RESPONSIBILITIES (EXPLICIT):
 * - Execute inference
 * - Execute workflows
 * - Modify upstream state directly
 * - Apply optimizations
 * - Enforce governance or policy decisions
 * - Trigger retries or automation implicitly
 * - Persist business state
 * - Connect directly to databases
 */

import * as crypto from 'node:crypto';
import type {
  AgentIdentifier,
  AgentRegistration,
  CLIUXAgentInput,
  CLIUXAgentOutput,
  AgentResult,
  SuccessResult,
  ErrorResult,
  GuidanceResult,
  ParsedCommand,
  AgentContext,
  OutputFormat,
  ConfidenceScore,
  ConstraintsApplied,
  EnvironmentContext,
  DecisionType,
  TimingInfo,
} from './types.js';
import {
  CLI_UX_AGENT_ID,
  CLI_UX_AGENT_VERSION,
  CLI_UX_AGENT_CLASSIFICATION,
  INVOCABLE_SERVICES,
  NON_RESPONSIBILITIES,
} from './types.js';
import {
  DecisionEventBuilder,
  DecisionEventEmitter,
  TelemetryEmitter,
  createDecisionEventEmitter,
  createTelemetryEmitter,
} from './decision-event.js';

// ============================================================================
// Agent Registration (PROMPT 1 Requirement)
// ============================================================================

/**
 * CLI UX Agent registration metadata.
 * Defines the complete contract for this agent.
 */
export const CLI_UX_AGENT_REGISTRATION: AgentRegistration = {
  identifier: {
    agent_id: CLI_UX_AGENT_ID,
    agent_version: CLI_UX_AGENT_VERSION,
    agent_name: 'CLI UX Agent',
    classification: CLI_UX_AGENT_CLASSIFICATION,
  },
  purpose:
    'Provide a consistent, guided, and contract-validated command-line user ' +
    'experience for interacting with the Agentics Dev platform.',
  inputs_schema_ref: 'agentics-contracts/cli-ux-agent-input/v1',
  outputs_schema_ref: 'agentics-contracts/cli-ux-agent-output/v1',
  decision_event_schema_ref: 'agentics-contracts/decision-event/v1',
  invocable_services: [...INVOCABLE_SERVICES],
  non_responsibilities: [...NON_RESPONSIBILITIES],
  failure_modes: [
    {
      code: 'ECLI-AGENT-001',
      description: 'Command validation failed',
      exit_code: 100,
      recoverable: false,
    },
    {
      code: 'ECLI-AGENT-002',
      description: 'Service routing failed',
      exit_code: 140,
      recoverable: false,
    },
    {
      code: 'ECLI-AGENT-003',
      description: 'Output formatting failed',
      exit_code: 150,
      recoverable: true,
    },
    {
      code: 'ECLI-AGENT-004',
      description: 'Authentication required',
      exit_code: 130,
      recoverable: true,
    },
    {
      code: 'ECLI-AGENT-005',
      description: 'Execution gate blocked',
      exit_code: 77,
      recoverable: false,
    },
  ],
};

// ============================================================================
// CLI UX Agent Interface
// ============================================================================

export interface ICLIUXAgent {
  /**
   * Get agent identifier.
   */
  getIdentifier(): AgentIdentifier;

  /**
   * Get agent registration.
   */
  getRegistration(): AgentRegistration;

  /**
   * Process a CLI command.
   * This is the main entry point for agent invocation.
   */
  process(input: CLIUXAgentInput): Promise<CLIUXAgentOutput>;

  /**
   * Validate command syntax.
   */
  validateCommand(command: ParsedCommand): ValidationResult;

  /**
   * Resolve environment context.
   */
  resolveContext(args: string[]): AgentContext;

  /**
   * Calculate confidence for a decision.
   */
  calculateConfidence(input: CLIUXAgentInput, result: AgentResult): ConfidenceScore;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// ============================================================================
// CLI UX Agent Configuration
// ============================================================================

export interface CLIUXAgentConfig {
  /** Enable DecisionEvent emission */
  emit_decisions?: boolean;
  /** Enable telemetry */
  emit_telemetry?: boolean;
  /** RuVector service URL for DecisionEvent emission */
  ruvector_url?: string;
  /** Telemetry endpoint */
  telemetry_endpoint?: string;
  /** Default output format */
  default_output_format?: OutputFormat;
  /** Default timeout in ms */
  default_timeout?: number;
}

// ============================================================================
// CLI UX Agent Implementation
// ============================================================================

export class CLIUXAgent implements ICLIUXAgent {
  private readonly config: Required<CLIUXAgentConfig>;
  private readonly decisionEmitter: DecisionEventEmitter;
  private readonly telemetryEmitter: TelemetryEmitter;

  constructor(config: CLIUXAgentConfig = {}) {
    this.config = {
      emit_decisions: config.emit_decisions ?? false,
      emit_telemetry: config.emit_telemetry ?? false,
      ruvector_url: config.ruvector_url ?? process.env['RUVECTOR_SERVICE_URL'] ?? '',
      telemetry_endpoint: config.telemetry_endpoint ?? '',
      default_output_format: config.default_output_format ?? 'json',
      default_timeout: config.default_timeout ?? 30000,
    };

    this.decisionEmitter = createDecisionEventEmitter({
      ruvector_url: this.config.ruvector_url,
      enabled: this.config.emit_decisions,
    });

    this.telemetryEmitter = createTelemetryEmitter({
      enabled: this.config.emit_telemetry,
      endpoint: this.config.telemetry_endpoint,
    });
  }

  /**
   * Get agent identifier.
   */
  getIdentifier(): AgentIdentifier {
    return CLI_UX_AGENT_REGISTRATION.identifier;
  }

  /**
   * Get agent registration.
   */
  getRegistration(): AgentRegistration {
    return CLI_UX_AGENT_REGISTRATION;
  }

  /**
   * Process a CLI command.
   *
   * EXECUTION FLOW:
   * 1. Record invocation telemetry
   * 2. Validate command
   * 3. Resolve execution context
   * 4. Calculate confidence
   * 5. Build result
   * 6. Emit DecisionEvent (async, non-blocking)
   * 7. Record completion telemetry
   * 8. Return output
   *
   * CONFIRMS:
   * - This agent does NOT execute inference
   * - This agent does NOT modify platform state
   * - This agent does NOT enforce policies
   * - This agent does NOT trigger automation implicitly
   */
  async process(input: CLIUXAgentInput): Promise<CLIUXAgentOutput> {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    // Record invocation telemetry
    this.telemetryEmitter.record(
      'agent_invocation',
      CLI_UX_AGENT_ID,
      input.trace_id,
      {
        type: 'invocation',
        command: input.command.command,
        subcommand: input.command.subcommand,
        input_hash: this.computeInputHash(input),
      }
    );

    try {
      // Step 1: Validate command
      const validation = this.validateCommand(input.command);
      if (!validation.valid) {
        const result = this.buildErrorResult(validation.errors);
        return this.buildOutput(false, result, input, startTime, startedAt);
      }

      // Step 2: Check for guidance scenarios
      const guidance = this.checkForGuidance(input);
      if (guidance) {
        return this.buildOutput(true, guidance, input, startTime, startedAt);
      }

      // Step 3: Build success result (orchestration happens in CLI command handlers)
      const result = this.buildSuccessResult(input);
      return this.buildOutput(true, result, input, startTime, startedAt);

    } catch (error) {
      const result: ErrorResult = {
        type: 'error',
        code: 'ECLI-AGENT-999',
        message: error instanceof Error ? error.message : 'Unknown error',
        recoverable: false,
      };
      return this.buildOutput(false, result, input, startTime, startedAt);
    }
  }

  /**
   * Validate command syntax and structure.
   */
  validateCommand(command: ParsedCommand): ValidationResult {
    const errors: ValidationError[] = [];

    // Validate command name
    if (!command.command || command.command.trim() === '') {
      errors.push({
        field: 'command',
        message: 'Command name is required',
        code: 'ECLI-VAL-001',
      });
    }

    // Validate command is known
    const knownCommands = [
      'login', 'logout', 'whoami',
      'plan', 'simulate', 'inspect', 'quantify',
      'deploy', 'export', 'erp', 'diligence',
      'usage', 'policy', 'audit',
      'help', 'version',
    ];

    if (command.command && !knownCommands.includes(command.command)) {
      errors.push({
        field: 'command',
        message: `Unknown command: ${command.command}. Run 'agentics help' for available commands.`,
        code: 'ECLI-VAL-002',
      });
    }

    // Validate subcommands for commands that require them
    const commandsRequiringSubcommand = ['plan', 'simulate', 'erp', 'diligence'];
    if (
      command.command &&
      commandsRequiringSubcommand.includes(command.command) &&
      !command.subcommand
    ) {
      errors.push({
        field: 'subcommand',
        message: `Command '${command.command}' requires a subcommand. Run 'agentics ${command.command} help' for options.`,
        code: 'ECLI-VAL-003',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Resolve environment context from arguments.
   */
  resolveContext(args: string[]): AgentContext {
    const flags = this.parseFlags(args);
    const options = this.parseOptions(args);

    return {
      cwd: process.cwd(),
      authenticated: this.checkAuthentication(),
      execution_gate_enabled: this.checkExecutionGate(),
      output_format: (options['format'] as OutputFormat) ?? this.config.default_output_format,
      verbose: flags['verbose'] || flags['v'] || false,
      timeout: parseInt(options['timeout'] ?? String(this.config.default_timeout), 10),
    };
  }

  /**
   * Confidence scoring removed — this is platform-side logic.
   * The CLI does not score, rank, or evaluate. It formats and sends.
   * Returns a neutral stub for contract compatibility.
   */
  calculateConfidence(_input: CLIUXAgentInput, _result: AgentResult): ConfidenceScore {
    return {
      value: 0,
      basis: 'command_resolution',
      components: [],
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildOutput(
    success: boolean,
    result: AgentResult,
    input: CLIUXAgentInput,
    startTime: number,
    startedAt: string
  ): CLIUXAgentOutput {
    const completedAt = new Date().toISOString();
    const totalMs = Date.now() - startTime;

    const timing: TimingInfo = {
      total_ms: totalMs,
      breakdown: {
        validation: Math.min(10, totalMs * 0.1),
        processing: totalMs * 0.9,
      },
      started_at: startedAt,
      completed_at: completedAt,
    };

    // Calculate confidence
    const confidence = this.calculateConfidence(input, result);

    // Build and emit DecisionEvent (async, non-blocking)
    const decisionEvent = this.buildDecisionEvent(input, result, confidence);
    if (this.config.emit_decisions) {
      this.decisionEmitter.emitAsync(decisionEvent);
    }

    // Record completion telemetry
    this.telemetryEmitter.record(
      'agent_completion',
      CLI_UX_AGENT_ID,
      input.trace_id,
      {
        type: 'completion',
        success,
        duration_ms: totalMs,
        services_invoked: result.type === 'success' ? (result as SuccessResult).services_invoked : [],
      }
    );

    return {
      success,
      result,
      decision_event: decisionEvent,
      timing,
    };
  }

  private buildDecisionEvent(
    input: CLIUXAgentInput,
    result: AgentResult,
    confidence: ConfidenceScore
  ) {
    const builder = new DecisionEventBuilder({
      trace_id: input.trace_id,
      command: input.command.command,
      subcommand: input.command.subcommand,
    });

    const decisionType = this.determineDecisionType(input, result);
    const constraints = this.buildConstraints(input);

    builder
      .withDecisionType(decisionType)
      .withInputsHash(input)
      .withResultType(result.type)
      .withConfidence(confidence)
      .withConstraints(constraints);

    if (result.type === 'success') {
      const successResult = result as SuccessResult;
      if (successResult.artifact_ref) {
        builder.withArtifactRef(successResult.artifact_ref);
      }
      builder.withServicesInvoked(successResult.services_invoked);
    }

    return builder.build();
  }

  /**
   * Decision type classification removed — this is platform-side logic.
   * The CLI does not classify intent or decision types.
   * Returns a neutral default for contract compatibility.
   */
  private determineDecisionType(_input: CLIUXAgentInput, _result: AgentResult): DecisionType {
    return 'cli_ux_orchestration';
  }

  private buildConstraints(input: CLIUXAgentInput): ConstraintsApplied {
    const environment: EnvironmentContext = {
      is_local: !process.env['AGENTICS_PRODUCTION'],
      is_production: !!process.env['AGENTICS_PRODUCTION'],
      execution_gate_enabled: input.context.execution_gate_enabled,
      auth_present: input.context.authenticated,
    };

    return {
      permissions: input.context.authenticated ? ['authenticated'] : ['anonymous'],
      environment,
      scope: [],
    };
  }

  private buildSuccessResult(input: CLIUXAgentInput): SuccessResult {
    return {
      type: 'success',
      data: {
        command: input.command.command,
        subcommand: input.command.subcommand,
        processed: true,
      },
      services_invoked: [],
    };
  }

  private buildErrorResult(errors: ValidationError[]): ErrorResult {
    return {
      type: 'error',
      code: errors[0]?.code ?? 'ECLI-AGENT-001',
      message: errors.map(e => e.message).join('; '),
      details: { errors },
      recoverable: false,
    };
  }

  private checkForGuidance(input: CLIUXAgentInput): GuidanceResult | null {
    const { command } = input.command;

    // Help command
    if (command === 'help' || input.command.flags['help'] || input.command.flags['h']) {
      return {
        type: 'guidance',
        message: 'Available commands and options',
        options: [
          { label: 'plan', command: 'agentics plan', description: 'Create simulation plans' },
          { label: 'simulate', command: 'agentics simulate', description: 'Run simulations' },
          { label: 'inspect', command: 'agentics inspect', description: 'Query simulation results' },
          { label: 'quantify', command: 'agentics quantify', description: 'Generate ROI analysis' },
          { label: 'deploy', command: 'agentics deploy', description: 'Resolve deployment intent' },
          { label: 'export', command: 'agentics export', description: 'Generate IaC artifacts' },
        ],
        next_steps: [
          'Run "agentics <command> help" for command-specific help',
          'Run "agentics login" to authenticate',
        ],
      };
    }

    // No guidance needed
    return null;
  }

  // calculateCommandConfidence removed — scoring is platform-side logic.

  private parseFlags(args: string[]): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const arg of args) {
      if (arg.startsWith('--') && !arg.includes('=')) {
        flags[arg.slice(2)] = true;
      } else if (arg.startsWith('-') && !arg.startsWith('--')) {
        flags[arg.slice(1)] = true;
      }
    }
    return flags;
  }

  private parseOptions(args: string[]): Record<string, string> {
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg?.startsWith('--') && arg.includes('=')) {
        const [key, value] = arg.slice(2).split('=');
        if (key && value) {
          options[key] = value;
        }
      } else if (arg?.startsWith('--') && args[i + 1] && !args[i + 1]?.startsWith('-')) {
        options[arg.slice(2)] = args[i + 1]!;
        i++;
      }
    }
    return options;
  }

  private checkAuthentication(): boolean {
    // Check for auth token in environment
    return !!process.env['AGENTICS_API_KEY'] || !!process.env['AGENTICS_AUTH_TOKEN'];
  }

  private checkExecutionGate(): boolean {
    // Execution is allowed for internal or paid users via entitlement resolution
    return true;
  }

  private computeInputHash(input: CLIUXAgentInput): string {
    const canonical = JSON.stringify({
      command: input.command,
      args: input.args,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a CLI UX Agent instance.
 */
export function createCLIUXAgent(config?: CLIUXAgentConfig): ICLIUXAgent {
  return new CLIUXAgent(config);
}

/**
 * Get the CLI UX Agent registration.
 */
export function getCLIUXAgentRegistration(): AgentRegistration {
  return CLI_UX_AGENT_REGISTRATION;
}
