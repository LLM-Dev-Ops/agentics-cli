/**
 * Plans Route Handler
 *
 * POST /v1/plans
 *
 * Handles simulation plan creation from the planner service.
 * Used by the CLI's `plan` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildPlanReference } from '../utils/response-builder.js';

const plans = new Hono();

interface PlansRequest {
  manifest_ref: unknown;
  params?: Record<string, unknown>;
}

/**
 * POST /v1/plans
 *
 * Create a simulation plan based on a manifest reference.
 */
plans.post('/', async (c) => {
  try {
    const body = await c.req.json<PlansRequest>();

    // Validate required fields
    if (!body.manifest_ref) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'manifest_ref is required',
          },
        },
        400
      );
    }

    const id = ids.plan();
    const params = body.params ?? {};

    // Build response matching PlanReference type
    const response = buildPlanReference(id, body.manifest_ref, params);

    return c.json(response, 200);
  } catch (error) {
    console.error('Plans route error:', error);
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

export { plans };
