/**
 * Contract Validator
 *
 * PURPOSE: Single validation boundary for all CLI commands.
 * Uses Ajv in STRICT mode - no coercion, no defaults, no bypass.
 *
 * RULES:
 * - Invalid requests FAIL LOCALLY (no network call)
 * - Invalid responses FAIL HARD (missing execution proof = reject)
 * - Responses MUST have execution_metadata AND multi-layer proof
 * - Multi-layer proof: layers_executed array AND/OR execution_graph
 * - No soft-fail behavior
 * - No bypass flags
 */

import { Ajv } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import ajvFormatsModule from 'ajv-formats';
import { CLIError } from '../errors/index.js';

// Import schemas bundled directly into CLI (no external dependency)
import {
  // Request schemas
  planRequestSchema,
  simulateRequestSchema,
  inspectRequestSchema,
  quantifyRequestSchema,
  deployRequestSchema,
  exportRequestSchema,
  diligenceRequestSchema,
  manifestsRequestSchema,
  plansRequestSchema,
  // Response schemas
  baseResponseSchema,
  manifestResponseSchema,
  planResponseSchema,
  simulationResponseSchema,
  simulationOutputResponseSchema,
  roiReportResponseSchema,
  intentResponseSchema,
  exportResponseSchema,
  diligencePackageResponseSchema,
  // Schema registry constants
  RequestSchemas,
  ResponseSchemas,
} from './schemas/index.js';

// Re-export contract types for convenience
export type {
  PlanRequestContract,
  ManifestsRequestContract,
  SimulateRequestContract,
  ScenarioObject,
  ScenarioStep,
  InspectRequestContract,
  QuantifyRequestContract,
  DeployRequestContract,
  ExportRequestContract,
  DiligenceRequestContract,
  ExecutionMetadata,
  LayerExecutionRecord,
  ExecutionGraph,
} from './schemas/index.js';

// Re-export schema registry constants
export { RequestSchemas, ResponseSchemas };

// Get the formats plugin (handle ESM/CJS default export)
const formatsPlugin: FormatsPlugin = ajvFormatsModule as unknown as FormatsPlugin;

// ============================================================================
// Ajv Instance Configuration (STRICT MODE)
// ============================================================================

const ajv = new Ajv({
  strict: true,
  strictSchema: true,
  strictNumbers: true,
  strictTypes: true,
  strictTuples: true,
  strictRequired: false, // Allow anyOf/oneOf with different required sets
  allowUnionTypes: true,
  validateFormats: true,
  allErrors: true, // Report all errors, not just the first
  verbose: true,   // Include schema and data in errors
  coerceTypes: false, // NO type coercion
  useDefaults: false, // NO default values
  removeAdditional: false, // Do not silently remove extra properties
});

// Add format validators (date-time, uri, email, etc.)
formatsPlugin(ajv);

// ============================================================================
// Request Schema Registry
// ============================================================================

type RequestSchemaName =
  | 'plan'
  | 'simulate'
  | 'inspect'
  | 'quantify'
  | 'deploy'
  | 'export'
  | 'diligence'
  | 'manifests'
  | 'plans';

const requestSchemas: Record<RequestSchemaName, object> = {
  plan: planRequestSchema,
  simulate: simulateRequestSchema,
  inspect: inspectRequestSchema,
  quantify: quantifyRequestSchema,
  deploy: deployRequestSchema,
  export: exportRequestSchema,
  diligence: diligenceRequestSchema,
  manifests: manifestsRequestSchema,
  plans: plansRequestSchema,
};

// ============================================================================
// Response Schema Registry
// ============================================================================

type ResponseSchemaName =
  | 'base'
  | 'manifest'
  | 'plan'
  | 'simulation'
  | 'simulationOutput'
  | 'roiReport'
  | 'intent'
  | 'export'
  | 'diligencePackage';

const responseSchemas: Record<ResponseSchemaName, object> = {
  base: baseResponseSchema,
  manifest: manifestResponseSchema,
  plan: planResponseSchema,
  simulation: simulationResponseSchema,
  simulationOutput: simulationOutputResponseSchema,
  roiReport: roiReportResponseSchema,
  intent: intentResponseSchema,
  export: exportResponseSchema,
  diligencePackage: diligencePackageResponseSchema,
};

// ============================================================================
// Compiled Validators (cached for performance)
// ============================================================================

const compiledRequestValidators = new Map<RequestSchemaName, ReturnType<typeof ajv.compile>>();
const compiledResponseValidators = new Map<ResponseSchemaName, ReturnType<typeof ajv.compile>>();

function getRequestValidator(schemaName: RequestSchemaName) {
  let validator = compiledRequestValidators.get(schemaName);
  if (!validator) {
    validator = ajv.compile(requestSchemas[schemaName]);
    compiledRequestValidators.set(schemaName, validator);
  }
  return validator;
}

function getResponseValidator(schemaName: ResponseSchemaName) {
  let validator = compiledResponseValidators.get(schemaName);
  if (!validator) {
    validator = ajv.compile(responseSchemas[schemaName]);
    compiledResponseValidators.set(schemaName, validator);
  }
  return validator;
}

