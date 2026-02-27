/**
 * Research Dossier Stage — Unit Tests
 *
 * Tests the pure `buildResearchDossier` function and the async
 * `generateResearchDossier` pipeline entry point from
 * src/pipeline/phase2/phases/research-dossier.ts.
 *
 * Uses fixture data from tests/fixtures/phase2/run-fixture-001/ to build
 * realistic Phase1Artifacts input.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  Phase1Artifacts,
  Phase1Manifest,
  ScenarioArtifact,
  RoadmapArtifact,
  RiskAssessmentArtifact,
  Phase2Context,
  Phase2StageOutput,
  DossierItemSource,
  DossierItemCategory,
  ResearchDossier,
} from '../../../../src/pipeline/phase2/types.js';

import {
  buildResearchDossier,
  generateResearchDossier,
} from '../../../../src/pipeline/phase2/phases/research-dossier.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../tests/fixtures/phase2/run-fixture-001',
);

function loadFixtureJson<T>(filename: string): T {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8');
  return JSON.parse(raw) as T;
}

function loadFixtureText(filename: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8');
}

function buildPhase1Artifacts(): Phase1Artifacts {
  return {
    manifest: loadFixtureJson<Phase1Manifest>('manifest.json'),
    scenario: loadFixtureJson<ScenarioArtifact>('scenario.json'),
    roadmap: loadFixtureJson<RoadmapArtifact>('roadmap.json'),
    riskAssessment: loadFixtureJson<RiskAssessmentArtifact>('risk-assessment.json'),
    executiveSummary: loadFixtureText('executive-summary.md'),
    decisionMemo: loadFixtureText('decision-memo.md'),
  };
}

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTempPhase2Dir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-dossier-test-'));
  return tmpDir;
}

function cleanupTempDir(): void {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function buildPhase2Context(overrides?: Partial<Phase2Context>): Phase2Context {
  const artifacts = buildPhase1Artifacts();
  const phase2Dir = makeTempPhase2Dir();

  const artifactLoadingOutput: Phase2StageOutput = {
    stage: 'artifact-loading',
    status: 'completed',
    data: artifacts,
    artifacts: [
      path.join(FIXTURE_DIR, 'manifest.json'),
      path.join(FIXTURE_DIR, 'scenario.json'),
      path.join(FIXTURE_DIR, 'roadmap.json'),
      path.join(FIXTURE_DIR, 'risk-assessment.json'),
      path.join(FIXTURE_DIR, 'executive-summary.md'),
      path.join(FIXTURE_DIR, 'decision-memo.md'),
    ],
    timing: 12,
    summary: 'Loaded 6 artifacts from phase 1',
  };

  const stageOutputs = new Map();
  stageOutputs.set('artifact-loading', artifactLoadingOutput);

  return {
    traceId: 'test-trace-001',
    phase1Dir: FIXTURE_DIR,
    phase2Dir,
    phase1Artifacts: artifacts,
    stageOutputs,
    telemetrySpans: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants for assertions
// ---------------------------------------------------------------------------

const VALID_SOURCES: DossierItemSource[] = [
  'scenario',
  'roadmap',
  'risk-assessment',
  'executive-summary',
  'decision-memo',
];

const VALID_CATEGORIES: DossierItemCategory[] = [
  'requirement',
  'constraint',
  'stakeholder',
  'success-criterion',
  'timeline',
  'risk',
  'recommendation',
  'decision-rationale',
];

const ID_PATTERN = /^RD-\d{3}$/;

// ============================================================================
// Tests
// ============================================================================

describe('buildResearchDossier (pure function)', () => {
  let artifacts: Phase1Artifacts;
  let dossier: ResearchDossier;

  beforeAll(() => {
    artifacts = buildPhase1Artifacts();
    dossier = buildResearchDossier(artifacts, 'test-trace-001');
  });

  // ---------- 1. Items from all 5 sources ----------

  it('generates dossier items from all 5 sources', () => {
    const sourcesPresent = new Set(dossier.items.map((item) => item.source));

    for (const source of VALID_SOURCES) {
      expect(sourcesPresent).toContain(source);
    }
    expect(sourcesPresent.size).toBe(5);
  });

  it('extracts a non-trivial number of items', () => {
    // The fixture data has stakeholders, constraints, success criteria,
    // roadmap deliverables, risk factors, recommendations, executive-summary
    // sections, and decision-memo sections.  We expect at least 30 items.
    expect(dossier.items.length).toBeGreaterThanOrEqual(30);
  });

  // ---------- 2. Valid ID format ----------

  it('assigns IDs in RD-NNN format (zero-padded, 3 digits)', () => {
    for (const item of dossier.items) {
      expect(item.id).toMatch(ID_PATTERN);
    }
  });

  it('assigns sequential IDs starting at RD-001', () => {
    expect(dossier.items[0]!.id).toBe('RD-001');

    for (let i = 0; i < dossier.items.length; i++) {
      const expected = `RD-${String(i + 1).padStart(3, '0')}`;
      expect(dossier.items[i]!.id).toBe(expected);
    }
  });

  // ---------- 3. Valid source and category values ----------

  it('every item has a valid source value', () => {
    for (const item of dossier.items) {
      expect(VALID_SOURCES).toContain(item.source);
    }
  });

  it('every item has a valid category value', () => {
    for (const item of dossier.items) {
      expect(VALID_CATEGORIES).toContain(item.category);
    }
  });

  it('every item has a non-empty title and content', () => {
    for (const item of dossier.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.content.length).toBeGreaterThan(0);
    }
  });

  // ---------- 4. Cross-references ----------

  it('generates cross-references between related items', () => {
    expect(dossier.crossReferences.length).toBeGreaterThan(0);
  });

  it('cross-references use valid item IDs', () => {
    const validIds = new Set(dossier.items.map((item) => item.id));

    for (const ref of dossier.crossReferences) {
      expect(validIds).toContain(ref.fromId);
      expect(validIds).toContain(ref.toId);
    }
  });

  it('cross-references have valid relationship types', () => {
    const validRelationships = ['mitigates', 'depends-on', 'constrains', 'supports', 'conflicts-with'];

    for (const ref of dossier.crossReferences) {
      expect(validRelationships).toContain(ref.relationship);
    }
  });

  it('cross-references do not self-reference', () => {
    for (const ref of dossier.crossReferences) {
      expect(ref.fromId).not.toBe(ref.toId);
    }
  });

  it('cross-references are sorted by fromId then toId', () => {
    for (let i = 1; i < dossier.crossReferences.length; i++) {
      const prev = dossier.crossReferences[i - 1]!;
      const curr = dossier.crossReferences[i]!;
      const cmp = prev.fromId.localeCompare(curr.fromId);
      if (cmp === 0) {
        expect(prev.toId.localeCompare(curr.toId)).toBeLessThanOrEqual(0);
      } else {
        expect(cmp).toBeLessThan(0);
      }
    }
  });

  // ---------- 5. Determinism ----------

  it('produces identical output on repeated invocations', () => {
    const dossier1 = buildResearchDossier(artifacts, 'test-trace-001');
    const dossier2 = buildResearchDossier(artifacts, 'test-trace-001');

    expect(dossier1.items).toEqual(dossier2.items);
    expect(dossier1.crossReferences).toEqual(dossier2.crossReferences);
    expect(dossier1.summary).toEqual(dossier2.summary);
    expect(dossier1.id).toBe(dossier2.id);
    expect(dossier1.generatedFrom).toBe(dossier2.generatedFrom);
  });

  it('IDs are sequential and deterministic across runs', () => {
    const run1 = buildResearchDossier(artifacts, 'run-a');
    const run2 = buildResearchDossier(artifacts, 'run-b');

    // Same artifacts produce same item count and same ID assignments
    expect(run1.items.length).toBe(run2.items.length);
    for (let i = 0; i < run1.items.length; i++) {
      expect(run1.items[i]!.id).toBe(run2.items[i]!.id);
      expect(run1.items[i]!.source).toBe(run2.items[i]!.source);
      expect(run1.items[i]!.category).toBe(run2.items[i]!.category);
    }
  });

  // ---------- 6. Summary ----------

  it('summary includes correct total item count', () => {
    expect(dossier.summary.totalItems).toBe(dossier.items.length);
  });

  it('summary bySource counts match actual items', () => {
    const actualBySource: Record<string, number> = {};
    for (const item of dossier.items) {
      actualBySource[item.source] = (actualBySource[item.source] ?? 0) + 1;
    }

    expect(dossier.summary.bySource).toEqual(actualBySource);
  });

  it('summary byCategory counts match actual items', () => {
    const actualByCategory: Record<string, number> = {};
    for (const item of dossier.items) {
      actualByCategory[item.category] = (actualByCategory[item.category] ?? 0) + 1;
    }

    expect(dossier.summary.byCategory).toEqual(actualByCategory);
  });

  it('summary source counts sum to totalItems', () => {
    const sourceSum = Object.values(dossier.summary.bySource).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sourceSum).toBe(dossier.summary.totalItems);
  });

  it('summary category counts sum to totalItems', () => {
    const categorySum = Object.values(dossier.summary.byCategory).reduce(
      (a, b) => a + b,
      0,
    );
    expect(categorySum).toBe(dossier.summary.totalItems);
  });

  it('summary keyRisks contains only IDs of high-severity risk items', () => {
    const highRiskIds = dossier.items
      .filter((i) => i.category === 'risk' && i.severity === 'high')
      .map((i) => i.id)
      .sort();

    expect(dossier.summary.keyRisks).toEqual(highRiskIds);
  });

  it('summary criticalConstraints contains at most 5 constraint item IDs', () => {
    expect(dossier.summary.criticalConstraints.length).toBeLessThanOrEqual(5);

    const constraintIds = dossier.items
      .filter((i) => i.category === 'constraint')
      .map((i) => i.id)
      .sort()
      .slice(0, 5);

    expect(dossier.summary.criticalConstraints).toEqual(constraintIds);
  });

  // ---------- 7. Dossier metadata ----------

  it('sets dossier id using traceId', () => {
    expect(dossier.id).toBe('dossier-test-trace-001');
  });

  it('sets traceId on the dossier', () => {
    expect(dossier.traceId).toBe('test-trace-001');
  });

  it('sets generatedFrom to the manifest run_id', () => {
    expect(dossier.generatedFrom).toBe('run-fixture-001');
  });

  // ---------- 8. Source ordering ----------

  it('processes sources in fixed order: scenario, roadmap, risk-assessment, executive-summary, decision-memo', () => {
    const sourceOrder: DossierItemSource[] = [
      'scenario',
      'roadmap',
      'risk-assessment',
      'executive-summary',
      'decision-memo',
    ];

    // Track the first occurrence index of each source
    const firstIndex = new Map<string, number>();
    for (let i = 0; i < dossier.items.length; i++) {
      const src = dossier.items[i]!.source;
      if (!firstIndex.has(src)) {
        firstIndex.set(src, i);
      }
    }

    // Verify ordering: each source's first occurrence is after the
    // previous source's first occurrence
    for (let i = 1; i < sourceOrder.length; i++) {
      const prevIdx = firstIndex.get(sourceOrder[i - 1]!)!;
      const currIdx = firstIndex.get(sourceOrder[i]!)!;
      expect(currIdx).toBeGreaterThan(prevIdx);
    }
  });

  // ---------- 9. Specific extraction checks ----------

  it('extracts stakeholders from scenario', () => {
    const stakeholderItems = dossier.items.filter(
      (i) => i.source === 'scenario' && i.category === 'stakeholder',
    );
    expect(stakeholderItems.length).toBe(5);
    const titles = stakeholderItems.map((i) => i.title);
    expect(titles).toContain('Chief Sustainability Officer');
    expect(titles).toContain('VP Supply Chain Operations');
  });

  it('extracts constraints from scenario', () => {
    const constraintItems = dossier.items.filter(
      (i) => i.source === 'scenario' && i.category === 'constraint',
    );
    expect(constraintItems.length).toBe(7);
  });

  it('extracts success criteria from scenario', () => {
    const criteriaItems = dossier.items.filter(
      (i) => i.source === 'scenario' && i.category === 'success-criterion',
    );
    expect(criteriaItems.length).toBe(6);
  });

  it('extracts scenario_type as a requirement', () => {
    const requirementItems = dossier.items.filter(
      (i) => i.source === 'scenario' && i.category === 'requirement',
    );
    expect(requirementItems.length).toBe(1);
    expect(requirementItems[0]!.title).toBe('Domain: enterprise-sustainability');
  });

  it('extracts roadmap deliverables as timeline items with phase metadata', () => {
    const timelineItems = dossier.items.filter(
      (i) => i.source === 'roadmap' && i.category === 'timeline',
    );
    // 4 phases with 5, 6, 5, 5 deliverables = 21 total
    expect(timelineItems.length).toBe(21);

    // Verify phase metadata is set
    for (const item of timelineItems) {
      expect(item.phase).toBeDefined();
      expect(item.phase!.length).toBeGreaterThan(0);
    }
  });

  it('extracts risk factors with severity metadata', () => {
    const riskItems = dossier.items.filter(
      (i) => i.source === 'risk-assessment' && i.category === 'risk',
    );
    expect(riskItems.length).toBe(7);

    // Verify severity is set on all risk items
    for (const item of riskItems) {
      expect(item.severity).toBeDefined();
      expect(['high', 'medium', 'low']).toContain(item.severity);
    }
  });

  it('extracts recommendations from risk-assessment', () => {
    const recItems = dossier.items.filter(
      (i) => i.source === 'risk-assessment' && i.category === 'recommendation',
    );
    expect(recItems.length).toBe(4);
  });

  it('extracts items from executive-summary markdown', () => {
    const execItems = dossier.items.filter(
      (i) => i.source === 'executive-summary',
    );
    // Key Findings (5) + Risk Factors (4) + Recommendation (1 non-list -> 0 list items, but the section has a paragraph)
    // + Next Steps (5). Actual count depends on extraction.
    expect(execItems.length).toBeGreaterThan(0);
    expect(execItems.every((i) => i.category === 'recommendation')).toBe(true);
  });

  it('extracts items from decision-memo markdown', () => {
    const decisionItems = dossier.items.filter(
      (i) => i.source === 'decision-memo',
    );
    expect(decisionItems.length).toBeGreaterThan(0);

    // Should include decision-rationale and constraint categories
    const categories = new Set(decisionItems.map((i) => i.category));
    expect(categories).toContain('decision-rationale');
    expect(categories).toContain('constraint');
  });
});

describe('buildResearchDossier — edge cases', () => {
  it('handles empty scenario arrays gracefully', () => {
    const artifacts = buildPhase1Artifacts();
    const minimal: Phase1Artifacts = {
      ...artifacts,
      scenario: {
        query: 'test query',
        stakeholders: [],
        constraints: [],
        success_criteria: [],
      },
    };

    const dossier = buildResearchDossier(minimal, 'edge-001');
    // scenario_type is undefined so no requirement item either
    const scenarioItems = dossier.items.filter((i) => i.source === 'scenario');
    expect(scenarioItems.length).toBe(0);
    // Dossier should still have items from other sources
    expect(dossier.items.length).toBeGreaterThan(0);
  });

  it('handles empty roadmap phases', () => {
    const artifacts = buildPhase1Artifacts();
    const minimal: Phase1Artifacts = {
      ...artifacts,
      roadmap: { phases: [] },
    };

    const dossier = buildResearchDossier(minimal, 'edge-002');
    const roadmapItems = dossier.items.filter((i) => i.source === 'roadmap');
    expect(roadmapItems.length).toBe(0);
  });

  it('handles empty executive summary', () => {
    const artifacts = buildPhase1Artifacts();
    const minimal: Phase1Artifacts = {
      ...artifacts,
      executiveSummary: '',
    };

    const dossier = buildResearchDossier(minimal, 'edge-003');
    const execItems = dossier.items.filter(
      (i) => i.source === 'executive-summary',
    );
    expect(execItems.length).toBe(0);
  });

  it('handles empty decision memo', () => {
    const artifacts = buildPhase1Artifacts();
    const minimal: Phase1Artifacts = {
      ...artifacts,
      decisionMemo: '',
    };

    const dossier = buildResearchDossier(minimal, 'edge-004');
    const decisionItems = dossier.items.filter(
      (i) => i.source === 'decision-memo',
    );
    expect(decisionItems.length).toBe(0);
  });

  it('handles risk assessment with no risk_factors and no recommendations', () => {
    const artifacts = buildPhase1Artifacts();
    const minimal: Phase1Artifacts = {
      ...artifacts,
      riskAssessment: {
        overall_risk_level: 'low',
        risk_factors: [],
      },
    };

    const dossier = buildResearchDossier(minimal, 'edge-005');
    const riskItems = dossier.items.filter(
      (i) => i.source === 'risk-assessment',
    );
    expect(riskItems.length).toBe(0);
  });
});

describe('generateResearchDossier (async stage entry)', () => {
  afterEach(() => {
    cleanupTempDir();
  });

  it('returns status completed with artifacts list', async () => {
    const context = buildPhase2Context();
    const result = await generateResearchDossier(context);

    expect(result.stage).toBe('research-dossier');
    expect(result.status).toBe('completed');
    expect(result.artifacts.length).toBe(1);
    expect(result.timing).toBeGreaterThanOrEqual(0);
  });

  it('writes research-dossier.json to phase2Dir', async () => {
    const context = buildPhase2Context();
    await generateResearchDossier(context);

    const outputPath = path.join(context.phase2Dir, 'research-dossier.json');
    expect(fs.existsSync(outputPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as ResearchDossier;
    expect(written.items.length).toBeGreaterThan(0);
    expect(written.id).toBe('dossier-test-trace-001');
  });

  it('artifact path in result points to the written file', async () => {
    const context = buildPhase2Context();
    const result = await generateResearchDossier(context);

    const expectedPath = path.join(context.phase2Dir, 'research-dossier.json');
    expect(result.artifacts[0]).toBe(expectedPath);
    expect(fs.existsSync(result.artifacts[0]!)).toBe(true);
  });

  it('stores output on context.stageOutputs', async () => {
    const context = buildPhase2Context();
    await generateResearchDossier(context);

    expect(context.stageOutputs.has('research-dossier')).toBe(true);
    const stored = context.stageOutputs.get('research-dossier')!;
    expect(stored.status).toBe('completed');
    expect(stored.stage).toBe('research-dossier');
  });

  it('populates telemetrySpans on context', async () => {
    const context = buildPhase2Context();
    await generateResearchDossier(context);

    expect(context.telemetrySpans.length).toBeGreaterThan(0);
  });

  it('result summary includes item and cross-reference counts', async () => {
    const context = buildPhase2Context();
    const result = await generateResearchDossier(context);

    expect(result.summary).toContain('items');
    expect(result.summary).toContain('cross-references');
    expect(result.summary).toContain('sources');
  });

  it('result data contains the full dossier object', async () => {
    const context = buildPhase2Context();
    const result = await generateResearchDossier(context);

    const data = result.data as ResearchDossier;
    expect(data.items).toBeDefined();
    expect(data.crossReferences).toBeDefined();
    expect(data.summary).toBeDefined();
    expect(data.traceId).toBe('test-trace-001');
  });

  it('written JSON is valid and parseable', async () => {
    const context = buildPhase2Context();
    await generateResearchDossier(context);

    const outputPath = path.join(context.phase2Dir, 'research-dossier.json');
    const raw = fs.readFileSync(outputPath, 'utf-8');

    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(raw);
    }).not.toThrow();
    expect(parsed).toBeDefined();
  });

  it('returns status failed when phase2Dir does not exist', async () => {
    const context = buildPhase2Context({
      phase2Dir: path.join(os.tmpdir(), 'nonexistent-dir-' + Date.now(), 'sub'),
    });

    const result = await generateResearchDossier(context);
    expect(result.status).toBe('failed');
    expect(result.artifacts).toEqual([]);
    expect(result.summary).toContain('failed');
  });
});
