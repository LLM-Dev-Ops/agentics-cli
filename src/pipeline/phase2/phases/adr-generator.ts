/**
 * Phase 2 Pipeline -- Stage 4: ADR Generator
 *
 * Generates Architecture Decision Records as markdown documents driven by
 * the SPARC specification and research dossier. ADRs are derived from actual
 * architectural decisions implied by the SPARC output.
 *
 * Primary output: ADR markdown files (one per decision)
 * Compat output: adr-index.json for downstream consumers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2ADRAlternative,
  Phase2ADRConsequence,
  ResearchDossier,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { detectTechnologyStack, writeTechStack, formatERPContextForPrompt } from './tech-stack-detector.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ADR_SUBDIR = 'adrs';

/**
 * Load agentics fleet report from phase2Dir and format for LLM context.
 */
function loadAgenticsFleetContextForADR(phase2Dir: string): string {
  try {
    // Check phase dir first, then .pre-phaseN (written before phase command runs)
    let reportPath = path.join(phase2Dir, 'agentics-agents-report.json');
    if (!fs.existsSync(reportPath)) {
      const prePhaseDir = path.join(path.dirname(phase2Dir), `.pre-${path.basename(phase2Dir)}`);
      reportPath = path.join(prePhaseDir, 'agentics-agents-report.json');
    }
    if (!fs.existsSync(reportPath)) return '';
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      results?: Array<{ domain: string; agent: string; role: string; status: number; response: unknown }>;
    };
    if (!report.results || report.results.length === 0) return '';
    const successResults = report.results.filter(r => r.status === 200);
    if (successResults.length === 0) return '';
    const summaries = successResults.slice(0, 12).map(r => {
      const resp = r.response as Record<string, unknown> | undefined;
      const data = resp?.['data'] as Record<string, unknown> | undefined;
      let finding = '';
      if (data) {
        const vals = Object.values(data).filter(v => typeof v === 'string').slice(0, 2);
        finding = vals.map(v => String(v).slice(0, 100)).join('; ');
      }
      return `- [${r.domain}/${r.agent}] ${r.role}: ${finding || 'completed'}`;
    }).join('\n');
    return `\nAGENTICS FLEET ANALYSIS (${successResults.length} agents):\n${summaries}\n`;
  } catch { return ''; }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function findDossierRefs(dossier: ResearchDossier, keywords: readonly string[]): string[] {
  const refs: string[] = [];
  for (const item of dossier.items) {
    const text = `${item.title} ${item.content}`.toLowerCase();
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      refs.push(item.id);
    }
  }
  return refs;
}

// ============================================================================
// ADR Markdown Renderer
// ============================================================================

