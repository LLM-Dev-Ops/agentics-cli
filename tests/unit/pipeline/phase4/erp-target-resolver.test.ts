/**
 * Phase 4 — ERP Target Resolver Tests
 *
 * Tests the Stage 2 ERP detection and database resolution logic:
 *   - Detects SAP S/4HANA from scenario query
 *   - Detects Oracle ERP from SPARC services
 *   - Detects Dynamics from dossier items
 *   - Workday → apiOnly: true
 *   - No ERP detected → ECLI-P4-002 error
 *   - Multiple ERP mentions → highest confidence wins
 */

import { resolveERPTarget } from '../../../../src/pipeline/phase4/phases/erp-target-resolver.js';
import type {
  Phase4Context,
  ERPResolution,
  Phase3Artifacts,
} from '../../../../src/pipeline/phase4/types.js';
import type { TelemetrySpan } from '../../../../src/pipeline/phase2/types.js';

// ============================================================================
// Helpers
// ============================================================================

function buildMinimalPhase2Artifacts(overrides?: {
  sparc?: unknown;
  adrs?: unknown;
  manifest?: unknown;
  domainModel?: unknown;
}) {
  return {
    manifest: overrides?.manifest ?? {},
    sparc: overrides?.sparc ?? {},
    adrs: overrides?.adrs ?? [],
    domainModel: overrides?.domainModel ?? { contexts: [], contextMap: [] },
    tddPlan: { approach: '', testPyramid: {}, testSuites: [], mockContracts: [], seamDefinitions: [], executionOrder: [] },
  };
}

