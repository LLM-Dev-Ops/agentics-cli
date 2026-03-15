/**
 * Health Route Tests
 *
 * Tests the /health endpoint for correct response shape,
 * status values, and timestamp formatting.
 */

import { Hono } from 'hono';

describe('Health Route', () => {
  let app: Hono;

  beforeAll(async () => {
    const mod = await import('../../../src/server/routes/health.js');
    app = new Hono();
    app.route('/health', mod.health);
  });

  it('should return HTTP 200', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('should return status=healthy', async () => {
    const res = await app.request('/health');
    const body = await res.json() as { status: string };
    expect(body.status).toBe('healthy');
  });

  it('should include a valid ISO 8601 timestamp', async () => {
    const res = await app.request('/health');
    const body = await res.json() as { timestamp: string };
    expect(body.timestamp).toBeDefined();
    const parsed = new Date(body.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
    // Verify it's recent (within last 5 seconds)
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000);
  });

  it('should include version string', async () => {
    const res = await app.request('/health');
    const body = await res.json() as { version: string };
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('should include services object with expected service names', async () => {
    const res = await app.request('/health');
    const body = await res.json() as { services: Record<string, string> };
    expect(body.services).toBeDefined();
    const expectedServices = [
      'simulation-engine', 'manifests', 'planner', 'runner',
      'roi-engine', 'intent', 'exporters', 'diligence',
    ];
    for (const svc of expectedServices) {
      expect(body.services[svc]).toBeDefined();
    }
  });

  it('should mark all services as available', async () => {
    const res = await app.request('/health');
    const body = await res.json() as { services: Record<string, string> };
    for (const [, value] of Object.entries(body.services)) {
      expect(value).toBe('available');
    }
  });

  it('should return Content-Type application/json', async () => {
    const res = await app.request('/health');
    const ct = res.headers.get('content-type');
    expect(ct).toContain('application/json');
  });

  it('should return 404 for POST to /health', async () => {
    const res = await app.request('/health', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('should have exactly 8 services', async () => {
    const res = await app.request('/health');
    const body = await res.json() as { services: Record<string, string> };
    expect(Object.keys(body.services)).toHaveLength(8);
  });

  it('should not include extra unknown fields at top level', async () => {
    const res = await app.request('/health');
    const body = await res.json() as Record<string, unknown>;
    const knownKeys = ['status', 'timestamp', 'version', 'services'];
    for (const key of Object.keys(body)) {
      expect(knownKeys).toContain(key);
    }
  });
});
