/**
 * ROI Route Handler
 *
 * POST /v1/roi
 *
 * Handles ROI report generation from the enterprise ROI engine.
 * Used by the CLI's `quantify` command.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildRoiReportReference } from '../utils/response-builder.js';

const roi = new Hono();

interface RoiRequest {
  sim_ref: unknown;
  report_type?: string;
  params?: Record<string, unknown>;
}

/**
 * POST /v1/roi
 *
 * Generate an ROI report based on a simulation reference.
 */
roi.post('/', async (c) => {
  try {
    const body = await c.req.json<RoiRequest>();

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

    const id = ids.roi();
    const reportType = body.report_type ?? 'cfo-grade';
    const params = body.params ?? {};

    // Build response matching RoiReportReference type
    const response = buildRoiReportReference(id, body.sim_ref, reportType, params);

    return c.json(response, 200);
  } catch (error) {
    console.error('ROI route error:', error);
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

export { roi };
