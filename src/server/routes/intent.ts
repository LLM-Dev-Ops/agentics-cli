/**
 * Intent Route Handler
 *
 * POST /v1/intent
 *
 * Handles deployment intent resolution from the intent service.
 * Used by the CLI's `deploy` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildIntentReference } from '../utils/response-builder.js';

const intent = new Hono();

interface IntentRequest {
  sim_ref: unknown;
  spec?: Record<string, unknown>;
  environment?: string;
}

/**
 * POST /v1/intent
 *
 * Resolve deployment intent based on a simulation reference.
 */
intent.post('/', async (c) => {
  try {
    const body = await c.req.json<IntentRequest>();

    // Validate required fields
    if (!body.sim_ref) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'sim_ref is required',
          },
        },
        400
      );
    }

    const id = ids.intent();
    const spec = {
      ...body.spec,
      environment: body.environment ?? 'default',
    };

    // Build response matching IntentReference type
    const response = buildIntentReference(id, body.sim_ref, spec);

    return c.json(response, 200);
  } catch (error) {
    console.error('Intent route error:', error);
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

export { intent };
