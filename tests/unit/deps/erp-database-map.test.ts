/**
 * ERP Database Map — Unit Tests
 *
 * Tests the authoritative ERP → Database Engine mapping table, all helper
 * functions, the keyword-based detection engine, and getAllERPSystems().
 */

import {
  ERP_DATABASE_MAP,
  resolveERPDatabase,
  isApiOnlyERP,
  getSQLDialect,
  getPrimaryEngine,
  detectERPFromText,
  getAllERPSystems,
} from '../../../src/deps/erp-database-map.js';
import type { ERPSystem } from '../../../src/deps/erp-database-map.js';

// ============================================================================
// 1. Mapping Completeness
// ============================================================================

describe('ERP_DATABASE_MAP completeness', () => {
  const EXPECTED_SYSTEMS: ERPSystem[] = [
    'sap-s4hana',
    'sap-ecc',
    'oracle-erp',
    'oracle-netsuite',
    'microsoft-dynamics',
    'infor',
    'workday',
  ];

  it('should contain exactly 7 ERP systems', () => {
    expect(Object.keys(ERP_DATABASE_MAP)).toHaveLength(7);
  });

  it.each(EXPECTED_SYSTEMS)('should contain %s', (system) => {
    expect(ERP_DATABASE_MAP[system]).toBeDefined();
  });
});

// ============================================================================
// 2. SAP S/4HANA
// ============================================================================

describe('SAP S/4HANA mapping', () => {
  const entry = ERP_DATABASE_MAP['sap-s4hana'];

  it('should have primaryEngine = sap-hana', () => {
    expect(entry.primaryEngine).toBe('sap-hana');
  });

  it('should have sqlDialect = hana-sql', () => {
    expect(entry.sqlDialect).toBe('hana-sql');
  });

  it('should have apiOnly = false', () => {
    expect(entry.apiOnly).toBe(false);
  });

  it('should have no alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(0);
  });

  it('should have erpSystem = sap-s4hana', () => {
    expect(entry.erpSystem).toBe('sap-s4hana');
  });
});

// ============================================================================
// 3. SAP ECC
// ============================================================================

describe('SAP ECC mapping', () => {
  const entry = ERP_DATABASE_MAP['sap-ecc'];

  it('should have primaryEngine = oracle', () => {
    expect(entry.primaryEngine).toBe('oracle');
  });

  it('should include db2 in alternateEngines', () => {
    expect(entry.alternateEngines).toContain('db2');
  });

  it('should include sql-server in alternateEngines', () => {
    expect(entry.alternateEngines).toContain('sql-server');
  });

  it('should have exactly 2 alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(2);
  });

  it('should have apiOnly = false', () => {
    expect(entry.apiOnly).toBe(false);
  });

  it('should have sqlDialect = oracle-sql', () => {
    expect(entry.sqlDialect).toBe('oracle-sql');
  });
});

// ============================================================================
// 4. Oracle ERP
// ============================================================================

describe('Oracle ERP mapping', () => {
  const entry = ERP_DATABASE_MAP['oracle-erp'];

  it('should have primaryEngine = oracle', () => {
    expect(entry.primaryEngine).toBe('oracle');
  });

  it('should have sqlDialect = oracle-sql', () => {
    expect(entry.sqlDialect).toBe('oracle-sql');
  });

  it('should have apiOnly = false', () => {
    expect(entry.apiOnly).toBe(false);
  });

  it('should have no alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(0);
  });
});

// ============================================================================
// 5. NetSuite
// ============================================================================

describe('NetSuite mapping', () => {
  const entry = ERP_DATABASE_MAP['oracle-netsuite'];

  it('should have primaryEngine = oracle', () => {
    expect(entry.primaryEngine).toBe('oracle');
  });

  it('should have sqlDialect = oracle-sql', () => {
    expect(entry.sqlDialect).toBe('oracle-sql');
  });

  it('should have apiOnly = false', () => {
    expect(entry.apiOnly).toBe(false);
  });

  it('should have no alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(0);
  });
});

// ============================================================================
// 6. Microsoft Dynamics
// ============================================================================

describe('Microsoft Dynamics mapping', () => {
  const entry = ERP_DATABASE_MAP['microsoft-dynamics'];

  it('should have primaryEngine = sql-server', () => {
    expect(entry.primaryEngine).toBe('sql-server');
  });

  it('should have sqlDialect = tsql', () => {
    expect(entry.sqlDialect).toBe('tsql');
  });

  it('should have apiOnly = false', () => {
    expect(entry.apiOnly).toBe(false);
  });

  it('should have no alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(0);
  });
});

