/**
 * ADR-078: Build-Time Platform Service Integration
 *
 * Invokes Agentics platform services during pipeline execution to validate,
 * benchmark, and quality-check generated code before deployment.
 *
 * Services called:
 *   - Test-Bench: quality scoring, hallucination detection
 *   - Config-Manager: validate generated config files
 *   - Schema-Registry: validate generated API schemas
 *   - Latency-Lens: establish performance baselines
 *   - Simulator: stress-test without external API costs
 *
 * All calls are best-effort — pipeline continues if a service is unavailable.
 * Results are logged to telemetry and included in the phase4 manifest.
 */

import { execFileSync } from 'node:child_process';
import type { Phase4Context, Phase4StageOutput, ServerFile, DeploymentFile } from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Platform Service Invocation
// ============================================================================

interface BuildTimeResult {
  service: string;
  agent: string;
  status: 'success' | 'error' | 'skipped' | 'synthetic';
  data: unknown;
  durationMs: number;
}

/**
 * Invoke an Agentics platform agent via CLI.
 * Returns null if the CLI is unavailable or the agent errors.
 */
function invokeAgent(domain: string, agent: string, payload: Record<string, unknown>, timeoutMs = 30_000): BuildTimeResult {
  const start = Date.now();
  try {
    const result = execFileSync('agentics', [
      'agents', 'invoke', domain, agent, JSON.stringify(payload),
    ], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.trim());
    } catch {
      parsed = { raw: result.trim() };
    }

    // INTEGRITY: a synthetic/fallback response is a fabricated stub returned
    // with HTTP 200 — it is NOT a real validation result. Tag it 'synthetic' so
    // it is never counted as a passed check baked into the prototype report.
    const status: BuildTimeResult['status'] = isSyntheticParsed(parsed) ? 'synthetic' : 'success';
    return { service: domain, agent, status, data: parsed, durationMs: Date.now() - start };
  } catch (err) {
    return {
      service: domain,
      agent,
      status: 'error',
      data: { error: err instanceof Error ? err.message : String(err) },
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Detect a synthetic/fallback agent response. Synthetic stubs are returned with
 * HTTP 200, so status alone cannot distinguish them — the `_fallback` marker
 * (or execution_tier) is the only reliable signal that the data is fabricated.
 */
function isSyntheticParsed(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  if (p['_fallback'] === true || p['execution_tier'] === 'synthetic') return true;
  const resp = p['response'];
  return !!resp && typeof resp === 'object' && (resp as Record<string, unknown>)['_fallback'] === true;
}

/** Strict integrity gate (mirrors AGENTICS_ERP_STRICT / the Phase-7 writer). */
function requireRealAgents(): boolean {
  const v = process.env['AGENTICS_REQUIRE_REAL_AGENTS'];
  return v === 'true' || v === '1';
}

/**
 * Check if the agentics CLI is available.
 */
function isAgenticsCLIAvailable(): boolean {
  try {
    execFileSync('which', ['agentics'], { encoding: 'utf-8', timeout: 3_000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Build-Time Validation Checks
// ============================================================================

/**
 * Run Test-Bench quality scoring on generated code.
 */
function runQualityScoring(projectDir: string, language: string): BuildTimeResult {
  return invokeAgent('test-bench', 'quality', {
    path: projectDir,
    language,
    checks: ['type_safety', 'error_handling', 'naming', 'modularity'],
  });
}

/**
 * Run Config-Manager validation on generated config files.
 */
function runConfigValidation(configFiles: Array<{ name: string; content: string }>): BuildTimeResult {
  return invokeAgent('config-manager', 'validate', {
    files: configFiles.map(f => ({ name: f.name, content: f.content })),
    checks: ['required_fields', 'valid_yaml', 'no_unresolved_placeholders'],
  });
}

/**
 * Run Schema-Registry validation on generated API schemas.
 */
function runSchemaValidation(schemas: Array<{ name: string; content: string }>): BuildTimeResult {
  return invokeAgent('schema-registry', 'validate', {
    schemas: schemas.map(s => ({ name: s.name, content: s.content })),
    checks: ['zod_consistency', 'type_coverage', 'required_fields'],
  });
}

/**
 * Run Test-Bench hallucination detection on LLM-generated code.
 */
function runHallucinationCheck(files: Array<{ path: string; content: string }>): BuildTimeResult {
  return invokeAgent('test-bench', 'hallucination', {
    files: files.map(f => ({ path: f.path, contentSample: f.content.slice(0, 2000) })),
    checks: ['import_exists', 'api_consistency', 'comment_accuracy'],
  }, 45_000);
}

/**
 * Run Latency-Lens cold-start estimation.
 */
function runLatencyEstimation(dockerfileContent: string, language: string): BuildTimeResult {
  return invokeAgent('latency-lens', 'cold-start', {
    dockerfile: dockerfileContent.slice(0, 1000),
    language,
    runtime: language === 'typescript' ? 'node20' : 'rust',
    platform: 'cloud-run',
  });
}

// ============================================================================
// Pipeline Stage: Build-Time Validation
// ============================================================================

/**
 * ADR-078: Post-codegen build-time validation stage.
 *
 * Invokes platform services to validate generated code quality, configs,
 * schemas, and establish performance baselines. All checks are best-effort —
 * the pipeline continues even if services are unavailable.
 *
 * Returns a summary of all validation results.
 */
export function runBuildTimeValidation(context: Phase4Context): Phase4StageOutput {
  const startTime = Date.now();
  const rootSpan = createSpan('build-time-validation', 'validate', {
    phase4Dir: context.phase4Dir,
    traceId: context.traceId,
  });

  const results: BuildTimeResult[] = [];
  const language = context.phase3Artifacts.implementationLanguage;

  // Check if agentics CLI is available
  if (!isAgenticsCLIAvailable()) {
    const span = endSpan(rootSpan, 'ok', { skipped: true, reason: 'agentics CLI not available' });
    emitSpan(span);

    return {
      stage: 'build-time-validation',
      status: 'completed',
      data: {
        results: [],
        summary: 'Build-time validation skipped — agentics CLI not available',
        skipped: true,
      },
      artifacts: [],
      timing: Date.now() - startTime,
      summary: '  [SKIP] Build-time validation — agentics CLI not available',
    };
  }

  console.error('  ADR-078: Running build-time platform service validation...');

  // --- 1. Test-Bench: Quality scoring ---
  const httpStage = context.stageOutputs.get('http-server-generation');
  if (httpStage?.status === 'completed') {
    const files = (httpStage.data as { files: ServerFile[] }).files;
    const projectDir = `${context.phase4Dir}/project/src`;

    console.error('    [1/5] Test-Bench/Quality: scoring generated code...');
    results.push(runQualityScoring(projectDir, language));

    // --- 2. Test-Bench: Hallucination detection on LLM-generated files ---
    console.error('    [2/5] Test-Bench/Hallucination: checking LLM output...');
    const codeFiles = files
      .filter(f => f.relativePath.endsWith('.ts') && f.content.length > 100)
      .slice(0, 5) // Limit to 5 files to keep payload reasonable
      .map(f => ({ path: f.relativePath, content: f.content }));
    if (codeFiles.length > 0) {
      results.push(runHallucinationCheck(codeFiles));
    }
  }

  // --- 3. Config-Manager: Validate config files ---
  const deployStage = context.stageOutputs.get('deployment-generation');
  if (deployStage?.status === 'completed') {
    const deployFiles = (deployStage.data as { files: DeploymentFile[] }).files;

    console.error('    [3/5] Config-Manager/Validate: checking configs...');
    const configFiles = deployFiles
      .filter(f =>
        f.relativePath.endsWith('.yaml') ||
        f.relativePath.endsWith('.yml') ||
        f.relativePath.endsWith('.json') ||
        f.relativePath.includes('.env'),
      )
      .map(f => ({ name: f.relativePath, content: f.content }));

    if (configFiles.length > 0) {
      results.push(runConfigValidation(configFiles));
    }
  }

  // --- 4. Schema-Registry: Validate API schemas ---
  if (httpStage?.status === 'completed') {
    const files = (httpStage.data as { files: ServerFile[] }).files;
    const schemaFile = files.find(f => f.relativePath.includes('schemas.ts'));

    console.error('    [4/5] Schema-Registry/Validate: checking schemas...');
    if (schemaFile) {
      results.push(runSchemaValidation([{ name: schemaFile.relativePath, content: schemaFile.content }]));
    }
  }

  // --- 5. Latency-Lens: Cold-start estimation ---
  if (deployStage?.status === 'completed') {
    const deployFiles = (deployStage.data as { files: DeploymentFile[] }).files;
    const dockerfile = deployFiles.find(f => f.relativePath.includes('Dockerfile'));

    console.error('    [5/5] Latency-Lens/Cold-Start: estimating baseline...');
    if (dockerfile) {
      results.push(runLatencyEstimation(dockerfile.content, language));
    }
  }

  // Summarize results
  const succeeded = results.filter(r => r.status === 'success').length;
  const errored = results.filter(r => r.status === 'error').length;
  // INTEGRITY: synthetic checks are fabricated stubs — counted separately, never
  // folded into `succeeded`, so a prototype can never claim "N/N checks passed"
  // on the back of data no real agent produced.
  const synthetic = results.filter(r => r.status === 'synthetic').length;
  const totalMs = Date.now() - startTime;

  const summaryText = results.map(r => {
    const icon = r.status === 'success' ? '✓' : r.status === 'error' ? '✗' : r.status === 'synthetic' ? '⚠' : '○';
    return `    ${icon} ${r.service}/${r.agent}: ${r.status} (${r.durationMs}ms)`;
  }).join('\n');

  console.error(summaryText);
  if (synthetic > 0) {
    console.error(`  [integrity] ${synthetic}/${results.length} build-time checks returned SYNTHETIC stub data — not real validation.`);
  }

  // Strict mode: a prototype whose build-time validation ran on fabricated agent
  // data must fail loudly rather than report a green build.
  const strictFail = synthetic > 0 && requireRealAgents();
  const stageStatus = strictFail ? 'failed' : 'completed';

  const finalSpan = endSpan(rootSpan, (errored === results.length || strictFail) ? 'error' : 'ok', {
    totalChecks: results.length,
    succeeded,
    errored,
    synthetic,
    totalMs,
  });
  emitSpan(finalSpan);

  const integritySuffix = synthetic > 0 ? `, ${synthetic} synthetic` : '';
  return {
    stage: 'build-time-validation',
    status: stageStatus,
    data: {
      results,
      summary: `${succeeded}/${results.length} checks passed, ${errored} errors${integritySuffix}`,
      skipped: false,
      ...(strictFail ? { integrity_error: `AGENTICS_REQUIRE_REAL_AGENTS: ${synthetic} build-time check(s) ran on synthetic data` } : {}),
    },
    artifacts: [],
    timing: totalMs,
    summary: `  [ADR-078] Build-time validation: ${succeeded}/${results.length} passed${integritySuffix} (${totalMs}ms)`,
  };
}
