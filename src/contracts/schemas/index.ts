/**
 * Contract Schemas - Bundled into CLI
 *
 * These schemas define the request/response contracts for all CLI commands.
 * Bundled directly to avoid external dependency issues.
 */

// ============================================================================
// Request Schemas
// ============================================================================

export const planRequestSchema = {
  type: 'object',
  properties: {
    manifest_ref: { type: 'object' },
    scenario: { type: 'object' },
    params: { type: 'object' },
    query: { type: 'string' },
  },
  additionalProperties: true,
};

export const simulateRequestSchema = {
  type: 'object',
  properties: {
    plan_ref: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        repository: { type: 'string' },
        created_at: { type: 'string' },
        checksum: { type: 'string' },
      },
    },
    scenario: {
      type: 'object',
      properties: {
        scenarioId: { type: 'string' },
        version: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        preconditions: { type: 'array', items: { type: 'string' } },
        setup: {
          type: 'object',
          properties: {
            environment: { type: 'object' },
            fixtures: { type: 'array', items: { type: 'object' } },
          },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string' },
              action: { type: 'string' },
              params: { type: 'object' },
              expected: { type: 'string' },
            },
            required: ['stepId', 'action'],
          },
          minItems: 1,
        },
        teardown: {
          type: 'object',
          properties: {
            cleanup: { type: 'array', items: { type: 'string' } },
          },
        },
        expectations: {
          type: 'object',
          properties: {
            success_criteria: { type: 'array', items: { type: 'string' } },
            metrics: { type: 'object' },
          },
        },
      },
      required: ['scenarioId', 'version', 'name', 'description', 'category', 'tags', 'preconditions', 'setup', 'steps', 'teardown', 'expectations'],
    },
    config: { type: 'object' },
    iterations: { type: 'integer', minimum: 1 },
  },
  additionalProperties: true,
};

export const inspectRequestSchema = {
  type: 'object',
  properties: {
    sim_ref: { type: 'object' },
    output_type: { type: 'string' },
    depth: { type: 'string' },
  },
  additionalProperties: true,
};

export const quantifyRequestSchema = {
  type: 'object',
  properties: {
    sim_ref: { type: 'object' },
    report_type: { type: 'string' },
    params: { type: 'object' },
    time_horizon: { type: 'string' },
  },
  additionalProperties: true,
};

export const deployRequestSchema = {
  type: 'object',
  properties: {
    sim_ref: { type: 'object' },
    spec: { type: 'object' },
    environment: { type: 'string' },
  },
  additionalProperties: true,
};

export const exportRequestSchema = {
  type: 'object',
  properties: {
    intent_ref: { type: 'object' },
    format_spec: { type: 'object' },
  },
  additionalProperties: true,
};

export const diligenceRequestSchema = {
  type: 'object',
  properties: {
    refs: {},
    requirements: { type: 'object' },
    frameworks: { type: 'array' },
    include_evidence: { type: 'boolean' },
    certifying_authority: { type: 'string' },
  },
  additionalProperties: true,
};

export const manifestsRequestSchema = {
  type: 'object',
  properties: {
    criteria: { type: 'object' },
    query: { type: 'string' },
  },
  additionalProperties: true,
};

export const plansRequestSchema = {
  type: 'object',
  properties: {
    manifest_ref: { type: 'object' },
    params: { type: 'object' },
    intent: { type: 'string' },
  },
  required: ['intent'],
  additionalProperties: true,
};

// ============================================================================
// Response Schemas
// ============================================================================

export const baseResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const manifestResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'ManifestReference' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const planResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'PlanReference' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const simulationResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'SimulationReference' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const simulationOutputResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    outputs: { type: 'object' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const roiReportResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'ROIReport' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const intentResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'IntentReference' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const exportResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'ExportReference' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export const diligencePackageResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'DiligencePackage' },
    execution_metadata: { type: 'object' },
  },
  additionalProperties: true,
};

// ============================================================================
// Execution Proof
// ============================================================================

export const platformLayers = [
  'INTENT_GATE',
  'SIMULATION_ENGINE',
  'ROI_CALCULATOR',
  'EXPORT_GENERATOR',
] as const;

// ============================================================================
// Schema Registry Constants
// ============================================================================

export const RequestSchemas = Object.freeze({
  PLAN: 'plan' as const,
  SIMULATE: 'simulate' as const,
  INSPECT: 'inspect' as const,
  QUANTIFY: 'quantify' as const,
  DEPLOY: 'deploy' as const,
  EXPORT: 'export' as const,
  DILIGENCE: 'diligence' as const,
  MANIFESTS: 'manifests' as const,
  PLANS: 'plans' as const,
});

