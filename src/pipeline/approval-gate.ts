/**
 * Approval Gate — Interactive user confirmation
 *
 * PURPOSE: Reusable approval prompt with revision loop.
 * Used by pipeline stages 2-5 in human-in-the-loop mode.
 *
 * In autonomous mode, this module is bypassed entirely.
 */

import * as readline from 'node:readline';
import type { ApprovalResult } from './types.js';

// ============================================================================
// Interactive Prompt
// ============================================================================

function createPrompt(): (question: string) => Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,  // Use stderr so stdout stays clean for JSON
    terminal: process.stdin.isTTY ?? false,
  });

  return (question: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  };
}

// ============================================================================
// Approval Gate
// ============================================================================

/**
 * Display stage results and ask user for approval.
 * Returns { approved: true } or { approved: false, feedback: "..." }.
 */
export async function requestApproval(
  stageName: string,
  summary: string,
): Promise<ApprovalResult> {
  const prompt = createPrompt();

  console.error('');
  console.error('='.repeat(72));
  console.error(`  Stage Complete: ${stageName}`);
  console.error('='.repeat(72));
  console.error('');
  console.error(summary);
  console.error('');

  const answer = await prompt(`  Does this look good? Proceed? (y/n): `);

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    return { approved: true };
  }

  const feedback = await createPrompt()(`  What needs to change? > `);
  return { approved: false, feedback: feedback || 'Unspecified changes requested' };
}

// ============================================================================
// Mode Selection
// ============================================================================

/**
 * Ask the user to choose between autonomous and human-in-the-loop mode.
 */
export async function requestModeSelection(): Promise<'autonomous' | 'human-in-the-loop'> {
  const prompt = createPrompt();

  console.error('');
  console.error('='.repeat(72));
  console.error('  PROTOTYPE DEVELOPMENT PIPELINE');
  console.error('='.repeat(72));
  console.error('');
  console.error('  Choose your pipeline mode:');
  console.error('');
  console.error('  [1] Autonomous     — Runs end-to-end without stopping');
  console.error('                       (Deep Research -> SPARC -> ADR/DDD -> Prompts -> Implementation)');
  console.error('');
  console.error('  [2] Human-in-the-Loop — Pauses at each stage for your approval');
  console.error('                          You can review and request changes at every step');
  console.error('');

  const answer = await prompt('  Select mode (1 or 2): ');

  if (answer === '1' || answer.toLowerCase().startsWith('auto')) {
    return 'autonomous';
  }
  return 'human-in-the-loop';
}

// ============================================================================
// Tech Stack Questions (for Deep Research stage)
// ============================================================================

/**
 * Ask user about their technology context for the deep research phase.
 */
export async function askTechStackQuestions(): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};

  const ask = async (question: string, key: string): Promise<void> => {
    const prompt = createPrompt();
    const answer = await prompt(`  ${question} `);
    if (answer) {
      answers[key] = answer;
    }
  };

  console.error('');
  console.error('  Before we begin research, a few questions about your environment:');
  console.error('');

  await ask('What ERP system are you using? (e.g., SAP S/4HANA, Oracle, NetSuite, none):', 'erpSystem');
  await ask('Primary tech stack? (e.g., Java/Spring, Node.js, Python, .NET):', 'techStack');
  await ask('Approximate team size for this initiative?:', 'teamSize');
  await ask('Target timeline? (e.g., 3 months, 6 months, 1 year):', 'timeline');
  await ask('Any other context or constraints? (or press Enter to skip):', 'additionalNotes');

  return answers;
}
