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
  const platformResults = normalizePlatformResults(input.platformAnalysis);

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