// ============================================================================
// Validation Error Class
// ============================================================================

export class ContractValidationError extends CLIError {
  readonly validationErrors: object[];

  constructor(options: {
    type: 'request' | 'response';
    schemaName: string;
    errors: object[];
    data?: unknown;
    correlationId?: string;
  }) {
    const errorSummary = options.errors
      .slice(0, 3)
      .map((e: any) => `${e.instancePath || '/'}: ${e.message}`)
      .join('; ');

    super({
      code: options.type === 'request' ? 'ECLI-CONTRACT-REQ-001' : 'ECLI-CONTRACT-RES-001',
      category: options.type === 'request' ? 'INPUT_ERROR' : 'DOWNSTREAM_ERROR',
      message: options.type === 'request'
        ? `Request validation failed against contract '${options.schemaName}': ${errorSummary}`
        : `Response missing required execution proof or violates contract '${options.schemaName}': ${errorSummary}`,
      details: {
        schema: options.schemaName,
        validation_errors: options.errors,
        data_preview: options.data ? JSON.stringify(options.data).slice(0, 200) : undefined,
      },
      module: 'contracts',
      correlationId: options.correlationId,
      recoverable: false,
      exitCode: options.type === 'request' ? 100 : 140,
    });
    this.name = 'ContractValidationError';
    this.validationErrors = options.errors;
  }
}

// ============================================================================
// Request Validation Functions
// ============================================================================

/**
 * Validate a request payload against its contract schema.
 * MUST be called BEFORE any network request.
 *
 * @throws ContractValidationError if validation fails
 */
export function validateRequest<T>(
  schemaName: RequestSchemaName,
  data: unknown,
  correlationId?: string
): T {
  const validator = getRequestValidator(schemaName);
  const valid = validator(data);

  if (!valid) {
    throw new ContractValidationError({
      type: 'request',
      schemaName,
      errors: validator.errors ?? [],
      data,
      correlationId,
    });
  }

  return data as T;
}

// ============================================================================
// Response Validation Functions
// ============================================================================

/**
 * Validate a response payload against its contract schema.
 * CRITICAL: This enforces:
 * 1. execution_metadata REQUIRED
 * 2. Multi-layer execution proof (layers_executed AND/OR execution_graph)
 *
 * @throws ContractValidationError if validation fails or execution proof missing
 */
export function validateResponse<T>(
  schemaName: ResponseSchemaName,
  data: unknown,
  correlationId?: string
): T {
  // ========================================================================
  // STEP 1: Verify execution_metadata exists (hard requirement)
  // ========================================================================
  if (!hasExecutionMetadata(data)) {
    throw new ContractValidationError({
      type: 'response',
      schemaName,
      errors: [{
        instancePath: '/execution_metadata',
        message: 'Response missing required execution_metadata - cannot prove execution graph participation',
        keyword: 'required',
        params: { missingProperty: 'execution_metadata' },
      }],
      data,
      correlationId,
    });
  }

  // ========================================================================
  // STEP 2: Verify multi-layer execution proof exists
  // Responses MUST have either:
  // - layers_executed array with layer execution records
  // - execution_graph with node participation evidence
  // ========================================================================
  const proofResult = validateMultiLayerExecutionProof(data);
  if (!proofResult.valid) {
    throw new ContractValidationError({
      type: 'response',
      schemaName,
      errors: proofResult.errors,
      data,
      correlationId,
    });
  }

  // ========================================================================
  // STEP 3: Validate full response schema
  // ========================================================================
  const validator = getResponseValidator(schemaName);
  const valid = validator(data);

  if (!valid) {
    throw new ContractValidationError({
      type: 'response',
      schemaName,
      errors: validator.errors ?? [],
      data,
      correlationId,
    });
  }

  return data as T;
}

/**
 * Validate that execution_metadata exists and has required fields.
 * This is a hard requirement - responses without it are REJECTED.
 *
 * Services may use different field names for the execution identifier:
 * - execution_id (canonical)
 * - simulation_id (manifests service)
 * - request_id (planner service)
 */
function hasExecutionMetadata(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const obj = data as Record<string, unknown>;
  const meta = obj['execution_metadata'];

  if (!meta || typeof meta !== 'object') {
    return false;
  }

  const metadata = meta as Record<string, unknown>;

  // Check for execution identifier (services may use different field names)
  const hasExecutionId = (
    typeof metadata['execution_id'] === 'string' ||
    typeof metadata['simulation_id'] === 'string' ||
    typeof metadata['request_id'] === 'string'
  );

  // Timestamp is always required
  const hasTimestamp = typeof metadata['timestamp'] === 'string';

  // Service identification
  const hasServiceInfo = typeof metadata['service'] === 'string';

  return hasExecutionId && hasTimestamp && hasServiceInfo;
}

/**
 * Validate multi-layer execution proof.
 * Responses MUST have at least one of:
 * - layers_executed: array of layer names (can be in execution_metadata or at top level)
 * - execution_graph: DAG showing node participation
 * - execution_proof: execution proof object with layerRecords (inside execution_metadata)
 *
 * This proves the response traversed the execution graph.
 */
