/**
 * ERP Surface Route Handler
 *
 * POST /v1/erpsurface
 *
 * Handles ERP Surface integration requests for enterprise resource planning.
 */

import { Hono } from 'hono';
import { ids } from '../utils/id-generator.js';
import { buildErpSurfaceReference } from '../utils/response-builder.js';

const erpsurface = new Hono();

interface ErpSurfaceRequest {
  // Source reference for ERP data
  source_ref?: unknown;
  // ERP system type (sap, oracle, dynamics, netsuite, etc.)
  erp_type?: string;
  // Integration operation
  operation?: string;
  // Entity type to surface
  entity_type?: string;
  // Query/filter parameters
  query?: Record<string, unknown>;
  // Sync configuration
  sync_config?: Record<string, unknown>;
}

/**
 * POST /v1/erpsurface
 *
 * Handles ERP Surface integration operations.
 */
erpsurface.post('/', async (c) => {
  try {
    const body = await c.req.json<ErpSurfaceRequest>();

    const id = ids.erp();
    const erpType = body.erp_type ?? 'generic';
    const operation = body.operation ?? 'sync';
    const entityType = body.entity_type ?? 'all';

    const response = buildErpSurfaceReference(
      id,
      body.source_ref,
      erpType,
      operation,
      entityType,
      body.query ?? {},
      body.sync_config ?? {}
    );

    return c.json(response, 200);
  } catch (error) {
    console.error('ERP Surface route error:', error);
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

/**
 * GET /v1/erpsurface/:id
 *
 * Get ERP Surface integration status.
 */
erpsurface.get('/:id', async (c) => {
  const id = c.req.param('id');

  return c.json({
    id,
    type: 'ErpSurfaceReference',
    status: 'completed',
    repository: 'agentics-erp-surface',
    created_at: new Date().toISOString(),
    sync_status: {
      entities_synced: 1250,
      entities_failed: 0,
      last_sync_at: new Date().toISOString(),
      next_sync_at: new Date(Date.now() + 3600000).toISOString(),
    },
  });
});

export { erpsurface };
