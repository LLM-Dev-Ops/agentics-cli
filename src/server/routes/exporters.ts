/**
 * Exporters Route Handler
 *
 * POST /v1/exporters
 *
 * Handles deployment export generation from the exporters service.
 * Used by the CLI's `export` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildExportReference } from '../utils/response-builder.js';

const exporters = new Hono();

interface ExportersRequest {
  intent_ref: unknown;
  format_spec?: {
    format?: string;
    output_path?: string;
  };
}

/**
 * POST /v1/exporters
 *
 * Generate deployment exports based on an intent reference.
 */
exporters.post('/', async (c) => {
  try {
    const body = await c.req.json<ExportersRequest>();

    // Validate required fields
    if (!body.intent_ref) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'intent_ref is required',
          },
        },
        400
      );
    }

    const id = ids.export();
    const formatSpec = body.format_spec ?? { format: 'terraform' };

    // Build response matching ExportReference type
    const response = buildExportReference(id, body.intent_ref, formatSpec);

    return c.json(response, 200);
  } catch (error) {
    console.error('Exporters route error:', error);
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

export { exporters };
