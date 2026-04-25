/**
 * Simulation Artifact Generator
 *
 * PURPOSE: Generate structured artifact files after a simulation completes.
 * Writes to ~/.agentics/runs/<run-id>/ following the same I/O patterns
 * as artifact-writer.ts (atomic writes, SHA-256, 0o600 permissions).
 *
 * Does NOT extend or modify ArtifactWriter (ADR-008 invariant: 4 files only).
 * This is a separate module that writes simulation-specific artifacts.
 *
 * INVARIANTS:
 * - Atomic temp-then-rename writes
 * - SHA-256 checksums for every file
 * - 0o600 file permissions, 0o700 directory permissions
 * - Path traversal prevention
 * - Non-fatal: errors never block simulation result display
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  renderExecutiveSummary,
  renderDecisionMemo,
  buildScenarioArtifact,
  buildRoadmapArtifact,
  buildRiskAssessment,
  renderFinancialAnalysis,
  renderSecurityAssessment,
  renderIntegrationAssessment,
  renderAgentFleetReport,
  computeFleetMetrics,
  synthesizeExecutiveDocument,
  extractSignalPayload,
  enrichSimulationResult,
  type AgentResult,
} from './simulation-renderers.js';
import { RuvectorAdapter } from '../adapters/base-adapter.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import { createClaudeCodeRunner } from '../runtime/claude-code-runner.js';
import { recordDegradation } from '../observability/degradations.js';
import {
  runConsistencyCheck,
  FinancialConsistencyError,
} from './financial-consistency-runner.js';
import {
  classifyLaborIntensity,
  estimateWorkforceExposure,
  buildLaborProfileArtifact,
  isLaborIntensive,
} from './domain-labor-classifier.js';
import { populateConsensusSnapshot } from './consensus-tiers.js';
import { renderConsensusSvg } from './consensus-svg.js';
import { executePreRender } from '../pipeline/phase4-5-pre-render/pre-render-coordinator.js';
import { extractDomainAnalysis } from './simulation-renderers.js';

// ============================================================================
// Constants (match artifact-writer.ts)
// ============================================================================

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const SAFE_RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_RUN_ID_LENGTH = 200;

// ============================================================================
// Types
// ============================================================================

export interface SimulationArtifactInput {
  executionId: string;
  query: string;
  simulationResult: unknown;
  platformAnalysis: AgentResult[];
  correlationId: string;
  timing: number;
}

export interface SimulationArtifactOutput {
  runDir: string;
  filesWritten: string[];
  checksums: Record<string, string>;
  bytesWritten: number;
}

// ============================================================================
// I/O Helpers (match artifact-writer.ts patterns)
// ============================================================================

function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * ADR-PIPELINE-096 D3 diagnostic — walk an agent response object up to
 * `maxDepth` levels and return a flat list of dot-paths. Used by
 * `agent-responses.json` so we can grep across runs to see which paths
 * agents actually expose financial fields at, without dumping full
 * payloads.
 */
function enumerateNestedKeys(value: unknown, maxDepth: number, prefix = ''): string[] {
  if (maxDepth <= 0) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...enumerateNestedKeys(v, maxDepth - 1, path));
    }
  }
  return out;
}

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content, { mode: FILE_MODE, encoding: 'utf-8' });
  fs.renameSync(tmpPath, filePath);
}

function resolveBaseDir(): string {
  return path.join(os.homedir(), '.agentics', 'runs');
}

