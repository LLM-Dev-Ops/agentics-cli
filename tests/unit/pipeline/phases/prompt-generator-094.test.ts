/**
 * ADR-PIPELINE-094 Decision 2 — Phase 5a Phase-1 fallback prompt generation.
 *
 * When the SPARC → ADR → DDD chain is unavailable but Phase-1 simulator
 * consensus is on disk, the prompt-generator emits ONE degraded prompt
 * tagged `degraded_mode: phase1-fallback` plus a valid execution-plan.json.
 * Verifies ADR Verification scenario #2.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executePromptGeneration } from '../../../../src/pipeline/phases/prompt-generator.js';
import type {
  PipelineContext,
  PipelineStage,
  StageOutput,
} from '../../../../src/pipeline/types.js';

let tmpDir: string;

function makeContext(runDir: string, query = 'water-usage analytics for ServiceNow'): PipelineContext {
  return {
    executionId: 'test-094-d2',
    query,
    simulationResult: {},
    platformAnalysis: [],
    artifactsDir: runDir,
    mode: 'autonomous',
    stageOutputs: new Map<PipelineStage, StageOutput>(),
    userFeedback: new Map<PipelineStage, string[]>(),
    userContext: {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-gen-094-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ADR-094 D2 — Phase-1 fallback prompt generation', () => {
  it('produces 1 prompt tagged degraded_mode:phase1-fallback when only Phase-1 outputs exist (flat layout)', async () => {
    // Production layout: Phase 1 writes flat. No phase3/, phase4/, engineering/.
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({ project: { language: 'typescript' } }));
    fs.writeFileSync(path.join(tmpDir, 'decision-memo.md'), '# Decision Memo\n\n' + 'x'.repeat(300));
    fs.writeFileSync(path.join(tmpDir, 'executive-summary.md'), '# Executive Summary\n\n' + 'y'.repeat(300));
    fs.writeFileSync(path.join(tmpDir, 'scenario.json'), JSON.stringify({ summary: 'a'.repeat(200) }));

    const result = await executePromptGeneration(makeContext(tmpDir));

    expect(result.status).toBe('completed');
    expect(result.artifacts).toContain('prompts/execution-plan.json');
    const implFiles = (result.artifacts as readonly string[]).filter((a) => /^prompts\/impl-\d+-.+\.md$/.test(a));
    expect(implFiles.length).toBeGreaterThanOrEqual(1);

    // Read the prompt and assert frontmatter tag.
    const promptPath = path.join(tmpDir, implFiles[0]!);
    const content = fs.readFileSync(promptPath, 'utf8');
    expect(content).toMatch(/degraded_mode:\s*phase1-fallback/);
    expect(content).toMatch(/quality:\s*degraded/);
    expect(content).toContain('Phase-1 fallback');

    // Read execution plan and assert it's valid + non-empty.
    const planRaw = fs.readFileSync(path.join(tmpDir, 'prompts', 'execution-plan.json'), 'utf8');
    const plan = JSON.parse(planRaw);
    expect(Array.isArray(plan.prompts)).toBe(true);
    expect(plan.prompts.length).toBeGreaterThanOrEqual(1);
    expect(plan.totalSteps).toBe(plan.prompts.length);
  });

  it('also accepts Phase-1 outputs in subdir layout (phase1/decision-memo.md)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'phase1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'phase1', 'decision-memo.md'), '# Decision Memo\n\n' + 'x'.repeat(300));

    const result = await executePromptGeneration(makeContext(tmpDir));
    expect(result.status).toBe('completed');
    expect((result.artifacts as readonly string[]).some((a) => a.includes('impl-001'))).toBe(true);
  });

  it('falls back on scenario.json alone when decision-memo is absent', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scenario.json'), JSON.stringify({ summary: 'b'.repeat(200) }));

    const result = await executePromptGeneration(makeContext(tmpDir));
    expect(result.status).toBe('completed');
    const implFiles = (result.artifacts as readonly string[]).filter((a) => /^prompts\/impl-\d+-.+\.md$/.test(a));
    expect(implFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('still hard-blocks when neither SPARC chain nor Phase-1 outputs exist', async () => {
    // Empty runDir.
    const result = await executePromptGeneration(makeContext(tmpDir));
    expect(result.status).toBe('failed');
    const data = result.data as { ok?: boolean; missing?: string[] };
    expect(data.ok).toBe(false);
    expect(data.missing).toBeDefined();
    expect(data.missing!.some((m) => m.includes('phase1/decision-memo.md'))).toBe(true);
  });

  it('the produced prompt includes the user query in its body', async () => {
    fs.writeFileSync(path.join(tmpDir, 'decision-memo.md'), '# Decision Memo\n\n' + 'z'.repeat(300));
    const query = 'unique-test-query-marker-9417';
    const result = await executePromptGeneration(makeContext(tmpDir, query));
    const implFiles = (result.artifacts as readonly string[]).filter((a) => /^prompts\/impl-\d+-.+\.md$/.test(a));
    const promptContent = fs.readFileSync(path.join(tmpDir, implFiles[0]!), 'utf8');
    expect(promptContent).toContain(query);
  });
});
