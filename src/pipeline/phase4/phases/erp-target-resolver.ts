/**
 * Phase 4 Pipeline — Stage 2: ERP Target Resolver
 *
 * Detects the target ERP system from Phase 2 artifacts using keyword scanning,
 * resolves the associated database engine and SQL dialect, and looks up known
 * integration points from the enterprise integration registry.
 *
 * Error codes:
 *   ECLI-P4-002  No ERP target detected in Phase 2 artifacts
 */

import type { Phase4Context, Phase4StageOutput, ERPResolution } from '../types.js';
import { detectERPFromText, detectDatabaseFromText, pickTransactionalDatabase, resolveERPDatabase } from '../../../deps/erp-database-map.js';
import type { ERPDetectionResult, ERPSystem as ERPSystemSlug } from '../../../deps/erp-database-map.js';
import { lookupIntegration } from '../../../enterprise/integration-registry.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';
import { loadTechStack } from '../../phase2/phases/tech-stack-detector.js';

// ============================================================================
// Internal: Detection source label
// ============================================================================

type DetectionSource = ERPResolution['detectionSource'];

interface ScanSource {
  readonly label: DetectionSource;
  readonly text: string;
}

// ============================================================================
// Helper: Collect text sources from Phase 2 artifacts
// ============================================================================

/**
 * Assemble all text corpora from Phase 2 artifacts for ERP keyword scanning.
 * Each corpus is tagged with a human-readable detection source label so the
 * winning detection signal can be attributed correctly.
 */
function collectScanSources(context: Phase4Context): ScanSource[] {
  const sources: ScanSource[] = [];
  const artifacts = context.phase3Artifacts.phase2Artifacts;

  // Source 1: scenario-query — the raw query string driving this pipeline run
  if (context.scenarioQuery) {
    sources.push({
      label: 'scenario-query',
      text: context.scenarioQuery,
    });
  }

  // Source 2: sparc-services — SPARC architecture service names + responsibilities
  try {
    const sparc = artifacts.sparc as unknown as Record<string, unknown>;
    const architecture = sparc['architecture'] as Record<string, unknown> | undefined;
    const services = (architecture?.['services'] ?? []) as Array<Record<string, unknown>>;
    const sparcText = services
      .map((svc) => `${String(svc['name'] ?? '')} ${String(svc['responsibility'] ?? '')}`)
      .join(' ');
    if (sparcText.trim()) {
      sources.push({ label: 'sparc-services', text: sparcText });
    }
  } catch {
    // Malformed SPARC output — skip this source gracefully
  }

  // Source 3: dossier-items — research dossier item titles + content
  try {
    const manifest = artifacts.manifest as unknown as Record<string, unknown>;
    const dossierItems = (manifest['dossier_items'] ?? []) as Array<Record<string, unknown>>;
    const dossierText = dossierItems
      .map((item) => `${String(item['title'] ?? '')} ${String(item['content'] ?? '')}`)
      .join(' ');
    if (dossierText.trim()) {
      sources.push({ label: 'dossier-items', text: dossierText });
    }
  } catch {
    // Malformed manifest — skip gracefully
  }

  // Source 4: adr-context — ADR context + decision text
  try {
    const adrs = (artifacts.adrs as unknown as Array<Record<string, unknown>>) ?? [];
    const adrText = adrs
      .map((adr) => `${String(adr['context'] ?? '')} ${String(adr['decision'] ?? '')}`)
      .join(' ');
    if (adrText.trim()) {
      sources.push({ label: 'adr-context', text: adrText });
    }
  } catch {
    // Malformed ADR index — skip gracefully
  }

  return sources;
}

// ============================================================================
// Main: resolveERPTarget
// ============================================================================

/**
 * Stage 2: Detect the ERP system from Phase 2 artifacts and resolve
 * the associated database engine, SQL dialect, and integration registry entry.
 *
 * Scans four text corpora (scenario query, SPARC services, dossier items,
 * ADR context) and selects the detection result with the highest confidence
 * score. Looks up integration points and constraints from the enterprise
 * integration registry.
 *
 * @param context - The Phase 4 pipeline context (must have phase3Artifacts set)
 * @returns Stage output describing success or failure
 */
