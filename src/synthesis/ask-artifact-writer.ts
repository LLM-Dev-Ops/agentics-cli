/**
 * Ask Artifact Writer — Dual-Mode Output Persistence for `agentics ask`
 *
 * Persists multi-agent results from `agentics ask` as browsable artifacts.
 *
 * Two modes (auto-detected):
 *   Development mode:  Writes to ~/.agentics/runs/<trace-id>/
 *                      Prints clickable Codespace / file link
 *   Project mode:      Creates git branch agentics/<slug>-<YYYYMMDD>,
 *                      commits artifacts to .agentics/runs/<trace-id>/,
 *                      returns to original branch, prints GitHub URL
 *
 * All persistence is NON-FATAL — errors warn but never block result display.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  detectExecutionMode,
  generateAskBranchName,
  createScenarioBranch,
  commitScenarioFiles,
  checkoutBranch,
  type ExecutionContext,
} from '../pipeline/execution-context.js';

import type {
  RouteResult,
  AgentsInvokeResult,
} from '../commands/agents.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ============================================================================
// Types
// ============================================================================

export interface AskPersistInput {
  query: string;
  routeResult: RouteResult;
  traceId: string;
  timing: number;
}

export interface AskPersistOutput {
  runDir: string;
  filesWritten: string[];
  mode: 'development' | 'project';
  branch?: string;
  commitHash?: string;
  githubUrl?: string;
}

// ============================================================================
// I/O Helpers (match simulation-artifact-generator.ts patterns)
// ============================================================================

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, content, { mode: FILE_MODE, encoding: 'utf-8' });
  fs.renameSync(tmpPath, filePath);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  }
}

// ============================================================================
// Artifact Builders
// ============================================================================

function buildManifest(input: AskPersistInput): Record<string, unknown> {
  const agents = extractAgents(input.routeResult);
  return {
    run_id: input.traceId,
    query: input.query,
    created_at: new Date().toISOString(),
    timing_ms: input.timing,
    kind: input.routeResult.kind,
    agent_count: agents.length,
    agents_invoked: agents.map(a => ({
      domain: a.domain,
      agent: a.agent,
      status: a.succeeded ? 'success' : 'error',
    })),
    artifacts: ['manifest.json', 'results.json', 'summary.md', 'prompt.txt'],
    schema_version: '1.0.0',
  };
}

function buildResultsJson(input: AskPersistInput): unknown {
  if (input.routeResult.kind === 'multi') {
    return {
      kind: 'multi',
      query: input.routeResult.result.query,
      agents: input.routeResult.result.invocations.map(inv => ({
        domain: inv.intent.domain,
        agent: inv.intent.agent,
        confidence: inv.intent.confidence,
        reasoning: inv.intent.reasoning,
        result: 'error' in inv.result ? { error: inv.result.error } : inv.result,
      })),
      timing: input.routeResult.result.timing,
    };
  }
  return {
    kind: 'single',
    query: input.query,
    intent: input.routeResult.result.intent,
    result: input.routeResult.result.invocation,
    timing: input.routeResult.result.timing,
  };
}

function buildSummaryMarkdown(input: AskPersistInput): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();

  lines.push(`# Agentics Run: ${input.query}`);
  lines.push('');
  lines.push(`**Trace ID:** \`${input.traceId}\``);
  lines.push(`**Timestamp:** ${timestamp}`);
  lines.push(`**Duration:** ${input.timing}ms`);
  lines.push('');

  if (input.routeResult.kind === 'multi') {
    const r = input.routeResult.result;
    const succeeded = r.invocations.filter(i => !('error' in i.result)).length;
    const failed = r.invocations.length - succeeded;

    lines.push(`## Multi-Agent Results`);
    lines.push('');
    lines.push(`**Agents:** ${r.invocations.length} (${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''})`);
    lines.push('');

    for (const inv of r.invocations) {
      const label = `${inv.intent.domain}/${inv.intent.agent}`;
      lines.push(`### ${label}`);
      lines.push('');

      if ('error' in inv.result) {
        lines.push(`**Status:** Error`);
        lines.push(`\`\`\`\n${inv.result.error}\n\`\`\``);
      } else {
        const agentResult = inv.result as AgentsInvokeResult;
        lines.push(`**Status:** ${agentResult.status} (${agentResult.timing}ms)`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(agentResult.response, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
  } else {
    const r = input.routeResult.result;
    lines.push(`## Agent: ${r.intent.domain}/${r.intent.agent}`);
    lines.push('');
    lines.push(`**Confidence:** ${(r.intent.confidence * 100).toFixed(0)}%`);
    if (r.intent.reasoning) {
      lines.push(`**Reasoning:** ${r.intent.reasoning}`);
    }
    lines.push(`**Status:** ${r.invocation.status} (${r.invocation.timing}ms)`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(r.invocation.response, null, 2));
    lines.push('```');
  }

  lines.push('');
  lines.push('---');
  lines.push(`*Generated by [Agentics CLI](https://github.com/ruvnet/agentics-cli)*`);

  return lines.join('\n');
}

interface AgentInfo {
  domain: string;
  agent: string;
  succeeded: boolean;
}

function extractAgents(routeResult: RouteResult): AgentInfo[] {
  if (routeResult.kind === 'multi') {
    return routeResult.result.invocations.map(inv => ({
      domain: inv.intent.domain,
      agent: inv.intent.agent,
      succeeded: !('error' in inv.result),
    }));
  }
  return [{
    domain: routeResult.result.intent.domain,
    agent: routeResult.result.intent.agent,
    succeeded: true,
  }];
}

// ============================================================================
// Write Artifacts to a Directory
// ============================================================================

function writeArtifacts(runDir: string, input: AskPersistInput): string[] {
  ensureDir(runDir);
  const filesWritten: string[] = [];

  // 1. manifest.json
  const manifest = buildManifest(input);
  atomicWriteFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  filesWritten.push('manifest.json');

  // 2. results.json
  const results = buildResultsJson(input);
  atomicWriteFile(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  filesWritten.push('results.json');

  // 3. summary.md
  const summary = buildSummaryMarkdown(input);
  atomicWriteFile(path.join(runDir, 'summary.md'), summary);
  filesWritten.push('summary.md');

  // 4. prompt.txt
  atomicWriteFile(path.join(runDir, 'prompt.txt'), input.query);
  filesWritten.push('prompt.txt');

  return filesWritten;
}

// ============================================================================
// Main: Persist Ask Results
// ============================================================================

/**
 * Persist `agentics ask` results to disk.
 *
 * - Development mode: writes to ~/.agentics/runs/<traceId>/
 * - Project mode: creates branch, writes to .agentics/runs/<traceId>/ in repo, commits
 *
 * NON-FATAL: all errors are caught and logged as warnings. Returns null on failure.
 */