function renderADRMarkdown(adr: Phase2ADRRecord): string {
  // ADR-PIPELINE-100 §D1: when the LLM emitted markdown directly, write it
  // verbatim. Structured fields are best-effort metadata, not the source of
  // truth — re-rendering from them would lose diagrams, code samples, tables.
  if (adr.rawMarkdown && adr.rawMarkdown.trim().length > 0) {
    return adr.rawMarkdown.endsWith('\n') ? adr.rawMarkdown : adr.rawMarkdown + '\n';
  }

  const lines: string[] = [];
  lines.push(`# ${adr.id}: ${adr.title}`);
  lines.push('');
  lines.push(`**Status:** ${adr.status}`);
  lines.push(`**Date:** ${adr.date}`);
  lines.push('');
  lines.push('## Context');
  lines.push(adr.context);
  lines.push('');
  lines.push('## Decision');
  lines.push(adr.decision);
  lines.push('');

  if (adr.alternatives.length > 0) {
    lines.push('## Alternatives Considered');
    for (const alt of adr.alternatives) {
      const status = alt.rejected ? '(rejected)' : '(selected)';
      lines.push(`- **${alt.option}** ${status}: ${alt.rationale}`);
    }
    lines.push('');
  }

  if (adr.consequences.length > 0) {
    lines.push('## Consequences');
    for (const c of adr.consequences) {
      const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
      lines.push(`- [${icon}] ${c.description}`);
    }
    lines.push('');
  }

  if (adr.researchDossierItemRefs.length > 0) {
    lines.push('## References');
    lines.push(`Dossier items: ${adr.researchDossierItemRefs.join(', ')}`);
    lines.push('');
  }

  // ADR-PIPELINE-018: Include simulation lineage when present
  if (adr.simulationId) {
    lines.push('## Lineage');
    lines.push(`Originating simulation: ${adr.simulationId}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// ADR Builder — derived from SPARC + dossier
// ============================================================================

function makeAlt(option: string, rationale: string, rejected: boolean): Phase2ADRAlternative {
  return { option, rationale, rejected };
}

function makeCons(description: string, type: 'positive' | 'negative' | 'neutral'): Phase2ADRConsequence {
  return { description, type };
}


/**
 * Generate ADRs for a project via the LLM transports.
 *
 * ADR-PIPELINE-100 §D5: there is no silent SPARC-template fallback. When
 * every LLM transport fails this returns a single loud-failure ADR record
 * that the renderer writes as `ADR-FAIL-001.md`.
 *
 * Callers that want to skip the LLM and emit a failure ADR directly (the
 * auto-chain "ensure ADRs exist" guarantee paths) should call
 * `buildLoudFailureADR` directly rather than passing a flag here.
 */
export async function buildPhase2ADRs(sparc: Phase2SPARCOutput, dossier: ResearchDossier, query?: string): Promise<Phase2ADRRecord[]> {
  if (!query) {
    process.stderr.write('[adr-generator] No query provided — emitting loud-failure ADR (ADR-PIPELINE-100 §D5)\n');
    return [buildLoudFailureADR({
      reason: 'No query string available — Phase 1 manifest/scenario did not surface the user prompt.',
      phase1Status: 'missing-query',
      dossierItemCount: dossier.items.length,
    })];
  }

  const runnerResult = await tryGenerateLLMADRs(sparc, dossier, query);
  if (runnerResult && runnerResult.length > 0) return runnerResult;
  const claudeFailureReason = 'tryGenerateLLMADRs returned no parseable markdown ADRs (timeout, claude binary missing, or empty output)';

  const apiResult = await tryGenerateADRsViaAPI(sparc, dossier, query);
  if (apiResult && apiResult.length > 0) return apiResult;
  const apiFailureReason = 'tryGenerateADRsViaAPI returned no parseable markdown ADRs (no ANTHROPIC_API_KEY, network, timeout, or rate-limit)';

  process.stderr.write('[adr-generator] All LLM transports failed — emitting loud-failure ADR (ADR-PIPELINE-100 §D5)\n');

  return [buildLoudFailureADR({
    reason: 'All LLM transports failed to return parseable markdown ADRs.',
    claudeFailureReason,
    apiFailureReason,
    dossierItemCount: dossier.items.length,
    sparcStatus: (sparc.architecture?.services?.length ?? 0) > 0 ? 'present' : 'missing-services',
    query,
  })];
}

/**
 * Render a list of ADR records as a single markdown document.
 * Used by ask-artifact-writer to produce engineering/architecture-decisions.md
 */
export function renderADRsAsDocument(adrs: Phase2ADRRecord[], query: string): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push('# Architecture Decision Records');
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push(`> Project: ${query.slice(0, 200)}${query.length > 200 ? '...' : ''}`);
  lines.push(`> Derived from: SPARC specification analysis`);
  lines.push('');

  for (const adr of adrs) {
    lines.push(renderADRMarkdown(adr));
    lines.push('---');
    lines.push('');
  }

  lines.push(`*${adrs.length} ADRs derived from SPARC analysis. Review with the team before implementation.*`);
  return lines.join('\n');
}

// ============================================================================
// ADR-027: LLM-Generated Architecture Decision Records
// ============================================================================

/**
 * Generate domain-specific ADRs using Claude (--print mode).
 * Bypasses the MCP availability guard since `claude --print` is a stateless
 * one-shot subprocess that does NOT use MCP — safe to call from any context.
 * Uses the user's Claude Max subscription (no separate API key needed).
 */
async function tryGenerateLLMADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
  phase2Dir = '',
): Promise<Phase2ADRRecord[] | null> {
  try {
    const claudeBin = resolveClaudeBin();
    if (!claudeBin) {
      process.stderr.write('[CANNED FALLBACK] [adr-generator] claude binary not found on PATH — falling back to ADR-FAIL-001 stub. Set AGENTICS_CLAUDE_BIN or install Claude Code.\n');
      return null;
    }

    const delimiter = newDocBreakDelimiter();
    const prompt = buildADRPrompt(sparc, dossier, query, delimiter, phase2Dir);
    const model = process.env['AGENTICS_CLAUDE_MODEL'] || 'claude-sonnet-4-20250514';
    const timeoutMs = parseAdrTimeoutMs();
    const startMs = Date.now();

    process.stderr.write(`[adr-generator] starting claude --print: model=${model}, timeout=${Math.round(timeoutMs / 1000)}s, prompt=${prompt.length} chars\n`);

    const result = await runStreamedClaudePrint(claudeBin, prompt, model, timeoutMs, phase2Dir);
    if (!result.ok) {
      process.stderr.write(
        `[CANNED FALLBACK] [adr-generator] Claude --print stream failed: ${result.reason} ` +
          `(received ${result.stdoutBytes} bytes over ${result.elapsedMs}ms) — will salvage partial output if ≥1KB, otherwise emit ADR-FAIL-001 stub\n`,
      );
      // ADR-PIPELINE-100 §D3: streamed output is preserved on timeout/kill, so
      // we still try to parse what came back — if the LLM finished the first
      // few ADRs before the cap, those are usable.
      if (result.stdout && result.stdoutBytes > 1024) {
        const partial = parseMarkdownADRs(result.stdout, delimiter, dossier);
        if (partial && partial.length > 0) {
          process.stderr.write(
            `[adr-generator] Salvaged ${partial.length} ADR(s) from partial stream output\n`,
          );
          return partial;
        }
      }
      return null;
    }

    const adrs = parseMarkdownADRs(result.stdout, delimiter, dossier);
    if (!adrs || adrs.length === 0) {
      process.stderr.write(`[CANNED FALLBACK] [adr-generator] Claude --print returned ${result.stdoutBytes} bytes but parseMarkdownADRs extracted 0 ADRs — delimiter "${delimiter.slice(0, 40)}…" not found or markdown malformed. Falling back to ADR-FAIL-001 stub.\n`);
      return null;
    }

    const durationMs = Date.now() - startMs;
    process.stderr.write(
      `[adr-generator] LLM-generated ${adrs.length} domain-specific ADRs via streamed claude --print ` +
        `in ${durationMs}ms (${result.stdoutBytes} bytes, markdown-direct, ADR-PIPELINE-100)\n`,
    );
    return adrs;
  } catch (err: unknown) {
    process.stderr.write(
      `[CANNED FALLBACK] [adr-generator] LLM ADR generation threw: ${err instanceof Error ? err.message : String(err)} — emitting ADR-FAIL-001 stub. Stack: ${err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : 'n/a'}\n`,
    );
    return null;
  }
}

/**
 * Locate the `claude` CLI binary for `--print` invocation.
 * Honors `AGENTICS_CLAUDE_BIN` env override first, then probes PATH for
 * `claude` and `claude-code`. Returns null when no binary is available.
 */
function resolveClaudeBin(): string | null {
  const envBin = process.env['AGENTICS_CLAUDE_BIN'];
  if (envBin) return envBin;

  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const candidate of ['claude', 'claude-code']) {
    try {
      const found = execFileSync(lookupCmd, [candidate], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        encoding: 'utf-8',
      }).trim().split(/\r?\n/)[0]?.trim();
      if (found) return found;
    } catch { /* not found, try next */ }
  }
  return null;
}

/**
 * Result of a streamed `claude --print` invocation.
 * `stdout` is the full buffered stdout received so far (preserved even on
 * failure paths so partial ADRs can be salvaged per ADR-PIPELINE-100 §D3).
 */
interface StreamedClaudeResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
}

/**
 * ADR-PIPELINE-100 §D3: streamed `claude --print` subprocess.
 *
 * Replaces buffered execFileSync with `child_process.spawn` so:
 *   - stdout is collected incrementally (partial output preserved on kill)
 *   - stderr is forwarded live to the user (visible Claude Code progress)
 *   - a 10-second heartbeat reports elapsed time and bytes-received so the
 *     terminal isn't silent during long generations
 *   - a 60-second idle bound kills the process if no output has been received
 *     in a minute (catches hung subprocesses without waiting for the hard cap)
 *   - a hard timeout of `timeoutMs` (default 30 minutes) is the absolute upper
 *     bound; runaway generations are killed and reported as failures
 *
 * Returns `{ ok: false }` with the partial `stdout` populated when the
 * subprocess is killed or exits non-zero. Caller may attempt to salvage
 * partial output rather than discarding the whole run.
 */
async function runStreamedClaudePrint(
  claudeBin: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  phase2Dir: string,
): Promise<StreamedClaudeResult> {
  const startMs = Date.now();
  const idleBoundMs = parseInt(process.env['AGENTICS_ADR_IDLE_MS'] || '', 10) || 60_000;
  const heartbeatMs = parseInt(process.env['AGENTICS_ADR_HEARTBEAT_MS'] || '', 10) || 10_000;

  return new Promise<StreamedClaudeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let lastDataMs = Date.now();
    let killed = false;
    let killReason: string | undefined;

    const child = spawn(claudeBin, [
      '--print',
      '--output-format', 'text',
      '--model', model,
      prompt,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_SERVER_MODE: undefined },
    });

    process.stderr.write(
      `[adr-generator] Streaming claude --print (model=${model}, timeout=${Math.floor(timeoutMs / 1000)}s, idle=${Math.floor(idleBoundMs / 1000)}s)\n`,
    );

    const debugLogPath = phase2Dir ? path.join(phase2Dir, 'claude-stderr.log') : null;
    let debugStream: fs.WriteStream | null = null;
    if (debugLogPath) {
      try {
        fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        debugStream = fs.createWriteStream(debugLogPath, { flags: 'a' });
      } catch { /* best-effort */ }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      lastDataMs = Date.now();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      // Forward Claude Code's stderr live so the user sees progress / warnings.
      // ADR-PIPELINE-099 heartbeat compatibility: prefix with [claude] so the
      // terminal scroller can identify the source.
      process.stderr.write(`[claude] ${text}`);
      debugStream?.write(text);
    });

    const heartbeat = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
      const bytes = stdout.length;
      const idleSec = Math.floor((Date.now() - lastDataMs) / 1000);
      process.stderr.write(
        `[agentics] ⏳ ADR generation streaming — ${elapsedSec}s elapsed, ${bytes} bytes received, ${idleSec}s since last byte\n`,
      );
    }, heartbeatMs);

    const idleCheck = setInterval(() => {
      if (Date.now() - lastDataMs > idleBoundMs && !killed) {
        killed = true;
        killReason = `idle bound exceeded (no output for ${Math.floor((Date.now() - lastDataMs) / 1000)}s)`;
        process.stderr.write(`[adr-generator] Killing claude --print: ${killReason}\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }
    }, Math.min(heartbeatMs, 5000));

    const hardTimeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        killReason = `hard timeout exceeded (${Math.floor(timeoutMs / 1000)}s)`;
        process.stderr.write(`[adr-generator] Killing claude --print: ${killReason}\n`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        // SIGKILL backstop in case SIGTERM is ignored.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      }
    }, timeoutMs);

    child.on('error', (err: Error) => {
      clearInterval(heartbeat);
      clearInterval(idleCheck);
      clearTimeout(hardTimeout);
      debugStream?.end();
      resolve({
        ok: false,
        reason: `spawn error: ${err.message}`,
        stdout,
        stderr,
        stdoutBytes: stdout.length,
        elapsedMs: Date.now() - startMs,
        exitCode: null,
      });
    });

    child.on('close', (code: number | null) => {
      clearInterval(heartbeat);
      clearInterval(idleCheck);
      clearTimeout(hardTimeout);
      debugStream?.end();
      const elapsedMs = Date.now() - startMs;
      const ok = !killed && code === 0;
      resolve({
        ok,
        reason: ok ? undefined : (killReason ?? `claude --print exited with code ${code}`),
        stdout,
        stderr,
        stdoutBytes: stdout.length,
        elapsedMs,
        exitCode: code,
      });
    });
  });
}