function validateRunId(runId: string): void {
  if (!runId || runId.length > MAX_RUN_ID_LENGTH) {
    throw new Error(`Invalid run-id length: ${runId?.length ?? 0}`);
  }
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run-id characters: ${runId}`);
  }
  // Path traversal check
  const normalized = path.normalize(runId);
  if (normalized.includes('..') || normalized.includes(path.sep)) {
    throw new Error(`Path traversal detected in run-id: ${runId}`);
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  }
}

// ============================================================================
// ADR-028 Change 1: Hollow Response Detection & LLM Enrichment
// ============================================================================

/** Generic string patterns produced by computeLocal* fallbacks. */
const HOLLOW_STRING_PATTERNS = [
  /^evaluate\b/i,
  /^standard\s+integration\s+risk$/i,
  /^to\s+be\s+determined$/i,
  /^none$/i,
  /^n\/a$/i,
  /^unknown$/i,
  /^default$/i,
  /^placeholder$/i,
  /^generic\b/i,
];

/**
 * Domain priority for enrichment — higher-value domains are enriched first
 * when the total exceeds the per-run cap.
 */
const DOMAIN_ENRICHMENT_PRIORITY: readonly string[] = [
  'costops',
  'connector-hub',
  'sentinel',
  'shield',
  'observatory',
  'platform',
  'test-bench',
  'auto-optimizer',
  'orchestrator',
  'policy-engine',
];

/** Maximum number of hollow responses to enrich per run. */
const MAX_ENRICHMENTS = 10;

/**
 * Recursively scan a value and collect numeric and string leaf values.
 * Returns counts used by the hollowness heuristic.
 */
function collectLeafStats(
  value: unknown,
  stats: { numericTotal: number; numericHollow: number; stringTotal: number; stringHollow: number; arrayTotal: number; arraySingleGeneric: number },
  depth = 0,
): void {
  if (depth > 10) return; // guard against deep/circular structures

  if (typeof value === 'number') {
    stats.numericTotal++;
    if (value === 0 || value === 0.5) {
      stats.numericHollow++;
    }
  } else if (typeof value === 'string' && value.length > 0) {
    stats.stringTotal++;
    if (HOLLOW_STRING_PATTERNS.some(p => p.test(value))) {
      stats.stringHollow++;
    }
  } else if (Array.isArray(value)) {
    stats.arrayTotal++;
    if (value.length === 1) {
      const elem = value[0];
      if (typeof elem === 'string' && HOLLOW_STRING_PATTERNS.some(p => p.test(elem))) {
        stats.arraySingleGeneric++;
      }
    }
    for (const item of value) {
      collectLeafStats(item, stats, depth + 1);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectLeafStats(v, stats, depth + 1);
    }
  }
}

/**
 * Detect whether an agent response came from a `computeLocal*` fallback.
 *
 * Heuristic: if >60% of numeric leaf values are 0 or 0.5, AND string values
 * match generic placeholder patterns, the response is hollow.
 */
export function isHollowAgentResponse(result: AgentResult): boolean {
  const response = result.response;
  if (response === null || response === undefined || typeof response !== 'object') {
    return false;
  }

  // Error responses (status >= 400) are not hollow — they're just failed.
  // Don't waste enrichment budget on error payloads like { error: "..." }.
  if (result.status >= 400) {
    return false;
  }

  // Responses marked _fallback: true are intentional synthetic data
  // (e.g. costops generating realistic financial projections, test-bench
  // generating evaluation scores). These are not broken — skip them.
  const resp = response as Record<string, unknown>;
  if (resp['_fallback'] === true) {
    return false;
  }

  // Responses with execution_metadata came from a real cloud function —
  // they contain genuine service output, not hollow placeholders.
  if ('execution_metadata' in resp) {
    return false;
  }

  // Responses with an error field are failed calls, not hollow data.
  if ('error' in resp && Object.keys(resp).length <= 2) {
    return false;
  }

  const stats = {
    numericTotal: 0,
    numericHollow: 0,
    stringTotal: 0,
    stringHollow: 0,
    arrayTotal: 0,
    arraySingleGeneric: 0,
  };

  collectLeafStats(response, stats);

  // Need a meaningful sample to judge — small responses are likely
  // legitimate short results, not hollow placeholders. Require at least
  // 4 leaf values (up from 2) to reduce false positives on terse but
  // real responses from cloud functions.
  const totalLeaves = stats.numericTotal + stats.stringTotal;
  if (totalLeaves < 4) return false;

  const numericHollowRatio = stats.numericTotal > 0
    ? stats.numericHollow / stats.numericTotal
    : 0;
  const stringHollowRatio = stats.stringTotal > 0
    ? stats.stringHollow / stats.stringTotal
    : 0;

  // Primary signal: >60% of numeric values are 0 or 0.5, AND at least 3 hollow numerics
  // (raised minimum from 2 to 3 to avoid flagging responses with e.g. { score: 0.5, count: 0 })
  if (stats.numericTotal >= 3 && numericHollowRatio > 0.6) {
    return true;
  }

  // Secondary signal: majority of strings are generic AND at least some hollow numerics
  if (stats.stringTotal >= 3 && stringHollowRatio > 0.5 && numericHollowRatio >= 0.5) {
    return true;
  }

  // Tertiary: arrays are all single-element generic + hollow numerics
  if (stats.arraySingleGeneric > 0 && stats.arraySingleGeneric === stats.arrayTotal && numericHollowRatio >= 0.5) {
    return true;
  }

  return false;
}

/**
 * Enrich hollow agent responses by calling Claude to fill in domain-specific
 * values. Non-fatal: any LLM failure preserves the original response.
 *
 * Prioritizes domains by business importance and caps at MAX_ENRICHMENTS.
 */
export function enrichHollowAgentResponses(
  results: AgentResult[],
  query: string,
): AgentResult[] {
  // Identify hollow responses
  const hollowIndices: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && isHollowAgentResponse(r)) {
      hollowIndices.push(i);
    }
  }

  if (hollowIndices.length === 0) {
    return results;
  }

  process.stderr.write(
    `[adr-028] Detected ${hollowIndices.length} hollow agent response(s) out of ${results.length} total\n`,
  );

  // Sort hollow indices by domain priority (lower index in priority list = higher priority)
  hollowIndices.sort((a, b) => {
    const domainA = results[a]!.domain;
    const domainB = results[b]!.domain;
    const prioA = DOMAIN_ENRICHMENT_PRIORITY.indexOf(domainA);
    const prioB = DOMAIN_ENRICHMENT_PRIORITY.indexOf(domainB);
    // Domains in the priority list come first; unknown domains go to the end
    const effectiveA = prioA === -1 ? DOMAIN_ENRICHMENT_PRIORITY.length : prioA;
    const effectiveB = prioB === -1 ? DOMAIN_ENRICHMENT_PRIORITY.length : prioB;
    return effectiveA - effectiveB;
  });

  // Cap enrichments
  const toEnrich = hollowIndices.slice(0, MAX_ENRICHMENTS);

  let runner: ReturnType<typeof createClaudeCodeRunner>;
  try {
    runner = createClaudeCodeRunner();
  } catch {
    process.stderr.write('[adr-028] Could not create Claude Code runner; skipping enrichment\n');
    return results;
  }

  // Clone results so we don't mutate the input array
  const enriched = [...results];
  let successCount = 0;

  for (const idx of toEnrich) {
    const original = results[idx]!;
    const responseJson = JSON.stringify(original.response, null, 2);

    // Truncate large responses to keep prompt reasonable
    const truncatedResponse = responseJson.length > 3000
      ? responseJson.slice(0, 3000) + '\n...(truncated)'
      : responseJson;

    const prompt = [
      `You are a ${original.domain}/${original.agent} specialist.`,
      `The user's enterprise scenario is: ${query}`,
      '',
      'Generate a realistic, domain-specific agent response as JSON with the SAME structure as the template below.',
      'Fill in real domain-specific values: real numbers, real recommendations, real findings specific to this scenario.',
      'Do NOT use placeholder values like 0, 0.5, "Evaluate...", "standard integration risk", or "none".',
      'Return ONLY valid JSON, no markdown fences, no explanation.',
      '',
      'Template structure:',
      truncatedResponse,
    ].join('\n');

    try {
      const result = runner.invoke<Record<string, unknown>>(prompt, {
        runId: `enrich-agent-${original.domain}-${original.agent}`,
        timeoutMs: 60_000,
      });

      // The runner unwraps the Claude Code envelope. result.data is the parsed JSON.
      // If data has a `content` string field (text envelope), try parsing it as JSON.
      let enrichedResponse: unknown = result.data;
      if (
        enrichedResponse &&
        typeof enrichedResponse === 'object' &&
        'content' in (enrichedResponse as Record<string, unknown>)
      ) {
        const content = (enrichedResponse as Record<string, unknown>)['content'];
        if (typeof content === 'string') {
          try {
            enrichedResponse = JSON.parse(content);
          } catch {
            // content wasn't JSON; use the data object as-is
          }
        }
      }

      // Merge: preserve metadata (domain, agent, status), replace response
      enriched[idx] = {
        domain: original.domain,
        agent: original.agent,
        status: original.status,
        response: enrichedResponse,
      };
      successCount++;
    } catch {
      // Non-fatal: keep original hollow response
      process.stderr.write(
        `[adr-028] Enrichment failed for ${original.domain}/${original.agent}; keeping original\n`,
      );
    }
  }

  process.stderr.write(
    `[adr-028] Enriched ${successCount}/${toEnrich.length} hollow response(s) successfully\n`,
  );

  return enriched;
}

