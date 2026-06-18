/**
 * Phase 2 Pipeline Schemas -- Zod Validation Tests
 *
 * Validates every exported schema in src/pipeline/phase2/schemas.ts.
 * Covers happy-path parsing, required-field rejection, regex-pattern
 * enforcement, enum/literal constraints, and .passthrough() behaviour
 * for Phase 1 input schemas.
 */

import {
  // Phase 1 passthrough schemas
  Phase1ManifestSchema,
  ScenarioArtifactSchema,
  RoadmapArtifactSchema,
  RiskAssessmentArtifactSchema,

  // Dossier schemas
  DossierItemSchema,
  DossierCrossReferenceSchema,
  DossierSummarySchema,
  ResearchDossierSchema,

  // SPARC schemas
  Phase2RequirementSchema,
  Phase2ConstraintSchema,
  Phase2SuccessCriterionSchema,
  Phase2SpecificationSchema,
  Phase2PseudocodeModuleSchema,
  Phase2PseudocodeSchema,
  Phase2ServiceDefinitionSchema,
  Phase2ArchitectureSchema,
  Phase2RefinementSchema,
  Phase2CompletionSchema,
  Phase2SPARCOutputSchema,

  // ADR schemas
  Phase2ADRAlternativeSchema,
  Phase2ADRConsequenceSchema,
  Phase2ADRRecordSchema,

  // DDD schemas
  Phase2EntitySchema,
  Phase2ValueObjectSchema,
  Phase2AggregateDefinitionSchema,
  Phase2DomainEventSchema,
  Phase2CommandSchema,
  Phase2QuerySchema,
  UbiquitousLanguageTermSchema,
  Phase2DDDBoundedContextSchema,
  Phase2ContextRelationSchema,
  Phase2DomainModelSchema,

  // TDD schemas
  TestPyramidLevelSchema,
  TestPyramidSchema,
  TDDTestCaseSchema,
  TDDTestSuiteSchema,
  MockContractMethodSchema,
  MockContractSchema,
  SeamDefinitionSchema,
  TDDPlanSchema,

  // Phase 2 Manifest
  Phase2ManifestSchema,
} from '../../../../src/pipeline/phase2/schemas.js';

// ============================================================================
// Reusable test-data factories
// ============================================================================

function makeDossierItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'RD-001',
    source: 'scenario',
    category: 'requirement',
    title: 'Must support OAuth',
    content: 'The system must integrate OAuth 2.0 for auth.',
    ...overrides,
  };
}

function makeCrossRef(overrides: Record<string, unknown> = {}) {
  return {
    fromId: 'RD-001',
    toId: 'RD-002',
    relationship: 'depends-on',
    ...overrides,
  };
}

function makeDossierSummary(overrides: Record<string, unknown> = {}) {
  return {
    totalItems: 2,
    bySource: { scenario: 1, roadmap: 1 },
    byCategory: { requirement: 1, risk: 1 },
    keyRisks: ['Data breach'],
    criticalConstraints: ['Must be HIPAA compliant'],
    ...overrides,
  };
}

function makeResearchDossier(overrides: Record<string, unknown> = {}) {
  return {
    items: [makeDossierItem()],
    crossReferences: [makeCrossRef()],
    summary: makeDossierSummary(),
    generatedAt: '2026-02-27T00:00:00Z',
    sourceManifest: 'phase1-manifest.json',
    ...overrides,
  };
}

function makeRequirement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'REQ-001',
    text: 'Support OAuth 2.0',
    dossierItemRefs: ['RD-001'],
    priority: 'must-have',
    ...overrides,
  };
}

function makeConstraint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'CON-001',
    text: 'Must run on Node 20+',
    dossierItemRefs: ['RD-002'],
    ...overrides,
  };
}

function makeSuccessCriterion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'SC-001',
    text: 'p99 latency under 200ms',
    ...overrides,
  };
}

function makeSpecification(overrides: Record<string, unknown> = {}) {
  return {
    requirements: [makeRequirement()],
    constraints: [makeConstraint()],
    successCriteria: [makeSuccessCriterion()],
    scope: 'Authentication subsystem',
    ...overrides,
  };
}

function makePseudocodeModule(overrides: Record<string, unknown> = {}) {
  return {
    name: 'AuthModule',
    description: 'Handles authentication flows',
    steps: ['Validate token', 'Refresh if expired'],
    tddAnchors: ['test-auth-flow'],
    dataStructures: ['TokenPayload'],
    ...overrides,
  };
}

function makePseudocode(overrides: Record<string, unknown> = {}) {
  return {
    modules: [makePseudocodeModule()],
    ...overrides,
  };
}

function makeServiceDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'AuthService',
    responsibility: 'Handle auth',
    api: ['POST /login', 'POST /refresh'],
    dependencies: ['UserService'],
    ...overrides,
  };
}

function makeArchitecture(overrides: Record<string, unknown> = {}) {
  return {
    services: [makeServiceDefinition()],
    boundaries: ['auth-context'],
    dataFlow: 'Client -> Gateway -> AuthService',
    apiContracts: ['auth-openapi.yaml'],
    ...overrides,
  };
}

