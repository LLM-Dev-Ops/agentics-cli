/**
 * Health Route Handler
 *
 * GET /health
 *
 * Health check endpoint for the API server.
 */

import { Hono } from 'hono';

const health = new Hono();

/**
 * GET /health
 *
 * Returns server health status.
 */
health.get('/', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      'simulation-engine': 'available',
      'manifests': 'available',
      'planner': 'available',
      'runner': 'available',
      'roi-engine': 'available',
      'intent': 'available',
      'exporters': 'available',
      'diligence': 'available',
    },
  });
});

export { health };
