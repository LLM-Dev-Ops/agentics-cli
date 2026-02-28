/**
 * Phase 5 Build Pipeline Coordinator
 *
 * Chains existing pipelines and integration inference sequentially:
 *   1. Prior phase loading (merge artifacts from phases 2-4)
 *   2. Domain-core code generation (src/pipeline/phase3/)
 *   3. Integration inference (infer which integrations the org would use)
 *   4. Integration injection (copy integration module code into project)
 *   5. Deployable Cloud Run service (src/pipeline/phase4/)
 *
 * Reads ADRs + DDDs from phase4/ output, SPARC from phase3/ output,
 * and research dossier from phase2/ output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Phase5BuildContext, Phase5BuildPipelineResult, Phase5BuildStage, IntegrationInferenceResult } from './types.js';
import type { TelemetrySpan } from '../phase2/types.js';
import type { Phase2Artifacts } from '../phase3/types.js';
import type { Phase3Context, Phase3PipelineResult } from '../phase3/types.js';
import type { Phase4Context, Phase4PipelineResult } from '../phase4/types.js';
import { executePhase3Pipeline } from '../phase3/index.js';
import { executePhase4Pipeline } from '../phase4/index.js';
import { createSpan, endSpan, emitSpan, writeSpans } from '../phase2/telemetry.js';
import { writePhase5BuildManifest } from './manifest-writer.js';
import { inferIntegrations } from './phases/integration-inferrer.js';
import { injectIntegrations } from './phases/integration-injector.js';

const DIR_MODE = 0o700;

/**
 * Recursively copy a directory tree.
 */
function copyDirRecursiveSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: DIR_MODE });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      copyDirRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Load Phase 2 artifacts from the merged directory for ERP target detection.
 * Reads SPARC, ADRs, DDD, and TDD data so the Phase 4 deploy pipeline
 * can scan them for ERP system keywords.
 */
function loadPhase2ArtifactsFromMerged(mergedDir: string): Phase2Artifacts {
  const readJSON = (relPath: string): unknown => {
    const p = path.join(mergedDir, relPath);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
  };

  const manifest = (readJSON('phase2-manifest.json') ?? {}) as Phase2Artifacts['manifest'];
  const sparc = (readJSON('sparc/sparc-combined.json') ?? readJSON('sparc-combined.json') ?? {}) as Phase2Artifacts['sparc'];
  const adrs = (readJSON('adrs/adr-index.json') ?? []) as Phase2Artifacts['adrs'];
  const domainModel = (readJSON('ddd/domain-model.json') ?? { contexts: [], contextMap: [] }) as Phase2Artifacts['domainModel'];
  const tddPlan = (readJSON('tdd/tdd-plan.json') ?? {
    approach: '', testPyramid: {}, testSuites: [], mockContracts: [],
    seamDefinitions: [], executionOrder: [],
  }) as Phase2Artifacts['tddPlan'];

  return { manifest, sparc, adrs, domainModel, tddPlan };
}

interface StageDefinition {
  readonly id: Phase5BuildStage;
  readonly label: string;
}

const STAGES: readonly StageDefinition[] = [
  { id: 'prior-phase-loading',    label: 'Prior Phase Loading' },
  { id: 'domain-codegen',         label: 'Domain Code Generation' },
  { id: 'integration-inference',  label: 'Integration Inference' },
  { id: 'integration-injection',  label: 'Integration Injection' },
  { id: 'deployable-service',     label: 'Deployable Service Generation' },
] as const;