export const ResponseSchemas = Object.freeze({
  MANIFEST: 'manifest' as const,
  PLAN: 'plan' as const,
  SIMULATION: 'simulation' as const,
  SIMULATION_OUTPUT: 'simulationOutput' as const,
  ROI_REPORT: 'roiReport' as const,
  INTENT: 'intent' as const,
  EXPORT: 'export' as const,
  DILIGENCE_PACKAGE: 'diligencePackage' as const,
});

// ============================================================================
// Contract Types
// ============================================================================

export interface PlanRequestContract {
  manifest_ref?: unknown;
  scenario?: unknown;
  params?: Record<string, unknown>;
  query?: string;
  [key: string]: unknown;
}

export interface ManifestsRequestContract {
  criteria?: Record<string, unknown>;
  query?: string;
  [key: string]: unknown;
}

/**
 * Step definition for simulation scenario
 */
export interface ScenarioStep {
  stepId: string;
  action: string;
  params?: Record<string, unknown>;
  expected?: string;
}

/**
 * Full scenario structure required by the API
 */
export interface ScenarioObject {
  scenarioId: string;
  version: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  preconditions: string[];
  setup: {
    environment?: Record<string, unknown>;
    fixtures?: Record<string, unknown>[];
  };
  steps: ScenarioStep[];
  teardown: {
    cleanup?: string[];
  };
  expectations: {
    success_criteria?: string[];
    metrics?: Record<string, unknown>;
  };
}

export interface SimulateRequestContract {
  plan_ref?: {
    id: string;
    type: string;
    repository?: string;
    created_at?: string;
    checksum?: string;
  };
  scenario?: ScenarioObject;
  config?: Record<string, unknown>;
  iterations?: number;
  /** Canonical execution context — required by agentics-contracts */
  execution_context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InspectRequestContract {
  sim_ref: unknown;
  output_type?: string;
  depth?: string | number;
  [key: string]: unknown;
}

export interface QuantifyRequestContract {
  sim_ref: unknown;
  report_type?: string;
  params?: Record<string, unknown>;
  time_horizon?: string | number;
  [key: string]: unknown;
}

export interface DeployRequestContract {
  sim_ref: unknown;
  spec?: Record<string, unknown>;
  environment?: string;
  [key: string]: unknown;
}

export interface ExportRequestContract {
  intent_ref: unknown;
  format_spec?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DiligenceRequestContract {
  refs: unknown[] | { natural_language: string };
  requirements?: Record<string, unknown>;
  frameworks?: unknown;
  include_evidence?: boolean;
  certifying_authority?: string;
  [key: string]: unknown;
}

export interface ExecutionMetadata {
  trace_id: string;
  timestamp: string;
  layers_executed?: LayerExecutionRecord[];
  // execution_graph type imported from agentics-contracts (canonical source)
  execution_graph?: { graph_id: string; root_node: string; nodes: unknown[]; edges: unknown[]; created_at: string };
}

export interface LayerExecutionRecord {
  layer: string;
  status: string;
  duration_ms?: number;
}

// ============================================================================
// CLI UX Agent Schemas (PROMPT 3 - Platform Wiring)
// ============================================================================

/**
 * CLI UX Agent Input Schema
 * Validates inputs to the CLI UX Agent.
 */
export const cliUxAgentInputSchema = {
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Raw command line arguments',
    },
    command: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        subcommand: { type: 'string' },
        flags: { type: 'object', additionalProperties: { type: 'boolean' } },
        options: { type: 'object', additionalProperties: { type: 'string' } },
        positionalArgs: { type: 'array', items: { type: 'string' } },
      },
      required: ['command', 'flags', 'options', 'positionalArgs'],
    },
    context: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        authenticated: { type: 'boolean' },
        execution_gate_enabled: { type: 'boolean' },
        output_format: { type: 'string', enum: ['json', 'yaml', 'table', 'text', 'csv'] },
        verbose: { type: 'boolean' },
        timeout: { type: 'number' },
      },
      required: ['cwd', 'authenticated', 'execution_gate_enabled', 'output_format', 'verbose', 'timeout'],
    },
    trace_id: { type: 'string' },
  },
  required: ['args', 'command', 'context', 'trace_id'],
  additionalProperties: false,
};

/**
 * CLI UX Agent Output Schema
 * Validates outputs from the CLI UX Agent.
 */
