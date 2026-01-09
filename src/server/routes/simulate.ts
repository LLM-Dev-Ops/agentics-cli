/**
 * Simulate Route Handler
 *
 * POST /v1/simulate
 *
 * Handles:
 * 1. Simulation execution from plan_ref (CLI's `simulate` command with structured ref)
 * 2. Simulation execution from scenario (CLI's `simulate` command with natural language)
 * 3. Simulation output retrieval from sim_ref (CLI's `inspect` command)
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildSimulationOutputReference, buildSimulationRunReference, buildScenarioSimulationReference } from '../utils/response-builder.js';

const simulate = new Hono();

/**
 * Step definition for simulation scenario
 */
interface ScenarioStep {
  stepId: string;
  action: string;
  params?: Record<string, unknown>;
  expected?: string;
}

/**
 * Full scenario structure as defined by the API contract
 */
interface ScenarioObject {
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

interface SimulateRequest {
  // For running a simulation (simulate command with structured ref)
  plan_ref?: unknown;
  // For running a simulation (simulate command with natural language scenario)
  scenario?: ScenarioObject;
  config?: Record<string, unknown>;
  iterations?: number;
  // For inspecting outputs (inspect command)
  sim_ref?: unknown;
  output_type?: string;
}

/**
 * Validate that a scenario object has all required fields
 */
function validateScenario(scenario: unknown): { valid: boolean; error?: string } {
  if (!scenario || typeof scenario !== 'object') {
    return { valid: false, error: 'scenario must be an object' };
  }

  const s = scenario as Record<string, unknown>;

  // Check required string fields
  const requiredStrings = ['scenarioId', 'version', 'name', 'description', 'category'];
  for (const field of requiredStrings) {
    if (typeof s[field] !== 'string') {
      return { valid: false, error: `scenario.${field} is required and must be a string` };
    }
  }

  // Check tags array
  if (!Array.isArray(s['tags'])) {
    return { valid: false, error: 'scenario.tags is required and must be an array' };
  }

  // Check preconditions array
  if (!Array.isArray(s['preconditions'])) {
    return { valid: false, error: 'scenario.preconditions is required and must be an array' };
  }

  // Check setup object
  if (!s['setup'] || typeof s['setup'] !== 'object') {
    return { valid: false, error: 'scenario.setup is required and must be an object' };
  }

  // Check steps array with at least one step
  if (!Array.isArray(s['steps']) || s['steps'].length === 0) {
    return { valid: false, error: 'scenario.steps is required and must contain at least one step' };
  }

  // Validate each step has required fields
  const steps = s['steps'] as Record<string, unknown>[];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') {
      return { valid: false, error: `scenario.steps[${i}] must be an object` };
    }
    if (typeof step['stepId'] !== 'string') {
      return { valid: false, error: `scenario.steps[${i}].stepId is required` };
    }
    if (typeof step['action'] !== 'string') {
      return { valid: false, error: `scenario.steps[${i}].action is required` };
    }
  }

  // Check teardown object
  if (!s['teardown'] || typeof s['teardown'] !== 'object') {
    return { valid: false, error: 'scenario.teardown is required and must be an object' };
  }

  // Check expectations object
  if (!s['expectations'] || typeof s['expectations'] !== 'object') {
    return { valid: false, error: 'scenario.expectations is required and must be an object' };
  }

  return { valid: true };
}

/**
 * POST /v1/simulate
 *
 * Handles simulation execution and output retrieval.
 */
simulate.post('/', async (c) => {
  try {
    const body = await c.req.json<SimulateRequest>();

    // Case 1: Running a simulation with structured plan_ref
    if (body.plan_ref) {
      const id = ids.run();
      const config = {
        ...body.config,
        iterations: body.iterations ?? 1,
      };
      const response = buildSimulationRunReference(id, body.plan_ref, config);
      return c.json(response, 200);
    }

    // Case 2: Running a simulation with scenario object (natural language converted)
    if (body.scenario) {
      // Validate scenario object has all required fields
      const validation = validateScenario(body.scenario);
      if (!validation.valid) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: validation.error,
            },
          },
          400
        );
      }

      const id = ids.run();
      const config = {
        ...body.config,
        iterations: body.iterations ?? 1,
      };
      const response = buildScenarioSimulationReference(id, body.scenario, config);
      return c.json(response, 200);
    }

    // Case 3: Inspecting simulation outputs (sim_ref provided)
    if (body.sim_ref) {
      const outputType = body.output_type ?? 'summary';
      const id = ids.simulation();
      const response = buildSimulationOutputReference(id, body.sim_ref, outputType);
      return c.json(response, 200);
    }

    // None provided - error
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Either plan_ref (structured reference), scenario (scenario object), or sim_ref (to inspect outputs) is required',
        },
      },
      400
    );
  } catch (error) {
    console.error('Simulate route error:', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      500
    );
  }
});

export { simulate };
