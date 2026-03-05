/**
 * Phase 2 Pipeline Schemas
 *
 * Zod validation schemas for all Phase 2 pipeline types.
 * Covers Phase 1 input artifacts, research dossier, SPARC output,
 * ADR records, DDD domain model, TDD plan, and the Phase 2 manifest.
 *
 * All object schemas for Phase 1 inputs use `.passthrough()` for
 * forward-compatibility with evolving upstream formats.
 */

import { z } from 'zod';

// ============================================================================
// Phase 1 Input Schemas (passthrough for forward-compatibility)
// ============================================================================

export const Phase1ManifestSchema = z.object({
  run_id: z.string().min(1),
  execution_id: z.string().optional(),
  correlation_id: z.string().optional(),
  query: z.string().min(1),
  created_at: z.string(),
  timing_ms: z.number().nonnegative(),
  agents_invoked: z.array(z.object({
    domain: z.string(),
    agent: z.string(),
    status: z.string(),
  })),
  artifacts: z.array(z.string()),
  schema_version: z.string(),
}).passthrough();

export const ScenarioArtifactSchema = z.object({
  query: z.string().optional(),
}).passthrough();

export const RoadmapArtifactSchema = z.object({
  phases: z.array(z.object({
    name: z.string(),
  }).passthrough()).optional(),
}).passthrough();

export const RiskAssessmentArtifactSchema = z.object({
  risk_factors: z.array(z.object({}).passthrough()).optional(),
  overall_risk_level: z.string().optional(),
}).passthrough();

// ============================================================================
// Dossier Schemas
// ============================================================================

const DossierSourceEnum = z.enum([
  'scenario',
  'roadmap',
  'risk-assessment',
  'executive-summary',
  'decision-memo',
  'agent-result',
  'user-context',
]);

const DossierCategoryEnum = z.enum([
  'requirement',
  'constraint',
  'risk',
  'stakeholder',
  'success-criterion',
  'timeline',
  'recommendation',
  'decision-rationale',
  'assumption',
  'dependency',
  'decision',
]);

export const DossierItemSchema = z.object({
  id: z.string().regex(/^RD-\d{3,}$/),
  source: DossierSourceEnum,
  category: DossierCategoryEnum,
  title: z.string().min(1),
  content: z.string().min(1),
  severity: z.string().optional(),
  phase: z.string().optional(),
});

const DossierRelationshipEnum = z.enum([
  'blocks',
  'depends-on',
  'mitigates',
  'constrains',
  'conflicts-with',
  'refines',
]);

export const DossierCrossReferenceSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  relationship: DossierRelationshipEnum,
});

export const DossierSummarySchema = z.object({
  totalItems: z.number(),
  bySource: z.record(z.string(), z.number()),
  byCategory: z.record(z.string(), z.number()),
  keyRisks: z.array(z.string()),
  criticalConstraints: z.array(z.string()),
});

export const ResearchDossierSchema = z.object({
  items: z.array(DossierItemSchema),
  crossReferences: z.array(DossierCrossReferenceSchema),
  summary: DossierSummarySchema,
  generatedAt: z.string(),
  sourceManifest: z.string(),
});

// ============================================================================
// SPARC Schemas
// ============================================================================

const RequirementPriorityEnum = z.enum([
  'must-have',
  'should-have',
  'could-have',
  'wont-have',
]);

export const Phase2RequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  dossierItemRefs: z.array(z.string()),
  priority: RequirementPriorityEnum,
});

export const Phase2ConstraintSchema = z.object({
  id: z.string(),
  text: z.string(),
  dossierItemRefs: z.array(z.string()),
  enforcedBy: z.string().optional(),
});

export const Phase2SuccessCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  metric: z.string().optional(),
  threshold: z.string().optional(),
});

export const Phase2SpecificationSchema = z.object({
  requirements: z.array(Phase2RequirementSchema),
  constraints: z.array(Phase2ConstraintSchema),
  successCriteria: z.array(Phase2SuccessCriterionSchema),
  scope: z.string(),
});

export const Phase2PseudocodeModuleSchema = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(z.string()),
  tddAnchors: z.array(z.string()),
  dataStructures: z.array(z.string()),
});

export const Phase2PseudocodeSchema = z.object({
  modules: z.array(Phase2PseudocodeModuleSchema),
});

export const Phase2ServiceDefinitionSchema = z.object({
  name: z.string(),
  responsibility: z.string(),
  api: z.array(z.string()),
  dependencies: z.array(z.string()),
  boundedContext: z.string().optional(),
});

export const Phase2ArchitectureSchema = z.object({
  services: z.array(Phase2ServiceDefinitionSchema),
  boundaries: z.array(z.string()),
  dataFlow: z.string(),
  apiContracts: z.array(z.string()),
});

export const Phase2RefinementSchema = z.object({
  securityConsiderations: z.array(z.string()),
  performanceTargets: z.array(z.string()),
  testStrategy: z.string(),
  edgeCases: z.array(z.string()).optional(),
});

export const Phase2CompletionSchema = z.object({
  integrationPlan: z.string(),
  documentation: z.array(z.string()),
  monitoringSetup: z.array(z.string()),
  deploymentChecklist: z.array(z.string()).optional(),
});