export async function executePhase5BuildPipeline(
  context: Phase5BuildContext,
): Promise<Phase5BuildPipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: Array<{
    stage: Phase5BuildStage;
    status: 'completed' | 'failed';
    timing: number;
    artifacts: string[];
    summary: string;
  }> = [];

  const rootSpan = createSpan('phase5-build-pipeline', 'execute-all', {
    traceId: context.traceId,
    phase4Dir: context.phase4Dir,
    phase5Dir: context.phase5Dir,
  });

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 5: ADRs + DDDs \u2192 BUILD (CODE GEN + DEPLOY)');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Trace ID:   ${context.traceId}`);
  console.error(`  Phase4 Dir: ${context.phase4Dir}`);
  console.error(`  Phase5 Dir: ${context.phase5Dir}`);
  console.error('');

  // Stage 1: Load prior phase artifacts
  console.error(`  >> [1/${STAGES.length}] ${STAGES[0]!.label}`);
  const loadSpan = createSpan('phase5-build-pipeline', 'prior-phase-loading', {}, rootSpan.spanId);
  const loadStart = Date.now();

  const phase4ManifestPath = path.join(context.phase4Dir, 'phase4-manifest.json');
  if (!fs.existsSync(phase4ManifestPath)) {
    const msg = `Phase 4 manifest not found: ${phase4ManifestPath}`;
    console.error(`  ERROR: ${msg}`);
    completedStages.push({ stage: 'prior-phase-loading', status: 'failed', timing: Date.now() - loadStart, artifacts: [], summary: `  ERROR: ${msg}` });
    const failSpan = endSpan(loadSpan, 'error');
    context.telemetrySpans.push(failSpan);
    writeSpans(context.telemetrySpans, context.phase5Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  // Build merged phase2 view for codegen pipeline (expects sparc/, adrs/, ddd/, tdd/ under one dir)
  const mergedPhase2Dir = path.join(context.phase5Dir, '.phase2-merged');
  fs.mkdirSync(mergedPhase2Dir, { recursive: true, mode: DIR_MODE });

  try {
    const p2Manifest = path.join(context.phase2Dir, 'phase2-manifest.json');
    if (fs.existsSync(p2Manifest)) fs.copyFileSync(p2Manifest, path.join(mergedPhase2Dir, 'phase2-manifest.json'));

    const dossier = path.join(context.phase2Dir, 'research-dossier.json');
    if (fs.existsSync(dossier)) fs.copyFileSync(dossier, path.join(mergedPhase2Dir, 'research-dossier.json'));

    // SPARC + TDD from phase3
    for (const sub of ['sparc', 'tdd']) {
      const src = path.join(context.phase3Dir, sub);
      if (fs.existsSync(src)) copyDirRecursive(src, path.join(mergedPhase2Dir, sub));
    }
    const sparcCombined = path.join(context.phase3Dir, 'sparc-combined.json');
    if (fs.existsSync(sparcCombined)) fs.copyFileSync(sparcCombined, path.join(mergedPhase2Dir, 'sparc-combined.json'));

    // ADRs + DDDs from phase4
    for (const sub of ['adrs', 'ddd']) {
      const src = path.join(context.phase4Dir, sub);
      if (fs.existsSync(src)) copyDirRecursive(src, path.join(mergedPhase2Dir, sub));
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    completedStages.push({ stage: 'prior-phase-loading', status: 'failed', timing: Date.now() - loadStart, artifacts: [], summary: `  ERROR: ${errMsg}` });
    const failSpan = endSpan(loadSpan, 'error');
    context.telemetrySpans.push(failSpan);
    writeSpans(context.telemetrySpans, context.phase5Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }

  completedStages.push({ stage: 'prior-phase-loading', status: 'completed', timing: Date.now() - loadStart, artifacts: [], summary: '     Merged artifacts from phases 2-4 into build context' });
  const finalLoadSpan = endSpan(loadSpan, 'ok');
  emitSpan(finalLoadSpan);
  context.telemetrySpans.push(finalLoadSpan);
  console.error('     Merged artifacts from phases 2-4 into build context');
  console.error('');

  // Stage 2: Domain Code Generation
  console.error(`  >> [2/${STAGES.length}] ${STAGES[1]!.label}`);
  const codegenSpan = createSpan('phase5-build-pipeline', 'domain-codegen', {}, rootSpan.spanId);
  const codegenStart = Date.now();
  const codegenDir = path.join(context.phase5Dir, 'codegen');
  fs.mkdirSync(codegenDir, { recursive: true, mode: DIR_MODE });

  let codegenResult: Phase3PipelineResult | null = null;
  try {
    const phase3Ctx: Phase3Context = {
      traceId: context.traceId,
      phase2Dir: mergedPhase2Dir,
      phase3Dir: codegenDir,
      scenarioQuery: context.scenarioQuery,
      phase2Artifacts: { manifest: {}, sparc: {}, adrs: [], domainModel: { contexts: [], contextMap: [] }, tddPlan: { approach: '', testPyramid: {}, testSuites: [], mockContracts: [], seamDefinitions: [], executionOrder: [] } } as any,
      stageOutputs: new Map(),
      telemetrySpans: [] as TelemetrySpan[],
    };

    codegenResult = await executePhase3Pipeline(phase3Ctx);
    if (!codegenResult.manifest.success) throw new Error('Domain codegen pipeline reported failure');

    completedStages.push({ stage: 'domain-codegen', status: 'completed', timing: Date.now() - codegenStart, artifacts: codegenResult.manifest.artifacts.map(a => a.path), summary: `     Generated ${codegenResult.manifest.artifacts.length} code artifacts (${codegenResult.manifest.implementation_language})` });
    const finalCG = endSpan(codegenSpan, 'ok', { artifactCount: codegenResult.manifest.artifacts.length });
    emitSpan(finalCG);
    context.telemetrySpans.push(finalCG);
    console.error(`     Generated ${codegenResult.manifest.artifacts.length} code artifacts (${codegenResult.manifest.implementation_language})`);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    completedStages.push({ stage: 'domain-codegen', status: 'failed', timing: Date.now() - codegenStart, artifacts: [], summary: `  ERROR: ${errMsg}` });
    const failSpan = endSpan(codegenSpan, 'error');
    context.telemetrySpans.push(failSpan);
    writeSpans(context.telemetrySpans, context.phase5Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }
  console.error('');

  // Stage 3: Integration Inference
  console.error(`  >> [3/${STAGES.length}] ${STAGES[2]!.label}`);
  const inferSpan = createSpan('phase5-build-pipeline', 'integration-inference', {}, rootSpan.spanId);
  const inferStart = Date.now();

  let inferenceResult: IntegrationInferenceResult = { selectedModules: [], totalScanned: 0, corpusSize: 0 };
  try {
    const { stageOutput } = inferIntegrations(context);
    inferenceResult = stageOutput.data;
    completedStages.push(stageOutput);
    const finalInferSpan = endSpan(inferSpan, stageOutput.status === 'completed' ? 'ok' : 'error', { selectedCount: inferenceResult.selectedModules.length });
    emitSpan(finalInferSpan);
    context.telemetrySpans.push(finalInferSpan);
    console.error(stageOutput.summary);
    if (stageOutput.status === 'failed') {
      writeSpans(context.telemetrySpans, context.phase5Dir);
      return buildFailResult(context, completedStages, pipelineStart);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    completedStages.push({ stage: 'integration-inference', status: 'failed', timing: Date.now() - inferStart, artifacts: [], summary: `  ERROR: ${errMsg}` });
    const failSpan = endSpan(inferSpan, 'error');
    context.telemetrySpans.push(failSpan);
    writeSpans(context.telemetrySpans, context.phase5Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }
  console.error('');

  // Stage 4: Integration Injection
  console.error(`  >> [4/${STAGES.length}] ${STAGES[3]!.label}`);
  const injectSpan = createSpan('phase5-build-pipeline', 'integration-injection', {}, rootSpan.spanId);
  const injectStart = Date.now();

  try {
    const implLangForInject = codegenResult?.manifest.implementation_language ?? 'typescript';
    const { stageOutput } = injectIntegrations(context, inferenceResult, implLangForInject, codegenDir);
    completedStages.push(stageOutput);
    const finalInjectSpan = endSpan(injectSpan, stageOutput.status === 'completed' ? 'ok' : 'error', { copiedCount: stageOutput.data.copiedModules.length });
    emitSpan(finalInjectSpan);
    context.telemetrySpans.push(finalInjectSpan);
    console.error(stageOutput.summary);
    if (stageOutput.status === 'failed') {
      // Integration injection is non-blocking — continue pipeline without integrations
      console.error(`  Stage "${STAGES[3]!.label}" failed (non-blocking). Continuing pipeline.`);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    completedStages.push({ stage: 'integration-injection', status: 'failed', timing: Date.now() - injectStart, artifacts: [], summary: `  ERROR: ${errMsg}` });
    const failSpan = endSpan(injectSpan, 'error');
    context.telemetrySpans.push(failSpan);
    // Integration injection is non-blocking — continue pipeline without integrations
    console.error(`  Stage "${STAGES[3]!.label}" failed (non-blocking). Continuing pipeline.`);
  }
  console.error('');

  // Stage 5: Deployable Service
  console.error(`  >> [5/${STAGES.length}] ${STAGES[4]!.label}`);
  const deploySpan = createSpan('phase5-build-pipeline', 'deployable-service', {}, rootSpan.spanId);
  const deployStart = Date.now();
  const deployDir = path.join(context.phase5Dir, 'deploy');
  fs.mkdirSync(deployDir, { recursive: true, mode: DIR_MODE });

  let deployResult: Phase4PipelineResult | null = null;
  try {
    // Load actual Phase 2 artifacts from merged directory for ERP detection
    const loadedPhase2Artifacts = loadPhase2ArtifactsFromMerged(mergedPhase2Dir);

    const phase4Ctx: Phase4Context = {
      traceId: context.traceId,
      phase2Dir: mergedPhase2Dir,
      phase3Dir: codegenDir,
      phase4Dir: deployDir,
      scenarioQuery: context.scenarioQuery,
      phase3Artifacts: {
        manifest: {} as any,
        implementationLanguage: codegenResult!.manifest.implementation_language,
        projectDir: path.join(codegenDir, 'project'),
        phase2Artifacts: loadedPhase2Artifacts,
      },
      platformRepoPaths: context.platformRepoPaths,
      stageOutputs: new Map(),
      telemetrySpans: [] as TelemetrySpan[],
    };

    deployResult = await executePhase4Pipeline(phase4Ctx);
    if (!deployResult.manifest.success) throw new Error('Deploy pipeline reported failure');

    // Copy integration modules from codegen into deploy project
    const codegenIntegrationsDir = path.join(codegenDir, 'project', 'src', 'integrations');
    const deployProjectDir = path.join(deployDir, 'project', 'src', 'integrations');
    if (fs.existsSync(codegenIntegrationsDir)) {
      copyDirRecursiveSync(codegenIntegrationsDir, deployProjectDir);
    }

    completedStages.push({ stage: 'deployable-service', status: 'completed', timing: Date.now() - deployStart, artifacts: deployResult.manifest.artifacts.map(a => a.path), summary: `     Generated ${deployResult.manifest.artifacts.length} deployment artifacts (${deployResult.manifest.erp_system})` });
    const finalDeploy = endSpan(deploySpan, 'ok', { artifactCount: deployResult.manifest.artifacts.length });
    emitSpan(finalDeploy);
    context.telemetrySpans.push(finalDeploy);
    console.error(`     Generated ${deployResult.manifest.artifacts.length} deployment artifacts (${deployResult.manifest.erp_system})`);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    completedStages.push({ stage: 'deployable-service', status: 'failed', timing: Date.now() - deployStart, artifacts: [], summary: `  ERROR: ${errMsg}` });
    const failSpan = endSpan(deploySpan, 'error');
    context.telemetrySpans.push(failSpan);
    writeSpans(context.telemetrySpans, context.phase5Dir);
    return buildFailResult(context, completedStages, pipelineStart);
  }
  console.error('');

  // Write manifest
  console.error('  Writing phase5-manifest.json...');
  const implLang = codegenResult?.manifest.implementation_language ?? 'typescript';
  const erpSys = deployResult?.manifest.erp_system ?? 'unknown';

  const manifest = writePhase5BuildManifest(context.phase5Dir, context.traceId, implLang, erpSys, completedStages, Date.now() - pipelineStart);

  const finalRootSpan = endSpan(rootSpan, 'ok', { totalStages: completedStages.length, totalArtifacts: manifest.artifacts.length });
  context.telemetrySpans.push(finalRootSpan);
  writeSpans(context.telemetrySpans, context.phase5Dir);

  console.error('');
  console.error('='.repeat(72));
  console.error('  PHASE 5 COMPLETE (Build)');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Output:     ${context.phase5Dir}`);
  console.error(`  Language:   ${implLang}`);
  console.error(`  ERP:        ${erpSys}`);
  console.error(`  Stages:     ${completedStages.length}/${STAGES.length} completed`);
  console.error(`  Artifacts:  ${manifest.artifacts.length} files`);
  console.error(`  Duration:   ${Date.now() - pipelineStart}ms`);
  console.error('');

  return { traceId: context.traceId, phase5Dir: context.phase5Dir, manifest, stageResults: completedStages, totalTiming: Date.now() - pipelineStart };
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: DIR_MODE });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function buildFailResult(
  context: Phase5BuildContext,
  stages: Array<{ stage: Phase5BuildStage; status: 'completed' | 'failed'; timing: number; artifacts: string[]; summary: string }>,
  startTime: number,
): Phase5BuildPipelineResult {
  const totalTiming = Date.now() - startTime;

  // Determine best-effort language/erp from completed stages
  const implLang = stages.find(s => s.stage === 'domain-codegen' && s.status === 'completed')
    ? 'rust' : 'unknown';
  const erpSys = 'unknown';

  const manifest = {
    schema_version: '5.0.0', trace_id: context.traceId, generated_at: new Date().toISOString(),
    pipeline_version: '5.0.0', implementation_language: implLang, erp_system: erpSys,
    stages: stages.map(s => ({ stage: s.stage, status: s.status, timing_ms: s.timing, artifact_count: s.artifacts.length })),
    artifacts: [] as Array<{ path: string; sha256: string; size_bytes: number }>,
    total_timing_ms: totalTiming, success: false,
  };

  // Always persist the manifest to disk so Phase 6 can read it and report the failure
  try {
    const manifestPath = path.join(context.phase5Dir, 'phase5-manifest.json');
    fs.mkdirSync(context.phase5Dir, { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf-8' });
  } catch {
    // Best-effort — if we can't write it, Phase 6 will get the original "not found" error
  }

  return {
    traceId: context.traceId,
    phase5Dir: context.phase5Dir,
    manifest: manifest as any,
    stageResults: stages,
    totalTiming,
  };
}
