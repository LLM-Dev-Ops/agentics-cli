/**
 * Lineage & Enterprise Integration Tests — ADR-004
 *
 * Tests for:
 * 1. Lineage record creation and validation
 * 2. Simulation memory record lifecycle
 * 3. Integration registry lookups
 * 4. ERP surface mapping creation
 * 5. Lineage Gate (Gate 6) enforcement
 * 6. Traceability chain validation
 */

import {
  createLineageRecord,
  createSimulationMemoryRecord,
  completeSimulationMemoryRecord,
  failSimulationMemoryRecord,
  createIntegrationProposal,
  createErpSurfaceMapping,
  validateTraceability,
  validateLineageChain,
} from '../../src/enterprise/lineage.js';

import {
  lookupIntegration,
  getIntegrationsByCategory,
  getIntegrationNames,
  isKnownIntegration,
  getAffectedEntities,
} from '../../src/enterprise/integration-registry.js';

import {
  checkLineageGate,
  enforceLineageGate,
  requiresLineageValidation,
  LINEAGE_VIOLATION_EXIT_CODE,
} from '../../src/gates/lineage-gate.js';

import type { CommandObject, Attribution } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCmd(
  command: string,
  subcommand?: string,
  options: Record<string, string> = {},
  flags: Record<string, boolean> = {},
): CommandObject {
  return { command, subcommand, flags, options, positionalArgs: [] };
}

const testAttribution: Attribution = {
  created_by: 'usr_test123',
  org_id: 'org_test456',
};

// ============================================================================
// 1. Lineage Record Creation
// ============================================================================

describe('Lineage record creation', () => {
  it('creates a lineage record with all required fields', () => {
    const record = createLineageRecord(
      'art_001',
      'erp_proposal',
      'sim_001',
      'ERP surface analysis',
      testAttribution,
    );

    expect(record.id).toMatch(/^lin-/);
    expect(record.artifact_id).toBe('art_001');
    expect(record.artifact_category).toBe('erp_proposal');
    expect(record.simulation_id).toBe('sim_001');
    expect(record.decision_context).toBe('ERP surface analysis');
    expect(record.attribution).toEqual(testAttribution);
    expect(record.governance.gate_pipeline_version).toBe('1.0.0');
    expect(record.created_at).toBeTruthy();
  });

  it('includes plan_id when provided', () => {
    const record = createLineageRecord(
      'art_002',
      'plan',
      'sim_002',
      'Plan creation',
      testAttribution,
      'pln_001',
    );

    expect(record.plan_id).toBe('pln_001');
  });

  it('omits plan_id when not provided', () => {
    const record = createLineageRecord(
      'art_003',
      'simulation',
      'sim_003',
      'Simulation run',
      testAttribution,
    );

    expect(record.plan_id).toBeUndefined();
  });
});

// ============================================================================
// 2. Simulation Memory Record Lifecycle
// ============================================================================

describe('Simulation memory record lifecycle', () => {
  it('creates a pending simulation memory record', () => {
    const record = createSimulationMemoryRecord(
      'sim_010',
      'Test simulation intent',
      testAttribution,
    );

    expect(record.id).toBe('sim_010');
    expect(record.type).toBe('simulation');
    expect(record.intent).toBe('Test simulation intent');
    expect(record.status).toBe('created');
    expect(record.attribution).toEqual(testAttribution);
    expect(record.artifact_ids).toEqual([]);
    expect(record.created_at).toBeTruthy();
    expect(record.updated_at).toBeTruthy();
  });

  it('completes a simulation memory record', () => {
    const pending = createSimulationMemoryRecord('sim_011', 'intent', testAttribution);
    const completed = completeSimulationMemoryRecord(
      pending,
      { summary: 'Success', confidence: 0.95 },
      ['art_100', 'art_101'],
    );

    expect(completed.status).toBe('completed');
    expect(completed.result).toEqual({ summary: 'Success', confidence: 0.95 });
    expect(completed.artifact_ids).toEqual(['art_100', 'art_101']);
    // updated_at should be set (may be same ms in fast tests)
    expect(completed.updated_at).toBeTruthy();
  });

  it('fails a simulation memory record', () => {
    const pending = createSimulationMemoryRecord('sim_012', 'intent', testAttribution);
    const failed = failSimulationMemoryRecord(pending, 'Timeout exceeded');

    expect(failed.status).toBe('failed');
    expect(failed.result).toEqual({ error: 'Timeout exceeded' });
    expect(failed.updated_at).toBeTruthy();
  });
});

