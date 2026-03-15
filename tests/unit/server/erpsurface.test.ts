/**
 * ERP Surface Route Tests
 *
 * Tests the ERP sustainability registry, route handlers, and query validation
 * for all 10 supported ERP platforms.
 */

import { Hono } from 'hono';

// We need to import the erpsurface router to test it via Hono's test client
// The module also exports the registry data implicitly through its routes.

describe('ERP Surface Routes', () => {
  let app: Hono;

  beforeAll(async () => {
    // Dynamic import to handle ESM
    const mod = await import('../../../src/server/routes/erpsurface.js');
    app = new Hono();
    app.route('/v1/erpsurface', mod.erpsurface);
  });

  // -------------------------------------------------------------------------
  // Registry completeness
  // -------------------------------------------------------------------------

  describe('GET /v1/erpsurface/sustainability/platforms', () => {
    it('should return all 10 ERP platforms', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/platforms');
      expect(res.status).toBe(200);
      const body = await res.json() as { platform_count: number; platforms: Array<{ erp_id: string }> };
      expect(body.platform_count).toBe(10);
      expect(body.platforms).toHaveLength(10);
    });

    it('should include all expected ERP IDs', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/platforms');
      const body = await res.json() as { platforms: Array<{ erp_id: string }> };
      const ids = body.platforms.map((p) => p.erp_id);

      const expectedIds = [
        'sap-s4hana', 'oracle-erp', 'oracle-netsuite', 'microsoft-dynamics',
        'infor', 'epicor', 'sage-x3', 'ifs', 'workday', 'oracle-peoplesoft',
      ];
      for (const id of expectedIds) {
        expect(ids).toContain(id);
      }
    });

    it('should include display_name, api_type, and module_count for each platform', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/platforms');
      const body = await res.json() as { platforms: Array<Record<string, unknown>> };

      for (const platform of body.platforms) {
        expect(platform).toHaveProperty('display_name');
        expect(platform).toHaveProperty('api_type');
        expect(platform).toHaveProperty('module_count');
        expect(typeof platform['display_name']).toBe('string');
        expect(typeof platform['api_type']).toBe('string');
        expect(typeof platform['module_count']).toBe('number');
        expect(platform['module_count']).toBeGreaterThanOrEqual(1);
      }
    });

    it('should include supported_certifications for each platform', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/platforms');
      const body = await res.json() as { platforms: Array<{ supported_certifications: string[] }> };

      for (const platform of body.platforms) {
        expect(Array.isArray(platform.supported_certifications)).toBe(true);
        expect(platform.supported_certifications.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Module detail for valid ERP
  // -------------------------------------------------------------------------

  describe('GET /v1/erpsurface/sustainability/modules/:erpId', () => {
    it('should return modules for sap-s4hana', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/modules/sap-s4hana');
      expect(res.status).toBe(200);
      const body = await res.json() as { erp_id: string; modules: Array<{ module: string; entities: Array<{ sustainability_fields: string[] }> }> };
      expect(body.erp_id).toBe('sap-s4hana');
      expect(body.modules.length).toBeGreaterThanOrEqual(3);
    });

    it('should return 400 for unknown erpId', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/modules/unknown-erp');
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; supported: string[] } };
      expect(body.error.code).toBe('ERP_NOT_FOUND');
      expect(Array.isArray(body.error.supported)).toBe(true);
      expect(body.error.supported.length).toBe(10);
    });

    it('should have non-empty sustainability_fields on every entity', async () => {
      const erpIds = ['sap-s4hana', 'oracle-erp', 'infor', 'epicor', 'ifs'];
      for (const erpId of erpIds) {
        const res = await app.request(`/v1/erpsurface/sustainability/modules/${erpId}`);
        const body = await res.json() as { modules: Array<{ entities: Array<{ sustainability_fields: string[] }> }> };
        for (const mod of body.modules) {
          for (const entity of mod.entities) {
            expect(entity.sustainability_fields.length).toBeGreaterThan(0);
          }
        }
      }
    });

    it('should include api_names and service_path in module definitions', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/modules/oracle-erp');
      const body = await res.json() as { modules: Array<{ api_names: string[]; service_path: string }> };
      for (const mod of body.modules) {
        expect(Array.isArray(mod.api_names)).toBe(true);
        expect(mod.api_names.length).toBeGreaterThan(0);
        expect(typeof mod.service_path).toBe('string');
        expect(mod.service_path.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Sustainability query validation
  // -------------------------------------------------------------------------

  describe('POST /v1/erpsurface/sustainability/query', () => {
    it('should return 400 when erp_id is missing', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'MM-PUR' }),
      });
      // Missing erp_id means ERP_NOT_FOUND because config lookup fails on undefined
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('ERP_NOT_FOUND');
    });

    it('should return 400 with invalid erp_id', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erp_id: 'nonexistent', module: 'MM-PUR' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; supported: string[] } };
      expect(body.error.code).toBe('ERP_NOT_FOUND');
      expect(body.error.supported).toBeDefined();
    });

    it('should return 400 with invalid module for valid erp_id', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erp_id: 'sap-s4hana', module: 'FAKE-MODULE' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; available: string[] } };
      expect(body.error.code).toBe('MODULE_NOT_FOUND');
      expect(Array.isArray(body.error.available)).toBe(true);
      expect(body.error.available).toContain('MM-PUR');
    });

    it('should return 400 with invalid entity for valid module', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erp_id: 'sap-s4hana', module: 'MM-PUR', entity: 'FAKE_ENTITY' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; available: string[] } };
      expect(body.error.code).toBe('ENTITY_NOT_FOUND');
      expect(Array.isArray(body.error.available)).toBe(true);
    });

    it('should return correct shape on valid query', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erp_id: 'sap-s4hana', module: 'MM-PUR', entity: 'MARA' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('id');
      expect(body['type']).toBe('ERPSustainabilityQueryResult');
      expect(body['erp_id']).toBe('sap-s4hana');
      expect(body['module']).toBe('MM-PUR');
      expect(body['entity']).toBe('MARA');
      expect(body['status']).toBe('ready');
      expect(body).toHaveProperty('service_path');
      expect(body).toHaveProperty('query');
    });

    it('should default to first entity when entity is omitted', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erp_id: 'sap-s4hana', module: 'MM-PUR' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { entity: string };
      expect(body.entity).toBe('MARA'); // first entity in MM-PUR
    });

    it('should include sustainability fields in query result when no fields specified', async () => {
      const res = await app.request('/v1/erpsurface/sustainability/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erp_id: 'sap-s4hana', module: 'MM-PUR', entity: 'MARA' }),
      });
      const body = await res.json() as { query: { fields: string[] } };
      expect(body.query.fields).toContain('ZZRECYCLED_PCT');
      expect(body.query.fields).toContain('MATNR');
    });
  });

  // -------------------------------------------------------------------------
  // Backward-compat SAP endpoint
  // -------------------------------------------------------------------------

  describe('GET /v1/erpsurface/sap/sustainability-modules', () => {
    it('should return SAP-specific module structure', async () => {
      const res = await app.request('/v1/erpsurface/sap/sustainability-modules');
      expect(res.status).toBe(200);
      const body = await res.json() as { type: string; modules: Array<{ module: string; tables: Array<{ table_name: string }> }> };
      expect(body.type).toBe('SAPSustainabilityModules');
      expect(body.modules.length).toBeGreaterThanOrEqual(3);
    });

    it('should use SAP-specific field names (bapi_names, tables)', async () => {
      const res = await app.request('/v1/erpsurface/sap/sustainability-modules');
      const body = await res.json() as { modules: Array<Record<string, unknown>> };
      const firstModule = body.modules[0]!;
      expect(firstModule).toHaveProperty('bapi_names');
      expect(firstModule).toHaveProperty('odata_service');
      expect(firstModule).toHaveProperty('tables');
    });

    it('should have custom_field_convention mentioning ZZ* namespace', async () => {
      const res = await app.request('/v1/erpsurface/sap/sustainability-modules');
      const body = await res.json() as { custom_field_convention: string };
      expect(body.custom_field_convention).toContain('ZZ*');
    });
  });
});