export function persistAskResults(input: AskPersistInput): AskPersistOutput | null {
  try {
    const execCtx = detectExecutionMode();

    if (execCtx.mode === 'project' && execCtx.isGitRepo && execCtx.isCleanTree) {
      return persistProjectMode(input, execCtx);
    }

    // Dev mode, or project mode with dirty tree (graceful fallback)
    if (execCtx.mode === 'project' && !execCtx.isCleanTree) {
      console.error('  [WARN] Working tree has uncommitted changes — writing artifacts to ~/.agentics/runs/ instead');
    }

    return persistDevMode(input, execCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [WARN] Could not persist ask results: ${msg}`);
    return null;
  }
}

function persistDevMode(input: AskPersistInput, _execCtx: ExecutionContext): AskPersistOutput {
  const baseDir = path.join(os.homedir(), '.agentics', 'runs');
  const runDir = path.join(baseDir, input.traceId);

  const filesWritten = writeArtifacts(runDir, input);

  return {
    runDir,
    filesWritten,
    mode: 'development',
  };
}

function persistProjectMode(input: AskPersistInput, execCtx: ExecutionContext): AskPersistOutput {
  const originalBranch = execCtx.currentBranch ?? 'main';
  const branch = generateAskBranchName(input.query);

  createScenarioBranch(branch);

  // Write artifacts to .agentics/runs/<traceId>/ within the repo
  const repoRoot = execCtx.repoRoot ?? process.cwd();
  const runDir = path.join(repoRoot, '.agentics', 'runs', input.traceId);
  const filesWritten = writeArtifacts(runDir, input);

  // Commit
  let commitHash: string | undefined;
  try {
    commitHash = commitScenarioFiles(input.query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [WARN] Failed to commit artifacts: ${msg}`);
  }

  // Return to original branch
  checkoutBranch(originalBranch);

  // Build GitHub URL
  let githubUrl: string | undefined;
  if (execCtx.remoteUrl) {
    const ghInfo = parseGitHubRemote(execCtx.remoteUrl);
    if (ghInfo) {
      githubUrl = `https://github.com/${ghInfo.owner}/${ghInfo.repo}/tree/${branch}/.agentics/runs/${input.traceId}`;
    }
  }

  return {
    runDir,
    filesWritten,
    mode: 'project',
    branch,
    commitHash,
    githubUrl,
  };
}

