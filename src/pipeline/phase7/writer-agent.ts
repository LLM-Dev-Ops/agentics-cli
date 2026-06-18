/**
 * Phase 7 — Writer-Agent Field Contract & Agent-Sourced Generation
 * (ADR-PIPELINE-111 D1, D2, D3, D8)
 *
 * Closes the ADR-098 "Q-future" hole: the Ruflo writer fan-out returned only
 * metadata (`RufloPhaseResult`), so its result was discarded (`void rufloResult`)
 * and every deliverable fell back to shared local extraction. This module
 * produces a real, per-deliverable field map by:
 *
 *   1. Invoking the row's `sourceAgents` through the repo-backed dispatch
 *      (`executeAgentsInvokeCommand`, lazy-imported to avoid a load-time cycle),
 *      cached per run (D3).
 *   2. Resolving each template placeholder by precedence — agent > artifact >
 *      slug > llm > _TBD_ — with financial/structural fields reserved so they
 *      always come from `unit-economics.json` (D2/D5).
 *   3. Filling remaining gaps with the family-scoped LLM field-writer (D4),
 *      grounded on the agent evidence.
 *
 * Never throws. Agent / LLM failures degrade gracefully (D8); the caller turns
 * an empty/under-filled result into the existing skeleton.
 */

import { extractPlaceholders } from './template-renderer.js';
import { getFamilySpec } from './field-mappers.js';
import { writeFieldsViaLLM } from './field-writer.js';
import type { DeliverableSpec } from './deliverables-registry.js';

export type FieldProvenance = 'agent' | 'artifact' | 'slug' | 'llm';

export interface AgentCallRecord {
  /** `domain/agent` reference. */
  readonly ref: string;
  readonly status: number;
  readonly tier?: string;
}

export interface WriterResult {
  readonly slug: string;
  readonly templateId: string;
  /** Resolved placeholder → value (non-reserved fields the writer produced). */
  readonly fields: Record<string, string>;
  /** Per-field source for the values in `fields`. */
  readonly field_provenance: Record<string, FieldProvenance>;
  /** Placeholders left unfilled after all tiers (will render as `_TBD_`). */
  readonly unfilled: string[];
  /** Agents actually invoked this row and their status (D7). */
  readonly agents_called: AgentCallRecord[];
}

export interface WriterContext {
  readonly scenarioQuery: string;
  readonly runDir: string;
  readonly traceId: string;
  /** Deterministic fields from run-artifact extraction (artifact tier). */
  readonly artifactFields: Readonly<Record<string, string>>;
  /** Deterministic fields derived from the slug (slug tier). */
  readonly slugFields: Readonly<Record<string, string>>;
  /**
   * Reserved fields that ALWAYS win (financial fcv values, title, date,
   * consensusBanner, fcvBlock, attribution). Never overridden by agent/LLM —
   * this is the D5 coherence guarantee. Keys present here are excluded from
   * agent/LLM filling.
   */
  readonly reservedFields: Readonly<Record<string, string>>;
  /** Canonical financial figures the LLM may cite verbatim (the fcv block). */
  readonly canonicalFigures: string;
  /** D3 toggle — false skips agent dispatch (AGENTICS_PHASE7_NO_AGENTS=1). */
  readonly enableAgents: boolean;
  /** D4 toggle — false skips the LLM field-writer (AGENTICS_PHASE7_NO_LLM=1). */
  readonly enableLLM: boolean;
}

/** Cached agent output for the current run, keyed by `domain/agent`. */
export interface CachedAgentOutput {
  readonly status: number;
  readonly tier?: string;
  readonly data: unknown;
}
export type AgentOutputCache = Map<string, CachedAgentOutput>;

/** Signature of the dispatch function (injectable for tests). */
export type AgentDispatch = (
  domain: string,
  agent: string,
  payload: Record<string, unknown>,
) => Promise<{ status: number; tier?: string; data: unknown }>;

/**
 * Generate the field map for one deliverable. Pure orchestration over the
 * three tiers; the renderer remains the single place that turns fields into
 * Markdown (determinism preserved).
 */
