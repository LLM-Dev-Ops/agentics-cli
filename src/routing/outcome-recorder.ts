/**
 * Outcome Recorder (ADR-031 Phase 2)
 *
 * Records execution outcomes to a local JSONL file for telemetry feedback.
 * Outcomes are used by the weight adjuster to improve routing precision.
 *
 * Storage: .agentics/telemetry/outcomes.jsonl (append-only)
 * Format: One JSON object per line (JSONL)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface AgentContribution {
  readonly produced_output: boolean;
  readonly output_used: boolean;
}

export type OutcomeStatus = 'success' | 'failure' | 'partial' | 'timeout';

export interface OutcomeRecord {
  readonly timestamp: string;
  readonly prompt_hash: string;
  readonly capabilities_used: readonly string[];
  readonly agents_selected: readonly string[];
  readonly outcome: OutcomeStatus;
  readonly user_rating: number | null;
  readonly execution_time_ms: number;
  readonly agent_contributions: Readonly<Record<string, AgentContribution>>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TELEMETRY_DIR = '.agentics/telemetry';
const OUTCOMES_FILE = 'outcomes.jsonl';
const MAX_RECORDS = 1000;

// ============================================================================
// Recording
// ============================================================================

/**
 * Record an execution outcome to the telemetry JSONL file.
 * Creates the telemetry directory if it doesn't exist.
 */
export function recordOutcome(
  record: OutcomeRecord,
  options?: { basePath?: string },
): void {
  const basePath = options?.basePath ?? process.cwd();
  const telemetryDir = path.join(basePath, DEFAULT_TELEMETRY_DIR);
  const filePath = path.join(telemetryDir, OUTCOMES_FILE);

  // Ensure directory exists
  fs.mkdirSync(telemetryDir, { recursive: true });

  // Append record as JSONL
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');
}

/**
 * Build an outcome record from execution data.
 */
export function buildOutcomeRecord(params: {
  prompt: string;
  capabilities: readonly string[];
  agents: readonly string[];
  outcome: OutcomeStatus;
  executionTimeMs: number;
  userRating?: number | null;
  contributions?: Record<string, AgentContribution>;
}): OutcomeRecord {
  return {
    timestamp: new Date().toISOString(),
    prompt_hash: hashPrompt(params.prompt),
    capabilities_used: [...params.capabilities],
    agents_selected: [...params.agents],
    outcome: params.outcome,
    user_rating: params.userRating ?? null,
    execution_time_ms: params.executionTimeMs,
    agent_contributions: params.contributions ?? buildDefaultContributions(params.agents, params.outcome),
  };
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load all outcome records from the telemetry file.
 * Returns empty array if file doesn't exist.
 */
export function loadOutcomes(options?: { basePath?: string }): OutcomeRecord[] {
  const basePath = options?.basePath ?? process.cwd();
  const filePath = path.join(basePath, DEFAULT_TELEMETRY_DIR, OUTCOMES_FILE);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const records: OutcomeRecord[] = [];

  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as OutcomeRecord);
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

/**
 * Load the most recent N outcome records.
 */
export function loadRecentOutcomes(
  count: number,
  options?: { basePath?: string },
): OutcomeRecord[] {
  const all = loadOutcomes(options);
  return all.slice(-count);
}

// ============================================================================
// Maintenance
// ============================================================================

/**
 * Rotate the outcomes file, keeping only the most recent records.
 * This prevents unbounded file growth.
 */
export function rotateOutcomes(
  maxRecords?: number,
  options?: { basePath?: string },
): { kept: number; removed: number } {
  const limit = maxRecords ?? MAX_RECORDS;
  const basePath = options?.basePath ?? process.cwd();
  const filePath = path.join(basePath, DEFAULT_TELEMETRY_DIR, OUTCOMES_FILE);

  if (!fs.existsSync(filePath)) {
    return { kept: 0, removed: 0 };
  }

  const records = loadOutcomes(options);
  if (records.length <= limit) {
    return { kept: records.length, removed: 0 };
  }

  const kept = records.slice(-limit);
  const removed = records.length - kept.length;

  // Rewrite file with only recent records
  const content = kept.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');

  return { kept: kept.length, removed };
}

/**
 * Get the path to the outcomes file.
 */
export function getOutcomesFilePath(basePath?: string): string {
  return path.join(basePath ?? process.cwd(), DEFAULT_TELEMETRY_DIR, OUTCOMES_FILE);
}

// ============================================================================
// Utilities
// ============================================================================

function hashPrompt(prompt: string): string {
  const hash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12);
  return `sha256:${hash}`;
}

function buildDefaultContributions(
  agents: readonly string[],
  outcome: OutcomeStatus,
): Record<string, AgentContribution> {
  const contributions: Record<string, AgentContribution> = {};
  const succeeded = outcome === 'success' || outcome === 'partial';

  for (const agent of agents) {
    contributions[agent] = {
      produced_output: succeeded,
      output_used: outcome === 'success',
    };
  }

  return contributions;
}