// ============================================================================
// 7. Infor
// ============================================================================

describe('Infor mapping', () => {
  const entry = ERP_DATABASE_MAP['infor'];

  it('should have primaryEngine = oracle', () => {
    expect(entry.primaryEngine).toBe('oracle');
  });

  it('should include sql-server in alternateEngines', () => {
    expect(entry.alternateEngines).toContain('sql-server');
  });

  it('should include db2 in alternateEngines', () => {
    expect(entry.alternateEngines).toContain('db2');
  });

  it('should have exactly 2 alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(2);
  });

  it('should have apiOnly = false', () => {
    expect(entry.apiOnly).toBe(false);
  });

  it('should have sqlDialect = oracle-sql', () => {
    expect(entry.sqlDialect).toBe('oracle-sql');
  });
});

// ============================================================================
// 8. Workday
// ============================================================================

describe('Workday mapping', () => {
  const entry = ERP_DATABASE_MAP['workday'];

  it('should have primaryEngine = null', () => {
    expect(entry.primaryEngine).toBeNull();
  });

  it('should have apiOnly = true', () => {
    expect(entry.apiOnly).toBe(true);
  });

  it('should have sqlDialect = null', () => {
    expect(entry.sqlDialect).toBeNull();
  });

  it('should have no alternate engines', () => {
    expect(entry.alternateEngines).toHaveLength(0);
  });
});

// ============================================================================
// 9. Helper Functions
// ============================================================================

describe('resolveERPDatabase()', () => {
  it('should return the full mapping for a known system', () => {
    const mapping = resolveERPDatabase('sap-s4hana');
    expect(mapping).toEqual(ERP_DATABASE_MAP['sap-s4hana']);
  });

  it('should return the full mapping for workday', () => {
    const mapping = resolveERPDatabase('workday');
    expect(mapping.primaryEngine).toBeNull();
    expect(mapping.apiOnly).toBe(true);
  });

  it('should return the full mapping for microsoft-dynamics', () => {
    const mapping = resolveERPDatabase('microsoft-dynamics');
    expect(mapping.primaryEngine).toBe('sql-server');
    expect(mapping.sqlDialect).toBe('tsql');
  });
});

describe('isApiOnlyERP()', () => {
  it('should return true for workday', () => {
    expect(isApiOnlyERP('workday')).toBe(true);
  });

  it('should return false for sap-s4hana', () => {
    expect(isApiOnlyERP('sap-s4hana')).toBe(false);
  });

  it('should return false for oracle-erp', () => {
    expect(isApiOnlyERP('oracle-erp')).toBe(false);
  });

  it('should return false for microsoft-dynamics', () => {
    expect(isApiOnlyERP('microsoft-dynamics')).toBe(false);
  });

  it('should return false for infor', () => {
    expect(isApiOnlyERP('infor')).toBe(false);
  });
});

describe('getSQLDialect()', () => {
  it('should return hana-sql for sap-s4hana', () => {
    expect(getSQLDialect('sap-s4hana')).toBe('hana-sql');
  });

  it('should return oracle-sql for sap-ecc', () => {
    expect(getSQLDialect('sap-ecc')).toBe('oracle-sql');
  });

  it('should return oracle-sql for oracle-erp', () => {
    expect(getSQLDialect('oracle-erp')).toBe('oracle-sql');
  });

  it('should return oracle-sql for oracle-netsuite', () => {
    expect(getSQLDialect('oracle-netsuite')).toBe('oracle-sql');
  });

  it('should return tsql for microsoft-dynamics', () => {
    expect(getSQLDialect('microsoft-dynamics')).toBe('tsql');
  });

  it('should return oracle-sql for infor', () => {
    expect(getSQLDialect('infor')).toBe('oracle-sql');
  });

  it('should return null for workday', () => {
    expect(getSQLDialect('workday')).toBeNull();
  });
});