export async function generateDeliverableFields(
  spec: DeliverableSpec,
  templateBody: string,
  ctx: WriterContext,
  agentCache: AgentOutputCache,
  dispatch?: AgentDispatch,
): Promise<WriterResult> {
  const placeholders = extractPlaceholders(templateBody);
  const reserved = ctx.reservedFields;
  // Non-reserved placeholders are the ones the writer may fill.
  const fillable = placeholders.filter((p) => !(p in reserved));

  // ── D3: dispatch sourceAgents (cached), collect grounded evidence ──
  const agents_called: AgentCallRecord[] = [];
  let agentEvidence = '';
  if (ctx.enableAgents && spec.sourceAgents.length > 0) {
    const family = getFamilySpec(spec.templateId);
    const ordered = orderAgentsByFamily(spec.sourceAgents, family.emphasizeAgents);
    const evidenceParts: string[] = [];
    for (const ref of ordered) {
      const [domain, agent] = ref.split('/');
      if (!domain || !agent) continue;
      const cached = await dispatchCached(agentCache, ref, domain, agent, ctx, dispatch);
      agents_called.push({ ref, status: cached.status, ...(cached.tier ? { tier: cached.tier } : {}) });
      if (cached.status >= 200 && cached.status < 300 && cached.data != null) {
        evidenceParts.push(`### ${ref}\n${stringifyEvidence(cached.data)}`);
      }
    }
    agentEvidence = evidenceParts.join('\n\n');
  }

  const fields: Record<string, string> = {};
  const provenance: Record<string, FieldProvenance> = {};

  // ── D2/D4: family-specific LLM writer is PRIMARY for narrative fields ──
  // This is what differentiates the 87 reports: each gets report-type-specific
  // content grounded in its sourceAgents, instead of the same exec-summary
  // extraction copied everywhere. Agent JSON keys rarely match placeholder
  // names, so agents inform the writer rather than projecting directly; a
  // value the writer grounded in successful agent evidence is tagged 'agent',
  // otherwise 'llm'. Skipped entirely when enableLLM is false (NO_LLM / test
  // noop) — the deterministic artifact/slug backstop below then takes over,
  // preserving the prior behaviour.
  if (ctx.enableLLM && fillable.length > 0) {
    const family = getFamilySpec(spec.templateId);
    const llmFields = await writeFieldsViaLLM({
      slug: spec.slug,
      templateId: spec.templateId,
      family,
      placeholders: fillable,
      scenarioQuery: ctx.scenarioQuery,
      agentEvidence,
      knownFields: { ...ctx.slugFields, ...ctx.artifactFields },
      canonicalFigures: ctx.canonicalFigures,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    });
    // These values are authored by the LLM (grounded on agent evidence when
    // available, but not a direct field projection), so they are tagged 'llm'
    // — honest provenance. Agent involvement is recorded separately in
    // `agents_called`. The 'agent' tier is reserved for any future direct
    // agent-JSON→placeholder projection.
    for (const [k, v] of Object.entries(llmFields)) {
      if (typeof v === 'string' && v.trim()) {
        fields[k] = v;
        provenance[k] = 'llm';
      }
    }
  }

  // ── D2: deterministic backstop — artifact > slug for anything still empty ──
  for (const p of fillable) {
    if (p in fields) continue;
    const fromArtifact = ctx.artifactFields[p];
    const fromSlug = ctx.slugFields[p];
    if (typeof fromArtifact === 'string' && fromArtifact.trim()) {
      fields[p] = fromArtifact;
      provenance[p] = 'artifact';
    } else if (typeof fromSlug === 'string' && fromSlug.trim()) {
      fields[p] = fromSlug;
      provenance[p] = 'slug';
    }
  }

  const unfilled = fillable.filter((p) => !(p in fields));
  return {
    slug: spec.slug,
    templateId: spec.templateId,
    fields,
    field_provenance: provenance,
    unfilled,
    agents_called,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Dispatch one agent, using the per-run cache; never throws. */
async function dispatchCached(
  cache: AgentOutputCache,
  ref: string,
  domain: string,
  agent: string,
  ctx: WriterContext,
  dispatch: AgentDispatch | undefined,
): Promise<CachedAgentOutput> {
  const hit = cache.get(ref);
  if (hit) return hit;

  let result: CachedAgentOutput;
  try {
    const fn = dispatch ?? (await defaultDispatch());
    const r = await fn(domain, agent, { text: ctx.scenarioQuery });
    result = { status: r.status, ...(r.tier ? { tier: r.tier } : {}), data: r.data };
  } catch (err) {
    result = { status: 502, data: { error: err instanceof Error ? err.message : String(err) } };
  }
  cache.set(ref, result);
  return result;
}

/**
 * Default dispatch — lazy dynamic import of `executeAgentsInvokeCommand` so
 * `commands/agents.ts` is only loaded at call time (avoids any load-order
 * cycle with the pipeline modules it imports).
 */
async function defaultDispatch(): Promise<AgentDispatch> {
  const mod = await import('../../commands/agents.js');
  return async (domain, agent, payload) => {
    const res = await mod.executeAgentsInvokeCommand(domain, agent, payload, {});
    const resp = res.response && typeof res.response === 'object' ? (res.response as Record<string, unknown>) : undefined;
    const data = resp && 'data' in resp ? resp['data'] : resp;
    const tier = (res as { execution_tier?: string }).execution_tier;
    return { status: res.status ?? 200, ...(tier ? { tier } : {}), data };
  };
}

/** Order sourceAgents so the family's emphasised agents come first. */
function orderAgentsByFamily(
  sourceAgents: ReadonlyArray<string>,
  emphasize: ReadonlyArray<string>,
): string[] {
  const score = (ref: string): number => {
    for (let i = 0; i < emphasize.length; i++) {
      const e = emphasize[i]!;
      if (ref === e || ref.startsWith(e) || ref.split('/')[0] === e) return i;
    }
    return emphasize.length + 1;
  };
  return [...sourceAgents].sort((a, b) => score(a) - score(b));
}

/** Compact a structured agent response into prompt-friendly evidence text. */
function stringifyEvidence(data: unknown): string {
  try {
    if (typeof data === 'string') return data.slice(0, 1500);
    const json = JSON.stringify(data, null, 2);
    return json.length > 1800 ? `${json.slice(0, 1800)}…` : json;
  } catch {
    return '(unserializable agent output)';
  }
}