// ============================================================================
// Link Printing
// ============================================================================

/**
 * Print a clickable output link based on execution mode and environment.
 */
export function printOutputLink(output: AskPersistOutput): void {
  console.error('');
  console.error('  ' + '─'.repeat(60));

  if (output.mode === 'project' && output.branch) {
    console.error('  Run artifacts committed to branch:');
    console.error('');

    // Print GitHub URL as an OSC 8 clickable link if available
    if (output.githubUrl) {
      const osc8Link = formatOsc8Link(output.githubUrl, `  View on GitHub: ${output.githubUrl}`);
      console.error(osc8Link);
    }

    console.error('');
    console.error(`  Branch:  ${output.branch}`);
    if (output.commitHash) {
      console.error(`  Commit:  ${output.commitHash.slice(0, 8)}`);
    }
    console.error('');
    console.error('  To browse:');
    console.error(`    git checkout ${output.branch}`);
    console.error(`    ls .agentics/runs/${path.basename(output.runDir)}/`);
    console.error('');
    console.error('  To compare with main:');
    console.error(`    git diff main...${output.branch} --stat`);
  } else {
    // Dev mode
    console.error('  Run artifacts saved:');
    console.error('');

    const isCodespace = process.env['CODESPACES'] === 'true';

    if (isCodespace) {
      // In Codespace, use vscode://file/ URI for clickable link
      const vscodeUri = `vscode://file${output.runDir}`;
      const osc8Link = formatOsc8Link(vscodeUri, `  Open in editor: ${output.runDir}`);
      console.error(osc8Link);
    } else {
      console.error(`  ${output.runDir}`);
    }

    console.error('');
    console.error('  Files:');
    for (const f of output.filesWritten) {
      const fullPath = path.join(output.runDir, f);
      console.error(`    ${fullPath}`);
    }

    console.error('');
    console.error('  To inspect:');
    console.error(`    cat ${path.join(output.runDir, 'summary.md')}`);
    console.error(`    agentics inspect run ${path.basename(output.runDir)}`);
  }

  console.error('  ' + '─'.repeat(60));
  console.error('');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format an OSC 8 terminal hyperlink.
 * Supported by VS Code terminal, iTerm2, Windows Terminal, etc.
 * Falls back to plain text in unsupported terminals.
 */
function formatOsc8Link(url: string, label: string): string {
  // OSC 8 format: \e]8;;URL\e\\LABEL\e]8;;\e\\
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Parse GitHub owner/repo from a remote URL.
 * Handles both HTTPS and SSH formats.
 */
function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }
  return null;
}
