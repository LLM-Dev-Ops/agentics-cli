/**
 * Pipeline Phase 1: Decision Gate
 *
 * Displays simulation summary and asks the user whether to proceed
 * to prototype development. In autonomous mode, auto-proceeds.
 */

import type { PipelineContext, StageOutput } from '../types.js';
import { requestModeSelection } from '../approval-gate.js';

export async function executeDecisionGate(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();

  console.error('');
  console.error('='.repeat(72));
  console.error('  SIMULATION COMPLETE');
  console.error('='.repeat(72));
  console.error('');
  console.error(`  Query:     ${context.query}`);
  console.error(`  Artifacts: ${context.artifactsDir}`);
  console.error('');
  console.error('  Would you like to proceed to developing a prototype for this solution?');
  console.error('  This will run: Deep Research -> SPARC -> ADR/DDD -> Prompts -> Implementation');
  console.error('');

  // If mode is already set (e.g. via --pipeline flag), skip the prompt
  if (context.mode !== 'autonomous' && context.mode !== 'human-in-the-loop') {
    // Should not happen with proper typing, but handle gracefully
    context.mode = 'human-in-the-loop';
  }

  // Ask user to choose mode
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  const answer = await new Promise<string>(resolve => {
    rl.question('  Proceed to prototype? (y/n): ', ans => {
      rl.close();
      resolve(ans.trim());
    });
  });

  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.error('');
    console.error('  Pipeline cancelled. Your simulation artifacts are available at:');
    console.error(`  ${context.artifactsDir}`);
    console.error('');

    return {
      stage: 'prototype-decision',
      status: 'cancelled',
      data: { userDecision: 'no' },
      artifacts: [],
      timing: Date.now() - start,
      summary: 'User declined to proceed to prototype development.',
    };
  }

  // User wants to proceed — ask about mode
  const mode = await requestModeSelection();
  context.mode = mode;

  console.error('');
  console.error(`  Mode selected: ${mode === 'autonomous' ? 'Autonomous (end-to-end)' : 'Human-in-the-Loop (approval gates)'}`);
  console.error('  Starting pipeline...');
  console.error('');

  return {
    stage: 'prototype-decision',
    status: 'completed',
    data: { userDecision: 'yes', mode },
    artifacts: [],
    timing: Date.now() - start,
    summary: `User approved prototype development in ${mode} mode.`,
  };
}