function validateMultiLayerExecutionProof(data: unknown): { valid: boolean; errors: object[] } {
  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      errors: [{
        instancePath: '/',
        message: 'Response must be an object',
        keyword: 'type',
        params: { type: 'object' },
      }],
    };
  }

  const obj = data as Record<string, unknown>;
  const meta = obj['execution_metadata'] as Record<string, unknown> | undefined;

  // Check for layers_executed - can be at top level, in execution_metadata, or as execution_proof
  const topLevelLayers = Array.isArray(obj['layers_executed']) && obj['layers_executed'].length > 0;
  const metaLayers = meta && Array.isArray(meta['layers_executed']) && meta['layers_executed'].length > 0;
  const hasExecutionProof = meta && meta['execution_proof'] && typeof meta['execution_proof'] === 'object';
  const hasExecutionGraph = obj['execution_graph'] && typeof obj['execution_graph'] === 'object';
  const hasPlanExecutionProof = obj['executionProof'] && typeof obj['executionProof'] === 'object';

  const hasLayersExecuted = topLevelLayers || metaLayers;
  const hasAnyProof = hasLayersExecuted || hasExecutionGraph || hasExecutionProof || hasPlanExecutionProof;

  // At least one form of multi-layer proof is required
  if (!hasAnyProof) {
    return {
      valid: false,
      errors: [{
        instancePath: '/',
        message: 'Response missing multi-layer execution proof - must include layers_executed array, execution_graph, or execution_proof',
        keyword: 'anyOf',
        params: { missingProperty: 'layers_executed OR execution_graph OR execution_proof' },
      }],
    };
  }

  // If layers_executed is present, just verify it's an array of strings (layer names are service-defined)
  if (hasLayersExecuted) {
    const layersExecuted = (topLevelLayers ? obj['layers_executed'] : meta!['layers_executed']) as unknown[];

    // If layers are strings (layer names), they're valid
    // If layers are objects (layer records), validate minimal structure
    for (let i = 0; i < layersExecuted.length; i++) {
      const layer = layersExecuted[i];
      if (typeof layer === 'string') {
        // Layer names are valid - services define their own layer names
        continue;
      }
      if (typeof layer === 'object' && layer !== null) {
        // Layer record - just needs a layer identifier
        const record = layer as Record<string, unknown>;
        if (typeof record['layer'] !== 'string') {
          // Could be using 'name' instead of 'layer'
          if (typeof record['name'] !== 'string') {
            return {
              valid: false,
              errors: [{
                instancePath: `/layers_executed/${i}`,
                message: 'Layer execution record must have a layer or name identifier',
                keyword: 'required',
                params: { missingProperty: 'layer or name' },
              }],
            };
          }
        }
      }
    }
  }

  // If execution_graph is present, validate it has required structure
  if (hasExecutionGraph) {
    const graph = obj['execution_graph'] as Record<string, unknown>;
    const graphErrors: object[] = [];

    if (typeof graph['graph_id'] !== 'string') {
      graphErrors.push({
        instancePath: '/execution_graph/graph_id',
        message: 'Execution graph missing graph_id',
        keyword: 'required',
        params: { missingProperty: 'graph_id' },
      });
    }

    if (typeof graph['root_node'] !== 'string') {
      graphErrors.push({
        instancePath: '/execution_graph/root_node',
        message: 'Execution graph missing root_node',
        keyword: 'required',
        params: { missingProperty: 'root_node' },
      });
    }

    if (!Array.isArray(graph['nodes']) || graph['nodes'].length === 0) {
      graphErrors.push({
        instancePath: '/execution_graph/nodes',
        message: 'Execution graph must have at least one node',
        keyword: 'minItems',
        params: { limit: 1 },
      });
    }

    if (typeof graph['created_at'] !== 'string') {
      graphErrors.push({
        instancePath: '/execution_graph/created_at',
        message: 'Execution graph missing created_at timestamp',
        keyword: 'required',
        params: { missingProperty: 'created_at' },
      });
    }

    if (graphErrors.length > 0) {
      return { valid: false, errors: graphErrors };
    }
  }

  return { valid: true, errors: [] };
}

// ============================================================================
// Combined Validation Utility
// ============================================================================

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: ContractValidationError };

/**
 * Safe validation that returns a result object instead of throwing.
 * Useful for conditional handling in some scenarios.
 */
export function safeValidateRequest<T>(
  schemaName: RequestSchemaName,
  data: unknown,
  correlationId?: string
): ValidationResult<T> {
  try {
    const validated = validateRequest<T>(schemaName, data, correlationId);
    return { valid: true, data: validated };
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return { valid: false, error };
    }
    throw error;
  }
}

export function safeValidateResponse<T>(
  schemaName: ResponseSchemaName,
  data: unknown,
  correlationId?: string
): ValidationResult<T> {
  try {
    const validated = validateResponse<T>(schemaName, data, correlationId);
    return { valid: true, data: validated };
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return { valid: false, error };
    }
    throw error;
  }
}