/**
 * Read `AGENTICS_ADR_TIMEOUT_MS` from env (default 30 minutes per
 * ADR-PIPELINE-100 §D3). Clamps to [60s, 60min] to prevent both runaway runs
 * and accidental zero/negative values.
 */
function parseAdrTimeoutMs(): number {
  const raw = process.env['AGENTICS_ADR_TIMEOUT_MS'];
  const parsed = raw ? Number(raw) : NaN;
  const def = 30 * 60 * 1000;     // 30 min
  if (!Number.isFinite(parsed) || parsed <= 0) return def;
  const min = 60 * 1000;          // 1 min lower bound
  const max = 60 * 60 * 1000;     // 60 min upper bound
  return Math.max(min, Math.min(max, parsed));
}

// ============================================================================
// ADR-PIPELINE-100: Markdown-direct ADR generation
// ============================================================================
//
// The LLM emits a sequence of full markdown ADR documents separated by a
// per-run UUID delimiter. We split on the delimiter, write each chunk as its
// own .md file, and best-effort extract a small set of structured fields
// (title, status, date, phaseTags) for the index. The full markdown is the
// canonical artifact — we never re-serialise it from the structured fields.

const DOC_BREAK_PREFIX = '---ADR-DOC-BREAK-';
const DOC_BREAK_SUFFIX = '---';

/** Generate a per-run document delimiter for the LLM prompt. */
function newDocBreakDelimiter(): string {
  return `${DOC_BREAK_PREFIX}${randomUUID()}${DOC_BREAK_SUFFIX}`;
}