// ============================================================================
// 3. Integration Registry
// ============================================================================

describe('Integration registry', () => {
  it('looks up known integrations', () => {
    const sap = lookupIntegration('sap');
    expect(sap).toBeDefined();
    expect(sap?.display_name).toBe('SAP S/4HANA');
    expect(sap?.category).toBe('erp');
  });

  it('returns undefined for unknown integrations', () => {
    expect(lookupIntegration('nonexistent')).toBeUndefined();
  });

  it('filters integrations by category', () => {
    const erpSystems = getIntegrationsByCategory('erp');
    expect(erpSystems.length).toBeGreaterThan(0);
    for (const sys of erpSystems) {
      expect(sys.category).toBe('erp');
    }
  });

  it('returns all integration names', () => {
    const names = getIntegrationNames();
    expect(names).toContain('sap');
    expect(names).toContain('salesforce');
    expect(names).toContain('okta');
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  it('checks known integration status', () => {
    expect(isKnownIntegration('sap')).toBe(true);
    expect(isKnownIntegration('oracle-erp')).toBe(true);
    expect(isKnownIntegration('nonexistent')).toBe(false);
  });

  it('returns affected entities for known integrations', () => {
    const entities = getAffectedEntities('sap');
    expect(entities.length).toBeGreaterThan(0);
  });

  it('returns empty entities for unknown integrations', () => {
    expect(getAffectedEntities('nonexistent')).toEqual([]);
  });
});

// ============================================================================
// 4. Integration Proposal & ERP Mapping
// ============================================================================

describe('Integration proposal creation', () => {
  it('creates a proposal with required fields', () => {
    const proposal = createIntegrationProposal(
      'sap',
      'Add GL posting interface',
      ['Data format incompatibility'],
      ['SAP RFC SDK'],
      'sim_020',
      testAttribution,
    );

    expect(proposal.id).toMatch(/^intprop-/);
    expect(proposal.type).toBe('integration_proposal');
    expect(proposal.integration_name).toBe('sap');
    expect(proposal.proposed_changes).toBe('Add GL posting interface');
    expect(proposal.risks).toEqual(['Data format incompatibility']);
    expect(proposal.dependencies).toEqual(['SAP RFC SDK']);
    expect(proposal.simulation_id).toBe('sim_020');
    expect(proposal.attribution).toEqual(testAttribution);
  });
});

describe('ERP surface mapping creation', () => {
  it('creates a mapping with required fields', () => {
    const mapping = createErpSurfaceMapping(
      'oracle_erp',
      'invoice',
      { method: 'REST API', endpoint: '/v1/invoices' },
      'sim_030',
      ['ip_001'],
      testAttribution,
    );

    expect(mapping.id).toMatch(/^erpmap-/);
    expect(mapping.type).toBe('erp_mapping');
    expect(mapping.erp_type).toBe('oracle_erp');
    expect(mapping.entity_type).toBe('invoice');
    expect(mapping.simulation_id).toBe('sim_030');
    expect(mapping.integration_proposal_ids).toEqual(['ip_001']);
    expect(mapping.attribution).toEqual(testAttribution);
  });
});

// ============================================================================
// 5. Traceability Validation
// ============================================================================

describe('Traceability validation', () => {
  it('passes with a valid simulation_id', () => {
    const result = validateTraceability('sim_001', 'erp surface');
    expect(result.valid).toBe(true);
  });

  it('fails with undefined simulation_id', () => {
    const result = validateTraceability(undefined, 'erp surface');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('simulation_id');
  });

  it('fails with empty simulation_id', () => {
    const result = validateTraceability('', 'erp map');
    expect(result.valid).toBe(false);
  });
});

describe('Lineage chain validation', () => {
  it('validates a complete chain', () => {
    const records = [
      createLineageRecord('art_a', 'simulation', 'sim_a', 'test', testAttribution),
      createLineageRecord('art_b', 'erp_proposal', 'sim_a', 'test', testAttribution),
    ];

    const result = validateLineageChain(records);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('detects missing fields in chain', () => {
    // Create a record with empty simulation_id (checked by validateLineageChain)
    const badRecord = {
      id: 'lin_bad',
      artifact_id: 'art_bad',
      artifact_category: 'simulation' as const,
      simulation_id: '',
      decision_context: 'test',
      attribution: testAttribution,
      governance: { gate_pipeline_version: '1.0.0', synthesis_classification: 'governed' },
      created_at: new Date().toISOString(),
    };

    const result = validateLineageChain([badRecord]);
    expect(result.complete).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 6. Lineage Gate (Gate 6) Enforcement
// ============================================================================

describe('Lineage Gate — requiresLineageValidation', () => {
  it('requires lineage for erp surface', () => {
    expect(requiresLineageValidation('erp', 'surface')).toBe(true);
  });

  it('requires lineage for erp map', () => {
    expect(requiresLineageValidation('erp', 'map')).toBe(true);
  });

  it('requires lineage for erp export', () => {
    expect(requiresLineageValidation('erp', 'export')).toBe(true);
  });

  it('does not require lineage for erp list', () => {
    expect(requiresLineageValidation('erp', 'list')).toBe(false);
  });

  it('does not require lineage for erp inspect', () => {
    expect(requiresLineageValidation('erp', 'inspect')).toBe(false);
  });

  it('does not require lineage for non-erp commands', () => {
    expect(requiresLineageValidation('plan', 'create')).toBe(false);
    expect(requiresLineageValidation('simulate', 'run')).toBe(false);
    expect(requiresLineageValidation('deploy', 'preview')).toBe(false);
  });

  it('does not require lineage for exempt commands', () => {
    expect(requiresLineageValidation('help')).toBe(false);
    expect(requiresLineageValidation('login')).toBe(false);
    expect(requiresLineageValidation('whoami')).toBe(false);
  });
});

describe('Lineage Gate — checkLineageGate', () => {
  it('allows erp surface with simulation-id', () => {
    const cmd = makeCmd('erp', 'surface', { 'simulation-id': 'sim_001' });
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(true);
    expect(result.lineageRequired).toBe(true);
  });

  it('blocks erp surface without simulation-id', () => {
    const cmd = makeCmd('erp', 'surface');
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(false);
    expect(result.exitCode).toBe(LINEAGE_VIOLATION_EXIT_CODE);
    expect(result.message).toContain('ADR-004');
  });

  it('blocks erp map without simulation-id', () => {
    const cmd = makeCmd('erp', 'map');
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(false);
    expect(result.exitCode).toBe(LINEAGE_VIOLATION_EXIT_CODE);
  });

  it('blocks erp export without simulation-id', () => {
    const cmd = makeCmd('erp', 'export');
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(false);
  });

  it('allows erp list without simulation-id', () => {
    const cmd = makeCmd('erp', 'list');
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(true);
    expect(result.lineageRequired).toBe(false);
  });

  it('allows non-erp commands without simulation-id', () => {
    const cmd = makeCmd('plan', 'create');
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(true);
    expect(result.lineageRequired).toBe(false);
  });

  it('allows exempt commands', () => {
    const cmd = makeCmd('help');
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(true);
    expect(result.lineageRequired).toBe(false);
  });

  it('accepts simulation_id with underscore variant', () => {
    const cmd = makeCmd('erp', 'surface', { 'simulation_id': 'sim_002' });
    const result = checkLineageGate(cmd);
    expect(result.allowed).toBe(true);
  });
});

describe('Lineage Gate — enforceLineageGate', () => {
  it('does not exit for valid commands', () => {
    const cmd = makeCmd('erp', 'surface', { 'simulation-id': 'sim_001' });
    // Should not throw or call process.exit
    expect(() => enforceLineageGate(cmd)).not.toThrow();
  });

  it('calls process.exit for invalid commands', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const cmd = makeCmd('erp', 'surface');
    expect(() => enforceLineageGate(cmd)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(LINEAGE_VIOLATION_EXIT_CODE);

    mockExit.mockRestore();
    mockError.mockRestore();
  });
});