export const Phase2SPARCOutputSchema = z.object({
  specification: Phase2SpecificationSchema,
  pseudocode: Phase2PseudocodeSchema,
  architecture: Phase2ArchitectureSchema,
  refinement: Phase2RefinementSchema,
  completion: Phase2CompletionSchema,
});

// ============================================================================
// ADR Schemas
// ============================================================================

export const Phase2ADRAlternativeSchema = z.object({
  title: z.string(),
  description: z.string(),
  tradeoffs: z.array(z.string()),
});

export const Phase2ADRConsequenceSchema = z.object({
  description: z.string(),
  type: z.enum(['positive', 'negative', 'neutral']),
});

export const Phase2ADRRecordSchema = z.object({
  id: z.string().regex(/^ADR-P2-\d{3}$/),
  title: z.string(),
  status: z.enum(['proposed', 'accepted', 'deprecated', 'superseded']),
  date: z.string(),
  context: z.string(),
  decision: z.string(),
  alternatives: z.array(Phase2ADRAlternativeSchema),
  consequences: z.array(Phase2ADRConsequenceSchema),
  dossierItemRefs: z.array(z.string()).optional(),
});

// ============================================================================
// DDD Schemas
// ============================================================================

export const Phase2EntitySchema = z.object({
  name: z.string(),
  properties: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
  })),
  invariants: z.array(z.string()).optional(),
});

export const Phase2ValueObjectSchema = z.object({
  name: z.string(),
  properties: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })),
  validationRules: z.array(z.string()).optional(),
});

export const Phase2AggregateDefinitionSchema = z.object({
  name: z.string(),
  root: z.string(),
  entities: z.array(Phase2EntitySchema),
  valueObjects: z.array(Phase2ValueObjectSchema),
  invariants: z.array(z.string()).optional(),
});

export const Phase2DomainEventSchema = z.object({
  name: z.string(),
  aggregate: z.string(),
  payload: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })),
  description: z.string().optional(),
});

export const Phase2CommandSchema = z.object({
  name: z.string(),
  aggregate: z.string(),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
  })),
  emits: z.array(z.string()),
});

export const Phase2QuerySchema = z.object({
  name: z.string(),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })),
  returns: z.string(),
});

export const UbiquitousLanguageTermSchema = z.object({
  term: z.string(),
  definition: z.string(),
  context: z.string(),
  aliases: z.array(z.string()).optional(),
});

export const Phase2DDDBoundedContextSchema = z.object({
  name: z.string(),
  description: z.string(),
  aggregates: z.array(Phase2AggregateDefinitionSchema),
  domainEvents: z.array(Phase2DomainEventSchema),
  commands: z.array(Phase2CommandSchema),
  queries: z.array(Phase2QuerySchema),
  ubiquitousLanguage: z.array(UbiquitousLanguageTermSchema).optional(),
  subdomain: z.enum(['core', 'supporting', 'generic']).optional(),
});

export const Phase2ContextRelationSchema = z.object({
  upstream: z.string(),
  downstream: z.string(),
  type: z.enum([
    'partnership',
    'customer-supplier',
    'conformist',
    'anticorruption-layer',
    'shared-kernel',
    'open-host-service',
    'published-language',
  ]),
  description: z.string().optional(),
  integration_pattern: z.string().optional(),
  data_flows: z.array(z.string()).optional(),
  anti_corruption_strategy: z.string().optional(),
});

export const Phase2DomainModelSchema = z.object({
  contexts: z.array(Phase2DDDBoundedContextSchema),
  contextMap: z.array(Phase2ContextRelationSchema),
  ubiquitousLanguage: z.array(UbiquitousLanguageTermSchema).optional(),
});

// ============================================================================
// TDD Schemas
// ============================================================================

export const TestPyramidLevelSchema = z.object({
  level: z.enum(['unit', 'integration', 'e2e', 'contract']),
  targetCount: z.number().nonnegative(),
  description: z.string(),
});

export const TestPyramidSchema = z.object({
  levels: z.array(TestPyramidLevelSchema),
  coverageTarget: z.number().min(0).max(100),
});

export const TDDTestCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  level: z.enum(['unit', 'integration', 'e2e', 'contract']),
  description: z.string(),
  givenWhenThen: z.object({
    given: z.string(),
    when: z.string(),
    then: z.string(),
  }),
  boundedContext: z.string().optional(),
  aggregate: z.string().optional(),
  dossierItemRefs: z.array(z.string()).optional(),
});

export const TDDTestSuiteSchema = z.object({
  name: z.string(),
  boundedContext: z.string(),
  testCases: z.array(TDDTestCaseSchema),
});

export const MockContractMethodSchema = z.object({
  name: z.string(),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })),
  returns: z.string(),
  behavior: z.string(),
});

export const MockContractSchema = z.object({
  name: z.string(),
  targetService: z.string(),
  methods: z.array(MockContractMethodSchema),
});

export const SeamDefinitionSchema = z.object({
  name: z.string(),
  type: z.enum(['service-boundary', 'adapter', 'port', 'gateway']),
  from: z.string(),
  to: z.string(),
  mockContract: z.string().optional(),
  description: z.string().optional(),
});

