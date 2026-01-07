/**
 * Simulate Route Handler
 *
 * POST /v1/simulate
 *
 * Handles both:
 * 1. Simulation execution from plan_ref (CLI's `simulate` command)
 * 2. Simulation output retrieval from sim_ref (CLI's `inspect` command)
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildSimulationOutputReference, buildSimulationRunReference } from '../utils/response-builder.js';

const simulate = new Hono();

interface SimulateRequest {
  // For running a simulation (simulate command)
  plan_ref?: unknown;
  config?: Record<string, unknown>;
  iterations?: number;
  // For inspecting outputs (inspect command)
  sim_ref?: unknown;
  output_type?: string;
}

/**
 * POST /v1/simulate
 *
 * Handles both simulation execution and output retrieval.
 */
simulate.post('/', async (c) => {
  try {
    const body = await c.req.json<SimulateRequest>();

    // Case 1: Running a simulation (plan_ref provided)
    if (body.plan_ref) {
      const id = ids.run();
      const config = {
        ...body.config,
        iterations: body.iterations ?? 1,
      };
      const response = buildSimulationRunReference(id, body.plan_ref, config);
      return c.json(response, 200);
    }

    // Case 2: Inspecting simulation outputs (sim_ref provided)
    if (body.sim_ref) {
      const outputType = body.output_type ?? 'summary';
      const id = ids.simulation();
      const response = buildSimulationOutputReference(id, body.sim_ref, outputType);
      return c.json(response, 200);
    }

    // Neither provided - error
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Either plan_ref (to run simulation) or sim_ref (to inspect outputs) is required',
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