/**
 * Locate and load the canonical good-ADR exemplar shipped with the repo.
 * Tries CWD first, then walks up from this module's location to find the
 * `docs/templates/ADR-Good-Example.md` file (handles src/ vs dist/ layouts).
 * Returns the empty string when not found — the prompt still works without
 * an exemplar but the output will be lower quality.
 */
function loadGoodAdrExemplar(): string {
  const candidates: string[] = [];
  candidates.push(path.resolve(process.cwd(), 'docs/templates/ADR-Good-Example.md'));
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
      candidates.push(path.join(dir, 'docs', 'templates', 'ADR-Good-Example.md'));
      dir = path.dirname(dir);
    }
  } catch { /* import.meta unavailable in some test contexts */ }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch { /* ignore unreadable candidates */ }
  }
  return '';
}

/**
 * Build the ADR generation prompt from SPARC + dossier + query.
 * Shared between tryGenerateLLMADRs (Claude Code runner) and tryGenerateADRsViaAPI (direct API).
 *
 * ADR-PIPELINE-100 §D1: prompt instructs the LLM to emit a sequence of full
 * markdown ADR documents separated by `delimiter`. The good-ADR exemplar is
 * embedded verbatim as a STRUCTURAL reference, with explicit instruction that
 * the input domain comes from the project requirements section, not the
 * exemplar. This keeps the generator domain-agnostic.
 */
function buildADRPrompt(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
  delimiter: string,
  phase2Dir = '',
): string {
  const services = sparc.architecture?.services ?? [];
  const serviceList = services.map(s =>
    `- ${s.name}: ${s.responsibility.slice(0, 200)} (deps: ${s.dependencies.join(', ') || 'none'})`
  ).join('\n');

  const dossierContext = dossier.items
    .filter(i => ['requirement', 'constraint', 'risk', 'decision-rationale'].includes(i.category))
    .slice(0, 30)
    .map(i => `- [${i.category}] ${i.title}: ${i.content.slice(0, 240)}`)
    .join('\n');

  const agentContext = phase2Dir ? loadAgenticsFleetContextForADR(phase2Dir) : '';

  const dossierText = dossier.items.map(i => i.content).join(' ');
  const techStack = detectTechnologyStack(query, dossierText);
  const techMentions: string[] = [];
  if (techStack.erp) techMentions.push(techStack.erp.name);
  if (techStack.cloud) techMentions.push(techStack.cloud.toUpperCase());
  if (techStack.database) techMentions.push(techStack.database);
  if (techStack.messageQueue) techMentions.push(techStack.messageQueue);
  if (techStack.searchEngine) techMentions.push(techStack.searchEngine);
  if (techStack.cacheLayer) techMentions.push(techStack.cacheLayer);

  const erpPromptContext = techStack.erp
    ? `\n## ERP integration surface (use these EXACT paths)\n${formatERPContextForPrompt(techStack.erp)}\n`
    : '';

  const exemplar = loadGoodAdrExemplar();
  const exemplarBlock = exemplar
    ? `\n## Structural exemplar (the bar to match)\n\n` +
      `The following is a canonical "good" ADR from a different domain (vector database). ` +
      `**Match its structure, depth, and rigour for the input domain below.** ` +
      `Do NOT reuse its subject matter — your input is the project requirements section, ` +
      `not the exemplar. Match these structural elements:\n\n` +
      `- Header block: Status / Date / Authors / Deciders / Builds-on / **Implementation Phase**\n` +
      `- Context with sub-sections and at least one comparison table\n` +
      `- Decision section with an architecture diagram (ASCII art or mermaid)\n` +
      `- Per-component subsections with code samples (typed signatures, struct/class definitions)\n` +
      `- Real source-file paths consistent with the project's tech stack\n` +
      `- Configuration parameters table (param / default / description)\n` +
      `- Per-platform or per-mode performance characteristics where relevant\n` +
      `- Numbered Alternatives Considered with multi-line "Rejected because:" rationales\n` +
      `- Consequences split into Benefits, Risks (table with Probability/Impact/Mitigation), Performance Targets\n` +
      `- Implementation Status table\n` +
      `- Related Decisions cross-links\n` +
      `- Revision History table\n\n` +
      `<EXEMPLAR>\n${exemplar}\n</EXEMPLAR>\n`
    : '';

  return (
    `You are a senior solution architect writing Architecture Decision Records.\n\n` +
    `Read the FULL project requirements, research findings, and detected technologies below, then write 8 to 14 ` +
    `ADRs as full markdown documents that guide a developer on HOW to build the specific system the user described.\n\n` +
    `## Project Requirements\n\n${query}\n\n` +
    `## Services Identified\n${serviceList || '(none — derive from requirements)'}\n` +
    `\n## Research Findings\n${dossierContext || '(no dossier items available)'}\n` +
    (agentContext ? agentContext + '\n' : '') +
    `\n## Detected Technologies\n${techMentions.join(', ') || '(none specified — pick reasonable defaults and justify them)'}\n` +
    erpPromptContext +
    exemplarBlock +
    `\n## Output format (CRITICAL — read carefully)\n\n` +
    `Emit ${techMentions.length > 0 ? '10 to 14' : '8 to 12'} ADRs as a sequence of full markdown documents.\n` +
    `Separate consecutive ADR documents with **exactly** this delimiter on its own line:\n\n` +
    `${delimiter}\n\n` +
    `Do not use that string anywhere else in your output. Do not wrap the response in code fences. ` +
    `Do not include any preamble, postscript, or explanation outside the ADR documents.\n\n` +
    `Each ADR document MUST start with:\n\n` +
    `\`\`\`\n` +
    `# ADR-P2-NNN: <specific decision title>\n\n` +
    `**Status:** Proposed\n` +
    `**Date:** ${new Date().toISOString().slice(0, 10)}\n` +
    `**Implementation Phase:** <foundation|domain|integration|api|deployment|operations|cross-cutting>\n` +
    `\`\`\`\n\n` +
    `where NNN is a zero-padded sequential number starting at 001. The Implementation Phase tag drives ` +
    `phase-aware ADR injection in the implementation prompts (ADR-PIPELINE-100 §D4): use \`foundation\` ` +
    `for repo scaffolding and core types, \`domain\` for domain models and business logic, \`integration\` ` +
    `for adapters/connectors/anti-corruption layers, \`api\` for HTTP/RPC surfaces, \`deployment\` for ` +
    `infrastructure/CI/Docker, \`operations\` for observability/logging/metrics, \`cross-cutting\` for ` +
    `decisions that apply across all phases (security, governance, audit).\n\n` +
    `## Coverage requirements\n\n` +
    `The complete set of ADRs must cover BOTH categories:\n\n` +
    `**A) Domain-specific decisions (at least 5)** — implementation of the actual business logic from the ` +
    `requirements. Each non-obvious algorithmic choice gets its own ADR: scoring/ranking, routing/filtering, ` +
    `factor sourcing, threshold models, estimation fallbacks, immutability/audit patterns, etc.\n\n` +
    `**B) Infrastructure decisions (3-5)** — supporting technology: data persistence, ` +
    `${techMentions[0] ? techMentions[0] + ' integration approach' : 'integration approach'}, deployment, security/compliance.\n\n` +
    `## Title rules\n\n` +
    `- GOOD: "Use Monte Carlo simulation for carbon price forecasting with configurable volatility"\n` +
    `- BAD: "Performance Architecture"\n` +
    `- GOOD: "Model emissions baseline as facility-level time series with business unit rollup"\n` +
    `- BAD: "Data persistence strategy"\n\n` +
    `Each title describes a specific decision the developer must build, not a category.\n\n` +
    `## Quality bar\n\n` +
    `- Reference actual domain concepts from the requirements (not generic "entities" or "services")\n` +
    `- If the user specified technologies (${techMentions.join(', ') || 'none specified'}), reference them in relevant ADRs by name\n` +
    `- Decision sections must be deep enough that a developer can build from them — multiple paragraphs, code samples where appropriate, file paths, named types\n` +
    `- Alternatives Considered must include 2-4 options with substantive rejection rationales (not strawmen)\n` +
    `- Consequences must include both benefits and risks; risks should be in a table with probability/impact/mitigation columns\n` +
    `- Match the structural depth of the exemplar above for the user's domain\n\n` +
    `Begin output now. First ADR's \`# ADR-P2-001:\` heading should be the very first line. ` +
    `No preamble.`
  );
}

