/**
 * Manifests Route Handler
 *
 * POST /v1/manifests
 *
 * Handles manifest selection/query from the manifests repository.
 * Used by the CLI's `plan` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildManifestReference } from '../utils/response-builder.js';

const manifests = new Hono();

interface ManifestsRequest {
  query: string;
}

/**
 * POST /v1/manifests
 *
 * Select a manifest based on a query string.
 */
manifests.post('/', async (c) => {
  try {
    const body = await c.req.json<ManifestsRequest>();

    // Validate required fields
    if (!body.query) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'query is required',
          },
        },
        400
      );
    }

    const id = ids.manifest();

    // Build response matching ManifestReference type
    const response = buildManifestReference(id, body.query);

    return c.json(response, 200);
  } catch (error) {
    console.error('Manifests route error:', error);
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

export { manifests };