export const TDDPlanSchema = z.object({
  approach: z.literal('london-school'),
  pyramid: TestPyramidSchema,
  testSuites: z.array(TDDTestSuiteSchema),
  mockContracts: z.array(MockContractSchema),
  seams: z.array(SeamDefinitionSchema),
});

// ============================================================================
// Phase 2 Manifest Schema
// ============================================================================

export const Phase2ManifestSchema = z.object({
  schema_version: z.literal('2.0.0'),
  run_id: z.string().min(1),
  phase1_run_id: z.string().min(1),
  created_at: z.string(),
  timing_ms: z.number().nonnegative(),
  query: z.string().min(1),
  dossier: ResearchDossierSchema,
  sparc: Phase2SPARCOutputSchema,
  adrs: z.array(Phase2ADRRecordSchema),
  domainModel: Phase2DomainModelSchema,
  tddPlan: TDDPlanSchema,
  artifacts: z.array(z.string()),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type ValidatedPhase1Manifest = z.infer<typeof Phase1ManifestSchema>;
export type ValidatedScenarioArtifact = z.infer<typeof ScenarioArtifactSchema>;
export type ValidatedRoadmapArtifact = z.infer<typeof RoadmapArtifactSchema>;
export type ValidatedRiskAssessmentArtifact = z.infer<typeof RiskAssessmentArtifactSchema>;
export type ValidatedDossierItem = z.infer<typeof DossierItemSchema>;
export type ValidatedDossierCrossReference = z.infer<typeof DossierCrossReferenceSchema>;
export type ValidatedDossierSummary = z.infer<typeof DossierSummarySchema>;
export type ValidatedResearchDossier = z.infer<typeof ResearchDossierSchema>;
export type ValidatedPhase2Requirement = z.infer<typeof Phase2RequirementSchema>;
export type ValidatedPhase2Constraint = z.infer<typeof Phase2ConstraintSchema>;
export type ValidatedPhase2SuccessCriterion = z.infer<typeof Phase2SuccessCriterionSchema>;
export type ValidatedPhase2Specification = z.infer<typeof Phase2SpecificationSchema>;
export type ValidatedPhase2PseudocodeModule = z.infer<typeof Phase2PseudocodeModuleSchema>;
export type ValidatedPhase2Pseudocode = z.infer<typeof Phase2PseudocodeSchema>;
export type ValidatedPhase2ServiceDefinition = z.infer<typeof Phase2ServiceDefinitionSchema>;
export type ValidatedPhase2Architecture = z.infer<typeof Phase2ArchitectureSchema>;
export type ValidatedPhase2Refinement = z.infer<typeof Phase2RefinementSchema>;
export type ValidatedPhase2Completion = z.infer<typeof Phase2CompletionSchema>;
export type ValidatedPhase2SPARCOutput = z.infer<typeof Phase2SPARCOutputSchema>;
export type ValidatedPhase2ADRAlternative = z.infer<typeof Phase2ADRAlternativeSchema>;
export type ValidatedPhase2ADRConsequence = z.infer<typeof Phase2ADRConsequenceSchema>;
export type ValidatedPhase2ADRRecord = z.infer<typeof Phase2ADRRecordSchema>;
export type ValidatedPhase2Entity = z.infer<typeof Phase2EntitySchema>;
export type ValidatedPhase2ValueObject = z.infer<typeof Phase2ValueObjectSchema>;
export type ValidatedPhase2AggregateDefinition = z.infer<typeof Phase2AggregateDefinitionSchema>;
export type ValidatedPhase2DomainEvent = z.infer<typeof Phase2DomainEventSchema>;
export type ValidatedPhase2Command = z.infer<typeof Phase2CommandSchema>;
export type ValidatedPhase2Query = z.infer<typeof Phase2QuerySchema>;
export type ValidatedUbiquitousLanguageTerm = z.infer<typeof UbiquitousLanguageTermSchema>;
export type ValidatedPhase2DDDBoundedContext = z.infer<typeof Phase2DDDBoundedContextSchema>;
export type ValidatedPhase2ContextRelation = z.infer<typeof Phase2ContextRelationSchema>;
export type ValidatedPhase2DomainModel = z.infer<typeof Phase2DomainModelSchema>;
export type ValidatedTestPyramidLevel = z.infer<typeof TestPyramidLevelSchema>;
export type ValidatedTestPyramid = z.infer<typeof TestPyramidSchema>;
export type ValidatedTDDTestCase = z.infer<typeof TDDTestCaseSchema>;
export type ValidatedTDDTestSuite = z.infer<typeof TDDTestSuiteSchema>;
export type ValidatedMockContractMethod = z.infer<typeof MockContractMethodSchema>;
export type ValidatedMockContract = z.infer<typeof MockContractSchema>;
export type ValidatedSeamDefinition = z.infer<typeof SeamDefinitionSchema>;
export type ValidatedTDDPlan = z.infer<typeof TDDPlanSchema>;
export type ValidatedPhase2Manifest = z.infer<typeof Phase2ManifestSchema>;