/**
 * Parse a raw LLM markdown response into Phase2ADRRecord[].
 * ADR-PIPELINE-100 §D1: split on the per-run delimiter, then per-chunk extract
 * a flat metadata head (id/title/status/date/phaseTags) and store the full
 * chunk as `rawMarkdown`. Tolerant to minor heading variation.
 */
function parseMarkdownADRs(
  rawText: string,
  delimiter: string,
  dossier: ResearchDossier,
): Phase2ADRRecord[] | null {
  if (!rawText || !delimiter) return null;

  // Strip surrounding code fences if the LLM wrapped its output despite
  // instruction not to.
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }

  // Primary split: per-run UUID delimiter.
  let chunks = cleaned
    .split(delimiter)
    .map(c => c.trim())
    .filter(c => c.length > 0);

  // Secondary split: if the model ignored the delimiter and emitted multiple
  // ADRs separated by `# ADR-...` headers, recover by splitting on those.
  if (chunks.length <= 1) {
    const headerSplits = cleaned.split(/(?=^#\s+ADR[-\s])/m).map(c => c.trim()).filter(c => c.length > 0);
    if (headerSplits.length > 1) {
      chunks = headerSplits;
    }
  }

  if (chunks.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);
  const records: Phase2ADRRecord[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const md = chunks[i]!;
    const meta = extractAdrMetaFromMarkdown(md, i + 1);

    // Best-effort structured-field extraction for backward-compat consumers.
    const context = extractMdSection(md, /^##\s+context\b/im) || '';
    const decision = extractMdSection(md, /^##\s+decision\b/im) || '';
    const alternatives = extractAlternativesFromMd(md, decision);
    const consequences = extractConsequencesFromMd(md);

    records.push({
      id: meta.id,
      title: meta.title,
      status: meta.status,
      date: meta.date || today,
      context,
      decision,
      alternatives,
      consequences,
      sparcSectionRefs: [],
      researchDossierItemRefs: findDossierRefs(dossier, [meta.title.toLowerCase()]),
      rawMarkdown: md.endsWith('\n') ? md : md + '\n',
      phaseTags: meta.phaseTags,
    });
  }

  return records.length > 0 ? records : null;
}

/**
 * Extract a flat metadata head (id, title, status, date, phaseTags) from a
 * single ADR markdown chunk. Tolerant of minor variation; falls back to a
 * generated ID if the H1 is missing or malformed.
 */
function extractAdrMetaFromMarkdown(md: string, fallbackIndex: number): {
  id: string;
  title: string;
  status: 'proposed' | 'accepted' | 'deprecated' | 'failed';
  date: string;
  phaseTags: string[];
} {
  // H1 like `# ADR-P2-001: Some Title` or `# ADR-PIPELINE-100: Some Title`
  const h1Re = /^#\s+(ADR[-\w]*\d+)[:\s]+(.+?)\s*$/m;
  const h1 = md.match(h1Re);
  const id = h1?.[1]?.trim() || `ADR-P2-${pad3(fallbackIndex)}`;
  let title = (h1?.[2] || '').trim();
  if (!title) {
    // Fallback: first H1 line, anything after the colon
    const anyH1 = md.match(/^#\s+(.+?)\s*$/m);
    title = anyH1?.[1]?.trim() || `Decision ${fallbackIndex}`;
    title = title.replace(/^ADR[-\w]*\d+\s*[:\s]+/i, '').trim() || `Decision ${fallbackIndex}`;
  }

  const statusLine = md.match(/^\*\*Status:\*\*\s*(.+?)\s*$/im);
  const statusText = (statusLine?.[1] || '').toLowerCase();
  const status: 'proposed' | 'accepted' | 'deprecated' | 'failed' =
    statusText.includes('failed') ? 'failed'
    : statusText.includes('deprecated') ? 'deprecated'
    : statusText.includes('accepted') ? 'accepted'
    : 'proposed';

  const dateLine = md.match(/^\*\*Date:\*\*\s*(.+?)\s*$/im);
  const date = (dateLine?.[1] || '').trim();

  const phaseLine = md.match(/^\*\*Implementation Phase:\*\*\s*(.+?)\s*$/im);
  const phaseTags: string[] = phaseLine?.[1]
    ? phaseLine[1].split(/[,/|]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  return { id, title, status, date, phaseTags };
}

/**
 * Extract the body text under a heading regex until the next heading at the
 * same or higher level (or end of document). Returns trimmed body or empty
 * string if the heading is absent.
 */
function extractMdSection(md: string, headingRe: RegExp): string {
  const match = headingRe.exec(md);
  if (!match) return '';
  const headingEnd = match.index + match[0].length;
  const after = md.slice(headingEnd);
  // Stop at the next H1 or H2 (don't stop at H3+ which are subsections of this
  // section).
  const nextHeadingMatch = /^(?:#{1,2})\s+/m.exec(after);
  const sectionBody = nextHeadingMatch ? after.slice(0, nextHeadingMatch.index) : after;
  return sectionBody.trim();
}

/**
 * Best-effort alternatives extraction from a markdown ADR. Looks under
 * `## Alternatives Considered` for either bullet items or `### N. <option>`
 * subsections, classifying each as rejected/selected by keyword search.
 */
function extractAlternativesFromMd(md: string, decisionText: string): Phase2ADRAlternative[] {
  const section = extractMdSection(md, /^##\s+alternatives?(?:\s+considered)?\b/im);
  if (!section) {
    // Synthesise a single "selected approach" alternative from the decision
    // text so backward-compat consumers see something non-empty.
    return decisionText
      ? [makeAlt('Selected approach', decisionText.split(/\n\s*\n/)[0]?.slice(0, 400) ?? '', false)]
      : [];
  }

  const alts: Phase2ADRAlternative[] = [];

  // Pattern A: `### N. Title` subsections
  const subRe = /^###\s+(?:\d+[.)]\s*)?(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  const positions: Array<{ start: number; headerEnd: number; option: string }> = [];
  while ((m = subRe.exec(section)) !== null) {
    positions.push({
      start: m.index,
      headerEnd: m.index + m[0].length,
      option: m[1]!.trim(),
    });
  }
  if (positions.length > 0) {
    for (let i = 0; i < positions.length; i++) {
      const cur = positions[i]!;
      const nextStart = i + 1 < positions.length ? positions[i + 1]!.start : section.length;
      const body = section.slice(cur.headerEnd, nextStart).trim();
      const rejected = /\brejected\b|\bnot\s+(?:selected|chosen)\b/i.test(body);
      alts.push(makeAlt(cur.option, body.slice(0, 600), rejected));
    }
    return alts;
  }

  // Pattern B: bullet list items
  const bulletRe = /^\s*[-*]\s+\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?:?\s*(.*)$/gm;
  while ((m = bulletRe.exec(section)) !== null) {
    const option = m[1]!.trim();
    const annotation = (m[2] || '').toLowerCase();
    const rationale = (m[3] || '').trim();
    const rejected = /reject|not.*select/i.test(annotation) || /reject/i.test(rationale);
    alts.push(makeAlt(option, rationale.slice(0, 600), rejected));
  }
  if (alts.length > 0) return alts;

  // Fallback: each non-empty line is an alternative
  const lines = section.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0).slice(0, 6);
  for (const line of lines) {
    const rejected = /reject|not.*select/i.test(line);
    alts.push(makeAlt(line.slice(0, 200), line.slice(0, 600), rejected));
  }
  return alts;
}

/**
 * Best-effort consequences extraction from a markdown ADR. Looks under
 * `## Consequences` for bullet items or sub-sections labelled
 * Benefits/Positive vs Risks/Negative.
 */
function extractConsequencesFromMd(md: string): Phase2ADRConsequence[] {
  const section = extractMdSection(md, /^##\s+consequences\b/im);
  if (!section) return [];

  const cons: Phase2ADRConsequence[] = [];

  // Pattern: bullet items with optional [+]/[-]/[~] markers
  const bulletRe = /^\s*[-*]\s+(?:\[\s*([+\-~])\s*\]\s*)?(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = bulletRe.exec(section)) !== null) {
    const marker = m[1];
    const text = m[2]!.trim();
    if (text.length < 8) continue;  // skip tiny noise lines
    const type: 'positive' | 'negative' | 'neutral' =
      marker === '+' ? 'positive'
      : marker === '-' ? 'negative'
      : marker === '~' ? 'neutral'
      : /\b(benefit|advantage|enabl|reduce|improv|gain)/i.test(text) ? 'positive'
      : /\b(risk|cost|drawback|disadvantage|limit|degrad|require.*invest)/i.test(text) ? 'negative'
      : 'neutral';
    cons.push(makeCons(text.slice(0, 400), type));
  }

  // If no bullets parsed, synthesise from sub-section headers
  if (cons.length === 0) {
    const benefits = extractMdSection(section, /^###\s+benefits?\b/im);
    const risks = extractMdSection(section, /^###\s+risks?\b/im);
    if (benefits) cons.push(makeCons(benefits.split(/\n\s*\n/)[0]!.slice(0, 400), 'positive'));
    if (risks) cons.push(makeCons(risks.split(/\n\s*\n/)[0]!.slice(0, 400), 'negative'));
  }

  return cons;
}

/**
 * ADR-PIPELINE-100 §D5: build a single loud-failure ADR record describing why
 * generation failed. The pipeline emits exactly this record (and writes its
 * markdown to `phase4/adrs/ADR-FAIL-001.md`) when both the LLM and the Ruflo
 * paths fail to produce content. Replaces the silent SPARC-template fallback.
 */
export function buildLoudFailureADR(args: {
  reason: string;
  rufloFailureReason?: string;
  claudeFailureReason?: string;
  apiFailureReason?: string;
  phase1Status?: string;
  dossierItemCount?: number;
  sparcStatus?: string;
  query?: string;
  simulationId?: string;
}): Phase2ADRRecord {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('# ADR-FAIL-001: ADR Generation Failed');
  lines.push('');
  lines.push('**Status:** Failed');
  lines.push(`**Date:** ${today}`);
  lines.push(`**Implementation Phase:** cross-cutting`);
  lines.push(`**Failure mode:** ${args.reason}`);
  lines.push('');
  lines.push('## What happened');
  lines.push('');
  lines.push(
    'Phase 4 attempted ADR generation via the configured Claude Code transport ' +
    '(streamed `claude --print` per ADR-PIPELINE-100 §D3) and any available fallback ' +
    'transports. All paths failed to produce usable markdown ADRs.'
  );
  lines.push('');
  if (args.rufloFailureReason) {
    lines.push(`- **Ruflo path:** ${args.rufloFailureReason}`);
  }
  if (args.claudeFailureReason) {
    lines.push(`- **Claude Code path:** ${args.claudeFailureReason}`);
  }
  if (args.apiFailureReason) {
    lines.push(`- **Direct Anthropic API path:** ${args.apiFailureReason}`);
  }
  lines.push('');
  lines.push('## Pipeline state');
  lines.push('');
  if (args.phase1Status) lines.push(`- **Phase 1 artifacts:** ${args.phase1Status}`);
  if (typeof args.dossierItemCount === 'number') lines.push(`- **Phase 2 dossier:** ${args.dossierItemCount} items`);
  if (args.sparcStatus) lines.push(`- **Phase 3 SPARC:** ${args.sparcStatus}`);
  if (args.simulationId) lines.push(`- **Simulation ID:** ${args.simulationId}`);
  lines.push('');
  lines.push('## Why this is the artifact (not template boilerplate)');
  lines.push('');
  lines.push(
    'Per ADR-PIPELINE-100 §D5, this run emits a single loud-failure ADR ' +
    'instead of falling back to template-substituted ADRs. The template path ' +
    'has been classified by the user as canned garbage that cannot meet the ' +
    'quality bar regardless of input domain. Loud failure replaces silent ' +
    'fallback so the regression is visible at the artifact level rather than ' +
    'hidden behind a successful exit code.'
  );
  lines.push('');
  lines.push('## Next steps');
  lines.push('');
  lines.push('Implementation prompts (Phase 5a) and code generation (Phase 5b) cannot proceed coherently from this run.');
  lines.push('To recover:');
  lines.push('');
  lines.push('1. Re-run with verbose Claude Code logging enabled: `AGENTICS_CLAUDE_DEBUG=1`');
  lines.push('2. Inspect `phase4/claude-stderr.log` for the live transport failure reason');
  lines.push('3. If Claude Code is unreachable, verify the subscription is active and `claude --print` works standalone');
  lines.push('4. If timeouts persist, increase `AGENTICS_ADR_TIMEOUT_MS` (default 1800000 / 30 min)');
  lines.push('');
  if (args.query) {
    lines.push('## Original query');
    lines.push('');
    lines.push('```');
    lines.push(args.query.slice(0, 4000));
    lines.push('```');
    lines.push('');
  }

  const rawMarkdown = lines.join('\n') + '\n';

  return {
    id: 'ADR-FAIL-001',
    title: 'ADR Generation Failed',
    status: 'failed',
    date: today,
    context: args.reason,
    decision: 'Emit failure ADR rather than silent template boilerplate.',
    alternatives: [
      makeAlt('Loud-failure ADR (selected)', 'Surface the regression at the artifact level so users can see the failure', false),
      makeAlt('Silent template fallback (rejected)', 'Hides the regression behind a successful exit code; produces canned output that fails the quality bar', true),
    ],
    consequences: [
      makeCons('Pipeline failures are visible to the user immediately', 'positive'),
      makeCons('Downstream phases (Phase 5a/b) cannot proceed coherently from this run', 'negative'),
    ],
    sparcSectionRefs: [],
    researchDossierItemRefs: [],
    simulationId: args.simulationId,
    rawMarkdown,
    phaseTags: ['cross-cutting'],
  };
}

/**
 * Generate ADRs via direct Anthropic API call.
 * Used when Claude Code runner is unavailable (MCP mode).
 * Requires ANTHROPIC_API_KEY in env or ~/.agentics/credentials.json.
 */
async function tryGenerateADRsViaAPI(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
): Promise<Phase2ADRRecord[] | null> {
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? null;
  if (!apiKey) {
    process.stderr.write('[adr-generator] No ANTHROPIC_API_KEY — cannot call API directly\n');
    return null;
  }

  try {
    const delimiter = newDocBreakDelimiter();
    const prompt = buildADRPrompt(sparc, dossier, query, delimiter);
    const startMs = Date.now();
    const timeoutMs = parseAdrTimeoutMs();

    // ADR-PIPELINE-100 §D3: async fetch with AbortController for timeout.
    // max_tokens widened to 32768 because markdown ADRs are substantially
    // larger than the old JSON form.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('adr-timeout'), timeoutMs);

    const heartbeatMs = parseInt(process.env['AGENTICS_ADR_HEARTBEAT_MS'] || '', 10) || 10_000;
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
      process.stderr.write(`[agentics] ⏳ Anthropic API call in flight — ${elapsedSec}s elapsed\n`);
    }, heartbeatMs);

    let rawResponse = '';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env['AGENTICS_ADR_MODEL'] || 'claude-sonnet-4-20250514',
          max_tokens: 32768,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: ctl.signal,
      });
      rawResponse = await res.text();
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }

    const response = JSON.parse(rawResponse) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message: string };
    };

    if (response.error) {
      process.stderr.write(`[adr-generator] API error: ${response.error.message}\n`);
      return null;
    }

    const textBlock = response.content?.find(b => b.type === 'text');
    if (!textBlock?.text) {
      process.stderr.write('[adr-generator] API returned no text content\n');
      return null;
    }

    const adrs = parseMarkdownADRs(textBlock.text, delimiter, dossier);
    if (!adrs || adrs.length === 0) {
      process.stderr.write('[adr-generator] API response did not contain parseable markdown ADRs\n');
      return null;
    }

    const durationMs = Date.now() - startMs;
    process.stderr.write(
      `[adr-generator] API-generated ${adrs.length} domain-specific ADRs in ${durationMs}ms (markdown-direct, ADR-PIPELINE-100)\n`,
    );
    return adrs;
  } catch (err: unknown) {
    process.stderr.write(
      `[adr-generator] API ADR generation failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateADRs(context: Phase2Context): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('adr-generation', 'generate-adrs', { phase2Dir: context.phase2Dir });

  try {
    const sparcStage = context.stageOutputs.get('sparc-specification');
    if (!sparcStage || sparcStage.status !== 'completed') {
      throw new Error('ECLI-P2-020: SPARC output not available.');
    }
    const sparc = sparcStage.data as Phase2SPARCOutput;

    const dossierStage = context.stageOutputs.get('research-dossier');
    if (!dossierStage || dossierStage.status !== 'completed') {
      throw new Error('ECLI-P2-020: Research dossier not available.');
    }
    const dossier = dossierStage.data as ResearchDossier;

    // ADR-027: Try LLM-generated domain-specific ADRs first, fall back to template
    const query = context.phase1Artifacts?.scenario?.query
      ?? (context.phase1Artifacts?.manifest as unknown as Record<string, unknown>)?.['query'] as string
      ?? '';

    // ADR-PIPELINE-018: Extract simulation ID for lineage tracing
    const simulationId = context.phase1Artifacts?.manifest?.execution_id
      ?? context.phase1Artifacts?.manifest?.run_id
      ?? '';
    if (simulationId) {
      process.stderr.write(`[adr-generator] Linking ADRs to simulation: ${simulationId}\n`);
    }

    // ADR-029: Detect and persist tech stack so downstream phases use the same ERP
    const dossierText = dossier.items.map(i => i.content).join(' ');
    const techStack = detectTechnologyStack(query, dossierText);
    writeTechStack(techStack, context.phase2Dir);
    if (techStack.erp) {
      process.stderr.write(`[adr-generator] Detected ERP: ${techStack.erp.name} (${techStack.erp.slug})\n`);
    }

    // ADR-PIPELINE-100: LLM-only chain with loud failure. No silent template
    // fallback. Order: claude --print (subscription-backed) → Anthropic API
    // (ANTHROPIC_API_KEY) → loud-failure ADR.
    let adrs: Phase2ADRRecord[];
    if (!query) {
      adrs = [buildLoudFailureADR({
        reason: 'No query string available — Phase 1 manifest/scenario did not surface the user prompt.',
        phase1Status: 'missing-query',
        dossierItemCount: dossier.items.length,
        sparcStatus: (sparc.architecture?.services?.length ?? 0) > 0 ? 'present' : 'missing-services',
        simulationId,
      })];
    } else {
      const runnerResult = await tryGenerateLLMADRs(sparc, dossier, query, context.phase2Dir);
      if (runnerResult && runnerResult.length > 0) {
        adrs = runnerResult;
      } else {
        const apiResult = await tryGenerateADRsViaAPI(sparc, dossier, query);
        if (apiResult && apiResult.length > 0) {
          adrs = apiResult;
        } else {
          process.stderr.write(
            '[adr-generator] All LLM transports failed in generateADRs — emitting loud-failure ADR (ADR-PIPELINE-100 §D5)\n'
          );
          adrs = [buildLoudFailureADR({
            reason: 'All LLM transports failed to return parseable markdown ADRs.',
            claudeFailureReason: 'tryGenerateLLMADRs returned no parseable markdown ADRs',
            apiFailureReason: 'tryGenerateADRsViaAPI returned no parseable markdown ADRs',
            dossierItemCount: dossier.items.length,
            sparcStatus: (sparc.architecture?.services?.length ?? 0) > 0 ? 'present' : 'missing-services',
            query,
            simulationId,
          })];
        }
      }
    }

    // ADR-PIPELINE-018: Stamp simulation lineage on all ADRs
    if (simulationId) {
      adrs = adrs.map(adr => ({ ...adr, simulationId }));
    }

    const adrDir = path.join(context.phase2Dir, ADR_SUBDIR);
    try {
      fs.mkdirSync(adrDir, { recursive: true, mode: DIR_MODE });
    } catch (mkdirErr) {
      process.stderr.write(`[ADR WRITE FAILED] mkdir ${adrDir}: ${mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr)}\n`);
      throw mkdirErr;
    }
    const writtenPaths: string[] = [];

    for (const adr of adrs) {
      const slug = slugify(adr.title);
      const filename = `${adr.id}-${slug}.md`;
      const filePath = path.join(adrDir, filename);
      const markdown = renderADRMarkdown(adr);
      try {
        fs.writeFileSync(filePath, markdown, { encoding: 'utf-8', mode: FILE_MODE });
      } catch (writeErr) {
        process.stderr.write(`[ADR WRITE FAILED] ${filePath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`);
        throw writeErr;
      }
      writtenPaths.push(filePath);
    }

    const indexPath = path.join(adrDir, 'adr-index.json');
    try {
      fs.writeFileSync(indexPath, JSON.stringify(adrs, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    } catch (writeErr) {
      process.stderr.write(`[ADR WRITE FAILED] index ${indexPath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`);
      throw writeErr;
    }
    writtenPaths.push(indexPath);

    endSpan(rootSpan, 'ok', { adrCount: adrs.length });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;
    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'completed',
      data: adrs,
      artifacts: writtenPaths,
      timing,
      summary: `     ADRs: ${adrs.length} decisions (${writtenPaths.length - 1} markdown + 1 JSON index)`,
    };

    context.stageOutputs.set('adr-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const output: Phase2StageOutput = {
      stage: 'adr-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing: rootSpan.durationMs ?? 0,
      summary: `ADR generation failed: ${errorMessage}`,
    };
    context.stageOutputs.set('adr-generation', output);
    return output;
  }
}
