/**
 * Pipeline Phase 6: RuvFlow Executor
 *
 * Executes implementation prompts one-by-one via Claude-Flow
 * and pushes results to ERP surfaces.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { PipelineContext, StageOutput, ExecutionPlan } from '../types.js';

export async function executeRuvFlowExecution(
  context: PipelineContext,
): Promise<StageOutput> {
  const start = Date.now();
  const implDir = path.join(context.artifactsDir, 'implementation');
  fs.mkdirSync(implDir, { recursive: true, mode: 0o700 });
  const artifacts: string[] = [];

  // Load execution plan
  const promptOutput = context.stageOutputs.get('prompt-generation');
  const executionPlan = promptOutput?.data as ExecutionPlan | undefined;

  if (!executionPlan) {
    return {
      stage: 'ruvflow-execution',
      status: 'failed',
      data: { error: 'Execution plan not available' },
      artifacts: [],
      timing: Date.now() - start,
      summary: '  ERROR: Execution plan not available.',
    };
  }

  console.error('');
  console.error('='.repeat(72));
  console.error('  RuvFlow Execution — Implementing Prompts');
  console.error('='.repeat(72));
  console.error('');

  const results: Array<{ promptId: string; title: string; status: string; outputFile?: string; error?: string }> = [];

  for (const prompt of executionPlan.prompts) {
    console.error(`  [${prompt.order}/${executionPlan.totalSteps}] Executing: ${prompt.title}`);

    try {
      // Write prompt to temp file for Claude-Flow
      const promptFile = path.join(implDir, `prompt-${String(prompt.order).padStart(3, '0')}.md`);
      fs.writeFileSync(promptFile, prompt.content, { mode: 0o600, encoding: 'utf-8' });

      // Try to execute via Claude-Flow
      const outputFile = path.join(implDir, `output-${String(prompt.order).padStart(3, '0')}.json`);
      const executed = await executeViaClaudeFlow(promptFile, outputFile, context);

      if (executed) {
        results.push({ promptId: prompt.id, title: prompt.title, status: 'completed', outputFile });
        artifacts.push(`implementation/output-${String(prompt.order).padStart(3, '0')}.json`);
        console.error(`    [OK] ${prompt.title}`);
      } else {
        // Claude-Flow not available — write prompt as implementation guide
        const guideFile = path.join(implDir, `guide-${String(prompt.order).padStart(3, '0')}.md`);
        fs.writeFileSync(guideFile, prompt.content, { mode: 0o600, encoding: 'utf-8' });
        results.push({ promptId: prompt.id, title: prompt.title, status: 'guide-generated', outputFile: guideFile });
        artifacts.push(`implementation/guide-${String(prompt.order).padStart(3, '0')}.md`);
        console.error(`    [GUIDE] ${prompt.title} (Claude-Flow unavailable; implementation guide written)`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ promptId: prompt.id, title: prompt.title, status: 'failed', error: errMsg });
      console.error(`    [FAIL] ${prompt.title}: ${errMsg.slice(0, 80)}`);
    }

    artifacts.push(`implementation/prompt-${String(prompt.order).padStart(3, '0')}.md`);
  }

  // Try to push to ERP surfaces
  const erpResult = await pushToERPSurfaces(context, results);
  if (erpResult) {
    const erpFile = path.join(implDir, 'erp-surface-result.json');
    fs.writeFileSync(erpFile, JSON.stringify(erpResult, null, 2), { mode: 0o600, encoding: 'utf-8' });
    artifacts.push('implementation/erp-surface-result.json');
  }

  // Write execution summary
  const summary = {
    execution_id: context.executionId,
    completed_at: new Date().toISOString(),
    total_prompts: executionPlan.totalSteps,
    results,
    erp_push: erpResult ? 'completed' : 'skipped',
  };

  const summaryFile = path.join(implDir, 'execution-summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), { mode: 0o600, encoding: 'utf-8' });
  artifacts.push('implementation/execution-summary.json');

  const succeeded = results.filter(r => r.status === 'completed' || r.status === 'guide-generated').length;
  const failed = results.filter(r => r.status === 'failed').length;

  console.error('');
  console.error(`  Execution complete: ${succeeded} succeeded, ${failed} failed`);
  console.error('');

  return {
    stage: 'ruvflow-execution',
    status: failed > 0 && succeeded === 0 ? 'failed' : 'completed',
    data: summary,
    artifacts,
    timing: Date.now() - start,
    summary: buildExecutionSummary(results, executionPlan.totalSteps),
  };
}

// ============================================================================
// Claude-Flow Integration
// ============================================================================

async function executeViaClaudeFlow(
  promptFile: string,
  outputFile: string,
  _context: PipelineContext,
): Promise<boolean> {
  try {
    // Resolve claude-flow binary from local node_modules (first-class dependency)
    const cfBinLocal = path.resolve(process.cwd(), 'node_modules', '.bin', 'claude-flow');
    const cfBin = fs.existsSync(cfBinLocal) ? cfBinLocal : 'npx claude-flow';

    execSync(`${cfBin} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });

    // Execute the prompt via claude-flow task
    const promptContent = fs.readFileSync(promptFile, 'utf-8');
    const result = execSync(
      `${cfBin} task create --description "${promptContent.slice(0, 200).replace(/"/g, '\\"')}" --type implementation`,
      {
        stdio: 'pipe',
        timeout: 300000, // 5 minutes per prompt
        encoding: 'utf-8',
      },
    );

    fs.writeFileSync(outputFile, JSON.stringify({ output: result, status: 'completed' }, null, 2), {
      mode: 0o600,
      encoding: 'utf-8',
    });

    return true;
  } catch {
    // Claude-Flow not available or execution failed
    return false;
  }
}

// ============================================================================
// ERP Surface Push
// ============================================================================

async function pushToERPSurfaces(
  context: PipelineContext,
  _results: Array<{ promptId: string; title: string; status: string }>,
): Promise<Record<string, unknown> | null> {
  try {
    const { AGENT_DOMAINS } = await import('../../commands/agents.js');
    const { loadEndpointConfig } = await import('../../config/endpoints.js');
    const { createAdapter } = await import('../../adapters/base-adapter.js');

    const domainConfig = AGENT_DOMAINS['connector-hub'];
    if (!domainConfig) return null;

    const config = loadEndpointConfig(domainConfig.serviceName);
    const adapter = createAdapter(domainConfig.serviceName, config, context.executionId);

    const response = await adapter.invoke({
      endpoint: '/v1/connector-hub/erp-surface',
      method: 'POST',
      headers: {},
      body: {
        execution_id: context.executionId,
        query: context.query,
        artifacts_dir: context.artifactsDir,
        erp_system: context.userContext.erpSystem ?? 'not specified',
      },
    });

    console.error('  [ERP] Pushed to ERP surface successfully');
    return response.body as Record<string, unknown>;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`  [ERP] ERP surface push skipped: ${errMsg.slice(0, 80)}`);
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function buildExecutionSummary(
  results: Array<{ promptId: string; title: string; status: string }>,
  total: number,
): string {
  const succeeded = results.filter(r => r.status === 'completed').length;
  const guides = results.filter(r => r.status === 'guide-generated').length;
  const failed = results.filter(r => r.status === 'failed').length;

  return [
    '  RuvFlow Execution Summary:',
    '',
    `  - Total prompts: ${total}`,
    `  - Executed via Claude-Flow: ${succeeded}`,
    `  - Implementation guides generated: ${guides}`,
    `  - Failed: ${failed}`,
    '',
    '  Results:',
    ...results.map(r => `    - ${r.title}: ${r.status}`),
  ].join('\n');
}
