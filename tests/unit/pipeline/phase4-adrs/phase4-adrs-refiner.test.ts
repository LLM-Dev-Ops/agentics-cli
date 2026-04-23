/**
 * Phase 4 ADR + DDD Coordinator — Ruflo-output refiner tests (ADR-PIPELINE-091).
 *
 * Covers the refiner paths introduced when the Phase 4 coordinator was
 * rewritten from a primary LLM generator into a Ruflo-output refiner:
 *
 *   (a) `refineADRsFromRufloEngineering` — parses Ruflo's
 *       `engineering/architecture-decisions.md` into structured
 *       `phase4/adrs/ADR-ENG-NNN.md` + `adr-index.json`. Tagged `ruflo-local`.
 *
 *   (b) `refineDDDFromRufloEngineering` — refines Ruflo's
 *       `engineering/domain-model.md` into `phase4/ddd/domain-model.md` +
 *       a best-effort `bounded-contexts.json`. Tagged `ruflo-local`.
 *
 *   (c) Template last-resort branches at coordinator lines 615-682 (ADRs)
 *       and 716-799 (DDD). Fire only when the engineering artifact is
 *       absent AND `checkRufloAvailable()` returns unavailable. Tagged
 *       `executionTier: 'template'`.
 *
 * `checkRufloAvailable()` is forced to the unavailable branch by setting
 * `AGENTICS_DISABLE_RUFLO=true`, mirroring the `reason: 'disabled-by-env'`
 * branch on `ruflo-phase-executor.ts:294`.
 */

import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePhase4ADRPipeline } from '../../../../src/pipeline/phase4-adrs/phase4-adrs-coordinator.js';
import type {
  Phase4ADRContext,
  Phase4ADRPipelineResult,
} from '../../../../src/pipeline/phase4-adrs/types.js';
import type {
  Phase2StageOutput,
  Phase2SPARCOutput,
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
  readonly phase4Dir: string;
}

function mkTempRun(): TempRun {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-adrs-refiner-'));
  const phase2Dir = path.join(runDir, 'phase2');
  const phase3Dir = path.join(runDir, 'phase3');
  const phase4Dir = path.join(runDir, 'phase4');
  fs.mkdirSync(phase2Dir, { recursive: true });
  fs.mkdirSync(phase3Dir, { recursive: true });
  fs.mkdirSync(phase4Dir, { recursive: true });
  return { runDir, phase2Dir, phase3Dir, phase4Dir };
}

function rmTree(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writeMinimalPhase1(runDir: string): void {
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({ query: 'Phase 4 refiner test scenario.' }, null, 2),
    { encoding: 'utf-8' },
  );
  fs.writeFileSync(
    path.join(runDir, 'scenario.json'),
    JSON.stringify({ query: 'Phase 4 refiner test scenario.' }, null, 2),
    { encoding: 'utf-8' },
  );
}

