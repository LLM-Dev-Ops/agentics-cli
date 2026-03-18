/**
 * Enterprise Pipeline Orchestrator — 7-Pass Execution Engine (ADR-032)
 *
 * The main entry point for the deterministic enterprise decision pipeline.
 *
 * Orchestrates 7 sequential passes:
 *   Pass 1: Problem Intelligence
 *   Pass 2: Simulation & Scenario Modeling
 *   Pass 3: Architecture & Prototype Generation
 *   Pass 4: Governance, Compliance & CostOps
 *   Pass 5: Decision Artifacts
 *   Pass 6: ERP Prototype Deployment
 *   Pass 7: Observability & Continuous Learning
 *
 * Each pass dispatches its agents concurrently, evaluates exit criteria,
 * and writes to the DecisionGraph. On completion, the 15 deterministic
 * enterprise artifacts are assembled into a Decision Package.
 *
 * This module is ADDITIVE — it does NOT modify any existing pipeline code.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  EnterprisePipelineOptions,
  EnterprisePipelineResult,
  PassNumber,
  PassOutput,
} from './types.js';
import { PASS_ID_MAP } from './types.js';
import { DecisionGraph } from './decision-graph.js';
import { ProvenanceTracker } from './provenance-tracker.js';
import { executePass } from './pass-executor.js';
import { ArtifactAssembler } from './artifact-assembler.js';
import { getPassConfig, getTotalUniqueAgents } from './pass-registry.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PASS_TIMEOUT_MS = 300_000; // 5 minutes per pass
const ALL_PASSES: readonly PassNumber[] = [1, 2, 3, 4, 5, 6, 7];
const BANNER_WIDTH = 72;

// ============================================================================
// Main Orchestrator
// ============================================================================

/**
 * Execute the full enterprise 7-pass pipeline.
 *
 * @param options - Pipeline configuration.
 * @returns Complete pipeline result with all pass outputs and artifact package.
 */