function makeRefinement(overrides: Record<string, unknown> = {}) {
  return {
    securityConsiderations: ['Encrypt tokens at rest'],
    performanceTargets: ['p99 < 200ms'],
    testStrategy: 'London-school TDD',
    ...overrides,
  };
}

function makeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    integrationPlan: 'Deploy behind feature flag',
    documentation: ['API docs', 'Runbook'],
    monitoringSetup: ['Latency dashboard'],
    ...overrides,
  };
}

function makeSPARCOutput(overrides: Record<string, unknown> = {}) {
  return {
    specification: makeSpecification(),
    pseudocode: makePseudocode(),
    architecture: makeArchitecture(),
    refinement: makeRefinement(),
    completion: makeCompletion(),
    ...overrides,
  };
}

function makeADRAlternative(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Use session cookies',
    description: 'Traditional cookie-based auth',
    tradeoffs: ['Simpler', 'No mobile support'],
    ...overrides,
  };
}

function makeADRConsequence(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Need token refresh logic',
    type: 'negative',
    ...overrides,
  };
}

function makeADRRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ADR-P2-001',
    title: 'Use JWT for auth',
    status: 'accepted',
    date: '2026-02-27',
    context: 'We need stateless auth',
    decision: 'Use JWT with refresh tokens',
    alternatives: [makeADRAlternative()],
    consequences: [makeADRConsequence()],
    ...overrides,
  };
}

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    name: 'User',
    properties: [{ name: 'id', type: 'string', required: true }],
    ...overrides,
  };
}

function makeValueObject(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Email',
    properties: [{ name: 'value', type: 'string' }],
    ...overrides,
  };
}

function makeAggregate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'UserAggregate',
    root: 'User',
    entities: [makeEntity()],
    valueObjects: [makeValueObject()],
    ...overrides,
  };
}

function makeDomainEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'UserRegistered',
    aggregate: 'UserAggregate',
    payload: [{ name: 'userId', type: 'string' }],
    ...overrides,
  };
}

function makeDomainCommand(overrides: Record<string, unknown> = {}) {
  return {
    name: 'RegisterUser',
    aggregate: 'UserAggregate',
    parameters: [{ name: 'email', type: 'string', required: true }],
    emits: ['UserRegistered'],
    ...overrides,
  };
}

function makeDomainQuery(overrides: Record<string, unknown> = {}) {
  return {
    name: 'GetUser',
    parameters: [{ name: 'userId', type: 'string' }],
    returns: 'User',
    ...overrides,
  };
}

function makeUbiquitousTerm(overrides: Record<string, unknown> = {}) {
  return {
    term: 'Bounded Context',
    definition: 'A boundary within which a model applies',
    context: 'DDD',
    ...overrides,
  };
}

function makeBoundedContext(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Identity',
    description: 'User identity and auth',
    aggregates: [makeAggregate()],
    domainEvents: [makeDomainEvent()],
    commands: [makeDomainCommand()],
    queries: [makeDomainQuery()],
    ...overrides,
  };
}

function makeContextRelation(overrides: Record<string, unknown> = {}) {
  return {
    upstream: 'Identity',
    downstream: 'Billing',
    type: 'customer-supplier',
    ...overrides,
  };
}

function makeDomainModel(overrides: Record<string, unknown> = {}) {
  return {
    contexts: [makeBoundedContext()],
    contextMap: [makeContextRelation()],
    ...overrides,
  };
}

function makeTestPyramidLevel(overrides: Record<string, unknown> = {}) {
  return {
    level: 'unit',
    targetCount: 50,
    description: 'Unit tests for domain logic',
    ...overrides,
  };
}

function makeTestPyramid(overrides: Record<string, unknown> = {}) {
  return {
    levels: [makeTestPyramidLevel()],
    coverageTarget: 80,
    ...overrides,
  };
}

function makeTDDTestCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TC-001',
    name: 'should register user',
    level: 'unit',
    description: 'Verify user registration creates aggregate',
    givenWhenThen: {
      given: 'A valid registration request',
      when: 'RegisterUser command is executed',
      then: 'UserRegistered event is emitted',
    },
    ...overrides,
  };
}

function makeTDDTestSuite(overrides: Record<string, unknown> = {}) {
  return {
    name: 'UserRegistration',
    boundedContext: 'Identity',
    testCases: [makeTDDTestCase()],
    ...overrides,
  };
}

function makeMockContractMethod(overrides: Record<string, unknown> = {}) {
  return {
    name: 'findById',
    parameters: [{ name: 'id', type: 'string' }],
    returns: 'User | null',
    behavior: 'Returns user if found, null otherwise',
    ...overrides,
  };
}

function makeMockContract(overrides: Record<string, unknown> = {}) {
  return {
    name: 'UserRepositoryMock',
    targetService: 'UserRepository',
    methods: [makeMockContractMethod()],
    ...overrides,
  };
}

function makeSeamDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: 'AuthGateway',
    type: 'gateway',
    from: 'AuthService',
    to: 'IdentityProvider',
    ...overrides,
  };
}