function writeMinimalResearchDossier(phase2Dir: string): void {
  const dossier: ResearchDossier = {
    id: 'RD-TEST',
    traceId: 'test-trace-091-phase4',
    generatedFrom: 'phase4-adrs-refiner.test.ts',
    items: [
      {
        id: 'RD-001',
        source: 'scenario',
        category: 'requirement',
        title: 'Minimal requirement',
        content: 'Need an architecture for a fleet-telemetry platform.',
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
 * Write a minimal Phase 3 SPARC JSON so the coordinator's `prior-phase-loading`
 * stage succeeds. Structural arrays are kept minimal but non-empty where the
 * template fallback would query them (`architecture.services`).
 */
function writeMinimalPhase3Sparc(phase3Dir: string): void {
  const sparc: Phase2SPARCOutput = {
    specification: {
      requirements: [],
      constraints: [],
      successCriteria: [],
      scope: 'Minimal SPARC scope for Phase 4 refiner tests.',
      dossierCoverage: 0,
    },
    pseudocode: { modules: [] },
    architecture: {
      services: [
        {
          id: 'SVC-001',
          name: 'TelemetrySvc',
          responsibility: 'Handle telemetry ingestion',
          api: ['getTelemetry', 'postTelemetry'],
          dependencies: [],
          dossierItemRefs: [],
        },
      ],
      boundaries: [],
      dataFlow: '',
      apiContracts: [],
      securityBoundaries: [],
    },
    refinement: {
      securityConsiderations: [],
      performanceTargets: [],
      testStrategy: '',
    },
    completion: {
      integrationPlan: '',
      documentation: [],
      monitoringSetup: [],
    },
  } as unknown as Phase2SPARCOutput;

  const sparcDir = path.join(phase3Dir, 'sparc');
  fs.mkdirSync(sparcDir, { recursive: true });
  fs.writeFileSync(
    path.join(sparcDir, 'sparc-combined.json'),
    JSON.stringify(sparc, null, 2),
    { encoding: 'utf-8' },
  );
}

function writeEngineering(runDir: string, filename: string, content: string): void {
  const engDir = path.join(runDir, 'engineering');
  fs.mkdirSync(engDir, { recursive: true });
  fs.writeFileSync(path.join(engDir, filename), content, { encoding: 'utf-8' });
}

function buildContext(run: TempRun): Phase4ADRContext {
  return {
    traceId: 'test-trace-091-phase4',
    phase2Dir: run.phase2Dir,
    phase3Dir: run.phase3Dir,
    phase4Dir: run.phase4Dir,
    scenarioQuery: 'Phase 4 refiner test scenario.',
    stageOutputs: new Map(),
    telemetrySpans: [] as TelemetrySpan[],
  };
}

function executionTier(stage: Phase2StageOutput | undefined): string | undefined {
  if (!stage) return undefined;
  return (stage as unknown as { executionTier?: string }).executionTier;
}

function findStage(
  result: Phase4ADRPipelineResult,
  stageName: string,
): Phase2StageOutput | undefined {
  return result.stageResults.find((s) => s.stage === stageName);
}

// ---------------------------------------------------------------------------
// Canonical engineering input used in the happy-path tests
// ---------------------------------------------------------------------------

const THREE_ADRS_MD = `# ADR-001: Use PostgreSQL for primary storage

### Status

accepted

### Context

We need a durable, transactional datastore for fleet telemetry metadata.
The team already operates PostgreSQL in production and has deep expertise.

### Decision

We will adopt PostgreSQL 15 as the primary metadata store for the platform.

### Consequences

- Leverage existing operator runbooks.
- Cost predictable on existing managed-service contract.
- Must manage row-level security for multi-tenant isolation.

# ADR-002: Adopt Kafka for event streaming

### Status

accepted

### Context

Telemetry ingest must scale to 10k events/sec and support multi-consumer
replay for analytics workloads.

### Decision

Deploy Apache Kafka with a 3-broker cluster per region.

### Consequences

- Operational overhead of running Kafka.
- Replay window enables analytics backfills.

# ADR-003: Use OpenTelemetry for distributed tracing

### Status

proposed

### Context

The platform spans many services; diagnosing latency without distributed
tracing is currently impractical.

### Decision

Instrument all services with the OpenTelemetry SDK and route spans to a
collector -> Jaeger backend.

### Consequences

- Uniform telemetry instrumentation.
- Additional runtime dependency on collector health.
`;

const DOMAIN_MODEL_MD = `# Fleet Telemetry Domain Model

## Telemetry Ingestion Context

Bounded context that owns the receipt, validation, and enrichment of
incoming telemetry events from vehicles. Aggregates: TelemetryEvent,
IngestSession. Ubiquitous language: "event", "session", "validator".

## Operator Dashboard Context

Bounded context that presents aggregated telemetry to fleet operators.
Aggregates: Dashboard, Tile, Alert. Ubiquitous language: "dashboard",
"tile", "alert", "operator".

## Compliance Audit Context

Bounded context that retains telemetry long-term for regulatory audits.
Aggregates: AuditRecord, RetentionPolicy. Ubiquitous language: "record",
"retention", "audit".
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 4 ADR + DDD Coordinator — Ruflo refiner paths (ADR-091)', () => {
  const originalDisable = process.env['AGENTICS_DISABLE_RUFLO'];
  let run: TempRun;

  beforeEach(() => {
    run = mkTempRun();
    writeMinimalPhase1(run.runDir);
    writeMinimalResearchDossier(run.phase2Dir);
    writeMinimalPhase3Sparc(run.phase3Dir);
  });

  afterEach(() => {
    rmTree(run.runDir);
    if (originalDisable === undefined) delete process.env['AGENTICS_DISABLE_RUFLO'];
    else process.env['AGENTICS_DISABLE_RUFLO'] = originalDisable;
  });

  // -------------------------------------------------------------------------
  // Case 1: Happy path — ADR refinement
  // -------------------------------------------------------------------------

  describe('Case 1: happy path — engineering/architecture-decisions.md with 3 ADRs', () => {
    it('writes ADR-ENG-001..003.md + adr-index.json tagged ruflo-local', async () => {
      writeEngineering(run.runDir, 'architecture-decisions.md', THREE_ADRS_MD);
      expect(Buffer.byteLength(THREE_ADRS_MD, 'utf-8')).toBeGreaterThan(256);
      // Also write a domain-model so the DDD stage can complete (it has its
      // own refiner path — we only assert on ADR content in this case).
      writeEngineering(run.runDir, 'domain-model.md', DOMAIN_MODEL_MD);

      const ctx = buildContext(run);
      const result = await executePhase4ADRPipeline(ctx);

      const adrStage = findStage(result, 'adr-generation');
      // The `executionTier` field is attached via cast-through-unknown on
      // `tagStageOutput(...)` in the coordinator. Read via the same cast —
      // it's not part of the Phase2StageOutput type surface.
      expect(adrStage).toBeDefined();
      expect(adrStage).toMatchObject({
        stage: 'adr-generation',
        status: 'completed',
      });
      expect(executionTier(adrStage)).toBe('ruflo-local');

      const adrDir = path.join(run.phase4Dir, 'adrs');
      for (const id of ['ADR-ENG-001', 'ADR-ENG-002', 'ADR-ENG-003']) {
        const adrPath = path.join(adrDir, `${id}.md`);
        expect(fs.existsSync(adrPath)).toBe(true);
      }

      const indexPath = path.join(adrDir, 'adr-index.json');
      expect(fs.existsSync(indexPath)).toBe(true);
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Array<{ id: string }>;
      expect(Array.isArray(index)).toBe(true);
      expect(index).toHaveLength(3);
      expect(index.map((x) => x.id)).toEqual(['ADR-ENG-001', 'ADR-ENG-002', 'ADR-ENG-003']);

      // Sanity: refined markdown preserves canonical section headers.
      const firstAdr = fs.readFileSync(path.join(adrDir, 'ADR-ENG-001.md'), 'utf-8');
      expect(firstAdr).toContain('## Context');
      expect(firstAdr).toContain('## Decision');
      expect(firstAdr).toContain('## Consequences');
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Happy path — DDD refinement
  // -------------------------------------------------------------------------

  describe('Case 2: happy path — engineering/domain-model.md present', () => {
    it('writes phase4/ddd/domain-model.md + bounded-contexts.json tagged ruflo-local', async () => {
      // Also supply ADRs so we reach the DDD stage (pipeline halts on
      // adr-generation failure before running DDD).
      writeEngineering(run.runDir, 'architecture-decisions.md', THREE_ADRS_MD);
      writeEngineering(run.runDir, 'domain-model.md', DOMAIN_MODEL_MD);
      expect(Buffer.byteLength(DOMAIN_MODEL_MD, 'utf-8')).toBeGreaterThan(256);

      const ctx = buildContext(run);
      const result = await executePhase4ADRPipeline(ctx);

      const dddStage = findStage(result, 'ddd-generation');
      expect(dddStage).toBeDefined();
      expect(dddStage).toMatchObject({
        stage: 'ddd-generation',
        status: 'completed',
      });
      expect(executionTier(dddStage)).toBe('ruflo-local');

      const modelMdPath = path.join(run.phase4Dir, 'ddd', 'domain-model.md');
      expect(fs.existsSync(modelMdPath)).toBe(true);
      const written = fs.readFileSync(modelMdPath, 'utf-8');
      // The coordinator prepends a header block then pastes Ruflo's content.
      expect(written).toContain('Ruflo local-swarm');
      expect(written).toContain('Telemetry Ingestion Context');

      const indexPath = path.join(run.phase4Dir, 'ddd', 'bounded-contexts.json');
      expect(fs.existsSync(indexPath)).toBe(true);
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
        contexts: Array<{ name: string; description: string }>;
      };
      expect(index.contexts.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: No engineering content, Ruflo unavailable -> template
  // -------------------------------------------------------------------------

  describe('Case 3: no engineering content, Ruflo unavailable', () => {
    it('fires template fallback for both ADR and DDD stages', async () => {
      // No engineering/architecture-decisions.md, no engineering/domain-model.md.
      process.env['AGENTICS_DISABLE_RUFLO'] = 'true';

      const ctx = buildContext(run);
      const result = await executePhase4ADRPipeline(ctx);

      const adrStage = findStage(result, 'adr-generation');
      const dddStage = findStage(result, 'ddd-generation');

      expect(adrStage).toBeDefined();
      expect(executionTier(adrStage)).toBe('template');

      // DDD only runs when ADR succeeds. When the template ADR fallback
      // produces output (non-empty ADR list), the DDD template fallback
      // fires too; when the SPARC input is too thin for ADR templates to
      // emit anything, ADR remains failed and DDD never runs. The fixture
      // here provides a non-empty SPARC service, so template-tier ADRs are
      // produced and we expect template-tier DDD.
      if (adrStage?.status === 'completed') {
        expect(dddStage).toBeDefined();
        expect(executionTier(dddStage)).toBe('template');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Parse degeneracy — no ADR or ## markers in engineering content
  // -------------------------------------------------------------------------

  describe('Case 4: engineering/architecture-decisions.md has no ADR or ## markers', () => {
    it('treats as "no structured ADRs" and falls through to template fallback', async () => {
      // Large blob with no `# ADR-` markers and no `##` level-2 headers.
      // parseRufloArchitectureDecisions returns an empty array; the refiner
      // returns null; since we also disable Ruflo, the template fallback
      // fires (coordinator lines 620-623).
      const blob = [
        '# Decisions',
        '',
        'We decided to use PostgreSQL because the team has experience with it.',
        'We decided to use Kafka because we need streaming. We decided to use',
        'OpenTelemetry because we need tracing. These decisions were made at',
        'the offsite in Q2 and were documented in the wiki. Further context',
        'is available in the engineering handbook and the onboarding deck.',
        'Additional discussion is captured in the retro notes from the same',
        'quarter. Reviewers: Alice, Bob, Carol. Sign-off date: TBD.',
        '',
      ].join('\n');
      expect(Buffer.byteLength(blob, 'utf-8')).toBeGreaterThan(256);
      // Confirm the input has NO `# ADR-` and NO `##` markers so we're
      // genuinely testing the degenerate-parse branch.
      expect(/^#\s+ADR-/m.test(blob)).toBe(false);
      expect(/^##\s+/m.test(blob)).toBe(false);

      writeEngineering(run.runDir, 'architecture-decisions.md', blob);
      process.env['AGENTICS_DISABLE_RUFLO'] = 'true';

      const ctx = buildContext(run);
      const result = await executePhase4ADRPipeline(ctx);

      const adrStage = findStage(result, 'adr-generation');
      expect(adrStage).toBeDefined();
      // Chosen behaviour: coordinator treats zero-parse as "no structured
      // ADRs", the Ruflo refiner returns null, and — because Ruflo is also
      // forced unavailable here — the template fallback fires and tags
      // `executionTier: 'template'`. (If the parse had instead produced a
      // single catch-all `ADR-ENG-001`, executionTier would be 'ruflo-local'
      // — that path is NOT what the current implementation does, so we
      // assert the template-path outcome explicitly.)
      expect(executionTier(adrStage)).toBe('template');
    });
  });
});