export const cliUxAgentOutputSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    result: {
      type: 'object',
      oneOf: [
        {
          properties: {
            type: { type: 'string', const: 'success' },
            data: {},
            artifact_ref: { type: 'string' },
            services_invoked: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'data', 'services_invoked'],
        },
        {
          properties: {
            type: { type: 'string', const: 'error' },
            code: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'object' },
            recoverable: { type: 'boolean' },
          },
          required: ['type', 'code', 'message', 'recoverable'],
        },
        {
          properties: {
            type: { type: 'string', const: 'guidance' },
            message: { type: 'string' },
            options: { type: 'array' },
            next_steps: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'message'],
        },
      ],
    },
    decision_event: { $ref: '#/$defs/DecisionEvent' },
    timing: {
      type: 'object',
      properties: {
        total_ms: { type: 'number' },
        breakdown: { type: 'object', additionalProperties: { type: 'number' } },
        started_at: { type: 'string', format: 'date-time' },
        completed_at: { type: 'string', format: 'date-time' },
      },
      required: ['total_ms', 'breakdown', 'started_at', 'completed_at'],
    },
  },
  required: ['success', 'result', 'timing'],
  additionalProperties: false,
  $defs: {
    DecisionEvent: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        agent_version: { type: 'string' },
        decision_type: {
          type: 'string',
          enum: [
            'cli_ux_orchestration',
            'command_validation',
            'service_routing',
            'output_formatting',
            'error_presentation',
            'workflow_guidance',
          ],
        },
        inputs_hash: { type: 'string' },
        outputs: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            subcommand: { type: 'string' },
            result_type: { type: 'string', enum: ['success', 'error', 'guidance'] },
            artifact_ref: { type: 'string' },
            services_invoked: { type: 'array', items: { type: 'string' } },
          },
          required: ['command', 'result_type', 'services_invoked'],
        },
        confidence: {
          type: 'object',
          properties: {
            value: { type: 'number', minimum: 0, maximum: 1 },
            basis: { type: 'string' },
            components: { type: 'array' },
          },
          required: ['value', 'basis'],
        },
        constraints_applied: {
          type: 'object',
          properties: {
            permissions: { type: 'array', items: { type: 'string' } },
            environment: { type: 'object' },
            scope: { type: 'array' },
          },
          required: ['permissions', 'environment', 'scope'],
        },
        execution_ref: {
          type: ['object', 'null'],
          properties: {
            service: { type: 'string' },
            execution_id: { type: 'string' },
            trace_id: { type: 'string' },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
        trace_id: { type: 'string' },
      },
      required: [
        'agent_id',
        'agent_version',
        'decision_type',
        'inputs_hash',
        'outputs',
        'confidence',
        'constraints_applied',
        'timestamp',
        'trace_id',
      ],
    },
  },
};

/**
 * DecisionEvent Schema (standalone)
 * Used for validating DecisionEvents independently.
 */
export const decisionEventSchema = {
  type: 'object',
  properties: {
    agent_id: { type: 'string' },
    agent_version: { type: 'string' },
    decision_type: {
      type: 'string',
      enum: [
        'cli_ux_orchestration',
        'command_validation',
        'service_routing',
        'output_formatting',
        'error_presentation',
        'workflow_guidance',
      ],
    },
    inputs_hash: { type: 'string' },
    outputs: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        subcommand: { type: 'string' },
        result_type: { type: 'string', enum: ['success', 'error', 'guidance'] },
        artifact_ref: { type: 'string' },
        services_invoked: { type: 'array', items: { type: 'string' } },
      },
      required: ['command', 'result_type', 'services_invoked'],
    },
    confidence: {
      type: 'object',
      properties: {
        value: { type: 'number', minimum: 0, maximum: 1 },
        basis: { type: 'string' },
        components: { type: 'array' },
      },
      required: ['value', 'basis'],
    },
    constraints_applied: {
      type: 'object',
      properties: {
        permissions: { type: 'array', items: { type: 'string' } },
        environment: {
          type: 'object',
          properties: {
            is_local: { type: 'boolean' },
            is_production: { type: 'boolean' },
            execution_gate_enabled: { type: 'boolean' },
            auth_present: { type: 'boolean' },
          },
          required: ['is_local', 'is_production', 'execution_gate_enabled', 'auth_present'],
        },
        scope: { type: 'array' },
      },
      required: ['permissions', 'environment', 'scope'],
    },
    execution_ref: {
      oneOf: [
        {
          type: 'object',
          properties: {
            service: { type: 'string' },
            execution_id: { type: 'string' },
            trace_id: { type: 'string' },
          },
          required: ['service', 'execution_id', 'trace_id'],
        },
        { type: 'null' },
      ],
    },
    timestamp: { type: 'string', format: 'date-time' },
    trace_id: { type: 'string' },
  },
  required: [
    'agent_id',
    'agent_version',
    'decision_type',
    'inputs_hash',
    'outputs',
    'confidence',
    'constraints_applied',
    'timestamp',
    'trace_id',
  ],
  additionalProperties: false,
};

/**
 * Agent Registration Schema
 * Validates agent registration metadata.
 */
