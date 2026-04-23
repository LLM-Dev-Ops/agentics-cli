/**
 * Phase 3 SPARC Coordinator — Ruflo-output refiner tests (ADR-PIPELINE-091).
 *
 * These tests cover the refiner paths introduced when the Phase 3 coordinator
 * was rewritten as a Ruflo-output refiner rather than a primary generator.
 * The refactor split the SPARC stage into three branches:
 *
 *   (a) `refineSPARCFromRufloEngineering` — primary path, refines
 *       `runDir/engineering/sparc-specification.md` into
 *       `runDir/phase3/sparc/specification.md` with normalized sections.
 *       Tagged `executionTier: 'ruflo-local'`.
 *
 *   (b) `carryForwardPhase2SPARC` — Phase 2 carry-forward fallback when the
 *       engineering artifact is absent / too small. Also `ruflo-local`.
 *
 *   (c) `generateSPARCSpecification` — template last-resort invoked only when
 *       both engineering/ and Phase 2 SPARC are absent AND
 *       `checkRufloAvailable()` reports unavailable. Tagged
 *       `executionTier: 'template'`.
 *
 * We drive the coordinator via its public entry point `executePhase3SPARCPipeline`
 * using a temp-dir run-dir. `checkRufloAvailable()` is forced to the unavailable
 * branch by setting `AGENTICS_DISABLE_RUFLO=true`, which mirrors the
 * `reason: 'disabled-by-env'` branch on `ruflo-phase-executor.ts:294`.
 *
 * Note: the `executionTier` field is attached via a cast-through-unknown on
 * `tagStageOutput(...)` so it is not part of the Phase2StageOutput type
 * surface. Tests read it as `(output as unknown as { executionTier?: string })`
 * — the pattern documented on the first assertion below.
 */

import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase3SPARCPipeline } from '../../../../src/pipeline/phase3-sparc/phase3-sparc-coordinator.js';
import type {
  Phase3SPARCContext,
  Phase3SPARCPipelineResult,
} from '../../../../src/pipeline/phase3-sparc/types.js';
import type {
  Phase2StageOutput,
  ResearchDossier,
  TelemetrySpan,
} from '../../../../src/pipeline/phase2/types.js';

jest.setTimeout(60000);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface TempRun {
  readonly runDir: string;
  readonly phase2Dir: string;
  readonly phase3Dir: string;
}

function mkTempRun(): TempRun {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-sparc-refiner-'));
  const phase2Dir = path.join(runDir, 'phase2');
  const phase3Dir = path.join(runDir, 'phase3');
  fs.mkdirSync(phase2Dir, { recursive: true });
  fs.mkdirSync(phase3Dir, { recursive: true });
  return { runDir, phase2Dir, phase3Dir };
}

function rmTree(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Minimum research-dossier.json required for the coordinator's
 * `phase2-loading` stage to succeed. When the template last-resort path is
 * exercised, the underlying `generateSPARCSpecification` also reads from
 * `context.stageOutputs.get('research-dossier')` which is pre-populated from
 * this file by the coordinator.
 */
function writeMinimalResearchDossier(phase2Dir: string): void {
  const dossier: ResearchDossier = {
    id: 'RD-TEST',
    traceId: 'test-trace-091-refiner',
    generatedFrom: 'phase3-sparc-refiner.test.ts',
    items: [
      {
        id: 'RD-001',
        source: 'scenario',
        category: 'requirement',
        title: 'Minimal requirement',
        content: 'System must build artifacts.',
      },
    ],
    crossReferences: [],
    summary: {
      totalItems: 1,
      bySource: { scenario: 1 },
      byCategory: { requirement: 1 },
      keyRisks: [],
      criticalConstraints: [],
    },
  };
  fs.writeFileSync(
    path.join(phase2Dir, 'research-dossier.json'),
    JSON.stringify(dossier, null, 2),
    { encoding: 'utf-8' },
  );
}

/**
 * Write a minimal Phase 1 manifest.json + scenario.json at the run-dir root
 * so the coordinator's `loadPhase1ArtifactsFromDisk` succeeds. Missing files
 * are tolerated but the template fallback path queries
 * `phase1Artifacts.scenario.query` so we always write these.
 */
function writeMinimalPhase1(runDir: string): void {
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({ query: 'Test scenario for Phase 3 SPARC refiner.' }, null, 2),
    { encoding: 'utf-8' },
  );
  fs.writeFileSync(
    path.join(runDir, 'scenario.json'),
    JSON.stringify({ query: 'Test scenario for Phase 3 SPARC refiner.' }, null, 2),
    { encoding: 'utf-8' },
  );
}

