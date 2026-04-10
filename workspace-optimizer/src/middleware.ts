import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger.js';
import { CircuitOpenError } from './errors.js';

const logger = createLogger('middleware');

// === Correlation ID Middleware ===

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-correlation-id'] as string) || randomUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}

// === Request Logger ===

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http.request', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      correlationId: req.correlationId,
    });
  });
  next();
}

// === RBAC Middleware ===

const ROLE_HIERARCHY: Record<string, number> = {
  analyst: 1,
  facility_manager: 2,
  vp_operations: 3,
  cfo: 4,
  admin: 5,
};

export function requireRole(minRole: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.headers['x-user-role'] as string;
    if (!role || !ROLE_HIERARCHY[role]) {
      res.status(403).json({ error: 'Missing or invalid X-User-Role header' });
      return;
    }
    if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[minRole]) {
      res.status(403).json({ error: `Requires role ${minRole} or higher` });
      return;
    }
    next();
  };
}

// === Alert Thresholds (ADR-054) ===
// Exported as a contract for Grafana/CloudWatch/Datadog to consume during pilot setup.
// NOT enforced at runtime — monitoring layer reads these from /metrics.

export const ALERT_THRESHOLDS = {
  errorRatePercent: 5,        // Alert if > 5% of requests return 5xx
  errorRateWindowMs: 300_000, // Over a 5-minute window
  p99LatencyMs: 2000,         // Alert if p99 > 2s
  circuitOpenCount: 3,        // Alert if circuit opens > 3 times in 1 hour
  auditChainBroken: true,     // Alert immediately on chain integrity failure
} as const;

// === Metrics Collector ===

interface Metrics {
  requestCount: number;
  errorCount: number;
  totalLatencyMs: number;
  latencies: number[];
}

const metrics: Metrics = { requestCount: 0, errorCount: 0, totalLatencyMs: 0, latencies: [] };

export function metricsCollector(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    metrics.requestCount++;
    metrics.totalLatencyMs += durationMs;
    metrics.latencies.push(durationMs);
    // Keep last 1000 latencies for percentile calculation
    if (metrics.latencies.length > 1000) metrics.latencies.shift();
    if (res.statusCode >= 500) metrics.errorCount++;
  });
  next();
}

function computeP99(): number {
  if (metrics.latencies.length === 0) return 0;
  const sorted = [...metrics.latencies].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[idx];
}

export function metricsHandler(_req: Request, res: Response): void {
  const errorRatePercent = metrics.requestCount > 0
    ? Math.round((metrics.errorCount / metrics.requestCount) * 10000) / 100
    : 0;

  res.json({
    requestCount: metrics.requestCount,
    errorCount: metrics.errorCount,
    errorRatePercent,
    avgLatencyMs: metrics.requestCount > 0 ? Math.round(metrics.totalLatencyMs / metrics.requestCount) : 0,
    p99LatencyMs: computeP99(),
    thresholds: ALERT_THRESHOLDS,
  });
}

export function resetMetrics(): void {
  metrics.requestCount = 0;
  metrics.errorCount = 0;
  metrics.totalLatencyMs = 0;
  metrics.latencies = [];
}

// === Health Checks (ADR-054) ===

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
}

export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export interface ReadinessResult {
  status: ReadinessStatus;
  checks: HealthCheck[];
  simulationId?: string;
}

export function computeReadiness(deps: {
  configLoaded: boolean;
  circuitBreakerState: string;
  auditChainValid: boolean;
  simulationId: string;
}): ReadinessResult {
  const checks: HealthCheck[] = [];

  // 1. Config loaded
  checks.push({
    name: 'config_loaded',
    status: deps.configLoaded ? 'pass' : 'fail',
    message: deps.configLoaded ? 'Configuration loaded' : 'Configuration failed to load',
  });

  // 2. Circuit breaker state
  const cbState = deps.circuitBreakerState;
  checks.push({
    name: 'circuit_breaker',
    status: cbState === 'closed' ? 'pass' : cbState === 'half-open' ? 'warn' : 'fail',
    message: `Circuit breaker is ${cbState}`,
  });

  // 3. Memory usage
  const mem = process.memoryUsage();
  const heapPercent = mem.heapUsed / mem.heapTotal;
  checks.push({
    name: 'memory_usage',
    status: heapPercent < 0.8 ? 'pass' : heapPercent < 0.9 ? 'warn' : 'fail',
    message: `Heap: ${Math.round(heapPercent * 100)}% (${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB)`,
  });

  // 4. Audit chain integrity
  checks.push({
    name: 'audit_chain',
    status: deps.auditChainValid ? 'pass' : 'fail',
    message: deps.auditChainValid ? 'Audit chain intact' : 'Audit chain integrity failure',
  });

  // Compute overall status
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  const status: ReadinessStatus = hasFail ? 'not_ready' : hasWarn ? 'degraded' : 'ready';

  return { status, checks, simulationId: deps.simulationId };
}

// === Circuit Breaker ===

export class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly logger_: ReturnType<typeof createLogger>,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetMs) {
        this.state = 'half-open';
        this.logger_.info('circuit.half-open');
      } else {
        throw new CircuitOpenError('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
        this.logger_.info('circuit.closed');
      }
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= this.threshold) {
        this.state = 'open';
        this.logger_.warn('circuit.open', { failures: this.failures });
      }
      throw error;
    }
  }

  getState(): string {
    return this.state;
  }
}
