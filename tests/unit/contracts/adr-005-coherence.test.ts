/**
 * ADR-005: System Coherence, Drift Detection, and Self-Governance
 *
 * Tests for the runtime implementation of ADR-005:
 * - Coherence domains, drift categories, invariants
 * - Self-management capabilities and prohibited autonomy
 * - Action classification and boundary validation
 * - Type integrity (no severity, no recommendation, no auto-fix)
 */

import {
  // Constants
  COHERENCE_INVARIANTS,
  COHERENCE_DOMAINS,
  DRIFT_CATEGORIES,
  SELF_MANAGEMENT_CAPABILITIES,
  PROHIBITED_AUTONOMY,
  ACTION_BOUNDARIES,
  // Functions
  classifyAction,
  isObservation,
  isAutonomous,
  isProhibitedAction,
  validateActionBoundary,
  // Metadata
  ADR_005_ID,
  ADR_005_TITLE,
  ADR_005_STATUS,
  ADR_005_DATE,
} from '../../../src/contracts/adr-005-system-coherence-drift-self-governance.js';

// ============================================================================
// ADR-005 Metadata
// ============================================================================

describe('ADR-005 metadata', () => {
  test('ID is ADR-005', () => {
    expect(ADR_005_ID).toBe('ADR-005');
  });

  test('title is non-empty', () => {
    expect(ADR_005_TITLE.length).toBeGreaterThan(0);
  });

  test('status is Accepted', () => {
    expect(ADR_005_STATUS).toBe('Accepted');
  });

  test('date is valid ISO date', () => {
    expect(ADR_005_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ============================================================================
// Coherence Domains
// ============================================================================

describe('ADR-005: Coherence Domains', () => {
  test('5 domains are defined', () => {
    expect(Object.keys(COHERENCE_DOMAINS)).toHaveLength(5);
  });

  test('each domain has name and description', () => {
    for (const [, domain] of Object.entries(COHERENCE_DOMAINS)) {
      expect(domain.name.length).toBeGreaterThan(0);
      expect(domain.description.length).toBeGreaterThan(0);
      expect(typeof domain.verifiable).toBe('boolean');
    }
  });

  test('expected domain keys exist', () => {
    expect(COHERENCE_DOMAINS.SYSTEM_COHERENCE).toBeDefined();
    expect(COHERENCE_DOMAINS.DRIFT_DETECTION).toBeDefined();
    expect(COHERENCE_DOMAINS.GOVERNED_SELF_MANAGEMENT).toBeDefined();
    expect(COHERENCE_DOMAINS.MEMORY_ANCHORED_REALITY).toBeDefined();
    expect(COHERENCE_DOMAINS.HUMAN_OVERSIGHT_BOUNDARY).toBeDefined();
  });

  test('HUMAN_OVERSIGHT_BOUNDARY is not automatically verifiable', () => {
    expect(COHERENCE_DOMAINS.HUMAN_OVERSIGHT_BOUNDARY.verifiable).toBe(false);
  });
});

// ============================================================================
// Drift Categories
// ============================================================================

describe('ADR-005: Drift Categories', () => {
  test('4 categories are defined', () => {
    expect(Object.keys(DRIFT_CATEGORIES)).toHaveLength(4);
  });

  test('each category specifies detectability', () => {
    for (const [, cat] of Object.entries(DRIFT_CATEGORIES)) {
      expect(cat.name.length).toBeGreaterThan(0);
      expect(cat.description.length).toBeGreaterThan(0);
      expect(typeof cat.detectable_automatically).toBe('boolean');
    }
  });

  test('semantic drift is NOT automatically detectable', () => {
    expect(DRIFT_CATEGORIES.SEMANTIC_DRIFT.detectable_automatically).toBe(false);
  });

  test('structural drift IS automatically detectable', () => {
    expect(DRIFT_CATEGORIES.STRUCTURAL_DRIFT.detectable_automatically).toBe(true);
  });
});

// ============================================================================
// Coherence Invariants
// ============================================================================

describe('ADR-005: Coherence Invariants', () => {
  test('5 invariants are defined', () => {
    expect(COHERENCE_INVARIANTS).toHaveLength(5);
  });

  test('invariants are numbered 1 through 5', () => {
    for (let i = 0; i < 5; i++) {
      expect(COHERENCE_INVARIANTS[i]!.number).toBe(i + 1);
    }
  });

  test('each invariant has description and domain', () => {
    for (const inv of COHERENCE_INVARIANTS) {
      expect(inv.description.length).toBeGreaterThan(0);
      expect(inv.domain).toBeDefined();
      expect(inv.id).toMatch(/^INV-005-0\d$/);
    }
  });
});

// ============================================================================
// Self-Management Capabilities
// ============================================================================

describe('ADR-005: Self-Management Capabilities', () => {
  test('6 capabilities are defined', () => {
    expect(Object.keys(SELF_MANAGEMENT_CAPABILITIES)).toHaveLength(6);
  });

  test('all capabilities are read-only', () => {
    for (const [, cap] of Object.entries(SELF_MANAGEMENT_CAPABILITIES)) {
      expect(cap.read_only).toBe(true);
    }
  });

  test('all capabilities have OBSERVATION boundary', () => {
    for (const [, cap] of Object.entries(SELF_MANAGEMENT_CAPABILITIES)) {
      expect(cap.boundary).toBe('OBSERVATION');
    }
  });

  test('no capability requires human authorization', () => {
    for (const [, cap] of Object.entries(SELF_MANAGEMENT_CAPABILITIES)) {
      expect(cap.requires_human).toBe(false);
    }
  });
});

// ============================================================================
// Prohibited Autonomy
// ============================================================================

describe('ADR-005: Prohibited Autonomy', () => {
  test('6 prohibited actions are defined', () => {
    expect(Object.keys(PROHIBITED_AUTONOMY)).toHaveLength(6);
  });

  test('all prohibited actions have AUTONOMOUS_ACTION boundary', () => {
    for (const [, action] of Object.entries(PROHIBITED_AUTONOMY)) {
      expect(action.boundary).toBe('AUTONOMOUS_ACTION');
    }
  });

  test('each prohibited action references an invariant', () => {
    for (const [, action] of Object.entries(PROHIBITED_AUTONOMY)) {
      expect(action.violates_invariant).toBeGreaterThanOrEqual(1);
      expect(action.violates_invariant).toBeLessThanOrEqual(5);
    }
  });

  test('isProhibitedAction returns true for all prohibited keys', () => {
    const keys = Object.keys(PROHIBITED_AUTONOMY) as Array<
      keyof typeof PROHIBITED_AUTONOMY
    >;
    for (const key of keys) {
      expect(isProhibitedAction(key)).toBe(true);
    }
  });
});

// ============================================================================
// Action Classification
// ============================================================================

describe('ADR-005: Action Classification', () => {
  test('classifyAction for known self-management capabilities', () => {
    const result = classifyAction('observe coherence');
    expect(result.boundary).toBe('OBSERVATION');
    expect(result.is_observation).toBe(true);
    expect(result.is_autonomous).toBe(false);
  });

  test('classifyAction for prohibited auto actions', () => {
    const result = classifyAction('auto-correct drift');
    expect(result.boundary).toBe('AUTONOMOUS_ACTION');
    expect(result.is_autonomous).toBe(true);
    expect(result.is_observation).toBe(false);
    expect(result.violates_invariant).toBeDefined();
  });

  test('classifyAction for read verbs', () => {
    const result = classifyAction('query artifacts');
    expect(result.boundary).toBe('OBSERVATION');
    expect(result.is_observation).toBe(true);
  });

  test('classifyAction for write verbs', () => {
    const result = classifyAction('delete artifact');
    expect(result.boundary).toBe('AUTONOMOUS_ACTION');
    expect(result.is_autonomous).toBe(true);
  });

  test('classifyAction for judgment verbs', () => {
    const result = classifyAction('score severity');
    expect(result.boundary).toBe('AUTONOMOUS_ACTION');
    expect(result.is_autonomous).toBe(true);
  });

  test('classifyAction defaults to GOVERNED_ACTION for unknown actions', () => {
    const result = classifyAction('xyzzy foobar');
    expect(result.boundary).toBe('GOVERNED_ACTION');
    expect(result.is_observation).toBe(false);
    expect(result.is_autonomous).toBe(false);
  });

  test('isObservation returns true for read operations', () => {
    expect(isObservation('inspect lineage')).toBe(true);
  });

  test('isObservation returns false for write operations', () => {
    expect(isObservation('modify schema')).toBe(false);
  });

  test('isAutonomous returns true for write operations', () => {
    expect(isAutonomous('overwrite record')).toBe(true);
  });

  test('isAutonomous returns false for read operations', () => {
    expect(isAutonomous('list artifacts')).toBe(false);
  });
});

// ============================================================================
// Action Boundary Validation
// ============================================================================

describe('ADR-005: Action Boundary Validation', () => {
  test('observations pass without human authorization', () => {
    expect(validateActionBoundary('query artifacts', false)).toBeNull();
  });

  test('autonomous actions always fail', () => {
    const result = validateActionBoundary('auto-correct drift', true);
    expect(result).not.toBeNull();
    expect(result).toContain('prohibited');
  });

  test('autonomous actions reference invariant in error', () => {
    const result = validateActionBoundary('auto-correct drift', false);
    expect(result).toContain('Invariant');
  });

  test('governed actions fail without human authorization', () => {
    const result = validateActionBoundary('xyzzy foobar', false);
    expect(result).not.toBeNull();
    expect(result).toContain('requires human authorization');
  });

  test('governed actions pass with human authorization', () => {
    expect(validateActionBoundary('xyzzy foobar', true)).toBeNull();
  });

  test('write operations fail even with human auth (classified as autonomous)', () => {
    const result = validateActionBoundary('delete artifact', true);
    expect(result).not.toBeNull();
    expect(result).toContain('prohibited');
  });
});

// ============================================================================
// Action Boundaries Constant
// ============================================================================

describe('ADR-005: ACTION_BOUNDARIES', () => {
  test('read_operations is non-empty', () => {
    expect(ACTION_BOUNDARIES.read_operations.length).toBeGreaterThan(0);
  });

  test('write_operations is non-empty', () => {
    expect(ACTION_BOUNDARIES.write_operations.length).toBeGreaterThan(0);
  });

  test('judgment_operations is non-empty', () => {
    expect(ACTION_BOUNDARIES.judgment_operations.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Type Integrity
// ============================================================================

describe('ADR-005: Type Integrity', () => {
  test('CoherenceViolation interface has no severity field', () => {
    // We can only verify at runtime that our constants/types don't include severity.
    // Verify that PROHIBITED_AUTONOMY entries have no 'severity' property.
    for (const [, action] of Object.entries(PROHIBITED_AUTONOMY)) {
      expect('severity' in action).toBe(false);
    }
  });

  test('DriftObservation has no severity in category definitions', () => {
    for (const [, cat] of Object.entries(DRIFT_CATEGORIES)) {
      expect('severity' in cat).toBe(false);
    }
  });

  test('Self-management capabilities have no auto-fix property', () => {
    for (const [, cap] of Object.entries(SELF_MANAGEMENT_CAPABILITIES)) {
      expect('auto_fix' in cap).toBe(false);
      expect('autoFix' in cap).toBe(false);
    }
  });

  test('Coherence domains have no recommendation property', () => {
    for (const [, domain] of Object.entries(COHERENCE_DOMAINS)) {
      expect('recommendation' in domain).toBe(false);
    }
  });
});
