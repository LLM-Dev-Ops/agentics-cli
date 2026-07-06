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
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBinary, generateClaudeText } from '../../../runtime/claude-code-runner.js';
import { resolveBackend } from '../../backend-resolver.js';
import { generateCodexText, isCodexError } from '../../../runtime/codex-runner.js';

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

  // ADR-PIPELINE-112 §D1: no raw ANTHROPIC_API_KEY fallback. When the
  // `claude --print` transport fails the chain emits the loud-failure ADR.
  process.stderr.write('[adr-generator] LLM transport failed — emitting loud-failure ADR (ADR-PIPELINE-100 §D5)\n');

  return [buildLoudFailureADR({
    reason: 'The claude --print transport failed to return parseable markdown ADRs.',
    claudeFailureReason,
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
    // ADR-114 §D5: resolve via the single canonical resolver.
    const resolution = await resolveClaudeBinary();
    if (!resolution.available || !resolution.binaryPath) {
      // ADR-112 §D2 priority 3 — codex tier-3 fallback. The ruflo (upstream
      // phase executor) and claude --print (above) happy paths are unchanged;
      // codex is reached ONLY when claude is unavailable. We consult the shared
      // backend resolver so we use the SAME tier decision the rest of the
      // pipeline does (codex is selected only when ruflo+claude both failed).
      const backend = await resolveBackend();
      if (backend.tier === 'codex') {
        const codexAdrs = await tryGenerateCodexADRs(sparc, dossier, query, phase2Dir);
        if (codexAdrs && codexAdrs.length > 0) return codexAdrs;
      }
      process.stderr.write(`[CANNED FALLBACK] [adr-generator] ${resolution.reason} — falling back to ADR-FAIL-001 stub. Set CLAUDE_CODE_BIN or install Claude Code.\n`);
      return null;
    }

    const delimiter = newDocBreakDelimiter();
    const prompt = buildADRPrompt(sparc, dossier, query, delimiter, phase2Dir);
    const model = process.env['AGENTICS_CLAUDE_MODEL'] || 'sonnet';
    const timeoutMs = parseAdrTimeoutMs();
    const startMs = Date.now();

    process.stderr.write(`[adr-generator] starting hardened claude --print (ADR-114): model=${model}, timeout=${Math.round(timeoutMs / 1000)}s, prompt=${prompt.length} chars, transport=stdin/json\n`);

    // ADR-114 §D1–D3: route synthesis through the hardened transport
    // (stdin delivery, --output-format json envelope unwrap, MCP_SERVER_MODE
    // deleted). No prompt is ever passed as an argv argument.
    let raw: string;
    try {
      raw = await generateClaudeText(prompt, {
        model,
        timeoutMs,
        runId: 'adr-generator',
        idleBoundMs: parseInt(process.env['AGENTICS_ADR_IDLE_MS'] || '', 10) || 180_000,
        heartbeatMs: parseInt(process.env['AGENTICS_ADR_HEARTBEAT_MS'] || '', 10) || 10_000,
        debugLogPath: phase2Dir ? path.join(phase2Dir, 'claude-stderr.log') : undefined,
        label: 'ADR generation',
      });
    } catch (err: unknown) {
      process.stderr.write(
        `[CANNED FALLBACK] [adr-generator] hardened claude --print failed: ${err instanceof Error ? err.message : String(err)} — emitting ADR-FAIL-001 stub\n`,
      );
      return null;
    }

    const adrs = parseMarkdownADRs(raw, delimiter, dossier);
    if (!adrs || adrs.length === 0) {
      process.stderr.write(`[CANNED FALLBACK] [adr-generator] claude --print returned ${raw.length} bytes but parseMarkdownADRs extracted 0 ADRs — markdown malformed. Falling back to ADR-FAIL-001 stub.\n`);
      return null;
    }

    const durationMs = Date.now() - startMs;
    process.stderr.write(
      `[adr-generator] LLM-generated ${adrs.length} domain-specific ADRs via hardened claude --print ` +
        `in ${durationMs}ms (${raw.length} bytes, markdown-direct, ADR-PIPELINE-114)\n`,
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
 * Tier-3 codex fallback for ADR synthesis (ADR-PIPELINE-112 §D2 priority 3).
 * Reached ONLY when ruflo and `claude --print` are both unavailable but the
 * shared backend resolver selected `tier:'codex'`. Mirrors `tryGenerateLLMADRs`:
 * same prompt, same markdown-ADR parsing — only the transport differs.
 *
 * NOTE: codex transport not live-validated in this env (no codex CLI installed).
 */
async function tryGenerateCodexADRs(
  sparc: Phase2SPARCOutput,
  dossier: ResearchDossier,
  query: string,
  phase2Dir = '',
): Promise<Phase2ADRRecord[] | null> {
  try {
    const delimiter = newDocBreakDelimiter();
    const prompt = buildADRPrompt(sparc, dossier, query, delimiter, phase2Dir);
    const timeoutMs = parseAdrTimeoutMs();
    process.stderr.write(`[adr-generator] claude unavailable — attempting codex tier-3 fallback (ADR-112 §D2): timeout=${Math.round(timeoutMs / 1000)}s, prompt=${prompt.length} chars, transport=stdin\n`);

    const raw = await generateCodexText(prompt, {
      timeoutMs,
      runId: 'adr-generator-codex',
      idleBoundMs: parseInt(process.env['AGENTICS_ADR_IDLE_MS'] || '', 10) || 60_000,
      heartbeatMs: parseInt(process.env['AGENTICS_ADR_HEARTBEAT_MS'] || '', 10) || 10_000,
      label: 'ADR generation (codex)',
    });
    if (isCodexError(raw)) {
      process.stderr.write(`[CANNED FALLBACK] [adr-generator] codex tier-3 fallback failed: ${raw} — emitting ADR-FAIL-001 stub\n`);
      return null;
    }

    const adrs = parseMarkdownADRs(raw, delimiter, dossier);
    if (!adrs || adrs.length === 0) {
      process.stderr.write(`[CANNED FALLBACK] [adr-generator] codex returned ${raw.length} bytes but parseMarkdownADRs extracted 0 ADRs — markdown malformed. Falling back to ADR-FAIL-001 stub.\n`);
      return null;
    }
    process.stderr.write(`[adr-generator] LLM-generated ${adrs.length} domain-specific ADRs via codex tier-3 fallback (ADR-112)\n`);
    return adrs;
  } catch (err: unknown) {
    process.stderr.write(`[CANNED FALLBACK] [adr-generator] codex tier-3 fallback threw: ${err instanceof Error ? err.message : String(err)} — emitting ADR-FAIL-001 stub\n`);
    return null;
  }
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
 * Consumed by tryGenerateLLMADRs (the `claude --print` transport). The raw
 * Anthropic API transport was removed in ADR-PIPELINE-112 §D1.
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
 * Minimum line count for a markdown segment to stand alone as an ADR.
 * Shorter segments are accumulated into the previous one (ADR-114 §D4 rule 3).
 * Deep ADRs produced by the synthesis prompt are reliably well over this.
 */
const ADR_MIN_SEGMENT_LINES = 50;

/**
 * Test whether a segment carries the structural ADR markers (`**Status:**` and
 * `**Date:**`) within its first ~40 lines (ADR-114 §D4 rule 2). This is the
 * primary validity signal — `# ADR-` headings that appear inside prose or
 * diagrams lack these markers and are merged into the preceding segment.
 */
function hasAdrStructuralMarkers(segment: string): boolean {
  const head = segment.split('\n').slice(0, 40).join('\n');
  return /^\*\*Status:\*\*/im.test(head) && /^\*\*Date:\*\*/im.test(head);
}

/**
 * Segment a raw markdown response into candidate ADR documents WITHOUT relying
 * on a per-run delimiter (ADR-114 §D4). Boundaries are:
 *   - a line-start `# ADR-` H1 heading, ignoring matches inside ``` code fences
 *   - the per-run UUID delimiter, if present (an ADDITIONAL split point — its
 *     absence never fails the parse, rule 4)
 */
function segmentAdrMarkdown(cleaned: string, delimiter: string): string[] {
  const lines = cleaned.split('\n');
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const delim = delimiter ? delimiter.trim() : '';

  const flush = () => {
    if (current.length > 0) {
      segments.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    const isFenceMarker = /^\s*```/.test(line);

    // UUID delimiter (bonus split point) — only outside code fences.
    if (!inFence && delim && line.includes(delim)) {
      flush();
      continue; // drop the delimiter line itself
    }

    // H1 ADR heading boundary — only outside code fences.
    if (!inFence && /^#\s+ADR-/.test(line)) {
      flush();
      current.push(line);
    } else {
      current.push(line);
    }

    if (isFenceMarker) inFence = !inFence;
  }
  flush();

  return segments;
}

/**
 * Parse a raw LLM markdown response into Phase2ADRRecord[].
 *
 * ADR-PIPELINE-114 §D4: delimiter-INDEPENDENT parsing. Segments are split on
 * line-start `# ADR-` H1 headings (code-fence aware) plus the per-run UUID
 * delimiter when present; segments lacking `**Status:**`/`**Date:**` or shorter
 * than ~50 lines are accumulated into the previous ADR. The UUID delimiter's
 * absence never fails the parse — backward-compatible with delimited fixtures.
 */
function parseMarkdownADRs(
  rawText: string,
  delimiter: string,
  dossier: ResearchDossier,
): Phase2ADRRecord[] | null {
  if (!rawText) return null;

  // Strip surrounding code fences if the LLM wrapped its output despite
  // instruction not to.
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }

  const rawSegments = segmentAdrMarkdown(cleaned, delimiter);

  // Accumulate fragments: a segment stands alone only when it carries the ADR
  // structural markers AND is long enough; otherwise it is folded into the
  // preceding ADR (or held as a pending prefix until the first valid ADR).
  const chunks: string[] = [];
  let pending = '';
  for (const seg of rawSegments) {
    if (!seg.trim()) continue;
    const standalone = hasAdrStructuralMarkers(seg) && seg.split('\n').length >= ADR_MIN_SEGMENT_LINES;
    if (standalone) {
      chunks.push(pending ? `${pending}\n${seg}` : seg);
      pending = '';
    } else if (chunks.length > 0) {
      chunks[chunks.length - 1] += `\n${seg}`;
    } else {
      pending = pending ? `${pending}\n${seg}` : seg;
    }
  }
  // Last resort: never lose a lone short-but-valid ADR (e.g. a single compact
  // ADR under the line threshold and no standalone segment was found).
  if (chunks.length === 0 && pending.trim() && hasAdrStructuralMarkers(pending)) {
    chunks.push(pending.trim());
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

// ADR-PIPELINE-112 §D1: `tryGenerateADRsViaAPI` (the raw Anthropic API
// transport driven by ANTHROPIC_API_KEY) was removed. The pipeline must not
// open a direct provider connection: doing so bills outside the user's Claude
// Code / Codex subscription, drifts model versions independently of the user's
// session, and was a silent empty-array failure path in the reference run. The
// only sanctioned transport here is `claude --print` (tryGenerateLLMADRs),
// hardened later by ADR-PIPELINE-114; on its failure we emit the loud-failure
// ADR (ADR-PIPELINE-100 §D5 / ADR-PIPELINE-116).

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
    // fallback. ADR-PIPELINE-112 §D1 removed the raw Anthropic API tier, so the
    // chain is: claude --print (subscription-backed) → loud-failure ADR.
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
        process.stderr.write(
          '[adr-generator] claude --print transport failed in generateADRs — emitting loud-failure ADR (ADR-PIPELINE-100 §D5)\n'
        );
        adrs = [buildLoudFailureADR({
          reason: 'The claude --print transport failed to return parseable markdown ADRs.',
          claudeFailureReason: 'tryGenerateLLMADRs returned no parseable markdown ADRs',
          dossierItemCount: dossier.items.length,
          sparcStatus: (sparc.architecture?.services?.length ?? 0) > 0 ? 'present' : 'missing-services',
          query,
          simulationId,
        })];
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
