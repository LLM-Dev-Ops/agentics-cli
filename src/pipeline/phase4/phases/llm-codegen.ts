/**
 * Phase 4 — LLM-Driven Code Generation (ADR-067)
 *
 * Shared utility for generating code via the canonical hardened Claude Code
 * transport instead of string templates. Each Phase 4 stage builds a prompt
 * from SPARC output, DDD model, ADRs, simulation context, and tech stack,
 * then sends it to Claude for code generation.
 *
 * ADR-PIPELINE-114 (§D1–D5): the prompt — which is large (SPARC + DDD + ADRs +
 * simulation context + tech stack, ~95–120 KB) — MUST NOT be passed as an argv
 * argument (ARG_MAX / E2BIG truncation). It is delivered via STDIN through the
 * single canonical Claude Code runner (`createClaudeCodeRunner().invoke()`):
 *   - prompt via stdin, never argv
 *   - `--output-format json` envelope (unwrapped by the runner)
 *   - the ONE canonical `claude` resolver (ADR-114 §D5) — no per-module detector
 * There is no direct `claude --print` spawn here and no raw-API path; this
 * module never opens a provider connection of its own.
 *
 * Falls back to template generators when the claude binary is unavailable
 * (the runner throws, which is caught and surfaced as `source: 'unavailable'`).
 */

import { createClaudeCodeRunner } from '../../../runtime/claude-code-runner.js';

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
 * Generate code via the canonical hardened Claude Code transport (ADR-114).
 *
 * The prompt is delivered to `claude` over STDIN by the shared runner
 * (`invoke()` with `--output-format json`), so the ~95–120 KB codegen prompt is
 * never subject to ARG_MAX / E2BIG argv truncation. Binary resolution uses the
 * one canonical resolver. Returns null code when the claude binary is
 * unavailable (runner throws) or the model returns empty/short output — the
 * caller falls back to its template generator.
 */
export function generateCodeViaLLM(options: LLMCodegenOptions): LLMCodegenResult {
  const start = Date.now();

  try {
    const model = options.model ?? process.env['AGENTICS_CLAUDE_MODEL'] ?? 'sonnet';

    // ADR-114 §D1–D5: route through the single canonical hardened runner.
    // `invoke()` pipes the prompt via stdin, runs `--output-format json`, and
    // unwraps the Claude Code envelope. For free-form code (not contract JSON)
    // the unwrapped payload exposes the model text as `.content`. No schemaKey
    // is supplied, so no contract validation is applied.
    const runner = createClaudeCodeRunner();
    const result = runner.invoke<{ content?: string } & Record<string, unknown>>(options.prompt, {
      runId: `llm-codegen-${options.label}`,
      model,
      timeoutMs: options.timeoutMs ?? 90_000,
    });
    const rawOutput = typeof result.data.content === 'string' ? result.data.content : '';

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
    process.stderr.write(`[llm-codegen] ${options.label}: Generated ${code.length} chars in ${durationMs}ms via canonical hardened runner (ADR-114, transport=stdin/json)\n`);
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