// ============================================================================
// Main Generator
// ============================================================================

export function generateSimulationArtifacts(
  input: SimulationArtifactInput,
): SimulationArtifactOutput {
  const runId = sanitizeRunId(input.executionId || input.correlationId || crypto.randomUUID());
  validateRunId(runId);

  const baseDir = resolveBaseDir();
  const runDir = path.join(baseDir, runId);
  ensureDir(runDir);

  const filesWritten: string[] = [];
  const checksums: Record<string, string> = {};
  let bytesWritten = 0;

  // Normalize platform results into AgentResult[]
  let platformResults = normalizePlatformResults(input.platformAnalysis);

  // ADR-028 Change 1: Enrich hollow agent responses with LLM-generated domain knowledge
  try {
    platformResults = enrichHollowAgentResponses(platformResults, input.query);
  } catch {
    // Enrichment is non-fatal; continue with original results
    process.stderr.write('[adr-028] Enrichment pass threw unexpectedly; continuing with original results\n');
  }

  // ADR-PIPELINE-017: Consensus Validation Gate
  // Check if the consensus agent returned low agreement and surface warnings
  const consensusValidation = validateConsensusResults(platformResults);
  if (consensusValidation.hasConsensus && !consensusValidation.meetsThreshold) {
    process.stderr.write(
      `[pipeline-017] WARNING: Consensus agent returned ${consensusValidation.agreementLevel}% agreement ` +
      `(below ${consensusValidation.threshold}% threshold). ` +
      `Disagreement areas: ${consensusValidation.disagreementAreas.join(', ') || 'unspecified'}. ` +
      `Pipeline proceeding but downstream artifacts should be reviewed with extra scrutiny.\n`,
    );
    // ADR-PIPELINE-089 §2: surface as a structured degradation for the
    // Phase 1 verdict.
    recordDegradation(input.correlationId, {
      code: 'consensus-low',
      message: `Consensus at ${consensusValidation.agreementLevel}% (threshold: ${consensusValidation.threshold}%). Disagreement: ${consensusValidation.disagreementAreas.join(', ') || 'unspecified'}`,
      phase: 1,
      source: 'pipeline-017',
    });
  }

  // 1. manifest.json (includes consensus validation metadata)
  const manifest = buildManifest(input, platformResults, runId);
  if (consensusValidation.hasConsensus) {
    (manifest as Record<string, unknown>)['consensus_validation'] = {
      agreement_level_pct: consensusValidation.agreementLevel,
      threshold_pct: consensusValidation.threshold,
      meets_threshold: consensusValidation.meetsThreshold,
      disagreement_areas: consensusValidation.disagreementAreas,
      dissenting_views: consensusValidation.dissenting,
    };
  }
  const manifestContent = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(runDir, 'manifest.json');
  atomicWriteFile(manifestPath, manifestContent);
  filesWritten.push('manifest.json');
  checksums['manifest.json'] = computeChecksum(manifestContent);
  bytesWritten += Buffer.byteLength(manifestContent, 'utf-8');

  // ADR-PIPELINE-096 D3 diagnostic — persist raw agent responses so the
  // agent-claim-registry can be calibrated against the actual response
  // shapes Cloud Run agents return. Pre-this-patch the registry's paths
  // (`data.investment`, `data.roi`, etc.) lit 0 src= attributions on real
  // runs because we couldn't see what shapes the agents actually returned.
  // This dump unblocks calibration. Truncated to 8KB per agent to keep the
  // file shippable; full payloads are NOT secrets but a 109-agent fleet at
  // full payload = ~MB.
  try {
    const agentResponses = platformResults.map(r => {
      const agent = r as { domain?: string; agent?: string };
      const respStr = JSON.stringify(r.response ?? null);
      const truncated = respStr.length > 8192 ? respStr.slice(0, 8192) + '... [truncated]' : respStr;
      return {
        domain: agent.domain ?? 'unknown',
        agent: agent.agent ?? 'unknown',
        status: r.status,
        response_keys: r.response && typeof r.response === 'object' && !Array.isArray(r.response)
          ? Object.keys(r.response as Record<string, unknown>)
          : null,
        // Full nested key map up to depth 3, so we can see registry-relevant paths.
        nested_keys: enumerateNestedKeys(r.response, 3),
        response_truncated: truncated,
      };
    });
    const respContent = JSON.stringify({
      run_id: runId,
      generated_at: new Date().toISOString(),
      adr: 'ADR-PIPELINE-096 D3 diagnostic',
      total_agents: platformResults.length,
      agents: agentResponses,
    }, null, 2);
    const respPath = path.join(runDir, 'agent-responses.json');
    atomicWriteFile(respPath, respContent);
    filesWritten.push('agent-responses.json');
    bytesWritten += Buffer.byteLength(respContent, 'utf-8');
  } catch (err) {
    process.stderr.write(`[ADR-096-DIAG] failed to persist agent-responses.json: ${(err as Error).message}\n`);
  }

  // ADR-PIPELINE-044: Enrich simulation result before any renderer consumes it
  const enrichedSimResult = enrichSimulationResult(
    extractSignalPayload(input.simulationResult).data ?? {},
    input.query,
  );
  // Wrap enriched data back into the signal format renderers expect
  const enrichedResult = { signal: { payload: { data: enrichedSimResult } } };

  // 2. scenario.json
  const scenario = buildScenarioArtifact(input.query, enrichedResult, platformResults);
  const scenarioContent = JSON.stringify(scenario, null, 2);
  const scenarioPath = path.join(runDir, 'scenario.json');
  atomicWriteFile(scenarioPath, scenarioContent);
  filesWritten.push('scenario.json');
  checksums['scenario.json'] = computeChecksum(scenarioContent);
  bytesWritten += Buffer.byteLength(scenarioContent, 'utf-8');

  // 3. roadmap.json
  const roadmap = buildRoadmapArtifact(input.query, enrichedResult, platformResults);
  const roadmapContent = JSON.stringify(roadmap, null, 2);
  const roadmapPath = path.join(runDir, 'roadmap.json');
  atomicWriteFile(roadmapPath, roadmapContent);
  filesWritten.push('roadmap.json');
  checksums['roadmap.json'] = computeChecksum(roadmapContent);
  bytesWritten += Buffer.byteLength(roadmapContent, 'utf-8');

  // ADR-PIPELINE-072: Pre-Render Analysis Pass. Produces unit-economics.json
  // BEFORE the exec summary / decision memo / financial analysis renderers
  // run, so ADR-066's tier-1 path fires on every run and the per-employee
  // heuristic fallback disappears from executive output.
  //
  // The preview is written to TWO paths:
  //   - unit-economics.json             → consumed by the renderer
  //   - unit-economics.preview.json     → preserved for the reconciler so
  //                                        the prototype can overwrite the
  //                                        first without clobbering the
  //                                        preview baseline
  try {
    const preRenderDomainAnalysis = extractDomainAnalysis(enrichedSimResult, input.query);
    const preRender = executePreRender({
      runDir,
      runId,
      query: input.query,
      scenarioArtifact: scenario as Record<string, unknown>,
      domainAnalysis: preRenderDomainAnalysis,
    });
    if (preRender.status === 'emitted') {
      filesWritten.push('unit-economics.json');
      checksums['unit-economics.json'] = computeChecksum(fs.readFileSync(preRender.manifestPath, 'utf-8'));
      bytesWritten += fs.statSync(preRender.manifestPath).size;

      // Mirror to unit-economics.preview.json for the reconciler.
      const previewMirrorPath = path.join(runDir, 'unit-economics.preview.json');
      const previewContent = JSON.stringify(preRender.manifest, null, 2) + '\n';
      atomicWriteFile(previewMirrorPath, previewContent);
      filesWritten.push('unit-economics.preview.json');
      checksums['unit-economics.preview.json'] = computeChecksum(previewContent);
      bytesWritten += Buffer.byteLength(previewContent, 'utf-8');

      process.stderr.write(
        `[pipeline-072] Pre-render emitted unit-economics.json: sector=${preRender.metrics.sector} ` +
        `pilot=$${preRender.metrics.annualMeasuredSavingsUsd.toLocaleString()}/yr ` +
        `enterprise=$${preRender.metrics.annualExtrapolatedSavingsUsd.toLocaleString()}/yr\n`,
      );
    } else {
      process.stderr.write(
        `[pipeline-072] Pre-render skipped: ${preRender.reason}` +
        (preRender.detail ? ` (${preRender.detail})` : '') + '\n',
      );
      // ADR-PIPELINE-089 §2: only unknown-sector is user-actionable;
      // other skip reasons (e.g. "no scenario steps") are expected on
      // short queries. Surface unknown-sector as a degradation so the
      // user knows the executive docs are using ADR-066 tier-3 fallback
      // instead of the domain-specific model.
      if (preRender.reason === 'unknown-sector') {
        recordDegradation(input.correlationId, {
          code: 'sector-unknown',
          message: 'Pre-render skipped: classifySector returned "unknown" — executive docs will use generic fallback',
          phase: 1,
          source: 'pipeline-072',
        });
      }
    }
  } catch (err) {
    // Pre-render is non-fatal — renderers fall back to ADR-066 tier-3.
    process.stderr.write(
      `[pipeline-072] Pre-render threw unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // 4. executive-summary.md
  // ADR-PIPELINE-096 D3++ (2.7.14) — pass runDir so the renderer can
  // apply unit-economics-derived bottom-up methodology when the manifest
  // is available. Same call serves all three docs (exec, decision, fin-analysis).
  const execSummary = renderExecutiveSummary(input.query, enrichedResult, platformResults, runDir);
  const execPath = path.join(runDir, 'executive-summary.md');
  atomicWriteFile(execPath, execSummary);
  filesWritten.push('executive-summary.md');
  checksums['executive-summary.md'] = computeChecksum(execSummary);
  bytesWritten += Buffer.byteLength(execSummary, 'utf-8');

  // 5. risk-assessment.json
  const risk = buildRiskAssessment(input.query, enrichedResult, platformResults);
  const riskContent = JSON.stringify(risk, null, 2);
  const riskPath = path.join(runDir, 'risk-assessment.json');
  atomicWriteFile(riskPath, riskContent);
  filesWritten.push('risk-assessment.json');
  checksums['risk-assessment.json'] = computeChecksum(riskContent);
  bytesWritten += Buffer.byteLength(riskContent, 'utf-8');

  // 6. decision-memo.md (ADR-096 D3++ — runDir for unit-economics methodology)
  const decisionMemo = renderDecisionMemo(input.query, enrichedResult, platformResults, runDir);
  const memoPath = path.join(runDir, 'decision-memo.md');
  atomicWriteFile(memoPath, decisionMemo);
  filesWritten.push('decision-memo.md');
  checksums['decision-memo.md'] = computeChecksum(decisionMemo);
  bytesWritten += Buffer.byteLength(decisionMemo, 'utf-8');

  // 7. Financial Analysis (ADR-PIPELINE-020: costops agents → document)
  // ADR-PIPELINE-066: pass runDir so the renderer can load unit-economics.json
  const financialAnalysis = renderFinancialAnalysis(input.query, enrichedResult, platformResults, runDir);
  const financialPath = path.join(runDir, 'financial-analysis.md');
  atomicWriteFile(financialPath, financialAnalysis);
  filesWritten.push('financial-analysis.md');
  checksums['financial-analysis.md'] = computeChecksum(financialAnalysis);
  bytesWritten += Buffer.byteLength(financialAnalysis, 'utf-8');

  // ADR-PIPELINE-070: persist labor-profile.json for downstream consumers
  // (the ReasoningBank, future LLM rewriters, and human review). Best-
  // effort — never blocks artifact emission on a classifier failure.
  try {
    const laborDomainAnalysis = (enrichedSimResult['domain_analysis'] ?? null) as
      | { domain: string; keyMetrics: Record<string, number | string>; scenarios: unknown[]; confidence: number; methodology: string }
      | null;
    const laborProfile = classifyLaborIntensity(laborDomainAnalysis as never, input.query);
    let exposure = null;
    if (isLaborIntensive(laborProfile)) {
      exposure = estimateWorkforceExposure(laborProfile, {
        employees: 0,
        operationalUnits: undefined,
        pilotInvestmentUsd: undefined,
      });
    }
    const laborArtifact = buildLaborProfileArtifact(laborProfile, exposure);
    const laborPath = path.join(runDir, 'labor-profile.json');
    const laborContent = JSON.stringify(laborArtifact, null, 2);
    atomicWriteFile(laborPath, laborContent);
    filesWritten.push('labor-profile.json');
    checksums['labor-profile.json'] = computeChecksum(laborContent);
    bytesWritten += Buffer.byteLength(laborContent, 'utf-8');
  } catch {
    // Classifier persistence is best-effort.
  }

  // ADR-PIPELINE-040: LLM synthesis pass — rewrite exec docs into consulting-grade prose
  // Fire-and-forget: skeleton is already written, synthesis overwrites if successful.
  // Build a condensed agent summary for evidence (not raw JSON — just key findings)
  const agentSummary = platformResults
    .filter(r => r.status >= 200 && r.status < 300)
    .map(r => {
      const data = extractSignalPayload(r.response).data;
      if (!data) return '';
      const findings = Array.isArray(data['findings']) ? data['findings'].slice(0, 3).join('; ') : '';
      const summary = typeof data['summary'] === 'string' ? data['summary'].slice(0, 200) : '';
      return `${r.domain}/${r.agent}: ${summary || findings || 'completed'}`;
    })
    .filter(Boolean)
    .join('\n');

  // ADR-PIPELINE-089 §4: pass the correlation id through so tag-survival
  // failures are recorded to the trace-keyed degradation sink and can
  // bubble into the Phase 1 verdict / status.json.
  Promise.allSettled([
    synthesizeExecutiveDocument(execSummary, input.query, 'executive-summary', agentSummary, input.correlationId)
      .then(synth => { if (synth !== execSummary) atomicWriteFile(execPath, synth); }),
    synthesizeExecutiveDocument(decisionMemo, input.query, 'decision-memo', agentSummary, input.correlationId)
      .then(synth => { if (synth !== decisionMemo) atomicWriteFile(memoPath, synth); }),
    synthesizeExecutiveDocument(financialAnalysis, input.query, 'financial-analysis', agentSummary, input.correlationId)
      .then(synth => { if (synth !== financialAnalysis) atomicWriteFile(financialPath, synth); }),
  ]).catch(() => { /* skeleton docs already written — synthesis is best-effort */ });

  // 8. Security Assessment (ADR-PIPELINE-020: shield agents → document)
  const securityAssessment = renderSecurityAssessment(input.query, enrichedResult, platformResults);
  const securityPath = path.join(runDir, 'security-assessment.md');
  atomicWriteFile(securityPath, securityAssessment);
  filesWritten.push('security-assessment.md');
  checksums['security-assessment.md'] = computeChecksum(securityAssessment);
  bytesWritten += Buffer.byteLength(securityAssessment, 'utf-8');

  // 9. Integration Assessment (ADR-PIPELINE-020: connector-hub agents → document)
  const integrationAssessment = renderIntegrationAssessment(input.query, enrichedResult, platformResults);
  const integrationPath = path.join(runDir, 'integration-assessment.md');
  atomicWriteFile(integrationPath, integrationAssessment);
  filesWritten.push('integration-assessment.md');
  checksums['integration-assessment.md'] = computeChecksum(integrationAssessment);
  bytesWritten += Buffer.byteLength(integrationAssessment, 'utf-8');

  // 10. Agent Fleet Report (ADR-PIPELINE-020: all agents → utilization report)
  const fleetReport = renderAgentFleetReport(input.query, enrichedResult, platformResults);
  const fleetPath = path.join(runDir, 'agent-fleet-report.md');
  atomicWriteFile(fleetPath, fleetReport);
  filesWritten.push('agent-fleet-report.md');
  checksums['agent-fleet-report.md'] = computeChecksum(fleetReport);
  bytesWritten += Buffer.byteLength(fleetReport, 'utf-8');

  // ADR-PIPELINE-071: persist consensus snapshot + SVG for downstream
  // consumers (board decks, ReasoningBank, future LLM rewriters). The
  // snapshot is also passed into the consistency runner so FCR-010 can
  // scan for forbidden spin phrases on contested runs.
  const consensusSnapshot = populateConsensusSnapshot(enrichedResult, platformResults);
  try {
    const snapshotPath = path.join(runDir, 'consensus.json');
    const snapshotContent = JSON.stringify(
      {
        version: '1.0',
        generated_at: new Date().toISOString(),
        snapshot: consensusSnapshot,
      },
      null,
      2,
    );
    atomicWriteFile(snapshotPath, snapshotContent);
    filesWritten.push('consensus.json');
    checksums['consensus.json'] = computeChecksum(snapshotContent);
    bytesWritten += Buffer.byteLength(snapshotContent, 'utf-8');

    // SVG only when the tier is non-aligned — aligned runs don't need the
    // visual since the textual story is sufficient.
    if (consensusSnapshot.tier !== 'aligned') {
      const svgPath = path.join(runDir, 'consensus.svg');
      const svgContent = renderConsensusSvg(consensusSnapshot);
      atomicWriteFile(svgPath, svgContent);
      filesWritten.push('consensus.svg');
      checksums['consensus.svg'] = computeChecksum(svgContent);
      bytesWritten += Buffer.byteLength(svgContent, 'utf-8');
    }
  } catch {
    // Persistence is best-effort.
  }

  // ADR-PIPELINE-067: cross-document financial consistency check.
  // Runs after every markdown artifact is on disk. Writes
  // financial-consistency.report.json and, by default, prepends a warning
  // header to any document with violations. Under AGENTICS_STRICT_FCV=true
  // the runner throws ECLI-SYN-067 and blocks the pipeline.
  // ADR-PIPELINE-071: pass the consensus snapshot through so FCR-010 fires.
  try {
    const consistencyResult = runConsistencyCheck({
      runDir,
      runId,
      documents: [
        { kind: 'executive-summary', path: execPath, content: execSummary },
        { kind: 'decision-memo', path: memoPath, content: decisionMemo },
        { kind: 'financial-analysis', path: financialPath, content: financialAnalysis },
      ],
      consensus: consensusSnapshot,
      annotateDocuments: true,
    });
    filesWritten.push('financial-consistency.report.json');
    checksums['financial-consistency.report.json'] = computeChecksum(
      fs.readFileSync(consistencyResult.reportPath, 'utf-8'),
    );
  } catch (err) {
    if (err instanceof FinancialConsistencyError) throw err;
    // Any other error in the runner is non-fatal — the skeleton documents are
    // already on disk and we prefer not to block the pipeline on a bug in the
    // consistency pass.
  }

  // ADR-PIPELINE-023: Add fleet metrics to manifest
  const fleetMetrics = computeFleetMetrics(platformResults);
  (manifest as Record<string, unknown>)['fleet_metrics'] = {
    total_invoked: fleetMetrics.totalInvoked,
    successful: fleetMetrics.successful,
    failed: fleetMetrics.failed,
    effectiveness_score: fleetMetrics.totalInvoked > 0
      ? Math.round((fleetMetrics.successful / fleetMetrics.totalInvoked) * 100)
      : 0,
    domain_breakdown: fleetMetrics.domainBreakdown,
  };
  // Re-write manifest with fleet metrics
  const updatedManifestContent = JSON.stringify(manifest, null, 2);
  atomicWriteFile(manifestPath, updatedManifestContent);
  checksums['manifest.json'] = computeChecksum(updatedManifestContent);

  // 11. Ruvector full API integration — lineage, ERP mappings, integration proposals
  //    Non-fatal: errors here never block artifact output
  storeRuvectorLineageAndMappings(input, runId, filesWritten, checksums, platformResults);

  return { runDir, filesWritten, checksums, bytesWritten };
}

// ============================================================================
// Helpers
// ============================================================================

function sanitizeRunId(id: string): string {
  // Replace invalid characters with hyphens, ensure starts with alphanumeric
  let sanitized = id.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (sanitized.length === 0 || !/^[a-zA-Z0-9]/.test(sanitized)) {
    sanitized = `sim-${sanitized}`;
  }
  if (sanitized.length > MAX_RUN_ID_LENGTH) {
    sanitized = sanitized.slice(0, MAX_RUN_ID_LENGTH);
  }
  return sanitized;
}

function normalizePlatformResults(raw: unknown[]): AgentResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      return {
        domain: String(r['domain'] ?? 'unknown'),
        agent: String(r['agent'] ?? 'unknown'),
        status: typeof r['status'] === 'number' ? r['status'] : 200,
        response: r['response'] ?? r,
      };
    }
    return { domain: 'unknown', agent: 'unknown', status: 200, response: item };
  });
}

function buildManifest(
  input: SimulationArtifactInput,
  platformResults: AgentResult[],
  runId: string,
): Record<string, unknown> {
  const agents_invoked = [
    { domain: 'simulator', agent: 'enterprise', status: 'invoked' },
    ...platformResults.map(r => ({
      domain: r.domain,
      agent: r.agent,
      status: r.status >= 200 && r.status < 300 ? 'success' : 'error',
    })),
  ];
  return {
    run_id: runId,
    execution_id: input.executionId,
    correlation_id: input.correlationId,
    query: input.query,
    created_at: new Date().toISOString(),
    timing_ms: input.timing,
    agents_invoked,
    artifacts: [
      'manifest.json',
      'scenario.json',
      'roadmap.json',
      'executive-summary.md',
      'risk-assessment.json',
      'decision-memo.md',
      'financial-analysis.md',
      'security-assessment.md',
      'integration-assessment.md',
      'agent-fleet-report.md',
    ],
    // ADR-PIPELINE-096 D2 — runtime lineage block. Populated from the same
    // platformResults the rest of the manifest is built from, plus a fresh
    // Ruflo availability probe (cached). Backwards-compatible: pre-D2
    // consumers ignore unknown top-level keys per ADR-088.
    runtime: buildRuntimeLineage(agents_invoked),
    schema_version: '1.1.0',
  };
}

/**
 * ADR-096 D2 — assemble the manifest.runtime block (full-fleet path).
 * Mirrors ask-artifact-writer's buildRuntimeLineage but lives here because
 * the full-fleet pipeline writes its own manifest, not via persistAskResults.
 */
function buildRuntimeLineage(agents_invoked: ReadonlyArray<{ domain: string; agent: string; status: string }>): Record<string, unknown> {
  // Ruflo probe — cached after first call (ADR-094 optimization).
  let ruflo: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rufloMod = require('../pipeline/ruflo-phase-executor.js') as { checkRufloAvailable?: () => unknown };
    const probe = typeof rufloMod.checkRufloAvailable === 'function' ? rufloMod.checkRufloAvailable() : null;
    if (probe && typeof probe === 'object') {
      const p = probe as Record<string, unknown>;
      ruflo = {
        available: Boolean(p['available']),
        version: typeof p['version'] === 'string' ? p['version'] : 'N/A',
        binary: typeof p['binary'] === 'string' ? p['binary'] : '',
        reason: typeof p['reason'] === 'string' ? p['reason'] : (p['available'] ? 'ok' : 'unknown'),
      };
    } else {
      ruflo = { available: false, version: 'N/A', binary: '', reason: 'probe-failed' };
    }
  } catch {
    ruflo = { available: false, version: 'N/A', binary: '', reason: 'probe-threw' };
  }

  // Hyperbolic-simulation enumeration: every simulator/* invocation is one.
  const simulatorAgents = agents_invoked.filter(a => a.domain === 'simulator');
  const ruvector = {
    hyperbolic_simulations: simulatorAgents.map(a => ({
      agent: `${a.domain}/${a.agent}`,
      status: a.status,
    })),
    embedding_lookups: 0,
    graph_routing_invocations: 0,  // full-fleet path bypasses graph routing
  };

  // Per-domain breakdown of dispatch outcomes.
  const byDomain: Record<string, { dispatched: number; succeeded: number; failed: number }> = {};
  for (const a of agents_invoked) {
    const slot = byDomain[a.domain] ?? { dispatched: 0, succeeded: 0, failed: 0 };
    slot.dispatched++;
    if (a.status === 'success' || a.status === 'invoked') slot.succeeded++;
    else slot.failed++;
    byDomain[a.domain] = slot;
  }
  const dispatched = agents_invoked.length;
  const succeeded = agents_invoked.filter(a => a.status === 'success' || a.status === 'invoked').length;
  const failed = dispatched - succeeded;
  const inferredDepth = dispatched >= 100 ? 'consultancy' : dispatched >= 20 ? 'standard' : 'lite';
  const fleet = {
    depth: inferredDepth,
    dispatched,
    succeeded,
    failed,
    by_domain: byDomain,
    cloud_breaker: { tripped: false },
  };

  return { ruflo, ruvector, fleet };
}

// ============================================================================
// ADR-PIPELINE-017: Consensus Validation Gate
//
// Checks analytics-hub/consensus agent results for agreement level.
// When consensus is below threshold (default 60%), emits a structured
// warning and includes validation metadata in the manifest.
// The pipeline is NOT blocked — low consensus is a quality signal, not a gate.
// ============================================================================

const DEFAULT_CONSENSUS_THRESHOLD = 60;

interface ConsensusValidationResult {
  hasConsensus: boolean;
  meetsThreshold: boolean;
  agreementLevel: number;
  threshold: number;
  disagreementAreas: string[];
  dissenting: string[];
}

export function validateConsensusResults(results: AgentResult[]): ConsensusValidationResult {
  const threshold = Number(process.env['AGENTICS_CONSENSUS_THRESHOLD']) || DEFAULT_CONSENSUS_THRESHOLD;

  // Find the consensus agent result
  const consensusResult = results.find(
    r => r.domain === 'analytics-hub' && r.agent === 'consensus' && r.status >= 200 && r.status < 300,
  );

  if (!consensusResult) {
    return { hasConsensus: false, meetsThreshold: true, agreementLevel: 0, threshold, disagreementAreas: [], dissenting: [] };
  }

  const resp = consensusResult.response as Record<string, unknown> | undefined;
  if (!resp) {
    return { hasConsensus: false, meetsThreshold: true, agreementLevel: 0, threshold, disagreementAreas: [], dissenting: [] };
  }

  // Extract agreement level from consensus_result or confidence_aggregation
  let agreementLevel = 0;
  const confAgg = resp['confidence_aggregation'] as Record<string, unknown> | undefined;
  if (confAgg && typeof confAgg['overall_confidence'] === 'number') {
    agreementLevel = Math.round(confAgg['overall_confidence'] * 100);
  } else if (typeof resp['overall_confidence'] === 'number') {
    agreementLevel = Math.round((resp['overall_confidence'] as number) * 100);
  } else {
    // Try to compute from agreement/disagreement areas
    const consensusData = resp['consensus_result'] as Record<string, unknown> | undefined;
    if (consensusData) {
      const agreeCount = Array.isArray(consensusData['agreement_areas']) ? consensusData['agreement_areas'].length : 0;
      const disagreeCount = Array.isArray(consensusData['disagreement_areas']) ? consensusData['disagreement_areas'].length : 0;
      const total = agreeCount + disagreeCount;
      agreementLevel = total > 0 ? Math.round((agreeCount / total) * 100) : 0;
    }
  }

  // Extract disagreement areas
  const consensusData = resp['consensus_result'] as Record<string, unknown> | undefined;
  const disagreementAreas: string[] = [];
  if (consensusData && Array.isArray(consensusData['disagreement_areas'])) {
    for (const area of consensusData['disagreement_areas']) {
      if (typeof area === 'string') disagreementAreas.push(area);
      else if (area && typeof area === 'object') {
        const a = area as Record<string, unknown>;
        disagreementAreas.push(String(a['topic'] ?? a['area'] ?? a['description'] ?? JSON.stringify(a)));
      }
    }
  }

  // Extract dissenting views
  const dissenting: string[] = [];
  if (Array.isArray(resp['dissenting_views'])) {
    for (const view of resp['dissenting_views']) {
      if (typeof view === 'string') dissenting.push(view);
      else if (view && typeof view === 'object') {
        const v = view as Record<string, unknown>;
        dissenting.push(String(v['view'] ?? v['description'] ?? JSON.stringify(v)));
      }
    }
  }

  return {
    hasConsensus: true,
    meetsThreshold: agreementLevel >= threshold,
    agreementLevel,
    threshold,
    disagreementAreas,
    dissenting,
  };
}

// ============================================================================
// Ruvector Full API Integration
// ============================================================================

/**
 * Store lineage records, integration proposals, and ERP mappings in Ruvector.
 *
 * Uses the full breadth of Ruvector's API (ADR-004 invariants 2, 3, 5, 6):
 *   - storeLineage: artifact provenance linking each file to the simulation
 *   - updateSimulation: progress tracking as artifacts are generated
 *   - storeIntegrationProposal: integration changes from connector-hub agents
 *   - storeErpMapping: ERP entity mappings from scenario extraction
 *
 * All calls are non-fatal — errors are logged but never block artifact output.
 */
function storeRuvectorLineageAndMappings(
  input: SimulationArtifactInput,
  runId: string,
  filesWritten: string[],
  checksums: Record<string, string>,
  platformResults: AgentResult[],
): void {
  // Fire-and-forget: ruvector calls run async, never block
  void (async () => {
    try {
      const ruvectorConfig = loadEndpointConfig('ruvector-service');
      const adapter = new RuvectorAdapter(ruvectorConfig, input.correlationId);
      const now = new Date().toISOString();
      const simulationId = input.executionId || input.correlationId;
      const attribution = { created_by: 'agentics-cli', org_id: 'default' };

      // 1. Update simulation status — mark as "artifacts_generated"
      try {
        await adapter.updateSimulation(simulationId, {
          status: 'artifacts_generated',
          artifact_ids: filesWritten.map(f => `${runId}/${f}`),
          updated_at: now,
          checksum: checksums['manifest.json'] ?? '',
        });
      } catch { /* non-fatal */ }

      // 2. Store lineage records — every artifact linked to the simulation
      for (const file of filesWritten) {
        const category = file.endsWith('.json') ? 'structured-data' :
          file.endsWith('.md') ? 'document' : 'artifact';
        try {
          await adapter.storeLineage({
            id: `lineage-${runId}-${file.replace(/[^a-z0-9]/gi, '-')}`,
            artifact_id: `${runId}/${file}`,
            artifact_category: category,
            simulation_id: simulationId,
            decision_context: `Generated from enterprise simulation: ${input.query.slice(0, 200)}`,
            attribution,
            governance: {
              gate_pipeline_version: '1.0.0',
              synthesis_classification: 'simulation-artifact',
            },
            created_at: now,
          });
        } catch { /* non-fatal: lineage storage is best-effort */ }
      }

      // 3. Integration proposals from connector-hub agents
      const connectorAgents = platformResults.filter(
        r => r.domain === 'connector-hub' && r.status >= 200 && r.status < 300,
      );
      for (const agent of connectorAgents) {
        const resp = agent.response as Record<string, unknown> | null;
        const proposedChanges = resp?.['proposed_changes'] ?? resp?.['integration'] ?? `${agent.agent} integration`;
        const risks = Array.isArray(resp?.['risks']) ? (resp['risks'] as string[]) : ['standard integration risk'];
        const deps = Array.isArray(resp?.['dependencies']) ? (resp['dependencies'] as string[]) : [];

        try {
          await adapter.storeIntegrationProposal({
            id: `proposal-${runId}-${agent.agent}`,
            type: 'integration_proposal',
            integration_name: `${agent.domain}/${agent.agent}`,
            proposed_changes: String(proposedChanges).slice(0, 500),
            risks,
            dependencies: deps,
            simulation_id: simulationId,
            attribution,
            created_at: now,
          });
        } catch { /* non-fatal */ }
      }

      // 4. ERP mappings from scenario extraction (systems detected in query)
      const scenarioResp = platformResults.find(r => r.domain === 'connector-hub' && r.agent === 'erp-surface');
      const erpResponse = scenarioResp?.response as Record<string, unknown> | null;
      const erpSystems = erpResponse?.['systems'] ?? erpResponse?.['erp_systems'] ?? [];
      const systemList = Array.isArray(erpSystems) ? erpSystems : [];

      for (const system of systemList.slice(0, 5)) {
        const sysName = typeof system === 'string' ? system : String((system as Record<string, unknown>)?.['name'] ?? system);
        try {
          await adapter.storeErpMapping({
            id: `erp-mapping-${runId}-${sysName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
            type: 'erp_mapping',
            erp_type: sysName,
            entity_type: 'enterprise-surface',
            proposed_implementation: {
              source: 'simulation',
              query: input.query.slice(0, 200),
              agent_source: `connector-hub/erp-surface`,
            },
            simulation_id: simulationId,
            integration_proposal_ids: connectorAgents.map(a => `proposal-${runId}-${a.agent}`),
            attribution,
            created_at: now,
          });
        } catch { /* non-fatal */ }
      }

      // 5. Store decision with embedding text for vector indexing in ruvector
      //    This enables hyperbolic similarity search across simulations
      try {
        const agentList = platformResults
          .filter(r => r.status >= 200 && r.status < 300)
          .slice(0, 10)
          .map(r => `${r.domain}/${r.agent}`);

        await adapter.storeDecision({
          id: `decision-${runId}`,
          objective: input.query.slice(0, 500),
          command: 'agentics ask',
          raw_output_hash: checksums['manifest.json'] ?? '',
          recommendation: `Enterprise simulation completed with ${platformResults.length} agents for: ${input.query.slice(0, 200)}`,
          confidence: String(platformResults.filter(r => r.status >= 200 && r.status < 300).length / Math.max(platformResults.length, 1)),
          signals: {
            financial: platformResults.filter(r => r.domain === 'costops').map(r => r.agent).join(', ') || 'none',
            risk: platformResults.filter(r => r.domain === 'sentinel' || r.domain === 'shield').map(r => r.agent).join(', ') || 'none',
            complexity: platformResults.filter(r => r.domain === 'test-bench').map(r => r.agent).join(', ') || 'none',
          },
          graph_relations: {
            objective_to_repos: [],
            repos_to_signals: Object.fromEntries(
              agentList.map(a => [a, [a.split('/')[0] ?? 'unknown']]),
            ),
            signals_to_recommendation: agentList,
          },
          embedding_text: `${input.query} | agents: ${platformResults.map(r => `${r.domain}/${r.agent}`).join(', ')}`,
          created_at: now,
        });
      } catch { /* non-fatal */ }

    } catch {
      // Entire ruvector integration is non-fatal
    }
  })();
}
