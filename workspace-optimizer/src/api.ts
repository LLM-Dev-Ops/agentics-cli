import express from 'express';
import { z } from 'zod';
import { container as defaultContainer, type Container } from './container.js';
import { createLogger } from './logger.js';
import { correlationId, identityHeaders, requestLogger, metricsCollector, metricsHandler, requireRole, computeReadiness, resetMetrics } from './middleware.js';
import { AppError } from './errors.js';

const logger = createLogger('api');

/** ADR-059: App factory for test isolation — accepts optional container override */
export function createApp(c: Container = defaultContainer): express.Express {
  const app = express();
  app.use(express.json());
  app.use(correlationId);
  app.use(identityHeaders);
  app.use(requestLogger);
  app.use(metricsCollector);

  // === Health (ADR-054: liveness/readiness split) ===

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  function readinessPayload() {
    const auditResult = c.audit.verify();
    return computeReadiness({
      configLoaded: c.config !== null && c.config !== undefined,
      circuitBreakerState: c.circuitBreaker.getState(),
      auditChainValid: auditResult.valid,
      simulationId: c.config.simulationId,
    });
  }

  app.get('/health/ready', (_req, res) => {
    const result = readinessPayload();
    const statusCode = result.status === 'not_ready' ? 503 : 200;
    res.status(statusCode).json(result);
  });

  app.get('/health', (_req, res) => {
    const result = readinessPayload();
    const statusCode = result.status === 'not_ready' ? 503 : 200;
    res.status(statusCode).json(result);
  });

  // ADR-PRR-006: Kubernetes-standard probe endpoints

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: c.config.pipelineVersion,
      simulationId: c.config.simulationId,
    });
  });

  app.get('/readyz', (_req, res) => {
    const result = readinessPayload();
    const allPass = result.checks.every(ch => ch.status === 'pass');
    const hasFail = result.checks.some(ch => ch.status === 'fail');
    const statusCode = hasFail ? 503 : 200;

    res.status(statusCode).json({
      status: allPass ? 'ready' : hasFail ? 'not_ready' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: Object.fromEntries(result.checks.map(ch => [ch.name, ch.status])),
      simulationId: c.config.simulationId,
    });
  });

  app.get('/metrics', metricsHandler);

  // === Buildings ===
  // ADR-PRR-007: Fleet data comes from the container, not a direct seed import
  app.get('/api/buildings', (_req, res) => {
    res.json(c.fleetData.getBuildings());
  });

  // === Scoring ===
  app.get('/api/scores', requireRole('analyst'), (_req, res) => {
    const scores = c.scoring.scoreZones(c.fleetData.getZones(), c.fleetData.getOccupancyReadings(), c.fleetData.getBuildings());
    res.json(scores);
  });

  // === Scenarios ===
  app.get('/api/scenarios', requireRole('analyst'), (_req, res) => {
    const scores = c.scoring.scoreZones(c.fleetData.getZones(), c.fleetData.getOccupancyReadings(), c.fleetData.getBuildings());
    const scenarios = c.scenarios.generateScenarios(scores, c.fleetData.getBuildings());
    res.json(scenarios);
  });

  // === Decisions ===
  const CreateDecisionSchema = z.object({
    scenarioId: z.string().uuid(),
    createdBy: z.string().min(1),
    rationale: z.string().min(20),
  });

  app.post('/api/decisions', requireRole('facility_manager'), (req, res) => {
    const parsed = CreateDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      return;
    }

    const scores = c.scoring.scoreZones(c.fleetData.getZones(), c.fleetData.getOccupancyReadings(), c.fleetData.getBuildings());
    const scenarios = c.scenarios.generateScenarios(scores, c.fleetData.getBuildings());
    const scenario = scenarios.find(s => s.id === parsed.data.scenarioId);

    if (!scenario) {
      res.status(404).json({ error: 'Scenario not found' });
      return;
    }

    const decision = c.decisions.create({
      scenario,
      createdBy: parsed.data.createdBy,
      rationale: parsed.data.rationale,
    });

    res.status(201).json(decision);
  });

  app.post('/api/decisions/:id/submit', requireRole('facility_manager'), (req, res) => {
    const decision = c.decisions.submit(req.params.id, req.userRole!);
    res.json(decision);
  });

  const ApproveSchema = z.object({
    approver: z.string().min(1),
    role: z.enum(['facility_manager', 'vp_operations', 'cfo', 'admin']),
    rationale: z.string().min(20),
  });

  app.post('/api/decisions/:id/approve', requireRole('facility_manager'), (req, res) => {
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      return;
    }

    const decision = c.decisions.approve({
      decisionId: req.params.id,
      ...parsed.data,
    });
    res.json(decision);
  });

  // ADR-PRR-004: Rejection endpoint
  const RejectSchema = z.object({
    rejector: z.string().min(1),
    role: z.enum(['facility_manager', 'vp_operations', 'cfo', 'admin']),
    rationale: z.string().min(20),
  });

  app.post('/api/decisions/:id/reject', requireRole('facility_manager'), (req, res) => {
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      return;
    }

    const decision = c.decisions.reject({
      decisionId: req.params.id,
      ...parsed.data,
    });
    res.json(decision);
  });

  // === Audit ===
  app.get('/api/audit', requireRole('analyst'), (_req, res) => {
    res.json(c.audit.getEntries());
  });

  app.get('/api/audit/verify', requireRole('analyst'), (_req, res) => {
    res.json(c.audit.verify());
  });

  // === Error Handler ===
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const corrId = req.correlationId ?? 'unknown';

    if (err instanceof AppError) {
      logger.warn('app.error', { code: err.code, message: err.message, correlationId: corrId });
      res.status(err.statusCode).json({ error: err.message, code: err.code, correlationId: corrId });
      return;
    }

    logger.error('unhandled.error', err, { correlationId: corrId });
    res.status(500).json({ error: 'Internal server error', correlationId: corrId });
  });

  return app;
}

// Default app for backwards compatibility with existing imports
export const app = createApp();

// === Start (only when run directly) ===
const isDirectRun = process.argv[1]?.endsWith('api.ts') || process.argv[1]?.endsWith('api.js');
if (isDirectRun) {
  const port = defaultContainer.config.port;
  app.listen(port, () => {
    logger.info('server.started', { port, simulationId: defaultContainer.config.simulationId });
  });
}
