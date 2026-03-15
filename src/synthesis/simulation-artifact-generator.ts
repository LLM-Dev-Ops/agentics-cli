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
  type AgentResult,
} from './simulation-renderers.js';
import { RuvectorAdapter } from '../adapters/base-adapter.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import { createClaudeCodeRunner } from '../runtime/claude-code-runner.js';

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

  // 1. manifest.json
  const manifest = buildManifest(input, platformResults, runId);
  const manifestContent = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(runDir, 'manifest.json');
  atomicWriteFile(manifestPath, manifestContent);
  filesWritten.push('manifest.json');
  checksums['manifest.json'] = computeChecksum(manifestContent);
  bytesWritten += Buffer.byteLength(manifestContent, 'utf-8');

  // 2. scenario.json
  const scenario = buildScenarioArtifact(input.query, input.simulationResult, platformResults);
  const scenarioContent = JSON.stringify(scenario, null, 2);
  const scenarioPath = path.join(runDir, 'scenario.json');
  atomicWriteFile(scenarioPath, scenarioContent);
  filesWritten.push('scenario.json');
  checksums['scenario.json'] = computeChecksum(scenarioContent);
  bytesWritten += Buffer.byteLength(scenarioContent, 'utf-8');

  // 3. roadmap.json
  const roadmap = buildRoadmapArtifact(input.query, input.simulationResult, platformResults);
  const roadmapContent = JSON.stringify(roadmap, null, 2);
  const roadmapPath = path.join(runDir, 'roadmap.json');
  atomicWriteFile(roadmapPath, roadmapContent);
  filesWritten.push('roadmap.json');
  checksums['roadmap.json'] = computeChecksum(roadmapContent);
  bytesWritten += Buffer.byteLength(roadmapContent, 'utf-8');

  // 4. executive-summary.md
  const execSummary = renderExecutiveSummary(input.query, input.simulationResult, platformResults);
  const execPath = path.join(runDir, 'executive-summary.md');
  atomicWriteFile(execPath, execSummary);
  filesWritten.push('executive-summary.md');
  checksums['executive-summary.md'] = computeChecksum(execSummary);
  bytesWritten += Buffer.byteLength(execSummary, 'utf-8');

  // 5. risk-assessment.json
  const risk = buildRiskAssessment(input.query, input.simulationResult, platformResults);
  const riskContent = JSON.stringify(risk, null, 2);
  const riskPath = path.join(runDir, 'risk-assessment.json');
  atomicWriteFile(riskPath, riskContent);
  filesWritten.push('risk-assessment.json');
  checksums['risk-assessment.json'] = computeChecksum(riskContent);
  bytesWritten += Buffer.byteLength(riskContent, 'utf-8');

  // 6. decision-memo.md
  const decisionMemo = renderDecisionMemo(input.query, input.simulationResult, platformResults);
  const memoPath = path.join(runDir, 'decision-memo.md');
  atomicWriteFile(memoPath, decisionMemo);
  filesWritten.push('decision-memo.md');
  checksums['decision-memo.md'] = computeChecksum(decisionMemo);
  bytesWritten += Buffer.byteLength(decisionMemo, 'utf-8');

  // 7. Ruvector full API integration — lineage, ERP mappings, integration proposals
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
  return {
    run_id: runId,
    execution_id: input.executionId,
    correlation_id: input.correlationId,
    query: input.query,
    created_at: new Date().toISOString(),
    timing_ms: input.timing,
    agents_invoked: [
      { domain: 'simulator', agent: 'enterprise', status: 'invoked' },
      ...platformResults.map(r => ({
        domain: r.domain,
        agent: r.agent,
        status: r.status >= 200 && r.status < 300 ? 'success' : 'error',
      })),
    ],
    artifacts: [
      'manifest.json',
      'scenario.json',
      'roadmap.json',
      'executive-summary.md',
      'risk-assessment.json',
      'decision-memo.md',
    ],
    schema_version: '1.0.0',
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
