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
  },
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
  execution_graph?: ExecutionGraph;
}

export interface LayerExecutionRecord {
  layer: string;
  status: string;
  duration_ms?: number;
}

export interface ExecutionGraph {
  nodes: unknown[];
  edges: unknown[];
}
