/**
 * Pipeline Phase 2: Deep Research
 *
 * Asks user about tech stack / ERP, then dispatches research agents
 * in parallel to gather technical feasibility, market analysis, etc.
 * Writes research-report.json to the run directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineContext, StageOutput } from '../types.js';
import { askTechStackQuestions } from '../approval-gate.js';

export async function executeDeepResearch(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();
  const artifacts: string[] = [];

  // Step 1: Gather user context (always ask, even in autonomous mode)
  let userAnswers: Record<string, string> = {};
  const existingFeedback = context.userFeedback.get('deep-research') ?? [];

  if (existingFeedback.length === 0) {
    // First run — ask tech stack questions
    userAnswers = await askTechStackQuestions();
    context.userContext = {
      ...context.userContext,
      erpSystem: userAnswers['erpSystem'],
      techStack: userAnswers['techStack']?.split(',').map(s => s.trim()),
      teamSize: userAnswers['teamSize'],
      timeline: userAnswers['timeline'],
      additionalNotes: userAnswers['additionalNotes'],
    };
  } else {
    console.error('');
    console.error('  Re-running research with your feedback incorporated...');
    console.error(`  Feedback: ${existingFeedback[existingFeedback.length - 1]}`);
    console.error('');
  }

  // Step 2: Dispatch research agents in parallel
  console.error('  Dispatching research agents...');

  const researchAgents = [
    { domain: 'copilot', agent: 'planner', task: 'Task decomposition' },
    { domain: 'copilot', agent: 'decomposer', task: 'Solution breakdown' },
    { domain: 'research-lab', agent: 'hypothesis', task: 'Technical feasibility' },
    { domain: 'research-lab', agent: 'metrics', task: 'KPI analysis' },
  ];

  const researchResults: Array<{ domain: string; agent: string; task: string; result: unknown }> = [];

  // Try to dispatch via the existing agent infrastructure
  for (const agentSpec of researchAgents) {
    try {
      // Dynamic import to avoid circular dependencies
      const { AGENT_DOMAINS } = await import('../../commands/agents.js');
      const { loadEndpointConfig } = await import('../../config/endpoints.js');
      const { createAdapter } = await import('../../adapters/base-adapter.js');

      const domainConfig = AGENT_DOMAINS[agentSpec.domain];
      if (!domainConfig) {
        researchResults.push({
          ...agentSpec,
          result: { error: `Domain not found: ${agentSpec.domain}` },
        });
        continue;
      }

      const config = loadEndpointConfig(domainConfig.serviceName);
      const adapter = createAdapter(domainConfig.serviceName, config, context.executionId);
      const payload = buildResearchPayload(context, agentSpec.agent, existingFeedback);

      const response = await adapter.invoke({
        endpoint: `/v1/${agentSpec.domain}/${agentSpec.agent}`,
        method: 'POST',
        headers: {},
        body: payload,
      });

      researchResults.push({ ...agentSpec, result: response.body });
      console.error(`    [OK] ${agentSpec.domain}/${agentSpec.agent}: ${agentSpec.task}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      researchResults.push({ ...agentSpec, result: { error: errMsg } });
      console.error(`    [SKIP] ${agentSpec.domain}/${agentSpec.agent}: ${errMsg.slice(0, 80)}`);
    }
  }

  // Step 3: Build research report
  const report = buildResearchReport(context, researchResults, existingFeedback);
  const reportContent = JSON.stringify(report, null, 2);
  const reportPath = path.join(context.artifactsDir, 'research-report.json');
  fs.writeFileSync(reportPath, reportContent, { mode: 0o600, encoding: 'utf-8' });
  artifacts.push('research-report.json');

  // Build summary for approval gate
  const summary = buildResearchSummary(report);

  return {
    stage: 'deep-research',
    status: 'completed',
    data: report,
    artifacts,
    timing: Date.now() - start,
    summary,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function buildResearchPayload(
  context: PipelineContext,
  _agent: string,
  feedback: string[],
): Record<string, unknown> {
  return {
    objective: context.query,
    context: {
      erp_system: context.userContext.erpSystem ?? 'not specified',
      tech_stack: context.userContext.techStack ?? [],
      team_size: context.userContext.teamSize ?? 'not specified',
      timeline: context.userContext.timeline ?? 'not specified',
      additional_notes: context.userContext.additionalNotes ?? '',
    },
    simulation_results: context.simulationResult,
    feedback: feedback.length > 0 ? feedback : undefined,
  };
}

function buildResearchReport(
  context: PipelineContext,
  results: Array<{ domain: string; agent: string; task: string; result: unknown }>,
  feedback: string[],
): Record<string, unknown> {
  const successful = results.filter(r => {
    const res = r.result as Record<string, unknown>;
    return !res['error'];
  });

  return {
    metadata: {
      created_at: new Date().toISOString(),
      query: context.query,
      revision: feedback.length,
    },
    user_context: context.userContext,
    agent_results: results.map(r => ({
      domain: r.domain,
      agent: r.agent,
      task: r.task,
      status: (r.result as Record<string, unknown>)['error'] ? 'error' : 'success',
      data: r.result,
    })),
    synthesis: {
      agents_succeeded: successful.length,
      agents_total: results.length,
      feedback_incorporated: feedback,
    },
  };
}

function buildResearchSummary(report: Record<string, unknown>): string {
  const synthesis = report['synthesis'] as Record<string, unknown>;
  const userCtx = report['user_context'] as Record<string, unknown> | undefined;

  const lines: string[] = [
    '  Research Summary:',
    '',
    `  - Agents queried: ${synthesis['agents_total']} (${synthesis['agents_succeeded']} succeeded)`,
  ];

  if (userCtx) {
    if (userCtx['erpSystem']) lines.push(`  - ERP System: ${userCtx['erpSystem']}`);
    if (userCtx['techStack']) lines.push(`  - Tech Stack: ${Array.isArray(userCtx['techStack']) ? (userCtx['techStack'] as string[]).join(', ') : userCtx['techStack']}`);
    if (userCtx['teamSize']) lines.push(`  - Team Size: ${userCtx['teamSize']}`);
    if (userCtx['timeline']) lines.push(`  - Timeline: ${userCtx['timeline']}`);
  }

  const revisions = synthesis['feedback_incorporated'] as string[];
  if (revisions && revisions.length > 0) {
    lines.push(`  - Revisions incorporated: ${revisions.length}`);
  }

  return lines.join('\n');
}