export function resolveERPTarget(context: Phase4Context): Phase4StageOutput {
  const rootSpan = createSpan('erp-target-resolution', 'resolve-erp', {
    phase2Dir: context.phase2Dir,
    scenarioQuery: context.scenarioQuery,
  });

  try {
    // -------------------------------------------------------------------------
    // Step 0 (ADR-029): Prefer Phase 2 tech-stack.json if available
    // This eliminates dual-detection risk by reusing Phase 2's deterministic
    // detection results instead of re-scanning text corpora.
    // -------------------------------------------------------------------------
    let techStackMatch: ERPDetectionResult | null = null;
    let techStackSource: DetectionSource = 'scenario-query';

    if (context.phase2Dir) {
      const techStackSpan = createSpan(
        'erp-target-resolution',
        'load-tech-stack-json',
        { phase2Dir: context.phase2Dir },
        rootSpan.spanId,
      );
      try {
        const techStack = loadTechStack(context.phase2Dir);
        if (techStack && techStack.erp) {
          // Map the ERPSystem.name to the detection system name used by erp-database-map
          // Map tech-stack-detector slugs to erp-database-map ERPSystem union values
          const erpSlugToSystem: Record<string, ERPSystemSlug> = {
            'oracle-fusion': 'oracle-erp',
            'sap-s4hana': 'sap-s4hana',
            'netsuite': 'oracle-netsuite',
            'workday': 'workday',
            'dynamics-365': 'microsoft-dynamics',
            'infor-cloudsuite': 'infor',
            'yardi-voyager': 'yardi-voyager',
          };
          const systemName: ERPSystemSlug = erpSlugToSystem[techStack.erp.slug] ?? 'oracle-netsuite';
          techStackMatch = {
            system: systemName,
            confidence: 0.95,
            matchedKeyword: techStack.erp.slug,
          };
          techStackSource = 'scenario-query'; // tech-stack.json is derived from scenario
        }
        const finalTsSpan = endSpan(techStackSpan, 'ok', {
          found: techStackMatch !== null,
          erpSystem: techStackMatch?.system ?? 'none',
        });
        emitSpan(finalTsSpan);
        context.telemetrySpans.push(finalTsSpan);
      } catch {
        const finalTsSpan = endSpan(techStackSpan, 'ok', { found: false, fallback: true });
        emitSpan(finalTsSpan);
        context.telemetrySpans.push(finalTsSpan);
        // Graceful fallback to text scanning below
      }
    }

    // -------------------------------------------------------------------------
    // Step 1: Collect text corpora from Phase 2 artifacts
    // -------------------------------------------------------------------------
    const scanSources = collectScanSources(context);

    const sourcesSpan = createSpan(
      'erp-target-resolution',
      'collect-scan-sources',
      { sourceCount: scanSources.length },
      rootSpan.spanId,
    );
    const finalSourcesSpan = endSpan(sourcesSpan, 'ok', { sourceCount: scanSources.length });
    emitSpan(finalSourcesSpan);
    context.telemetrySpans.push(finalSourcesSpan);

    // -------------------------------------------------------------------------
    // Step 2: Scan each source and collect all ERP detection results
    // If tech-stack.json provided a match, use it as the initial best;
    // text scanning can still override if it finds a higher-confidence match.
    // -------------------------------------------------------------------------
    let bestMatch: ERPDetectionResult | null = techStackMatch;
    let bestSource: DetectionSource = techStackMatch ? techStackSource : 'scenario-query';

    for (const source of scanSources) {
      const scanSpan = createSpan(
        'erp-target-resolution',
        `scan-${source.label}`,
        { source: source.label, textLength: source.text.length },
        rootSpan.spanId,
      );

      const results = detectERPFromText(source.text);

      const finalScanSpan = endSpan(scanSpan, 'ok', {
        source: source.label,
        matchCount: results.length,
        topMatch: results[0]?.system ?? 'none',
        topConfidence: results[0]?.confidence ?? 0,
      });
      emitSpan(finalScanSpan);
      context.telemetrySpans.push(finalScanSpan);

      if (results.length > 0) {
        const top = results[0];
        if (top !== undefined && (bestMatch === null || top.confidence > bestMatch.confidence)) {
          bestMatch = top;
          bestSource = source.label;
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 3: Fail fast if no ERP system was detected
    // -------------------------------------------------------------------------
    if (bestMatch === null) {
      throw new Error(
        'ECLI-P4-002: No ERP target detected in Phase 2 artifacts. ' +
        'Ensure the scenario mentions an ERP system.',
      );
    }

    // -------------------------------------------------------------------------
    // Step 4: Resolve database mapping
    // -------------------------------------------------------------------------
    const dbMapping = resolveERPDatabase(bestMatch.system);

    const resolveSpan = createSpan(
      'erp-target-resolution',
      'resolve-database-mapping',
      {
        erpSystem: bestMatch.system,
        primaryEngine: dbMapping.primaryEngine ?? 'none',
        sqlDialect: dbMapping.sqlDialect ?? 'none',
        apiOnly: dbMapping.apiOnly,
      },
      rootSpan.spanId,
    );
    const finalResolveSpan = endSpan(resolveSpan, 'ok', {
      erpSystem: bestMatch.system,
    });
    emitSpan(finalResolveSpan);
    context.telemetrySpans.push(finalResolveSpan);

    // -------------------------------------------------------------------------
    // Step 5: Look up integration registry for integration points + constraints
    // -------------------------------------------------------------------------
    const registryEntry = lookupIntegration(bestMatch.system);

    const integrationPoints: string[] = registryEntry?.integration_points
      ? [...registryEntry.integration_points]
      : [];
    const constraints: string[] = registryEntry?.constraints
      ? [...registryEntry.constraints]
      : [];

    // -------------------------------------------------------------------------
    // Step 5b: Detect explicit database infrastructure from user prompt
    // If the user explicitly names a database (e.g. "PostgreSQL", "BigQuery"),
    // override the ERP-inferred dialect with the explicitly stated one.
    // Transactional databases (PostgreSQL, MySQL) take priority over analytics
    // databases (Redshift, BigQuery) for schema DDL generation.
    // -------------------------------------------------------------------------
    let resolvedEngine = dbMapping.primaryEngine;
    let resolvedDialect = dbMapping.sqlDialect;
    let dbOverrideSource: string | null = null;
    let dbOverrideKeyword: string | null = null;

    const allDbDetections: import('../../../deps/erp-database-map.js').DatabaseDetectionResult[] = [];

    for (const source of scanSources) {
      const dbResults = detectDatabaseFromText(source.text);
      for (const r of dbResults) {
        if (!allDbDetections.some(d => d.engine === r.engine)) {
          allDbDetections.push(r);
        }
      }
    }

    if (allDbDetections.length > 0) {
      // Prefer transactional databases for schema DDL; fall back to any detection
      const txDb = pickTransactionalDatabase(allDbDetections);
      const chosen = txDb ?? allDbDetections[0]!;
      resolvedEngine = chosen.engine;
      resolvedDialect = chosen.dialect;
      dbOverrideSource = txDb ? 'transactional-priority' : 'first-detected';
      dbOverrideKeyword = chosen.matchedKeyword;
    }

    const dbOverrideSpan = createSpan(
      'erp-target-resolution',
      'database-override',
      {
        erpInferredEngine: String(dbMapping.primaryEngine ?? 'none'),
        erpInferredDialect: String(dbMapping.sqlDialect ?? 'none'),
        detectedDatabases: allDbDetections.map(d => `${d.engine}(${d.category})`).join(', ') || 'none',
        resolvedEngine: String(resolvedEngine ?? 'none'),
        resolvedDialect: String(resolvedDialect ?? 'none'),
        overrideApplied: dbOverrideSource !== null,
        overrideSource: dbOverrideSource ?? 'none',
        overrideKeyword: dbOverrideKeyword ?? 'none',
      },
      rootSpan.spanId,
    );
    const finalDbOverrideSpan = endSpan(dbOverrideSpan, 'ok', {
      overrideApplied: dbOverrideSource !== null,
    });
    emitSpan(finalDbOverrideSpan);
    context.telemetrySpans.push(finalDbOverrideSpan);

    // -------------------------------------------------------------------------
    // Step 6: Build ERPResolution and return stage output
    // -------------------------------------------------------------------------
    const erpResolution: ERPResolution = {
      erpSystem: bestMatch.system,
      databaseEngine: resolvedEngine,
      sqlDialect: resolvedDialect,
      apiOnly: dbMapping.apiOnly,
      detectionSource: bestSource,
      confidence: bestMatch.confidence,
      integrationPoints,
      constraints,
    };

    const finalRootSpan = endSpan(rootSpan, 'ok', {
      erpSystem: bestMatch.system,
      confidence: bestMatch.confidence,
      detectionSource: bestSource,
      matchedKeyword: bestMatch.matchedKeyword,
      apiOnly: dbMapping.apiOnly,
      erpInferredEngine: dbMapping.primaryEngine ?? 'none',
      erpInferredDialect: dbMapping.sqlDialect ?? 'none',
      resolvedEngine: String(resolvedEngine ?? 'none'),
      resolvedDialect: String(resolvedDialect ?? 'none'),
      dbOverrideApplied: dbOverrideSource !== null,
    });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase4StageOutput = {
      stage: 'erp-target-resolution',
      status: 'completed',
      data: erpResolution,
      artifacts: [],
      timing,
      summary:
        `  [OK] Detected ERP system: ${dbMapping.displayName} ` +
        `(confidence=${bestMatch.confidence.toFixed(2)}, ` +
        `source=${bestSource}, keyword='${bestMatch.matchedKeyword}') ` +
        `→ ${dbMapping.apiOnly ? 'API-only' : `${String(resolvedEngine)} / ${String(resolvedDialect)}`}` +
        `${dbOverrideSource ? ` (DB override: ${dbOverrideKeyword})` : ''}` +
        ` in ${timing}ms`,
    };

    context.stageOutputs.set('erp-target-resolution', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);
    context.telemetrySpans.push(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase4StageOutput = {
      stage: 'erp-target-resolution',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `  [FAIL] ERP target resolution failed: ${errorMessage}`,
    };

    context.stageOutputs.set('erp-target-resolution', output);
    return output;
  }
}