export const agentRegistrationSchema = {
  type: 'object',
  properties: {
    identifier: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        agent_version: { type: 'string' },
        agent_name: { type: 'string' },
        classification: { type: 'string', const: 'CLI_UX_ORCHESTRATION' },
      },
      required: ['agent_id', 'agent_version', 'agent_name', 'classification'],
    },
    purpose: { type: 'string' },
    inputs_schema_ref: { type: 'string' },
    outputs_schema_ref: { type: 'string' },
    decision_event_schema_ref: { type: 'string' },
    invocable_services: { type: 'array', items: { type: 'string' } },
    non_responsibilities: { type: 'array', items: { type: 'string' } },
    failure_modes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          description: { type: 'string' },
          exit_code: { type: 'number' },
          recoverable: { type: 'boolean' },
        },
        required: ['code', 'description', 'exit_code', 'recoverable'],
      },
    },
  },
  required: [
    'identifier',
    'purpose',
    'inputs_schema_ref',
    'outputs_schema_ref',
    'decision_event_schema_ref',
    'invocable_services',
    'non_responsibilities',
    'failure_modes',
  ],
  additionalProperties: false,
};

// Add Agent schemas to schema registry
export const AgentSchemas = Object.freeze({
  CLI_UX_AGENT_INPUT: 'cliUxAgentInput' as const,
  CLI_UX_AGENT_OUTPUT: 'cliUxAgentOutput' as const,
  DECISION_EVENT: 'decisionEvent' as const,
  AGENT_REGISTRATION: 'agentRegistration' as const,
});

// ============================================================================
// Readiness State Schema (agentics-contracts/readiness-state/v1)
// ============================================================================

export const readinessStateSchema = {
  type: 'object',
  properties: {
    schema: { type: 'string', const: 'agentics-contracts/readiness-state/v1' },
    state: {
      type: 'string',
      enum: ['INSPECTION_ONLY', 'INTEGRATION_READY_EXECUTION_GATED', 'EXECUTION_READY'],
    },
    simulation_id: { type: 'string' },
    plan_ref: { type: 'string' },
    determined_at: { type: 'string', format: 'date-time' },
    determination_inputs: {
      type: 'object',
      properties: {
        decision_readiness_summary: { type: 'string' },
        integration_manifest: { type: 'string' },
      },
    },
    execution_gate: {
      type: 'object',
      properties: {
        locked: { type: 'boolean' },
        reason: { type: 'string' },
        prerequisites_total: { type: 'integer', minimum: 0 },
        prerequisites_completed: { type: 'integer', minimum: 0 },
        critical_blockers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              system: { type: 'string' },
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              effort: { type: 'string' },
            },
            required: ['id', 'system', 'severity', 'effort'],
          },
        },
        unlock_criteria: { type: 'string' },
      },
      required: ['locked', 'reason', 'prerequisites_total', 'prerequisites_completed'],
    },
    integration_readiness: {
      type: 'object',
      properties: {
        entities_ready: { type: 'integer', minimum: 0 },
        entities_blocked: { type: 'integer', minimum: 0 },
        entities_total: { type: 'integer', minimum: 0 },
        readiness_pct: { type: 'number', minimum: 0, maximum: 100 },
        systems_ready: { type: 'array', items: { type: 'string' } },
        systems_blocked: { type: 'array', items: { type: 'string' } },
      },
      required: ['entities_ready', 'entities_blocked', 'entities_total', 'readiness_pct'],
    },
    financial_posture: {
      type: 'object',
      properties: {
        annual_api_spend_usd: { type: 'number' },
        year1_investment_usd: { type: 'number' },
        annual_savings_usd: { type: 'number' },
        roi_payback_months: { type: 'integer' },
        npv_5yr_usd: { type: 'number' },
      },
      required: ['annual_api_spend_usd', 'year1_investment_usd', 'annual_savings_usd', 'roi_payback_months'],
    },
    audit_matrix: {
      type: 'object',
      properties: {
        result: { type: 'string', enum: ['PASS', 'FAIL', 'PENDING'] },
        checks_passed: { type: 'integer', minimum: 0 },
        checks_total: { type: 'integer', minimum: 0 },
        last_audit: { type: 'string', format: 'date-time' },
      },
      required: ['result', 'checks_passed', 'checks_total'],
    },
    mode_transitions: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          allowed_commands: { type: 'array', items: { type: 'string' } },
          blocked_commands: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  required: [
    'schema',
    'state',
    'simulation_id',
    'plan_ref',
    'determined_at',
    'execution_gate',
    'integration_readiness',
    'financial_posture',
    'audit_matrix',
  ],
  additionalProperties: true,
};

export const ReadinessSchemas = Object.freeze({
  READINESS_STATE: 'readinessState' as const,
});