describe('getPrimaryEngine()', () => {
  it('should return sap-hana for sap-s4hana', () => {
    expect(getPrimaryEngine('sap-s4hana')).toBe('sap-hana');
  });

  it('should return oracle for sap-ecc', () => {
    expect(getPrimaryEngine('sap-ecc')).toBe('oracle');
  });

  it('should return oracle for oracle-erp', () => {
    expect(getPrimaryEngine('oracle-erp')).toBe('oracle');
  });

  it('should return oracle for oracle-netsuite', () => {
    expect(getPrimaryEngine('oracle-netsuite')).toBe('oracle');
  });

  it('should return sql-server for microsoft-dynamics', () => {
    expect(getPrimaryEngine('microsoft-dynamics')).toBe('sql-server');
  });

  it('should return oracle for infor', () => {
    expect(getPrimaryEngine('infor')).toBe('oracle');
  });

  it('should return null for workday', () => {
    expect(getPrimaryEngine('workday')).toBeNull();
  });
});

// ============================================================================
// 10. ERP Detection
// ============================================================================

describe('detectERPFromText()', () => {
  it('should find SAP S/4HANA from "Our company uses SAP S/4HANA"', () => {
    const results = detectERPFromText('Our company uses SAP S/4HANA');
    expect(results).toHaveLength(1);
    expect(results[0]!.system).toBe('sap-s4hana');
  });

  it('should find microsoft-dynamics from "integrating with Dynamics 365"', () => {
    const results = detectERPFromText('integrating with Dynamics 365');
    expect(results).toHaveLength(1);
    expect(results[0]!.system).toBe('microsoft-dynamics');
  });

  it('should find workday from "workday HR system"', () => {
    const results = detectERPFromText('workday HR system');
    expect(results).toHaveLength(1);
    expect(results[0]!.system).toBe('workday');
  });

  it('should return empty array for "no erp mentioned"', () => {
    const results = detectERPFromText('no erp mentioned');
    expect(results).toHaveLength(0);
  });

  it('should handle multiple ERP mentions', () => {
    const results = detectERPFromText('We are migrating from SAP ECC to NetSuite');
    const systems = results.map(r => r.system);
    expect(systems).toContain('sap-ecc');
    expect(systems).toContain('oracle-netsuite');
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('should be case-insensitive', () => {
    const results = detectERPFromText('WORKDAY is our HRIS');
    expect(results).toHaveLength(1);
    expect(results[0]!.system).toBe('workday');
  });

  it('should include confidence score on each result', () => {
    const results = detectERPFromText('We use SAP S/4HANA');
    expect(results[0]!.confidence).toBeGreaterThan(0);
    expect(typeof results[0]!.confidence).toBe('number');
  });

  it('should include matchedKeyword on each result', () => {
    const results = detectERPFromText('Our ERP is Dynamics 365');
    expect(results[0]!.matchedKeyword).toBeDefined();
    expect(typeof results[0]!.matchedKeyword).toBe('string');
  });

  it('should return results sorted by confidence descending', () => {
    const results = detectERPFromText('We use SAP ECC and Infor LN');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.confidence).toBeGreaterThanOrEqual(results[i]!.confidence);
    }
  });

  it('should not return duplicate systems for repeated keyword matches', () => {
    const results = detectERPFromText('SAP HANA is part of SAP S/4HANA');
    const sapSystems = results.filter(r => r.system === 'sap-s4hana');
    expect(sapSystems).toHaveLength(1);
  });
});

// ============================================================================
// 11. getAllERPSystems
// ============================================================================

describe('getAllERPSystems()', () => {
  it('should return all 7 ERP systems', () => {
    const systems = getAllERPSystems();
    expect(systems).toHaveLength(7);
  });

  it('should include sap-s4hana', () => {
    expect(getAllERPSystems()).toContain('sap-s4hana');
  });

  it('should include sap-ecc', () => {
    expect(getAllERPSystems()).toContain('sap-ecc');
  });

  it('should include oracle-erp', () => {
    expect(getAllERPSystems()).toContain('oracle-erp');
  });

  it('should include oracle-netsuite', () => {
    expect(getAllERPSystems()).toContain('oracle-netsuite');
  });

  it('should include microsoft-dynamics', () => {
    expect(getAllERPSystems()).toContain('microsoft-dynamics');
  });

  it('should include infor', () => {
    expect(getAllERPSystems()).toContain('infor');
  });

  it('should include workday', () => {
    expect(getAllERPSystems()).toContain('workday');
  });

  it('should match the keys of ERP_DATABASE_MAP', () => {
    const systems = getAllERPSystems();
    const mapKeys = Object.keys(ERP_DATABASE_MAP) as ERPSystem[];
    expect([...systems].sort()).toEqual([...mapKeys].sort());
  });
});