function makeTDDPlan(overrides: Record<string, unknown> = {}) {
  return {
    approach: 'london-school' as const,
    pyramid: makeTestPyramid(),
    testSuites: [makeTDDTestSuite()],
    mockContracts: [makeMockContract()],
    seams: [makeSeamDefinition()],
    ...overrides,
  };
}

function makePhase1Manifest(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run-abc-123',
    execution_id: 'exec-001',
    correlation_id: 'corr-001',
    query: 'Build an authentication service',
    created_at: '2026-02-27T00:00:00Z',
    timing_ms: 1500,
    agents_invoked: [{ domain: 'copilot', agent: 'planner', status: 'ok' }],
    artifacts: ['scenario.json'],
    schema_version: '1.0.0',
    ...overrides,
  };
}

function makePhase2Manifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '2.0.0' as const,
    run_id: 'run-phase2-001',
    phase1_run_id: 'run-abc-123',
    created_at: '2026-02-27T01:00:00Z',
    timing_ms: 5000,
    query: 'Build an authentication service',
    dossier: makeResearchDossier(),
    sparc: makeSPARCOutput(),
    adrs: [makeADRRecord()],
    domainModel: makeDomainModel(),
    tddPlan: makeTDDPlan(),
    artifacts: ['dossier.json', 'sparc.json'],
    ...overrides,
  };
}

// ============================================================================
// Phase 1 Input Schemas (passthrough)
// ============================================================================

describe('Phase1ManifestSchema', () => {
  test('accepts valid Phase 1 manifest', () => {
    const result = Phase1ManifestSchema.safeParse(makePhase1Manifest());
    expect(result.success).toBe(true);
  });

  test('rejects missing run_id', () => {
    const result = Phase1ManifestSchema.safeParse(
      makePhase1Manifest({ run_id: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects empty run_id', () => {
    const result = Phase1ManifestSchema.safeParse(
      makePhase1Manifest({ run_id: '' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects empty query', () => {
    const result = Phase1ManifestSchema.safeParse(
      makePhase1Manifest({ query: '' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects negative timing_ms', () => {
    const result = Phase1ManifestSchema.safeParse(
      makePhase1Manifest({ timing_ms: -1 }),
    );
    expect(result.success).toBe(false);
  });

  test('allows extra fields via passthrough', () => {
    const input = makePhase1Manifest({ custom_field: 'extra', debug: true });
    const result = Phase1ManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).custom_field).toBe('extra');
      expect((result.data as Record<string, unknown>).debug).toBe(true);
    }
  });
});

describe('ScenarioArtifactSchema', () => {
  test('accepts minimal object', () => {
    const result = ScenarioArtifactSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts object with query', () => {
    const result = ScenarioArtifactSchema.safeParse({ query: 'test' });
    expect(result.success).toBe(true);
  });

  test('allows extra fields via passthrough', () => {
    const result = ScenarioArtifactSchema.safeParse({
      query: 'test',
      someExtra: 123,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).someExtra).toBe(123);
    }
  });
});

describe('RoadmapArtifactSchema', () => {
  test('accepts minimal object', () => {
    const result = RoadmapArtifactSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts object with phases', () => {
    const result = RoadmapArtifactSchema.safeParse({
      phases: [{ name: 'Phase 1' }],
    });
    expect(result.success).toBe(true);
  });

  test('allows extra fields on phases via passthrough', () => {
    const result = RoadmapArtifactSchema.safeParse({
      phases: [{ name: 'Phase 1', duration: '2 weeks' }],
      extraTopLevel: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extraTopLevel).toBe(true);
      const phases = result.data.phases!;
      expect((phases[0] as Record<string, unknown>).duration).toBe('2 weeks');
    }
  });

  test('rejects phases item missing name', () => {
    const result = RoadmapArtifactSchema.safeParse({
      phases: [{ duration: '2 weeks' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('RiskAssessmentArtifactSchema', () => {
  const validRisk = {
    risk_factors: [
      {
        id: 'RF-001',
        category: 'security',
        description: 'Data breach risk',
        severity: 'high',
        likelihood: 'medium',
        mitigation: 'Encrypt at rest',
      },
    ],
    overall_risk_level: 'medium',
  };

  test('accepts valid risk assessment', () => {
    const result = RiskAssessmentArtifactSchema.safeParse(validRisk);
    expect(result.success).toBe(true);
  });

  // overall_risk_level is intentionally optional in the Phase-1 input schema
  // (lenient .passthrough() contract for forward-compatibility), so a missing
  // value is accepted, not rejected.
  test('accepts missing overall_risk_level (optional)', () => {
    const { overall_risk_level, ...rest } = validRisk;
    const result = RiskAssessmentArtifactSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  // risk_factors uses z.object({}).passthrough() — partial factor objects are
  // intentionally accepted under the lenient Phase-1 input contract.
  test('accepts partial risk_factor objects (passthrough)', () => {
    const result = RiskAssessmentArtifactSchema.safeParse({
      risk_factors: [{ id: 'RF-001', category: 'sec' }],
      overall_risk_level: 'low',
    });
    expect(result.success).toBe(true);
  });

  test('allows extra fields via passthrough', () => {
    const result = RiskAssessmentArtifactSchema.safeParse({
      ...validRisk,
      assessor: 'SecurityBot',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).assessor).toBe('SecurityBot');
    }
  });
});

// ============================================================================
// Dossier Schemas
// ============================================================================

describe('DossierItemSchema', () => {
  test('accepts valid dossier item', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem());
    expect(result.success).toBe(true);
  });

  test('accepts id with more than 3 digits (e.g. RD-1234)', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ id: 'RD-1234' }));
    expect(result.success).toBe(true);
  });

  test('accepts all valid source enum values', () => {
    const sources = ['scenario', 'roadmap', 'risk-assessment', 'agent-result', 'user-context'];
    for (const source of sources) {
      const result = DossierItemSchema.safeParse(makeDossierItem({ source }));
      expect(result.success).toBe(true);
    }
  });

  test('accepts all valid category enum values', () => {
    const categories = ['requirement', 'constraint', 'risk', 'assumption', 'dependency', 'decision'];
    for (const category of categories) {
      const result = DossierItemSchema.safeParse(makeDossierItem({ category }));
      expect(result.success).toBe(true);
    }
  });

  test('accepts optional severity and phase fields', () => {
    const result = DossierItemSchema.safeParse(
      makeDossierItem({ severity: 'high', phase: 'phase-1' }),
    );
    expect(result.success).toBe(true);
  });

  // --- Rejection tests ---

  test('rejects id not matching /^RD-\\d{3,}$/ -- too few digits', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ id: 'RD-1' }));
    expect(result.success).toBe(false);
  });

  test('rejects id not matching /^RD-\\d{3,}$/ -- two digits', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ id: 'RD-12' }));
    expect(result.success).toBe(false);
  });

  test('rejects id with wrong prefix', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ id: 'XX-001' }));
    expect(result.success).toBe(false);
  });

  test('rejects id with letters after dash', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ id: 'RD-abc' }));
    expect(result.success).toBe(false);
  });

  test('rejects id with trailing text', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ id: 'RD-001-extra' }));
    expect(result.success).toBe(false);
  });

  test('rejects unknown source value', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ source: 'wikipedia' }));
    expect(result.success).toBe(false);
  });

  test('rejects unknown category value', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ category: 'wish' }));
    expect(result.success).toBe(false);
  });

  test('rejects empty title', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ title: '' }));
    expect(result.success).toBe(false);
  });

  test('rejects empty content', () => {
    const result = DossierItemSchema.safeParse(makeDossierItem({ content: '' }));
    expect(result.success).toBe(false);
  });

  test('rejects missing required fields', () => {
    const result = DossierItemSchema.safeParse({ id: 'RD-001' });
    expect(result.success).toBe(false);
  });
});

