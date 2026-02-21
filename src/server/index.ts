/**
 * Agentics Platform API Server
 *
 * Hono-based backend API server providing stub implementations
 * for all agentics platform services.
 *
 * Routes:
 * - GET  /health                     - Health check
 * - GET  /ready                      - Readiness check
 * - POST /v1/cli/auth/sessions       - OAuth device flow session creation
 * - GET  /v1/cli/auth/sessions/:code - Poll auth status
 * - GET  /v1/identity/whoami         - Identity resolution (user + org + role)
 * - POST /v1/identity/check-permission - Server-side permission check
 * - POST /v1/simulate                - Simulation engine (inspect command)
 * - POST /v1/manifests               - Manifests service (plan command)
 * - POST /v1/plans                   - Planner service (plan command)
 * - POST /v1/runner                  - Runner service (simulate command)
 * - POST /v1/roi                     - ROI engine (quantify command)
 * - POST /v1/intent                  - Intent service (deploy command)
 * - POST /v1/exporters               - Exporters service (export command)
 * - POST /v1/diligence               - Diligence service (diligence command)
 * - POST /v1/erpsurface             - ERP Surface service (ERP integration)
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import {
  simulate,
  manifests,
  plans,
  runner,
  roi,
  intent,
  exporters,
  diligence,
  health,
  auth,
  erpsurface,
  identity,
  lineage,
  // Downstream Agent Routes
  testBench,
  observatory,
  shield,
  sentinel,
  memoryGraph,
  latencyLens,
  forge,
  edge,
  autoOptimizer,
  incidentManager,
  orchestrator,
  costops,
  governanceDashboard,
  policyEngine,
  registry,
  marketplace,
  analyticsHub,
  configManager,
  schemaRegistry,
  connectorHub,
  copilot,
  simulator,
  benchmarkExchange,
  inferenceGateway,
  dataVault,
  researchLab,
  platformAgents,
} from './routes/index.js';

// ============================================================================
// App Configuration
// ============================================================================

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'X-Trace-ID'],
  credentials: true,
}));

// ============================================================================
// Route Registration
// ============================================================================

// Health check (root level)
app.route('/health', health);

// Readiness check
app.get('/ready', (c) => {
  return c.json({
    ready: true,
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'Agentics Platform API',
    version: process.env['npm_package_version'] ?? '1.0.0',
    documentation: 'https://platform.agentics.dev/docs',
  });
});

// Legacy status endpoint
app.get('/api/v1/status', (c) => {
  return c.json({
    operational: true,
    timestamp: new Date().toISOString(),
  });
});

// Auth routes
app.route('/v1/cli/auth', auth);

// Identity routes
app.route('/v1/identity', identity);

// API v1 routes
app.route('/v1/simulate', simulate);
app.route('/v1/manifests', manifests);
app.route('/v1/plans', plans);
app.route('/v1/runner', runner);
app.route('/v1/roi', roi);
app.route('/v1/intent', intent);
app.route('/v1/exporters', exporters);
app.route('/v1/diligence', diligence);
app.route('/v1/erpsurface', erpsurface);
app.route('/v1/lineage', lineage);

// Downstream Agent Routes
app.route('/v1/test-bench', testBench);
app.route('/v1/observatory', observatory);
app.route('/v1/shield', shield);
app.route('/v1/sentinel', sentinel);
app.route('/v1/memory-graph', memoryGraph);
app.route('/v1/latency-lens', latencyLens);
app.route('/v1/forge', forge);
app.route('/v1/edge', edge);
app.route('/v1/auto-optimizer', autoOptimizer);
app.route('/v1/incident-manager', incidentManager);
app.route('/v1/orchestrator', orchestrator);
app.route('/v1/costops', costops);
app.route('/v1/governance-dashboard', governanceDashboard);
app.route('/v1/policy-engine', policyEngine);
app.route('/v1/registry', registry);
app.route('/v1/marketplace', marketplace);
app.route('/v1/analytics-hub', analyticsHub);
app.route('/v1/config-manager', configManager);
app.route('/v1/schema-registry', schemaRegistry);
app.route('/v1/connector-hub', connectorHub);
app.route('/v1/copilot', copilot);
app.route('/v1/simulator', simulator);
app.route('/v1/benchmark-exchange', benchmarkExchange);
app.route('/v1/inference-gateway', inferenceGateway);
app.route('/v1/data-vault', dataVault);
app.route('/v1/research-lab', researchLab);
app.route('/v1/platform', platformAgents);

// ============================================================================
// Error Handling
// ============================================================================

app.notFound((c) => {
  return c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${c.req.method} ${c.req.path} not found`,
        available_routes: [
          'GET /health',
          'GET /ready',
          'POST /v1/cli/auth/sessions',
          'GET /v1/cli/auth/sessions/:device_code',
          'GET /v1/identity/whoami',
          'POST /v1/identity/check-permission',
          'POST /v1/simulate',
          'POST /v1/manifests',
          'POST /v1/plans',
          'POST /v1/runner',
          'POST /v1/roi',
          'POST /v1/intent',
          'POST /v1/exporters',
          'POST /v1/diligence',
          'POST /v1/erpsurface',
          'POST /v1/lineage',
          'GET /v1/lineage/artifact/:id',
          'GET /v1/lineage/simulation/:id/artifacts',
          // Downstream Agent Domains
          'POST /v1/test-bench/:agent',
          'POST /v1/observatory/:agent',
          'POST /v1/shield/:agent',
          'POST /v1/sentinel/:agent',
          'POST /v1/memory-graph/:agent',
          'POST /v1/latency-lens/:agent',
          'POST /v1/forge/:agent',
          'POST /v1/edge/:agent',
          'POST /v1/auto-optimizer/:agent',
          'POST /v1/incident-manager/:agent',
          'POST /v1/orchestrator/:agent',
          'POST /v1/costops/:agent',
          'POST /v1/governance-dashboard/:agent',
          'POST /v1/policy-engine/:agent',
          'POST /v1/registry/:agent',
          'POST /v1/marketplace/:agent',
          'POST /v1/analytics-hub/:agent',
          'POST /v1/config-manager/:agent',
          'POST /v1/schema-registry/:agent',
          'POST /v1/connector-hub/:agent',
          'POST /v1/copilot/:agent',
          'POST /v1/simulator/:agent',
          'POST /v1/benchmark-exchange/:agent',
          'POST /v1/inference-gateway/:agent',
          'POST /v1/data-vault/:agent',
          'POST /v1/research-lab/:agent',
          'POST /v1/platform/:agent',
        ],
      },
    },
    404
  );
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env['NODE_ENV'] === 'production'
          ? 'An error occurred'
          : (err.message ?? 'An unexpected error occurred'),
      },
    },
    500
  );
});

// ============================================================================
// Server Startup
// ============================================================================

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

console.log(`Starting Agentics Platform API Server...`);
console.log(`Environment: ${process.env['NODE_ENV'] ?? 'development'}`);

serve({
  fetch: app.fetch,
  port: PORT,
}, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET  http://localhost:${info.port}/health`);
  console.log(`  GET  http://localhost:${info.port}/ready`);
  console.log(`  POST http://localhost:${info.port}/v1/cli/auth/sessions`);
  console.log(`  GET  http://localhost:${info.port}/v1/cli/auth/sessions/:device_code`);
  console.log(`  GET  http://localhost:${info.port}/v1/identity/whoami`);
  console.log(`  POST http://localhost:${info.port}/v1/identity/check-permission`);
  console.log(`  POST http://localhost:${info.port}/v1/simulate`);
  console.log(`  POST http://localhost:${info.port}/v1/manifests`);
  console.log(`  POST http://localhost:${info.port}/v1/plans`);
  console.log(`  POST http://localhost:${info.port}/v1/runner`);
  console.log(`  POST http://localhost:${info.port}/v1/roi`);
  console.log(`  POST http://localhost:${info.port}/v1/intent`);
  console.log(`  POST http://localhost:${info.port}/v1/exporters`);
  console.log(`  POST http://localhost:${info.port}/v1/diligence`);
  console.log(`  POST http://localhost:${info.port}/v1/erpsurface`);
  console.log(`  POST http://localhost:${info.port}/v1/lineage`);
  console.log(`  GET  http://localhost:${info.port}/v1/lineage/artifact/:id`);
  console.log(`  GET  http://localhost:${info.port}/v1/lineage/simulation/:id/artifacts`);
});

// Export for testing and programmatic use
export { app };
export default app;