/** Write Ruflo's engineering output directory. */
function writeEngineering(runDir: string, filename: string, content: string): void {
  const engDir = path.join(runDir, 'engineering');
  fs.mkdirSync(engDir, { recursive: true });
  fs.writeFileSync(path.join(engDir, filename), content, { encoding: 'utf-8' });
}

function buildContext(run: TempRun): Phase3SPARCContext {
  return {
    traceId: 'test-trace-091-refiner',
    phase2Dir: run.phase2Dir,
    phase3Dir: run.phase3Dir,
    scenarioQuery: 'Test scenario for Phase 3 SPARC refiner.',
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };
}

/** Reader for the non-typed `executionTier` tag attached by `tagStageOutput`. */
function executionTier(stage: Phase2StageOutput | undefined): string | undefined {
  if (!stage) return undefined;
  return (stage as unknown as { executionTier?: string }).executionTier;
}

function findStage(
  result: Phase3SPARCPipelineResult,
  stageName: string,
): Phase2StageOutput | undefined {
  return result.stageResults.find((s) => s.stage === stageName);
}

// ---------------------------------------------------------------------------
// Shared canonical SPARC markdown used in the happy-path test.
// All 5 section headers present, each body > 0 bytes, overall > 256 bytes.
// ---------------------------------------------------------------------------