export async function executeEnterprisePipeline(
  options: EnterprisePipelineOptions,
): Promise<EnterprisePipelineResult> {
  const pipelineStart = Date.now();
  const executionId = options.traceId || crypto.randomUUID();
  const outputDir = options.outputDir || path.join(process.cwd(), 'plans');
  const passTimeoutMs = options.passTimeoutMs ?? DEFAULT_PASS_TIMEOUT_MS;
  const verbose = options.verbose ?? false;

  // Resolve which passes to run
  const passesToRun = resolvePassList(options);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Initialize DecisionGraph
  const graph = DecisionGraph.load(executionId, outputDir);

  // Initialize Provenance Tracker
  const tracker = new ProvenanceTracker(executionId);

  // Print banner
  printBanner(executionId, options.prompt, passesToRun, options.mode);

  // ── Execute passes sequentially ──
  const passOutputs: PassOutput[] = [];
  const passesDegraded: PassNumber[] = [];
  let pipelineAborted = false;

  for (const passNum of passesToRun) {
    const config = getPassConfig(passNum);

    // Print pass header
    printPassHeader(passNum, config.label, config.agenticsServices.length);

    // HITL approval gate (Passes 2-5 in human-in-the-loop mode)
    if (config.hasApprovalGate && options.mode === 'human-in-the-loop') {
      const approved = await requestHITLApproval(passNum, config.label);
      if (!approved) {
        console.error(`  Pass ${passNum} skipped by user.`);
        const skippedOutput = buildSkippedOutput(passNum);
        passOutputs.push(skippedOutput);
        continue;
      }
    }

    // Execute the pass
    let output: PassOutput;
    try {
      output = await executePass({
        pass: passNum,
        prompt: options.prompt,
        graph,
        tracker,
        timeoutMs: passTimeoutMs,
        verbose,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output = buildFailedOutput(passNum, message);
    }

    passOutputs.push(output);
    printPassResult(output);

    // Track degradation
    if (output.status === 'degraded') {
      passesDegraded.push(passNum);
    }

    // ADR-032 Rule 4: Pass failures are non-fatal.
    // Pipeline continues with degraded status recorded.
    if (output.status === 'failed') {
      passesDegraded.push(passNum);
      console.error(`  Pass ${passNum} failed. Pipeline continues in degraded mode.`);
      // If ALL agents in the pass failed and it's a critical pass (1-3),
      // we still continue but note it for the confidence score.
    }

    // Persist graph after each pass for crash resilience
    graph.persist();
  }

  // ── Assemble Decision Package (Artifact #1-15) ──
  console.error('');
  console.error('  Assembling Decision Package...');

  const assembler = new ArtifactAssembler(graph, tracker, outputDir, executionId);
  const decisionPackage = assembler.assemble({
    prompt: options.prompt,
    passOutputs,
    passesDegraded,
  });

  // Persist provenance trace records
  tracker.persist(path.join(outputDir, executionId));

  // Persist final graph state
  graph.persist();

  // Compute final status
  const failedCount = passOutputs.filter(p => p.status === 'failed').length;
  const degradedCount = passesDegraded.length;
  let finalStatus: EnterprisePipelineResult['finalStatus'];

  if (pipelineAborted) {
    finalStatus = 'cancelled';
  } else if (failedCount > 0 && failedCount === passOutputs.length) {
    finalStatus = 'failed';
  } else if (degradedCount > 0) {
    finalStatus = 'completed-degraded';
  } else {
    finalStatus = 'completed';
  }

  const totalDurationMs = Date.now() - pipelineStart;

  // Print completion banner
  printCompletionBanner(executionId, finalStatus, passOutputs.length, degradedCount, totalDurationMs, decisionPackage.confidenceScore, outputDir);

  return {
    executionId,
    prompt: options.prompt,
    mode: options.mode,
    passOutputs,
    finalStatus,
    outputDir: path.join(outputDir, executionId),
    totalDurationMs,
    passesExecuted: passOutputs.filter(p => p.status !== 'skipped').length,
    passesDegraded: degradedCount,
    passesFailed: failedCount,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Pass List Resolution
// ============================================================================

/**
 * Determine which passes to run based on options.
 *
 * Supports:
 *   - Full pipeline (default): all 7 passes
 *   - Partial pipeline (--passes 1-5): range of passes
 *   - Single pass (--pass 4): one pass only
 */
function resolvePassList(options: EnterprisePipelineOptions): readonly PassNumber[] {
  if (options.singlePass !== undefined) {
    return [options.singlePass];
  }
  if (options.passes && options.passes.length > 0) {
    // Validate and sort
    const sorted = [...options.passes].sort((a, b) => a - b);
    return sorted;
  }
  return ALL_PASSES;
}

// ============================================================================
// HITL Approval
// ============================================================================

async function requestHITLApproval(pass: PassNumber, label: string): Promise<boolean> {
  // Attempt interactive prompt; fall back to auto-approve if stdin is not a TTY
  if (!process.stdin.isTTY) {
    return true;
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  const answer = await new Promise<string>(resolve => {
    rl.question(`  Proceed with Pass ${pass} (${label})? (y/n): `, ans => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  return answer === 'y' || answer === 'yes';
}

// ============================================================================
// Output Builders
// ============================================================================

function buildSkippedOutput(pass: PassNumber): PassOutput {
  return {
    pass: PASS_ID_MAP[pass],
    passNumber: pass,
    status: 'skipped',
    data: {},
    artifacts: [],
    agentResults: [],
    durationMs: 0,
    summary: `  Pass ${pass} skipped by user.`,
  };
}

function buildFailedOutput(pass: PassNumber, error: string): PassOutput {
  return {
    pass: PASS_ID_MAP[pass],
    passNumber: pass,
    status: 'failed',
    data: { error },
    artifacts: [],
    agentResults: [],
    durationMs: 0,
    summary: `  Pass ${pass} failed: ${error}`,
    degradationReason: error,
  };
}

// ============================================================================
// Console Output
// ============================================================================

function printBanner(
  executionId: string,
  prompt: string,
  passes: readonly PassNumber[],
  mode: string,
): void {
  console.error('');
  console.error('='.repeat(BANNER_WIDTH));
  console.error('  ENTERPRISE DECISION PIPELINE (ADR-032)');
  console.error('='.repeat(BANNER_WIDTH));
  console.error('');
  console.error(`  Execution ID: ${executionId}`);
  console.error(`  Mode:         ${mode}`);
  console.error(`  Passes:       ${passes.join(', ')} (of 7)`);
  console.error(`  Total Agents: ${getTotalUniqueAgents()} unique across all passes`);
  console.error(`  Prompt:       ${prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt}`);
  console.error('');
  console.error('-'.repeat(BANNER_WIDTH));
  console.error('');
}

function printPassHeader(pass: PassNumber, label: string, agentCount: number): void {
  console.error(`  >> Pass ${pass}: ${label} (${agentCount} agents)`);
}

function printPassResult(output: PassOutput): void {
  console.error(output.summary);
  console.error('');
}

function printCompletionBanner(
  executionId: string,
  status: string,
  passesExecuted: number,
  passesDegraded: number,
  totalDurationMs: number,
  confidenceScore: number,
  outputDir: string,
): void {
  console.error('');
  console.error('='.repeat(BANNER_WIDTH));
  console.error('  PIPELINE COMPLETE');
  console.error('='.repeat(BANNER_WIDTH));
  console.error('');
  console.error(`  Status:            ${status}`);
  console.error(`  Execution ID:      ${executionId}`);
  console.error(`  Passes Executed:   ${passesExecuted}/7`);
  console.error(`  Passes Degraded:   ${passesDegraded}`);
  console.error(`  Confidence Score:  ${confidenceScore}%`);
  console.error(`  Duration:          ${formatDurationMs(totalDurationMs)}`);
  console.error(`  Artifacts:         ${path.join(outputDir, executionId)}/`);
  console.error(`  Decision Package:  ${path.join(outputDir, executionId, 'DECISION_PACKAGE.md')}`);
  console.error('');
}

// ============================================================================
// Helpers
// ============================================================================

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
