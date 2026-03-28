/**
 * Phase 4 — LLM-Driven Code Generation (ADR-067)
 *
 * Shared utility for generating code via `claude --print` instead of
 * string templates. Each Phase 4 stage builds a prompt from SPARC output,
 * DDD model, ADRs, simulation context, and tech stack, then sends it
 * to Claude for code generation.
 *
 * Falls back to template generators when claude binary is unavailable.
 */

import { execFileSync } from 'node:child_process';

// ============================================================================
// Claude Binary Resolution (cached)
// ============================================================================

let _claudeBin: string | null | undefined; // undefined = not checked yet

function resolveClaudeBinary(): string | null {
  if (_claudeBin !== undefined) return _claudeBin;

  const envBin = process.env['AGENTICS_CLAUDE_BIN'];
  if (envBin) {
    _claudeBin = envBin;
    return _claudeBin;
  }

  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const candidate of ['claude', 'claude-code']) {
    try {
      const found = execFileSync(lookupCmd, [candidate], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        encoding: 'utf-8',
      }).trim().split(/\r?\n/)[0]?.trim();
      if (found) {
        _claudeBin = found;
        return _claudeBin;
      }
    } catch { /* not found */ }
  }

  _claudeBin = null;
  return null;
}

// ============================================================================
// LLM Code Generation
// ============================================================================

export interface LLMCodegenOptions {
  /** Human-readable label for logging (e.g., "schemas.ts", "routes.ts") */
  label: string;
  /** The full prompt including SPARC context, DDD model, etc. */
  prompt: string;
  /** Timeout in ms (default: 90s) */
  timeoutMs?: number;
  /** Model override (default: claude-sonnet-4-20250514) */
  model?: string;
}

export interface LLMCodegenResult {
  /** Generated code (or null if LLM unavailable) */
  code: string | null;
  /** Whether this came from LLM or was null (caller should use template fallback) */
  source: 'llm' | 'unavailable';
  /** Duration in ms */
  durationMs: number;
}

/**
 * Generate code via `claude --print`.
 * Returns null code if claude binary is unavailable — caller should fall back to template.
 */
export function generateCodeViaLLM(options: LLMCodegenOptions): LLMCodegenResult {
  const start = Date.now();
  const claudeBin = resolveClaudeBinary();

  if (!claudeBin) {
    return { code: null, source: 'unavailable', durationMs: Date.now() - start };
  }

  try {
    const model = options.model ?? process.env['AGENTICS_CLAUDE_MODEL'] ?? 'claude-sonnet-4-20250514';
    const rawOutput = execFileSync(claudeBin, [
      '--print',
      '--output-format', 'text',
      '--model', model,
      options.prompt,
    ], {
      encoding: 'utf-8',
      timeout: options.timeoutMs ?? 90_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_SERVER_MODE: undefined },
    });

    // Strip markdown code fences if present
    let code = rawOutput.trim();
    if (code.startsWith('```')) {
      code = code.replace(/^```(?:typescript|ts|rust|json|yaml|dockerfile|makefile)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    if (!code || code.length < 20) {
      process.stderr.write(`[llm-codegen] ${options.label}: LLM returned empty/short output (${code.length} chars)\n`);
      return { code: null, source: 'unavailable', durationMs: Date.now() - start };
    }

    const durationMs = Date.now() - start;
    process.stderr.write(`[llm-codegen] ${options.label}: Generated ${code.length} chars in ${durationMs}ms via claude --print\n`);
    return { code, source: 'llm', durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[llm-codegen] ${options.label}: LLM generation failed: ${msg}\n`);
    return { code: null, source: 'unavailable', durationMs: Date.now() - start };
  }
}

// ============================================================================
// Prompt Builders — shared context formatters
// ============================================================================

export interface CodegenContext {
  scenarioQuery: string;
  sparc?: {
    specification?: string;
    architecture?: string;
    pseudocode?: string;
    refinement?: string;
    completion?: string;
  };
  dddContexts: Array<{
    name: string;
    commands: Array<{ name: string; description?: string; input?: readonly string[]; preconditions?: readonly string[]; postconditions?: readonly string[] }>;
    queries: Array<{ name: string; description?: string; parameters?: readonly string[]; returns?: string }>;
    entities: Array<{ name: string; description: string }>;
    valueObjects: Array<{ name: string; description: string }>;
    domainEvents: Array<{ name: string; description?: string; payload?: readonly string[]; triggeredBy?: string }>;
    invariants: string[];
  }>;
  adrs?: Array<{ title: string; decision: string }>;
  simulationContext?: {
    scenarios: ReadonlyArray<{ id: string; name: string; costDelta: number; riskLevel: string; [key: string]: unknown }>;
    costModel: unknown;
    simulationId: string | null;
    [key: string]: unknown;
  } | null;
  techStack: {
    erp?: string;
    cloud?: string;
    databases?: string[];
    languages?: string[];
    hasRustOptimizer?: boolean;
  };
}

export function formatDDDForPrompt(contexts: CodegenContext['dddContexts']): string {
  return contexts.map(ctx => {
    const parts = [`### ${ctx.name}`];
    if (ctx.commands.length > 0) {
      parts.push('Commands:');
      for (const cmd of ctx.commands) {
        parts.push(`  - ${cmd.name}: ${cmd.description ?? ''}`);
        if (cmd.preconditions?.length) parts.push(`    Preconditions: ${cmd.preconditions.join('; ')}`);
        if (cmd.input?.length) parts.push(`    Input: ${cmd.input.join(', ')}`);
      }
    }
    if (ctx.queries.length > 0) {
      parts.push('Queries:');
      for (const q of ctx.queries) {
        parts.push(`  - ${q.name}: ${q.description ?? ''} → ${q.returns ?? 'unknown'}`);
        if (q.parameters?.length) parts.push(`    Parameters: ${q.parameters.join(', ')}`);
      }
    }
    if (ctx.invariants.length > 0) {
      parts.push(`Invariants: ${ctx.invariants.join('; ')}`);
    }
    if (ctx.domainEvents.length > 0) {
      parts.push(`Domain Events: ${ctx.domainEvents.map(e => e.name).join(', ')}`);
    }
    return parts.join('\n');
  }).join('\n\n');
}

export function formatSimulationForPrompt(simCtx: CodegenContext['simulationContext']): string {
  if (!simCtx || (!simCtx.scenarios.length && !simCtx.simulationId)) return 'No simulation context available.';
  const parts = [`Simulation ID: ${simCtx.simulationId ?? 'none'}`];
  if (simCtx.scenarios.length > 0) {
    parts.push(`Scenarios (${simCtx.scenarios.length}):`);
    for (const s of simCtx.scenarios.slice(0, 5)) {
      parts.push(`  - ${s.name}: costDelta=${s.costDelta}, risk=${s.riskLevel}`);
    }
  }
  if (simCtx.costModel) parts.push(`Cost Model: ${JSON.stringify(simCtx.costModel).slice(0, 300)}`);
  return parts.join('\n');
}