const CANONICAL_SPARC_MD = `# Specification

The system shall ingest telemetry from fleet vehicles, persist it in a
time-series database, and surface dashboards to operators. Requirements
include: throughput of 10k events/sec, 99.9% uptime, and GDPR-aligned data
handling. Stakeholders include fleet operators, sustainability analysts,
and compliance officers.

# Pseudocode

function ingest(event):
    validate(event)
    enrich(event)
    store(event)
    emit(event)

# Architecture

Services: IngestorSvc, EnrichmentSvc, StorageSvc, DashboardSvc.
Data flow: Ingestor -> Kafka -> Enrichment -> ClickHouse -> Dashboard.
Deploy each service as a container on k8s with horizontal scaling.

# Refinement

Security: mTLS between services, OIDC at the edge. Performance: p99 <100ms
at 10k events/sec sustained. Test strategy: unit tests for each service,
contract tests at seams, chaos tests for resilience.

# Completion

Integration plan: rolling deploy with canary. Documentation: runbooks,
architecture diagrams, and API reference. Monitoring: Prometheus metrics,
Grafana dashboards, and PagerDuty alerts on SLO burn.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 3 SPARC Coordinator — Ruflo refiner paths (ADR-091)', () => {
  const originalDisable = process.env['AGENTICS_DISABLE_RUFLO'];
  let run: TempRun;

  beforeEach(() => {
    run = mkTempRun();
    writeMinimalPhase1(run.runDir);
    writeMinimalResearchDossier(run.phase2Dir);
  });

  afterEach(() => {
    rmTree(run.runDir);
    if (originalDisable === undefined) delete process.env['AGENTICS_DISABLE_RUFLO'];
    else process.env['AGENTICS_DISABLE_RUFLO'] = originalDisable;
  });

  // -------------------------------------------------------------------------
  // Case 1: Happy path — Ruflo engineering/sparc-specification.md refined
  // -------------------------------------------------------------------------

  describe('Case 1: happy path — engineering/sparc-specification.md present with canonical headers', () => {
    it('refines into phase3/sparc/specification.md tagged ruflo-local', async () => {
      writeEngineering(run.runDir, 'sparc-specification.md', CANONICAL_SPARC_MD);
      // Sanity: input exceeds the usable-size threshold.
      expect(Buffer.byteLength(CANONICAL_SPARC_MD, 'utf-8')).toBeGreaterThan(256);

      const ctx = buildContext(run);
      const result = await executePhase3SPARCPipeline(ctx);

      const sparcStage = findStage(result, 'sparc-specification');
      // The `executionTier` field is attached via cast-through-unknown on
      // `tagStageOutput(...)` in the coordinator. Read it the same way —
      // it's not part of the Phase2StageOutput type surface.
      expect(sparcStage).toBeDefined();
      expect(sparcStage).toMatchObject({
        stage: 'sparc-specification',
        status: 'completed',
      });
      expect(executionTier(sparcStage)).toBe('ruflo-local');

      const specMdPath = path.join(run.phase3Dir, 'sparc', 'specification.md');
      expect(fs.existsSync(specMdPath)).toBe(true);

      const refined = fs.readFileSync(specMdPath, 'utf-8');
      // All 5 canonical sections preserved as anchor + ## header pairs.
      for (const section of ['Specification', 'Pseudocode', 'Architecture', 'Refinement', 'Completion']) {
        expect(refined).toContain(`<a id="${section.toLowerCase()}"></a>`);
        expect(refined).toContain(`## ${section}`);
      }

      // Verbatim Ruflo prose is preserved inside the refined output.
      expect(refined).toContain('IngestorSvc, EnrichmentSvc, StorageSvc, DashboardSvc');
      expect(refined).toContain('mTLS between services');
      expect(refined).toContain('rolling deploy with canary');

      // JSON shim is also written alongside the markdown.
      const combinedPath = path.join(run.phase3Dir, 'sparc', 'sparc-combined.json');
      expect(fs.existsSync(combinedPath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Engineering content below the usability threshold
  // -------------------------------------------------------------------------

  describe('Case 2: engineering/sparc-specification.md <= 256 bytes', () => {
    it('falls through to template last-resort when Ruflo also unavailable', async () => {
      // File exists but is below the MIN_ENGINEERING_BYTES threshold (256).
      writeEngineering(run.runDir, 'sparc-specification.md', '# Spec\n\ntoo small.\n');
      // Force Ruflo unavailable so carryForwardPhase2SPARC hits the template
      // last-resort branch (no engineering -> no phase2 SPARC -> no Ruflo ->
      // `generateSPARCSpecification`).
      process.env['AGENTICS_DISABLE_RUFLO'] = 'true';

      const ctx = buildContext(run);
      const result = await executePhase3SPARCPipeline(ctx);

      const sparcStage = findStage(result, 'sparc-specification');
      expect(sparcStage).toBeDefined();
      // Template path fires; status depends on the underlying template generator
      // but the executionTier tag MUST be 'template' per ADR-091 §5.
      expect(executionTier(sparcStage)).toBe('template');
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: No engineering content, Ruflo unavailable -> template
  // -------------------------------------------------------------------------

  describe('Case 3: no engineering/sparc-specification.md, no Phase 2 SPARC, Ruflo unavailable', () => {
    it('fires the template last-resort path tagged executionTier=template', async () => {
      // No engineering/, no phase2/sparc/.
      process.env['AGENTICS_DISABLE_RUFLO'] = 'true';

      const ctx = buildContext(run);
      const result = await executePhase3SPARCPipeline(ctx);

      const sparcStage = findStage(result, 'sparc-specification');
      expect(sparcStage).toBeDefined();
      expect(executionTier(sparcStage)).toBe('template');
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Non-canonical section names
  // -------------------------------------------------------------------------

  describe('Case 4: markdown has non-canonical section headers', () => {
    it('does not crash and still produces a specification.md', async () => {
      // `# Spec` and `# Pseudo` are NOT canonical SPARC section names; the
      // splitter's canonical-name filter skips them. Coordinator should fall
      // back to preserving the full document as the Specification section
      // (splitSparcMarkdownIntoSections: "if no canonical headers found,
      // treat the whole document as the Specification section").
      const md = [
        '# Spec',
        '',
        'This project aims to ingest telemetry from fleet vehicles at scale, enrich it with',
        'metadata, persist it in a time-series store, and expose dashboards to operators.',
        'Requirements include high-throughput ingest, low-latency query, and compliance',
        'with regulatory data-handling frameworks such as GDPR and CCPA. Stakeholders',
        'include fleet operators, sustainability analysts, and compliance officers who',
        'depend on timely, accurate, and trustworthy telemetry to make decisions.',
        '',
        '# Pseudo',
        '',
        'ingest -> enrich -> store -> emit.',
        '',
      ].join('\n');
      // Sanity — content must exceed 256 bytes to clear the usability threshold.
      expect(Buffer.byteLength(md, 'utf-8')).toBeGreaterThan(256);
      writeEngineering(run.runDir, 'sparc-specification.md', md);

      const ctx = buildContext(run);
      // Must not throw.
      const result = await executePhase3SPARCPipeline(ctx);

      const sparcStage = findStage(result, 'sparc-specification');
      expect(sparcStage).toBeDefined();
      expect(sparcStage).toMatchObject({ stage: 'sparc-specification' });
      // The refiner ran and tagged ruflo-local; refinement never throws on
      // unrecognized section names — the whole document is preserved as the
      // Specification section.
      expect(executionTier(sparcStage)).toBe('ruflo-local');

      const specMdPath = path.join(run.phase3Dir, 'sparc', 'specification.md');
      expect(fs.existsSync(specMdPath)).toBe(true);

      const refined = fs.readFileSync(specMdPath, 'utf-8');
      // Source prose is preserved verbatim somewhere in the refined doc —
      // this asserts the "content not dropped" contract without demanding a
      // specific canonical-name-mismatch tag (the implementation records
      // unrecognized content under the Specification section rather than
      // adding an explicit mismatch marker).
      expect(refined).toContain('fleet vehicles at scale');
    });
  });
});
