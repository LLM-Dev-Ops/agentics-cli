/**
 * Pipeline Coordinator
 *
 * Orchestrates the 6-stage prototype-to-production pipeline.
 * Supports two modes:
 * - 'autonomous': Runs all stages end-to-end without stopping.
 * - 'human-in-the-loop': Pauses at each stage for approval with revision loops.
 */

import type { PipelineContext, PipelineResult, PipelineStage, StageOutput } from './types.js';
import { requestApproval } from './approval-gate.js';
import { executeDecisionGate } from './phases/decision-gate.js';
import { executeDeepResearch } from './phases/deep-research.js';
import { executeSPARCDevelopment } from './phases/sparc-development.js';
import { executeADRDDDGeneration } from './phases/adr-ddd-generator.js';
import { executePromptGeneration } from './phases/prompt-generator.js';
import { executeRuvFlowExecution } from './phases/ruvflow-executor.js';

// ============================================================================
// Stage Definitions
// ============================================================================

interface StageDefinition {
  id: PipelineStage;
  label: string;
  executor: (context: PipelineContext) => Promise<StageOutput>;
  /** Whether this stage has an approval gate in HITL mode */
  hasApprovalGate: boolean;
}

const STAGES: StageDefinition[] = [
  { id: 'prototype-decision', label: 'Prototype Decision',    executor: executeDecisionGate,      hasApprovalGate: false },
  { id: 'deep-research',     label: 'Deep Research',          executor: executeDeepResearch,       hasApprovalGate: true },
  { id: 'sparc-development', label: 'SPARC Development',      executor: executeSPARCDevelopment,    hasApprovalGate: true },
  { id: 'adr-ddd-generation', label: 'ADR & DDD Generation',  executor: executeADRDDDGeneration,   hasApprovalGate: true },
  { id: 'prompt-generation', label: 'Prompt Generation',      executor: executePromptGeneration,    hasApprovalGate: true },
  { id: 'ruvflow-execution', label: 'RuvFlow Execution',      executor: executeRuvFlowExecution,    hasApprovalGate: false },
];

// ============================================================================
// Pipeline Executor
// ============================================================================

/**
 * Execute the full prototype-to-production pipeline.
 *
 * Stage 1 (Decision Gate): Always interactive — asks proceed y/n + mode selection.
 * Stages 2-5 (Research, SPARC, ADR/DDD, Prompts):
 *   - Autonomous: run straight through.
 *   - HITL: run stage -> show results -> ask approval -> if no, get feedback, re-run, ask again.
 * Stage 6 (RuvFlow Execution): Always runs without gate.
 */
export async function executePipeline(context: PipelineContext): Promise<PipelineResult> {
  const pipelineStart = Date.now();
  const completedStages: StageOutput[] = [];

  console.error('');
  console.error('='.repeat(72));
  console.error('  PROTOTYPE DEVELOPMENT PIPELINE');
  console.error('='.repeat(72));
  console.error('');

  for (const stage of STAGES) {
    console.error(`  >> Stage: ${stage.label}`);
    console.error('');

    let output: StageOutput;

    try {
      output = await stage.executor(context);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      output = {
        stage: stage.id,
        status: 'failed',
        data: { error: errMsg },
        artifacts: [],
        timing: 0,
        summary: `  ERROR: ${errMsg}`,
      };
    }

    // Stage 1 (decision gate): if cancelled, stop pipeline
    if (stage.id === 'prototype-decision') {
      completedStages.push(output);
      context.stageOutputs.set(stage.id, output);

      if (output.status === 'cancelled') {
        return buildPipelineResult(context, completedStages, 'cancelled', pipelineStart);
      }
      continue;
    }

    // If stage failed, stop pipeline
    if (output.status === 'failed') {
      completedStages.push(output);
      context.stageOutputs.set(stage.id, output);
      console.error(`  Stage "${stage.label}" failed. Pipeline halted.`);
      return buildPipelineResult(context, completedStages, 'failed', pipelineStart);
    }

    // Stages 2-5 in HITL mode: approval gate with revision loop
    if (stage.hasApprovalGate && context.mode === 'human-in-the-loop') {
      output = await runApprovalLoop(stage, output, context);

      // If cancelled during revision (shouldn't happen, but guard)
      if (output.status === 'cancelled') {
        completedStages.push(output);
        context.stageOutputs.set(stage.id, output);
        return buildPipelineResult(context, completedStages, 'cancelled', pipelineStart);
      }
    } else {
      // Autonomous mode or no-gate stage: just log and continue
      console.error(output.summary);
      console.error('');
    }

    completedStages.push(output);
    context.stageOutputs.set(stage.id, output);
  }

  // Pipeline complete
  console.error('');
  console.error('='.repeat(72));
  console.error('  PIPELINE COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  All artifacts written to: ${context.artifactsDir}`);
  console.error(`  Mode: ${context.mode}`);
  console.error(`  Total stages: ${completedStages.length}`);
  console.error('');

  return buildPipelineResult(context, completedStages, 'completed', pipelineStart);
}

// ============================================================================
// Approval Loop
// ============================================================================

async function runApprovalLoop(
  stage: StageDefinition,
  output: StageOutput,
  context: PipelineContext,
): Promise<StageOutput> {
  const MAX_REVISIONS = 10;  // Safety limit
  let revisions = 0;

  while (revisions < MAX_REVISIONS) {
    const approval = await requestApproval(stage.label, output.summary);

    if (approval.approved) {
      return output;
    }

    // User wants changes — record feedback and re-run
    revisions++;
    const feedback = approval.feedback ?? 'Unspecified changes requested';

    console.error('');
    console.error(`  Incorporating feedback (revision ${revisions}): ${feedback}`);
    console.error('');

    const existing = context.userFeedback.get(stage.id);
    if (existing) {
      existing.push(feedback);
    } else {
      context.userFeedback.set(stage.id, [feedback]);
    }

    try {
      output = await stage.executor(context);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      output = {
        stage: stage.id,
        status: 'failed',
        data: { error: errMsg },
        artifacts: [],
        timing: 0,
        summary: `  ERROR during revision: ${errMsg}`,
      };
      return output;
    }
  }

  console.error(`  Maximum revisions (${MAX_REVISIONS}) reached. Proceeding with last output.`);
  return output;
}

// ============================================================================
// Result Builder
// ============================================================================

function buildPipelineResult(
  context: PipelineContext,
  stages: StageOutput[],
  finalStatus: 'completed' | 'cancelled' | 'failed',
  startTime: number,
): PipelineResult {
  return {
    executionId: context.executionId,
    mode: context.mode,
    stages,
    finalStatus,
    outputDir: context.artifactsDir,
    totalTiming: Date.now() - startTime,
  };
}
