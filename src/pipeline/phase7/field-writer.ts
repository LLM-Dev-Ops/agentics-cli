/**
 * Phase 7 — LLM Field Writer (ADR-PIPELINE-111 D2/D4)
 *
 * Given the placeholders a template still needs, the grounded agent outputs,
 * and the family spec, produce a JSON `Record<placeholder,string>` of values.
 *
 * Channel policy (ADR-PIPELINE-098 / 110): Claude Code Max only — the local
 * `claude --print` binary. NEVER the billed Anthropic API. If the binary is
 * unavailable the writer returns `{}` and the caller degrades to the
 * deterministic render (skeleton), exactly like `synthesizeExecutiveDocument`.
 *
 * Coherence (ADR-PIPELINE-111 D5): the prompt forbids inventing dollar figures
 * and a post-parse guard drops any returned value that introduces a `$` amount
 * not already present in the provided figures — financial values stay owned by
 * `unit-economics.json`.
 */

import type { FamilySpec } from './field-mappers.js';

export interface FieldWriterInput {
  readonly slug: string;
  readonly templateId: string;
  readonly family: FamilySpec;
  /** Placeholder keys the writer should fill (already-filled keys excluded). */
  readonly placeholders: ReadonlyArray<string>;
  /** The user's business context for the run. */
  readonly scenarioQuery: string;
  /** Grounded structured outputs from the row's sourceAgents (D3). */
  readonly agentEvidence: string;
  /** Deterministic fields already resolved (artifact/slug/reserved) — context. */
  readonly knownFields: Readonly<Record<string, string>>;
  /** Canonical financial figures the writer MAY cite verbatim (never alter). */
  readonly canonicalFigures: string;
  /** Trace id for degradation logging. */
  readonly traceId?: string;
}

const PROMPT_TIMEOUT_MS = 90_000;
const MAX_EVIDENCE = 6000;
const MAX_CONTEXT = 2500;

/**
 * Produce field values for the requested placeholders. Returns `{}` on any
 * failure (no binary, timeout, unparseable output) — never throws.
 */
export async function writeFieldsViaLLM(
  input: FieldWriterInput,
): Promise<Record<string, string>> {
  if (input.placeholders.length === 0) return {};

  const prompt = buildFieldWriterPrompt(input);

  try {
    const { execSync } = await import('node:child_process');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const claudeBin = process.env['AGENTICS_CLAUDE_BIN'] || 'claude';
    const tmpFile = `/tmp/agentics-p7-fields-${input.slug}-${Date.now()}.txt`;
    writeFileSync(tmpFile, prompt, 'utf-8');
    try {
      const raw = execSync(`${claudeBin} --print < "${tmpFile}"`, {
        encoding: 'utf-8',
        timeout: PROMPT_TIMEOUT_MS,
        maxBuffer: 2_000_000,
        shell: '/bin/sh',
      });
      const parsed = extractJsonObject(raw);
      if (!parsed) return {};
      return sanitizeFields(parsed, input);
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch {
    // Binary unavailable / timeout / non-zero exit — caller degrades.
    return {};
  }
}

/** Build the family-scoped, JSON-returning prompt. */
export function buildFieldWriterPrompt(input: FieldWriterInput): string {
  const placeholderList = input.placeholders.map((p) => `  - ${p}`).join('\n');
  const known = Object.entries(input.knownFields)
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    .slice(0, 20)
    .map(([k, v]) => `  ${k}: ${truncate(v, 200)}`)
    .join('\n');

  return [
    `You are a senior management-consulting writer producing the "${input.family.label}" deliverable (slug: ${input.slug}).`,
    '',
    `DOCUMENT PURPOSE:\n${input.family.focus}`,
    '',
    `BUSINESS CONTEXT (for understanding — do not echo verbatim):\n${truncate(input.scenarioQuery, MAX_CONTEXT)}`,
    '',
    input.agentEvidence.trim()
      ? `AGENT ANALYSIS (your evidence — use these findings, do not contradict them):\n${truncate(input.agentEvidence, MAX_EVIDENCE)}`
      : 'AGENT ANALYSIS: (none available — derive from business context and known fields)',
    '',
    input.canonicalFigures.trim()
      ? `CANONICAL FINANCIAL FIGURES (the ONLY dollar amounts you may use — cite verbatim, never alter or invent):\n${truncate(input.canonicalFigures, 1500)}`
      : '',
    '',
    known ? `ALREADY-FILLED FIELDS (for consistency — do not restate):\n${known}` : '',
    '',
    'TASK: Return a single JSON object whose keys are EXACTLY the field names below and whose values are the Markdown content for each field. Each value must be specific to this document type and grounded in the agent analysis and business context.',
    '',
    `FIELDS TO FILL:\n${placeholderList}`,
    '',
    'RULES:',
    '- Output ONLY the JSON object. No prose, no markdown fences, no commentary.',
    '- Keys must be exactly the field names listed (omit a key only if you genuinely cannot produce content for it).',
    '- Values are Markdown strings (may contain lists, short tables, bold). Keep each focused and decision-grade.',
    '- NEVER invent dollar figures. Use ONLY the canonical figures provided above; if a field needs money you do not have, describe it qualitatively.',
    '- Be concrete and specific to the business context — no generic filler.',
  ].filter((l) => l !== '').join('\n');
}

/**
 * Extract the first balanced top-level JSON object from arbitrary LLM text
 * (handles ```json fences and leading/trailing prose).
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1]! : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          const obj = JSON.parse(slice);
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Detects a `$<number>` money token (e.g. $340K, $8.5M, $1,200). */
const MONEY_RE = /\$\s?\d[\d,.]*\s?[KkMmBb]?/g;

/**
 * Keep only requested keys with non-empty string values, and drop any value
 * that introduces a dollar figure not present in the canonical figures
 * (ADR-111 D5 — financials stay owned by unit-economics.json).
 */
export function sanitizeFields(
  parsed: Record<string, unknown>,
  input: FieldWriterInput,
): Record<string, string> {
  const allowed = new Set(input.placeholders);
  const canonicalMoney = new Set(
    (input.canonicalFigures.match(MONEY_RE) ?? []).map(normalizeMoney),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!allowed.has(k)) continue;
    if (typeof v !== 'string') continue;
    const value = v.trim();
    if (value.length === 0) continue;
    const introduced = (value.match(MONEY_RE) ?? []).map(normalizeMoney);
    const invents = introduced.some((m) => !canonicalMoney.has(m));
    if (invents) continue; // drop fields that fabricate dollar figures
    out[k] = value;
  }
  return out;
}

function normalizeMoney(s: string): string {
  // Strip whitespace, uppercase the magnitude suffix, and trim any trailing
  // punctuation the greedy `[\d,.]*` may have captured (e.g. "$1,200." → "$1,200").
  return s.replace(/\s/g, '').replace(/[.,]+$/, '').toUpperCase();
}

function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
