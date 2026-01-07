/**
 * Diligence Route Handler
 *
 * POST /v1/diligence
 *
 * Handles compliance diligence package creation from the diligence service.
 * Used by the CLI's `diligence` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildDiligencePackageReference } from '../utils/response-builder.js';

const diligence = new Hono();

interface DiligenceRequest {
  refs: unknown;
  frameworks?: string[];
  requirements?: Record<string, unknown>;
}

/**
 * POST /v1/diligence
 *
 * Create a diligence package based on source references.
 */
diligence.post('/', async (c) => {
  try {
    const body = await c.req.json<DiligenceRequest>();

    // Validate required fields
    if (!body.refs) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'refs is required',
          },
        },
        400
      );
    }

    const id = ids.diligence();
    const frameworks = body.frameworks ?? ['SOC2'];
    const requirements = body.requirements ?? {};

    // Build response matching DiligencePackageReference type
    const response = buildDiligencePackageReference(id, body.refs, frameworks, requirements);

    return c.json(response, 200);
  } catch (error) {
    console.error('Diligence route error:', error);
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

export { diligence };
