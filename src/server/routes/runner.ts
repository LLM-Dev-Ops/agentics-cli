/**
 * Runner Route Handler
 *
 * POST /v1/runner
 *
 * Handles simulation execution from the runner service.
 * Used by the CLI's `simulate` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildSimulationRunReference } from '../utils/response-builder.js';

const runner = new Hono();

interface RunnerRequest {
  plan_ref: unknown;
  config?: Record<string, unknown>;
  iterations?: number;
}

/**
 * POST /v1/runner
 *
 * Execute a simulation based on a plan reference.
 */
runner.post('/', async (c) => {
  try {
    const body = await c.req.json<RunnerRequest>();

    // Validate required fields
    if (!body.plan_ref) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'plan_ref is required',
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

    // Build response matching SimulationReference type
    const response = buildSimulationRunReference(id, body.plan_ref, config);

    return c.json(response, 200);
  } catch (error) {
    console.error('Runner route error:', error);
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

export { runner };