function buildContext(
  scenarioQuery: string,
  phase2Overrides?: Parameters<typeof buildMinimalPhase2Artifacts>[0],
): Phase4Context {
  const phase2Artifacts = buildMinimalPhase2Artifacts(phase2Overrides);

  const phase3Artifacts: Phase3Artifacts = {
    manifest: { schema_version: '3.0.0', success: true } as any,
    implementationLanguage: 'typescript',
    projectDir: '/tmp/fake-project',
    phase2Artifacts: phase2Artifacts as any,
  };

  return {
    traceId: 'test-trace-erp',
    phase2Dir: '/tmp/fake-phase2',
    phase3Dir: '/tmp/fake-phase3',
    phase4Dir: '/tmp/fake-phase4',
    scenarioQuery,
    phase3Artifacts,
    platformRepoPaths: {},
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('resolveERPTarget (Stage 2)', () => {

  describe('detection from scenario query', () => {
    it('should detect SAP S/4HANA from scenario query', () => {
      const context = buildContext('Build an SAP S/4HANA procurement integration');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('sap-s4hana');
      expect(data.databaseEngine).toBe('sap-hana');
      expect(data.sqlDialect).toBe('hana-sql');
      expect(data.apiOnly).toBe(false);
      expect(data.detectionSource).toBe('scenario-query');
      expect(data.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should detect Oracle ERP from scenario query', () => {
      const context = buildContext('Integrate with Oracle ERP Cloud for financials');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('oracle-erp');
      expect(data.databaseEngine).toBe('oracle');
      expect(data.sqlDialect).toBe('oracle-sql');
      expect(data.apiOnly).toBe(false);
    });

    it('should detect Microsoft Dynamics from scenario query', () => {
      const context = buildContext('Build a Dynamics 365 CRM integration');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('microsoft-dynamics');
      expect(data.databaseEngine).toBe('sql-server');
      expect(data.sqlDialect).toBe('tsql');
      expect(data.apiOnly).toBe(false);
    });

    it('should detect NetSuite from scenario query', () => {
      const context = buildContext('Connect to NetSuite for order management');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('oracle-netsuite');
      expect(data.databaseEngine).toBe('oracle');
      expect(data.sqlDialect).toBe('oracle-sql');
    });

    it('should detect Workday as API-only', () => {
      const context = buildContext('Integrate with Workday HCM for employee data');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('workday');
      expect(data.databaseEngine).toBeNull();
      expect(data.sqlDialect).toBeNull();
      expect(data.apiOnly).toBe(true);
    });

    it('should detect Infor from scenario query', () => {
      const context = buildContext('Build an Infor CloudSuite manufacturing integration');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('infor');
      expect(data.databaseEngine).toBe('oracle');
    });

    it('should detect SAP ECC from scenario query', () => {
      const context = buildContext('Migrate data from SAP ECC legacy system');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('sap-ecc');
      expect(data.databaseEngine).toBe('oracle');
      expect(data.sqlDialect).toBe('oracle-sql');
    });
  });

  describe('detection from SPARC services', () => {
    it('should detect ERP from SPARC architecture services', () => {
      const context = buildContext('Build a procurement integration', {
        sparc: {
          architecture: {
            services: [
              { name: 'ProcurementService', responsibility: 'Manages SAP S/4HANA purchase orders' },
            ],
          },
        },
      });
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('sap-s4hana');
      // Source is scenario-query since 'procurement' doesn't match, but SPARC also has 'SAP S/4HANA'
      // The scenario query is checked first; if it doesn't match, SPARC is the source
    });
  });

  describe('detection from dossier items', () => {
    it('should detect ERP from Phase 2 manifest dossier items', () => {
      const context = buildContext('Build a procurement system', {
        manifest: {
          dossier_items: [
            { title: 'Dynamics 365 Integration', content: 'The enterprise uses Dynamics 365 for CRM.' },
          ],
        },
      });
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('microsoft-dynamics');
      expect(data.detectionSource).toBe('dossier-items');
    });
  });

  describe('detection from ADR context', () => {
    it('should detect ERP from ADR context and decision text', () => {
      const context = buildContext('Build a data integration', {
        adrs: [
          { context: 'The system integrates with Oracle Fusion ERP.', decision: 'Use Oracle ERP REST APIs.' },
        ],
      });
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      expect(data.erpSystem).toBe('oracle-erp');
      expect(data.detectionSource).toBe('adr-context');
    });
  });

  describe('error cases', () => {
    it('should fail with ECLI-P4-002 when no ERP is detected', () => {
      const context = buildContext('Build a simple REST API for user management');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('failed');
      expect(output.summary).toContain('ECLI-P4-002');
    });
  });

  describe('multiple ERP mentions', () => {
    it('should pick highest confidence match', () => {
      // SAP S/4HANA has weight 1.0, SAP ECC has weight 0.9
      const context = buildContext('Migrate from SAP ECC to SAP S/4HANA');
      const output = resolveERPTarget(context);

      expect(output.status).toBe('completed');
      const data = output.data as ERPResolution;
      // Both are in the query; detectERPFromText returns highest confidence first
      // SAP S/4HANA keywords appear first in detection rules and have weight 1.0
      expect(data.erpSystem).toBe('sap-s4hana');
      expect(data.confidence).toBe(1.0);
    });
  });

  describe('stage output shape', () => {
    it('should return correct stage name', () => {
      const context = buildContext('Build SAP S/4HANA integration');
      const output = resolveERPTarget(context);

      expect(output.stage).toBe('erp-target-resolution');
    });

    it('should include timing', () => {
      const context = buildContext('Build SAP S/4HANA integration');
      const output = resolveERPTarget(context);

      expect(output.timing).toBeGreaterThanOrEqual(0);
    });

    it('should include integration points and constraints', () => {
      const context = buildContext('Build SAP S/4HANA integration');
      const output = resolveERPTarget(context);
      const data = output.data as ERPResolution;

      expect(data.integrationPoints).toBeDefined();
      expect(data.constraints).toBeDefined();
      expect(Array.isArray(data.integrationPoints)).toBe(true);
      expect(Array.isArray(data.constraints)).toBe(true);
    });

    it('should store output on context.stageOutputs', () => {
      const context = buildContext('Build SAP S/4HANA integration');
      resolveERPTarget(context);

      const stored = context.stageOutputs.get('erp-target-resolution');
      expect(stored).toBeDefined();
      expect(stored!.status).toBe('completed');
    });
  });
});