describe('DossierCrossReferenceSchema', () => {
  test('accepts valid cross reference', () => {
    const result = DossierCrossReferenceSchema.safeParse(makeCrossRef());
    expect(result.success).toBe(true);
  });

  test('accepts all valid relationship values', () => {
    const rels = ['blocks', 'depends-on', 'mitigates', 'conflicts-with', 'refines'];
    for (const relationship of rels) {
      const result = DossierCrossReferenceSchema.safeParse(makeCrossRef({ relationship }));
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown relationship', () => {
    const result = DossierCrossReferenceSchema.safeParse(
      makeCrossRef({ relationship: 'likes' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing fromId', () => {
    const result = DossierCrossReferenceSchema.safeParse(
      makeCrossRef({ fromId: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('DossierSummarySchema', () => {
  test('accepts valid summary', () => {
    const result = DossierSummarySchema.safeParse(makeDossierSummary());
    expect(result.success).toBe(true);
  });

  test('rejects missing totalItems', () => {
    const result = DossierSummarySchema.safeParse(
      makeDossierSummary({ totalItems: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects non-number totalItems', () => {
    const result = DossierSummarySchema.safeParse(
      makeDossierSummary({ totalItems: 'two' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('ResearchDossierSchema', () => {
  test('accepts valid research dossier', () => {
    const result = ResearchDossierSchema.safeParse(makeResearchDossier());
    expect(result.success).toBe(true);
  });

  test('rejects missing items array', () => {
    const result = ResearchDossierSchema.safeParse(
      makeResearchDossier({ items: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects invalid item inside items array', () => {
    const result = ResearchDossierSchema.safeParse(
      makeResearchDossier({ items: [{ id: 'BAD' }] }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing generatedAt', () => {
    const result = ResearchDossierSchema.safeParse(
      makeResearchDossier({ generatedAt: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('accepts empty arrays for items and crossReferences', () => {
    const result = ResearchDossierSchema.safeParse(
      makeResearchDossier({ items: [], crossReferences: [] }),
    );
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// SPARC Schemas
// ============================================================================

describe('Phase2RequirementSchema', () => {
  test('accepts valid requirement', () => {
    const result = Phase2RequirementSchema.safeParse(makeRequirement());
    expect(result.success).toBe(true);
  });

  test('accepts all priority values', () => {
    for (const priority of ['must-have', 'should-have', 'could-have', 'wont-have']) {
      const result = Phase2RequirementSchema.safeParse(makeRequirement({ priority }));
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown priority', () => {
    const result = Phase2RequirementSchema.safeParse(
      makeRequirement({ priority: 'nice-to-have' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing dossierItemRefs', () => {
    const result = Phase2RequirementSchema.safeParse(
      makeRequirement({ dossierItemRefs: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2ConstraintSchema', () => {
  test('accepts valid constraint', () => {
    const result = Phase2ConstraintSchema.safeParse(makeConstraint());
    expect(result.success).toBe(true);
  });

  test('accepts optional enforcedBy', () => {
    const result = Phase2ConstraintSchema.safeParse(
      makeConstraint({ enforcedBy: 'CI pipeline' }),
    );
    expect(result.success).toBe(true);
  });
});

describe('Phase2SuccessCriterionSchema', () => {
  test('accepts valid criterion', () => {
    const result = Phase2SuccessCriterionSchema.safeParse(makeSuccessCriterion());
    expect(result.success).toBe(true);
  });

  test('accepts optional metric and threshold', () => {
    const result = Phase2SuccessCriterionSchema.safeParse(
      makeSuccessCriterion({ metric: 'latency_p99', threshold: '200ms' }),
    );
    expect(result.success).toBe(true);
  });
});

describe('Phase2SpecificationSchema', () => {
  test('accepts valid specification', () => {
    const result = Phase2SpecificationSchema.safeParse(makeSpecification());
    expect(result.success).toBe(true);
  });

  test('rejects missing scope', () => {
    const result = Phase2SpecificationSchema.safeParse(
      makeSpecification({ scope: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2PseudocodeModuleSchema', () => {
  test('accepts valid module', () => {
    const result = Phase2PseudocodeModuleSchema.safeParse(makePseudocodeModule());
    expect(result.success).toBe(true);
  });

  test('rejects missing steps', () => {
    const result = Phase2PseudocodeModuleSchema.safeParse(
      makePseudocodeModule({ steps: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2PseudocodeSchema', () => {
  test('accepts valid pseudocode', () => {
    const result = Phase2PseudocodeSchema.safeParse(makePseudocode());
    expect(result.success).toBe(true);
  });

  test('accepts empty modules array', () => {
    const result = Phase2PseudocodeSchema.safeParse({ modules: [] });
    expect(result.success).toBe(true);
  });
});

describe('Phase2ServiceDefinitionSchema', () => {
  test('accepts valid service definition', () => {
    const result = Phase2ServiceDefinitionSchema.safeParse(makeServiceDefinition());
    expect(result.success).toBe(true);
  });

  test('accepts optional boundedContext', () => {
    const result = Phase2ServiceDefinitionSchema.safeParse(
      makeServiceDefinition({ boundedContext: 'Identity' }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing responsibility', () => {
    const result = Phase2ServiceDefinitionSchema.safeParse(
      makeServiceDefinition({ responsibility: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2ArchitectureSchema', () => {
  test('accepts valid architecture', () => {
    const result = Phase2ArchitectureSchema.safeParse(makeArchitecture());
    expect(result.success).toBe(true);
  });

  test('rejects missing dataFlow', () => {
    const result = Phase2ArchitectureSchema.safeParse(
      makeArchitecture({ dataFlow: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2RefinementSchema', () => {
  test('accepts valid refinement', () => {
    const result = Phase2RefinementSchema.safeParse(makeRefinement());
    expect(result.success).toBe(true);
  });

  test('accepts optional edgeCases', () => {
    const result = Phase2RefinementSchema.safeParse(
      makeRefinement({ edgeCases: ['Empty input', 'Max payload'] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing testStrategy', () => {
    const result = Phase2RefinementSchema.safeParse(
      makeRefinement({ testStrategy: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2CompletionSchema', () => {
  test('accepts valid completion', () => {
    const result = Phase2CompletionSchema.safeParse(makeCompletion());
    expect(result.success).toBe(true);
  });

  test('accepts optional deploymentChecklist', () => {
    const result = Phase2CompletionSchema.safeParse(
      makeCompletion({ deploymentChecklist: ['Smoke test', 'Rollback plan'] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing integrationPlan', () => {
    const result = Phase2CompletionSchema.safeParse(
      makeCompletion({ integrationPlan: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2SPARCOutputSchema', () => {
  test('accepts valid SPARC output', () => {
    const result = Phase2SPARCOutputSchema.safeParse(makeSPARCOutput());
    expect(result.success).toBe(true);
  });

  test('rejects missing specification', () => {
    const result = Phase2SPARCOutputSchema.safeParse(
      makeSPARCOutput({ specification: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing pseudocode', () => {
    const result = Phase2SPARCOutputSchema.safeParse(
      makeSPARCOutput({ pseudocode: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing architecture', () => {
    const result = Phase2SPARCOutputSchema.safeParse(
      makeSPARCOutput({ architecture: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing refinement', () => {
    const result = Phase2SPARCOutputSchema.safeParse(
      makeSPARCOutput({ refinement: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing completion', () => {
    const result = Phase2SPARCOutputSchema.safeParse(
      makeSPARCOutput({ completion: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ADR Schemas
// ============================================================================

describe('Phase2ADRAlternativeSchema', () => {
  test('accepts valid alternative', () => {
    const result = Phase2ADRAlternativeSchema.safeParse(makeADRAlternative());
    expect(result.success).toBe(true);
  });

  test('rejects missing tradeoffs', () => {
    const result = Phase2ADRAlternativeSchema.safeParse(
      makeADRAlternative({ tradeoffs: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2ADRConsequenceSchema', () => {
  test('accepts valid consequence', () => {
    const result = Phase2ADRConsequenceSchema.safeParse(makeADRConsequence());
    expect(result.success).toBe(true);
  });

  test('accepts all consequence types', () => {
    for (const type of ['positive', 'negative', 'neutral']) {
      const result = Phase2ADRConsequenceSchema.safeParse(makeADRConsequence({ type }));
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown consequence type', () => {
    const result = Phase2ADRConsequenceSchema.safeParse(
      makeADRConsequence({ type: 'unknown' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2ADRRecordSchema', () => {
  test('accepts valid ADR record', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord());
    expect(result.success).toBe(true);
  });

  test('accepts id ADR-P2-999', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ id: 'ADR-P2-999' }));
    expect(result.success).toBe(true);
  });

  test('accepts all valid status values', () => {
    for (const status of ['proposed', 'accepted', 'deprecated', 'superseded']) {
      const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ status }));
      expect(result.success).toBe(true);
    }
  });

  test('accepts optional dossierItemRefs', () => {
    const result = Phase2ADRRecordSchema.safeParse(
      makeADRRecord({ dossierItemRefs: ['RD-001'] }),
    );
    expect(result.success).toBe(true);
  });

  // --- Regex rejection tests ---

  test('rejects id with too few digits (ADR-P2-01)', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ id: 'ADR-P2-01' }));
    expect(result.success).toBe(false);
  });

  test('rejects id with too many digits (ADR-P2-0001)', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ id: 'ADR-P2-0001' }));
    expect(result.success).toBe(false);
  });

  test('rejects id with wrong prefix (ADR-P1-001)', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ id: 'ADR-P1-001' }));
    expect(result.success).toBe(false);
  });

  test('rejects id without P2 segment (ADR-001)', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ id: 'ADR-001' }));
    expect(result.success).toBe(false);
  });

  test('rejects id with trailing text', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ id: 'ADR-P2-001-x' }));
    expect(result.success).toBe(false);
  });

  test('rejects unknown status', () => {
    const result = Phase2ADRRecordSchema.safeParse(makeADRRecord({ status: 'draft' }));
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// DDD Schemas
// ============================================================================

describe('Phase2EntitySchema', () => {
  test('accepts valid entity', () => {
    const result = Phase2EntitySchema.safeParse(makeEntity());
    expect(result.success).toBe(true);
  });

  test('accepts optional invariants', () => {
    const result = Phase2EntitySchema.safeParse(
      makeEntity({ invariants: ['Email must be unique'] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects property missing required boolean', () => {
    const result = Phase2EntitySchema.safeParse(
      makeEntity({ properties: [{ name: 'id', type: 'string' }] }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2ValueObjectSchema', () => {
  test('accepts valid value object', () => {
    const result = Phase2ValueObjectSchema.safeParse(makeValueObject());
    expect(result.success).toBe(true);
  });

  test('accepts optional validationRules', () => {
    const result = Phase2ValueObjectSchema.safeParse(
      makeValueObject({ validationRules: ['Must contain @'] }),
    );
    expect(result.success).toBe(true);
  });
});

describe('Phase2AggregateDefinitionSchema', () => {
  test('accepts valid aggregate', () => {
    const result = Phase2AggregateDefinitionSchema.safeParse(makeAggregate());
    expect(result.success).toBe(true);
  });

  test('rejects missing root', () => {
    const result = Phase2AggregateDefinitionSchema.safeParse(
      makeAggregate({ root: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2DomainEventSchema', () => {
  test('accepts valid domain event', () => {
    const result = Phase2DomainEventSchema.safeParse(makeDomainEvent());
    expect(result.success).toBe(true);
  });

  test('accepts optional description', () => {
    const result = Phase2DomainEventSchema.safeParse(
      makeDomainEvent({ description: 'Emitted when a new user registers' }),
    );
    expect(result.success).toBe(true);
  });
});

describe('Phase2CommandSchema', () => {
  test('accepts valid command', () => {
    const result = Phase2CommandSchema.safeParse(makeDomainCommand());
    expect(result.success).toBe(true);
  });

  test('rejects missing emits array', () => {
    const result = Phase2CommandSchema.safeParse(
      makeDomainCommand({ emits: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2QuerySchema', () => {
  test('accepts valid query', () => {
    const result = Phase2QuerySchema.safeParse(makeDomainQuery());
    expect(result.success).toBe(true);
  });

  test('rejects missing returns', () => {
    const result = Phase2QuerySchema.safeParse(
      makeDomainQuery({ returns: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('UbiquitousLanguageTermSchema', () => {
  test('accepts valid term', () => {
    const result = UbiquitousLanguageTermSchema.safeParse(makeUbiquitousTerm());
    expect(result.success).toBe(true);
  });

  test('accepts optional aliases', () => {
    const result = UbiquitousLanguageTermSchema.safeParse(
      makeUbiquitousTerm({ aliases: ['BC'] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing context', () => {
    const result = UbiquitousLanguageTermSchema.safeParse(
      makeUbiquitousTerm({ context: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2DDDBoundedContextSchema', () => {
  test('accepts valid bounded context', () => {
    const result = Phase2DDDBoundedContextSchema.safeParse(makeBoundedContext());
    expect(result.success).toBe(true);
  });

  test('accepts optional ubiquitousLanguage', () => {
    const result = Phase2DDDBoundedContextSchema.safeParse(
      makeBoundedContext({ ubiquitousLanguage: [makeUbiquitousTerm()] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing aggregates', () => {
    const result = Phase2DDDBoundedContextSchema.safeParse(
      makeBoundedContext({ aggregates: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2ContextRelationSchema', () => {
  test('accepts valid context relation', () => {
    const result = Phase2ContextRelationSchema.safeParse(makeContextRelation());
    expect(result.success).toBe(true);
  });

  test('accepts all valid relation types', () => {
    const types = [
      'partnership',
      'customer-supplier',
      'conformist',
      'anticorruption-layer',
      'shared-kernel',
      'open-host-service',
    ];
    for (const type of types) {
      const result = Phase2ContextRelationSchema.safeParse(makeContextRelation({ type }));
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown relation type', () => {
    const result = Phase2ContextRelationSchema.safeParse(
      makeContextRelation({ type: 'peer-to-peer' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('Phase2DomainModelSchema', () => {
  test('accepts valid domain model', () => {
    const result = Phase2DomainModelSchema.safeParse(makeDomainModel());
    expect(result.success).toBe(true);
  });

  test('accepts optional ubiquitousLanguage at top level', () => {
    const result = Phase2DomainModelSchema.safeParse(
      makeDomainModel({ ubiquitousLanguage: [makeUbiquitousTerm()] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing contexts', () => {
    const result = Phase2DomainModelSchema.safeParse(
      makeDomainModel({ contexts: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// TDD Schemas
// ============================================================================

describe('TestPyramidLevelSchema', () => {
  test('accepts valid pyramid level', () => {
    const result = TestPyramidLevelSchema.safeParse(makeTestPyramidLevel());
    expect(result.success).toBe(true);
  });

  test('accepts all level values', () => {
    for (const level of ['unit', 'integration', 'e2e', 'contract']) {
      const result = TestPyramidLevelSchema.safeParse(makeTestPyramidLevel({ level }));
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown level', () => {
    const result = TestPyramidLevelSchema.safeParse(
      makeTestPyramidLevel({ level: 'smoke' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects negative targetCount', () => {
    const result = TestPyramidLevelSchema.safeParse(
      makeTestPyramidLevel({ targetCount: -1 }),
    );
    expect(result.success).toBe(false);
  });
});

describe('TestPyramidSchema', () => {
  test('accepts valid pyramid', () => {
    const result = TestPyramidSchema.safeParse(makeTestPyramid());
    expect(result.success).toBe(true);
  });

  test('rejects coverageTarget above 100', () => {
    const result = TestPyramidSchema.safeParse(
      makeTestPyramid({ coverageTarget: 101 }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects coverageTarget below 0', () => {
    const result = TestPyramidSchema.safeParse(
      makeTestPyramid({ coverageTarget: -1 }),
    );
    expect(result.success).toBe(false);
  });

  test('accepts coverageTarget at boundaries (0 and 100)', () => {
    expect(TestPyramidSchema.safeParse(makeTestPyramid({ coverageTarget: 0 })).success).toBe(true);
    expect(TestPyramidSchema.safeParse(makeTestPyramid({ coverageTarget: 100 })).success).toBe(true);
  });
});

describe('TDDTestCaseSchema', () => {
  test('accepts valid test case', () => {
    const result = TDDTestCaseSchema.safeParse(makeTDDTestCase());
    expect(result.success).toBe(true);
  });

  test('accepts optional boundedContext, aggregate, dossierItemRefs', () => {
    const result = TDDTestCaseSchema.safeParse(
      makeTDDTestCase({
        boundedContext: 'Identity',
        aggregate: 'UserAggregate',
        dossierItemRefs: ['RD-001'],
      }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing givenWhenThen', () => {
    const result = TDDTestCaseSchema.safeParse(
      makeTDDTestCase({ givenWhenThen: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects givenWhenThen missing then', () => {
    const result = TDDTestCaseSchema.safeParse(
      makeTDDTestCase({
        givenWhenThen: { given: 'A', when: 'B' },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('TDDTestSuiteSchema', () => {
  test('accepts valid test suite', () => {
    const result = TDDTestSuiteSchema.safeParse(makeTDDTestSuite());
    expect(result.success).toBe(true);
  });

  test('rejects missing boundedContext', () => {
    const result = TDDTestSuiteSchema.safeParse(
      makeTDDTestSuite({ boundedContext: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('MockContractMethodSchema', () => {
  test('accepts valid mock contract method', () => {
    const result = MockContractMethodSchema.safeParse(makeMockContractMethod());
    expect(result.success).toBe(true);
  });

  test('rejects missing behavior', () => {
    const result = MockContractMethodSchema.safeParse(
      makeMockContractMethod({ behavior: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('MockContractSchema', () => {
  test('accepts valid mock contract', () => {
    const result = MockContractSchema.safeParse(makeMockContract());
    expect(result.success).toBe(true);
  });

  test('rejects missing targetService', () => {
    const result = MockContractSchema.safeParse(
      makeMockContract({ targetService: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

describe('SeamDefinitionSchema', () => {
  test('accepts valid seam definition', () => {
    const result = SeamDefinitionSchema.safeParse(makeSeamDefinition());
    expect(result.success).toBe(true);
  });

  test('accepts all valid seam types', () => {
    for (const type of ['service-boundary', 'adapter', 'port', 'gateway']) {
      const result = SeamDefinitionSchema.safeParse(makeSeamDefinition({ type }));
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown seam type', () => {
    const result = SeamDefinitionSchema.safeParse(
      makeSeamDefinition({ type: 'bridge' }),
    );
    expect(result.success).toBe(false);
  });

  test('accepts optional mockContract and description', () => {
    const result = SeamDefinitionSchema.safeParse(
      makeSeamDefinition({ mockContract: 'UserRepoMock', description: 'Auth gateway seam' }),
    );
    expect(result.success).toBe(true);
  });
});

describe('TDDPlanSchema', () => {
  test('accepts valid TDD plan', () => {
    const result = TDDPlanSchema.safeParse(makeTDDPlan());
    expect(result.success).toBe(true);
  });

  test('approach must be literal london-school', () => {
    const result = TDDPlanSchema.safeParse(
      makeTDDPlan({ approach: 'london-school' }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects approach other than london-school', () => {
    const result = TDDPlanSchema.safeParse(
      makeTDDPlan({ approach: 'chicago-school' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects approach of classical', () => {
    const result = TDDPlanSchema.safeParse(
      makeTDDPlan({ approach: 'classical' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing pyramid', () => {
    const result = TDDPlanSchema.safeParse(
      makeTDDPlan({ pyramid: undefined }),
    );
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Phase 2 Manifest Schema
// ============================================================================

describe('Phase2ManifestSchema', () => {
  test('accepts valid Phase 2 manifest', () => {
    const result = Phase2ManifestSchema.safeParse(makePhase2Manifest());
    expect(result.success).toBe(true);
  });

  test('schema_version must be literal 2.0.0', () => {
    const result = Phase2ManifestSchema.safeParse(makePhase2Manifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe('2.0.0');
    }
  });

  test('rejects schema_version other than 2.0.0', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ schema_version: '1.0.0' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects schema_version 2.0.1', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ schema_version: '2.0.1' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects empty run_id', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ run_id: '' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects empty phase1_run_id', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ phase1_run_id: '' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects empty query', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ query: '' }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects negative timing_ms', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ timing_ms: -100 }),
    );
    expect(result.success).toBe(false);
  });

  test('accepts timing_ms of zero', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ timing_ms: 0 }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects missing dossier', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ dossier: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing sparc', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ sparc: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing adrs', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ adrs: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing domainModel', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ domainModel: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects missing tddPlan', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ tddPlan: undefined }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects invalid nested dossier item id', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({
        dossier: makeResearchDossier({
          items: [makeDossierItem({ id: 'BAD-ID' })],
        }),
      }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects invalid nested ADR id', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({
        adrs: [makeADRRecord({ id: 'ADR-001' })],
      }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects invalid nested TDD approach', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({
        tddPlan: makeTDDPlan({ approach: 'chicago-school' }),
      }),
    );
    expect(result.success).toBe(false);
  });

  test('accepts empty adrs array', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ adrs: [] }),
    );
    expect(result.success).toBe(true);
  });

  test('accepts empty artifacts array', () => {
    const result = Phase2ManifestSchema.safeParse(
      makePhase2Manifest({ artifacts: [] }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects completely empty object', () => {
    const result = Phase2ManifestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects non-object input', () => {
    expect(Phase2ManifestSchema.safeParse(null).success).toBe(false);
    expect(Phase2ManifestSchema.safeParse(undefined).success).toBe(false);
    expect(Phase2ManifestSchema.safeParse('string').success).toBe(false);
    expect(Phase2ManifestSchema.safeParse(42).success).toBe(false);
  });
});
