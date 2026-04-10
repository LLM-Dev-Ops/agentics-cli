import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/api.js';
import { ALERT_THRESHOLDS, computeReadiness, resetMetrics } from '../src/middleware.js';

beforeEach(() => {
  resetMetrics();
});

describe('ADR-054: Observability Completion', () => {

  // === 1. Correlation ID in Response Headers ===

  describe('Correlation ID response header', () => {
    it('returns X-Correlation-Id header on every response', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['x-correlation-id']).toBeDefined();
      expect(res.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('echoes back client-provided correlation ID', async () => {
      const clientId = '11111111-2222-3333-4444-555555555555';
      const res = await request(app)
        .get('/health/live')
        .set('X-Correlation-Id', clientId);
      expect(res.headers['x-correlation-id']).toBe(clientId);
    });

    it('includes correlation ID in error responses', async () => {
      const res = await request(app).get('/api/scores'); // no role header → 403
      expect(res.status).toBe(403);
      expect(res.headers['x-correlation-id']).toBeDefined();
    });
  });

  // === 2. Deep Health Checks ===

  describe('GET /health/live', () => {
    it('returns 200 with minimal payload', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('does NOT check dependencies', async () => {
      const res = await request(app).get('/health/live');
      expect(res.body.checks).toBeUndefined();
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 with checks array when healthy', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks).toBeInstanceOf(Array);
      expect(res.body.checks.length).toBeGreaterThanOrEqual(4);
      expect(res.body.simulationId).toBeDefined();
    });

    it('includes config_loaded check', async () => {
      const res = await request(app).get('/health/ready');
      const configCheck = res.body.checks.find((c: { name: string }) => c.name === 'config_loaded');
      expect(configCheck).toBeDefined();
      expect(configCheck.status).toBe('pass');
    });

    it('includes circuit_breaker check', async () => {
      const res = await request(app).get('/health/ready');
      const cbCheck = res.body.checks.find((c: { name: string }) => c.name === 'circuit_breaker');
      expect(cbCheck).toBeDefined();
      expect(cbCheck.status).toBe('pass');
      expect(cbCheck.message).toContain('closed');
    });

    it('includes memory_usage check', async () => {
      const res = await request(app).get('/health/ready');
      const memCheck = res.body.checks.find((c: { name: string }) => c.name === 'memory_usage');
      expect(memCheck).toBeDefined();
      expect(memCheck.status).toBe('pass');
      expect(memCheck.message).toContain('Heap:');
    });

    it('includes audit_chain check', async () => {
      const res = await request(app).get('/health/ready');
      const auditCheck = res.body.checks.find((c: { name: string }) => c.name === 'audit_chain');
      expect(auditCheck).toBeDefined();
      expect(auditCheck.status).toBe('pass');
    });
  });

  describe('GET /health (alias)', () => {
    it('returns same structure as /health/ready', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks).toBeInstanceOf(Array);
    });
  });

  describe('computeReadiness unit tests', () => {
    it('returns not_ready when circuit breaker is open', () => {
      const result = computeReadiness({
        configLoaded: true,
        circuitBreakerState: 'open',
        auditChainValid: true,
        simulationId: 'test-sim',
      });
      expect(result.status).toBe('not_ready');
      const cbCheck = result.checks.find(c => c.name === 'circuit_breaker');
      expect(cbCheck?.status).toBe('fail');
    });

    it('returns degraded when circuit breaker is half-open', () => {
      const result = computeReadiness({
        configLoaded: true,
        circuitBreakerState: 'half-open',
        auditChainValid: true,
        simulationId: 'test-sim',
      });
      expect(result.status).toBe('degraded');
      const cbCheck = result.checks.find(c => c.name === 'circuit_breaker');
      expect(cbCheck?.status).toBe('warn');
    });

    it('returns not_ready when config not loaded', () => {
      const result = computeReadiness({
        configLoaded: false,
        circuitBreakerState: 'closed',
        auditChainValid: true,
        simulationId: 'test-sim',
      });
      expect(result.status).toBe('not_ready');
    });

    it('returns not_ready when audit chain is broken', () => {
      const result = computeReadiness({
        configLoaded: true,
        circuitBreakerState: 'closed',
        auditChainValid: false,
        simulationId: 'test-sim',
      });
      expect(result.status).toBe('not_ready');
      const auditCheck = result.checks.find(c => c.name === 'audit_chain');
      expect(auditCheck?.status).toBe('fail');
    });

    it('returns ready when all checks pass', () => {
      const result = computeReadiness({
        configLoaded: true,
        circuitBreakerState: 'closed',
        auditChainValid: true,
        simulationId: 'test-sim',
      });
      expect(result.status).toBe('ready');
      expect(result.checks.every(c => c.status === 'pass')).toBe(true);
    });
  });

  // === 3. Alert Thresholds ===

  describe('Alert thresholds', () => {
    it('exports ALERT_THRESHOLDS constant with expected keys', () => {
      expect(ALERT_THRESHOLDS.errorRatePercent).toBe(5);
      expect(ALERT_THRESHOLDS.errorRateWindowMs).toBe(300_000);
      expect(ALERT_THRESHOLDS.p99LatencyMs).toBe(2000);
      expect(ALERT_THRESHOLDS.circuitOpenCount).toBe(3);
      expect(ALERT_THRESHOLDS.auditChainBroken).toBe(true);
    });

    it('includes thresholds in /metrics response', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.body.thresholds).toBeDefined();
      expect(res.body.thresholds.errorRatePercent).toBe(5);
      expect(res.body.thresholds.p99LatencyMs).toBe(2000);
      expect(res.body.thresholds.circuitOpenCount).toBe(3);
      expect(res.body.thresholds.auditChainBroken).toBe(true);
    });

    it('includes error rate and p99 latency in /metrics response', async () => {
      // Make a few requests first to populate metrics
      await request(app).get('/health/live');
      await request(app).get('/health/live');

      const res = await request(app).get('/metrics');
      expect(res.body.requestCount).toBeGreaterThanOrEqual(2);
      expect(res.body.errorRatePercent).toBeDefined();
      expect(typeof res.body.errorRatePercent).toBe('number');
      expect(res.body.p99LatencyMs).toBeDefined();
      expect(typeof res.body.p99LatencyMs).toBe('number');
    });
  });

  // === ADR-PRR-006: Kubernetes-standard probe endpoints ===

  describe('GET /healthz (liveness)', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('includes timestamp as ISO string', async () => {
      const res = await request(app).get('/healthz');
      expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('includes uptime as a positive number', async () => {
      const res = await request(app).get('/healthz');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.uptime).toBeGreaterThan(0);
    });

    it('includes pipeline version and simulation ID', async () => {
      const res = await request(app).get('/healthz');
      expect(res.body.version).toBeDefined();
      expect(res.body.simulationId).toBeDefined();
    });

    it('does not require authentication', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /readyz (readiness)', () => {
    it('returns 200 with status ready when healthy', async () => {
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
    });

    it('includes timestamp as ISO string', async () => {
      const res = await request(app).get('/readyz');
      expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('includes checks as a flat object with pass/warn/fail values', async () => {
      const res = await request(app).get('/readyz');
      expect(res.body.checks).toBeDefined();
      expect(typeof res.body.checks).toBe('object');
      expect(res.body.checks.config_loaded).toBe('pass');
      expect(res.body.checks.circuit_breaker).toBe('pass');
      expect(res.body.checks.memory_usage).toBe('pass');
      expect(res.body.checks.audit_chain).toBe('pass');
    });

    it('includes simulation ID', async () => {
      const res = await request(app).get('/readyz');
      expect(res.body.simulationId).toBeDefined();
    });

    it('does not require authentication', async () => {
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
    });
  });
});
