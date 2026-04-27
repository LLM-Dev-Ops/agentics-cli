# ADR-PIPELINE-100: Markdown-Direct ADRs + Phase-Aware ADR Path Injection in Implementation Prompts

**Status:** Implemented (Steps 1-6); pending end-to-end validation (Step 7)
**Date:** 2026-04-27
**Priority:** CRITICAL — Quality regression on the load-bearing artifact (ADRs) and its downstream consumer (implementation prompts). User has classified the current output as unacceptable across multiple runs and multiple input domains. Affects every `agentics ask` invocation regardless of subject matter.
**Builds on:** ADR-PIPELINE-091 (Ruflo as primary engineering executor — this ADR keeps Ruflo primary and replaces what Ruflo's output flows *into*), ADR-PIPELINE-098 (LLM enrichment for Phase 7 — this ADR generalises the same Claude-Code-Max-only principle to Phase 4), ADR-PIPELINE-099 (multi-prompt Phase 5a + heartbeat — this ADR makes the prompts Phase 5a emits actually link to the ADRs they cite), ADR-027 (LLM-generated ADRs — this ADR rebuilds the LLM path to match a real quality bar).
**Reference exemplars:** `docs/templates/ADR-Good-Example.md` (Ruvector Core Architecture, 788 lines), `docs/templates/Implementation-Prompts-Good-Example.md` (Protein-Engine, 23 sequential prompts). These are the canonical quality bars. Both are deliberately drawn from different domains (vector DB, drug discovery) to make the point: the bar is **structural**, not subject-matter-specific.

---

## Context

### Defect: ADR output is canned regardless of domain

Real run trace (ServiceNow water-cooling / 83k employees, 2026-04-27):

- Phase 2 deep-research swarm completed cleanly: 48 agents responded across cloud + local fallback; `phase2/research-dossier.json` populated with 85 artifacts including ServiceNow ERP surface, costops ROI/tradeoff/forecast, observability SLO/health, sentinel alerts, test-bench hallucination/faithfulness/bias.
- Phase 4 ADR generation entered `tryGenerateLLMADRs` (`src/pipeline/phase2/phases/adr-generator.ts:1243`).
- The buffered `execFileSync` call to `claude --print` (120s timeout, line 1291) timed out.
- Pipeline silently fell through to `buildADRsFromSPARC` (`adr-generator.ts:417`) — the SPARC-template path.
- Generated ADRs had titles like "Domain Model: water management entity graph with N bounded contexts" and consequences like "Requires upfront domain modeling investment before implementation."
- User killed the run.

User's verdict, verbatim: *"The ADRs written were the same canned garbage I explicitly told you were unacceptable or classified as 'bad' .. I gave you examples of what are considered 'good' but this didn't work."*

This is **not specific to water cooling.** The same template path fires for any domain where the LLM call doesn't return: supply chain, fleet routing, ERP migration, agent governance — the user runs `agentics ask`, the LLM call times out, and the user gets the same boilerplate. The defect is structural, not contextual.

### Two structural causes

#### Cause 1: The JSON schema is the ceiling

`buildADRPrompt` (`adr-generator.ts:1324`) instructs the LLM to return:

```json
[{
  "title": "...",
  "context": "...",
  "decision": "...",
  "alternatives": [{"option": "...", "rationale": "...", "rejected": true|false}],
  "consequences": [{"description": "...", "type": "positive|negative|neutral"}]
}]
```

Five fields. The good ADR example has approximately twenty structural elements:

| # | Element | Present in 5-field schema? |
|---|---------|----------------------------|
| 1 | Status / Date / Authors / Deciders / SDK header | No |
| 2 | Version History table | No |
| 3 | Context with comparison tables | Partial (single string) |
| 4 | ASCII layer diagram | No |
| 5 | Per-component code samples (Rust trait/struct definitions) | No |
| 6 | Real source-file paths (`simd_intrinsics.rs`) | No |
| 7 | Configuration parameters table (param / default / description) | No |
| 8 | Complexity analysis table (Big-O time + space) | No |
| 9 | Per-platform performance characteristics tables | No |
| 10 | Decision drivers table (requirement → implementation) | No |
| 11 | Numbered Alternatives Considered with multi-line "Rejected because:" | Partial (flat array) |
| 12 | Risks table: Risk / Probability / Impact / Mitigation | No |
| 13 | Performance Targets vs Achieved table | No |
| 14 | Implementation Status tables per module | No |
| 15 | Feature flags table | No |
| 16 | Dependencies (core + optional) tables | No |
| 17 | API Examples in real code blocks | No |
| 18 | References to academic papers + internal benchmarks | No |
| 19 | Appendices (memory layout, register usage, benchmark results) | No |
| 20 | Related Decisions cross-links | No |

A 5-field schema cannot physically hold a good ADR. No prompt engineering on top of this schema can produce output at the bar.

#### Cause 2: The fallback is the bug, not the safety net

When the LLM path fails, the pipeline silently falls through to `buildADRsFromSPARC`, which produces template-substitution output:

```typescript
title: `Domain Model: ${domain.primary} entity graph with ${entityNames.length} bounded contexts`,
decision: `Model ${domain.primary} as ${entityNames.length} bounded contexts with explicit aggregate roots. ` +
  `${entityNames.slice(0, 3).map(n => `"${n}" owns its entities and exposes a domain API`).join('; ')}. ` +
  `Cross-context communication via domain events (not shared database). `,
```

This output is **always wrong**, regardless of domain. There is no input that produces good ADRs from this template, because the template doesn't synthesise — it interpolates. The user has explicitly classified this output as canned garbage.

The fallback masks LLM failures. From the user's perspective the run "succeeded" (the pipeline emits files); the artifacts are the failure signal, not an exception. By the time the user notices, 30 minutes of pipeline runtime are already gone.

### Defect downstream: implementation prompts inline weak ADR content

`prompt-generator.ts` has no LLM call (line 619, `buildLayerPromptContent`). It deterministically renders prompts from the ADRs and DDD aggregates Phase 4 produced. So when ADRs are weak, prompts are weak by mechanical consequence. The good prompt example shows the right pattern:

```
Implement the pe-core crate with all domain types defined in DDD-001
(plans/ddd-001-protein-engineering-domain-model.md, "Variant Design Context") and
DDD-003 (plans/ddd-003-aggregate-specifications.md, Aggregates 1, 2, and 6).
```

Specific file path, specific section anchor — the downstream code generator can read the ADR/DDD as source of truth. The current generator instead inlines the ADR's title, context, decision, and consequences as paraphrased text inside the prompt itself. When the upstream ADR is weak, the inline copy is weak; when the upstream ADR is strong, the inline copy lossily summarises it.

---

## Decision

Five rules.

### D1. ADR output is markdown, not JSON

LLM emits one `.md` file per ADR matching the structure of `docs/templates/ADR-Good-Example.md`. The 5-field JSON schema is removed.

The good example is included **verbatim as a structural exemplar** in the LLM prompt, with explicit instruction:

> Produce ADRs at this depth and shape for the input domain below. The exemplar is a vector-database project; your input is a different domain. Match the structure (sections, tables, code blocks, diagrams) — the content must derive from the input, not from the exemplar.

This is domain-agnostic by construction. The LLM's job is structural — apply the bar to whatever input arrives.

#### Schema change

Before (`adr-generator.ts:1390`):
```typescript
return [JSON.stringify ADR objects with 5 fields]
```

After:
```typescript
// Each ADR is a complete markdown document.
// Output format: ADR markdown documents separated by `\n---DOC-BREAK---\n`
// Parser splits on the marker; each chunk is written as adrs/ADR-NNN-<slug>.md
```

Rationale for delimiter-separated markdown over per-call generation: a single LLM call producing all ADRs preserves cross-ADR consistency (related-decisions cross-links, shared terminology, non-overlapping scope). Per-call generation is deferred to Phase 2 of implementation if depth-per-ADR proves insufficient.

### D2. Thin extractor produces `adr-index.json` from the markdown

A small parser walks each emitted `.md` and extracts:

| Field | Source in markdown |
|-------|-------------------|
| `id` | First H1 heading: `# ADR-PIPELINE-NNN: <title>` |
| `title` | First H1 heading after the colon |
| `status` | Line matching `**Status:** <value>` |
| `date` | Line matching `**Date:** <value>` |
| `priority` | Line matching `**Priority:** <value>` (if present) |
| `buildsOn` | Line matching `**Builds on:** <value>` (if present) — list of referenced ADR IDs |
| `relatedDecisions` | Items under `## Related Decisions` heading (if present) |
| `phaseTags` | Items under `## Implementation Status` headings, mapped to build phases |
| `filePath` | Absolute path of the .md file |

The index is regenerated on every Phase 4 run. Downstream consumers (consensus, exec-summary, prompt-generator) read the index for navigation; they read the `.md` for content.

The index is intentionally flat. We do not try to faithfully serialise the full ADR back into JSON — that's the trap that produced the 5-field schema in the first place.

### D3. Producer chain: Ruflo + Agentics.dev → Claude Code → markdown

The producer hierarchy, top to bottom:

1. **Ruflo writer agents** (ADR-091 primary). Ruflo orchestrates the swarm. Stays primary.
2. **Agentics.dev platform agents** feed structured input INTO the prompt — they do NOT write the ADR text directly. The dossier from `phase2/research-dossier.json` (which contains responses from `copilot/planner`, `copilot/decomposer`, `costops/*`, `sentinel/*`, `observatory/*`, `connector-hub/*`, etc.) is the upstream context the LLM call synthesises.
3. **Claude Code (Claude Max subscription)** is the LLM transport. Per ADR-098, Phase 7 enrichment uses Claude Code Max only. Phase 4 ADR generation uses the same transport for the same reasons (deep synthesis, long context, no rate limits within subscription).
4. **`claude --print` subprocess** is replaced with a **streamed** subprocess. Buffered `execFileSync` (`adr-generator.ts:1284`) drops everything on timeout; streaming preserves partial output and reveals where generation stalls.
5. **No hard 120s ceiling.** Replace with a streaming heartbeat consistent with ADR-099 (10s `[agentics] ⏳ generating ADR <N>/<total>`). Generation runs as long as it needs to; the user sees that progress is happening.
6. **Hard upper bound:** 30 minutes total Phase 4 LLM time. If exceeded, treat as failure (D5).

#### Streaming subprocess (replaces `execFileSync`)

```typescript
// Before (adr-generator.ts:1284):
const rawOutput = execFileSync(claudeBin, [...args], {
  encoding: 'utf-8',
  timeout: 120_000,           // hard 120s ceiling
  maxBuffer: 10 * 1024 * 1024,
});

// After:
const child = spawn(claudeBin, [...args], { env: { ...process.env, MCP_SERVER_MODE: undefined } });
let buffer = '';
const heartbeat = setInterval(() => {
  process.stderr.write(`[agentics] ⏳ ADR generation running (${Math.floor((Date.now() - startMs) / 1000)}s, ${buffer.length} bytes received)\n`);
}, 10_000);
child.stdout.on('data', (chunk) => { buffer += chunk.toString(); });
child.stderr.on('data', (chunk) => process.stderr.write(chunk));   // forward Claude Code stderr live
const exitCode = await new Promise<number>((resolve, reject) => {
  child.on('close', resolve);
  child.on('error', reject);
  // 30-minute hard bound — long enough for any reasonable input, short enough to detect runaway
  setTimeout(() => { child.kill('SIGTERM'); reject(new Error('ADR generation exceeded 30min hard bound')); }, 1_800_000);
});
clearInterval(heartbeat);
```

Streaming gives three properties the buffered call doesn't: live progress feedback (per ADR-099), preserved partial output if the process is killed, and visibility of `claude --print`'s own stderr (warnings, retries) which is otherwise discarded.

### D4. Phase-aware ADR path injection in implementation prompts

`prompt-generator.ts` `buildLayerPromptContent` currently inlines ADR content (line 656-670):

```typescript
lines.push(`### ${adr.id}: ${adr.title}`);
lines.push(`**Context:** ${adr.context}`);
lines.push(`**Decision:** ${adr.decision}`);
if (adr.consequences.length > 0) {
  lines.push('**Consequences:**');
  for (const c of adr.consequences) { lines.push(`- ${c}`); }
}
```

Replace with explicit file-path references following the good example's pattern:

```typescript
// New shape — references ADRs by path + section, lets downstream LLM read source of truth
lines.push(`## Architecture Decisions Governing This Layer`);
lines.push('');
lines.push(`The implementation must satisfy these decisions. Read each ADR file in full before writing code:`);
lines.push('');
for (const adr of layer.adrs) {
  lines.push(`- **${adr.id}: ${adr.title}** — \`${adr.relativePath}\``);
  lines.push(`  Implements sections: ${adr.implementationSections.join(', ')}`);
}
lines.push('');
lines.push(`Do NOT paraphrase from this prompt — open each ADR file and follow its decision section, alternatives rationale, and consequences.`);
```

#### Phase mapping

ADRs are tagged with build phases during generation. The mapping from ADR → phase is computed from two signals:

1. **Explicit tag** — D1 instructs the LLM to emit `**Implementation Phase:** <foundation|domain|integration|api|deployment|operations>` in the ADR header.
2. **Inferred fallback** — If the explicit tag is missing, derive from heading patterns: ADRs with `## Schema` or `## Domain Model` → `domain`; ADRs with `## API Examples` or `## REST Endpoints` → `api`; ADRs with `## Deployment` → `deployment`; etc.

The `adr-index.json` carries `phaseTags: string[]` per ADR. `prompt-generator.ts` filters `layer.adrs` to those whose `phaseTags` overlap the current build layer's name. ADRs that match no layer go into a top-level `Cross-Cutting Decisions` section in every prompt (security, observability, governance — these apply everywhere).

### D5. Loud failure replaces silent template

`buildADRsFromSPARC` is removed from the fallback chain in `phase4-adrs-coordinator.ts`. The remaining fallback is:

```typescript
// If Ruflo + streaming Claude Code both produce zero usable ADRs:
const failureAdr = `# ADR-FAIL-001: ADR Generation Failed

**Status:** Failed
**Date:** ${new Date().toISOString().slice(0, 10)}
**Failure mode:** ${reason}

## What happened

Phase 4 attempted ADR generation via Ruflo writer agents (ADR-091) and streamed Claude Code subprocess. Both paths failed.

- Ruflo result: ${rufloFailureReason}
- Claude Code result: ${claudeFailureReason}

## Pipeline state

- Phase 1 artifacts: ${phase1Status}
- Phase 2 dossier: ${dossierItemCount} items
- Phase 3 SPARC: ${sparcStatus}

## Next steps

This run produced NO valid ADRs. Implementation prompts (Phase 5a) and code generation (Phase 5b) cannot proceed coherently. The pipeline emitted this failure ADR instead of falling back to template boilerplate (per ADR-PIPELINE-100 §D5).

To recover: re-run with verbose Claude Code logging (\`AGENTICS_CLAUDE_DEBUG=1\`) and inspect \`phase4/claude-stderr.log\`.
`;
```

The failure ADR is the only artifact in `phase4/adrs/` when generation fails. Downstream consumers see it and can decide whether to proceed or halt. The user sees it and knows generation failed without having to inspect every emitted .md file.

`buildADRsFromSPARC` and its helper functions (`extractDomainContext`, the per-service template branches, the algorithmic-pattern detector) are removed entirely. Their existence has been a recurring source of regression — every fix that "speeds up the fallback" or "makes the templates more domain-aware" is fixing the wrong thing. The right thing is to not have a silent fallback at all.

---

## Alternatives Considered

### Alternative 1: Expand the JSON schema to ~20 nested fields

Define a schema that captures all 20 structural elements of the good example, and have the LLM populate it.

**Rejected because:**
- Under instruction load, LLMs flatten or skip nested fields. A 20-field nested schema is more likely to produce holes (empty `riskAssessment.mitigations`, empty `appendices`) than richer output.
- The good example IS markdown. Forcing a JSON intermediate adds a serialisation step that loses information (ASCII diagrams in markdown render fine; the same diagrams as escaped JSON strings are an eyesore).
- Every consumer of the JSON would need to re-render it back to markdown for human reading — net work increase.

### Alternative 2: Domain-specific templates (water cooling, supply chain, ERP, etc.)

Hand-author template families per domain. Detect the domain from the input and pick the matching template.

**Rejected because:**
- Violates the user's explicit principle: *"the system MUST digest whatever context is given to it."* Domain-tuning regresses on the next domain.
- The set of domains is unbounded. Enumerating them is a combinatorial trap.
- The bad path today already does a weak version of this (the algorithmic-pattern detector at `buildADRsFromSPARC`'s `detectAlgorithmicDecisions`). Doubling down on it makes the regression worse, not better.

### Alternative 3: Keep the SPARC template fallback as a safety net

Leave `buildADRsFromSPARC` in place as a "graceful degradation" path so the pipeline always produces something.

**Rejected because:**
- The silent fallback IS the regression. The user's complaint is not "the pipeline crashed" — it's "the pipeline produced bad ADRs without telling me."
- "Always produce something" optimises for the wrong metric. The right metric is "always produce something **that meets the bar, OR a visible failure**." The current fallback produces something that fails the bar invisibly.
- Loud failure is the safety net. The pipeline still continues (other phases can read the failure ADR), but the artifact is honest.

### Alternative 4: Per-ADR LLM calls (one call per decision)

Generate each ADR in its own subprocess invocation, parallelised. Each call produces deeper output because the LLM has more attention budget per ADR.

**Considered, deferred:** simpler to start with single-call streamed output and measure depth. If individual ADRs are still shallow after D1-D5, per-ADR calls are the next escalation. The Ruflo agent topology already supports this — Ruflo can fan out N writer agents, each producing one ADR. Documented as a follow-up in the implementation plan below, not blocking on this ADR.

### Alternative 5: Multi-shot LLM with self-critique loop

Generate ADR draft, then prompt the LLM to critique its own output against the good example, then revise. Expected to produce higher-quality output at higher cost.

**Considered, deferred:** evidence from ADR-098 Phase 7 enrichment suggests that a single high-context call with a good exemplar already approaches the bar. Self-critique adds a second round-trip without clear quality lift. Re-evaluate if D1-D5 ship and depth is still insufficient.

---

## Consequences

### Benefits

1. **ADR quality matches the bar regardless of input domain.** The exemplar is structural; the input is the domain. Water cooling, supply chain, fleet logistics, ERP migration — all flow through the same path and emerge at the same depth.
2. **Implementation prompts cite ADRs by path, not paraphrase.** Downstream code generation reads source-of-truth instead of a lossy summary. Matches the good prompt example's pattern.
3. **Failures are visible.** The 30-minute regression silently fed the user boilerplate; the new path emits a failure ADR with diagnostics.
4. **Streaming preserves work-in-progress.** The 120s timeout dropped everything; the new path keeps partial output and forwards Claude Code stderr live.
5. **Producer chain matches existing architecture.** Ruflo stays primary (ADR-091); Agentics.dev agents stay as upstream research feeders; Claude Code stays the LLM transport (ADR-098). No new system.
6. **Phase-aware injection improves prompt coherence.** Each Phase 5a prompt references only the ADRs that govern its layer — no copy-paste of irrelevant decisions, no missing ADRs that should have been cited.
7. **Loud failure forces upstream fixes.** Every silent fallback hid the real bug (LLM timeout). With loud failure, every regression is immediately visible and traceable.

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| LLM produces markdown that doesn't match the heading conventions, breaking the extractor | Medium | Medium | Tolerant parser: match `# ADR-` and `**Status:**` patterns case-insensitively; fall back to inferring from content if explicit headers absent. Ship with golden tests against 5+ domains. |
| Streaming subprocess hangs without producing output, hits 30-minute hard bound | Low | Medium | Heartbeat surfaces idle time; if no bytes received in 60s, kill and fail. The 30-min bound is a backstop, not the primary detection. |
| `---DOC-BREAK---` delimiter appears inside an ADR body (e.g., in a code block) and breaks the splitter | Low | Low | Use a UUID-based delimiter regenerated per run. Document in the LLM prompt: "do not use this exact string anywhere in your output." |
| Loud-failure ADR is mistaken for a real ADR by downstream consumers | Low | Medium | The failure ADR has `Status: Failed` and an explicit `# ADR-FAIL-NNN` ID. Consensus, exec-summary, and prompt-generator all check `status !== 'Failed'` before consuming. |
| Phase tagging from heading patterns is inaccurate | Medium | Low | Explicit `**Implementation Phase:**` tag is the primary signal; inference is fallback. Mismatched ADRs land in `Cross-Cutting Decisions` (visible in every prompt) — over-inclusion, not under-inclusion. |
| Per-ADR depth degrades when emitting many ADRs in one LLM call | Medium | Medium | Measure depth on the first 5 runs after ship. Escalate to per-ADR calls (Alternative 4) if average ADR length < 60% of good-example length. |
| Existing ADR-091 Ruflo path keeps producing thin content because Ruflo's writer prompt doesn't carry the new exemplar | High | High | D1 applies to BOTH paths: Ruflo writer prompt and direct Claude Code call use the same exemplar. Ruflo's writer task must be updated alongside this ADR. |

### Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Phase 4 LLM call wall-clock (p50, single domain) | ≤ 8 minutes | streamed, includes all ADRs in one call |
| Phase 4 LLM call wall-clock (p95, complex domain) | ≤ 20 minutes | streamed |
| Heartbeat interval during Phase 4 | 10 seconds | per ADR-099 D3 |
| ADR file count per run | 8-15 | matches good-example count (~10), domain-dependent |
| ADR average length | ≥ 500 lines | good example is 788; matching at 60-70% is acceptable for single-call generation |
| `adr-index.json` regeneration latency | < 100ms | thin extractor on already-written files |
| Pipeline halt rate from loud failure (early runs) | acceptable | replaces silent regression with visible failure; expected during ramp |

### Implementation Status

| Sub-decision | Status | File(s) |
|--------------|--------|---------|
| D1 — markdown-direct schema in `buildADRPrompt` | Implemented | `src/pipeline/phase2/phases/adr-generator.ts` (`buildADRPrompt`) |
| D1 — exemplar inclusion from `docs/templates/ADR-Good-Example.md` | Implemented | `loadGoodAdrExemplar` + embed-in-prompt block |
| D1 — Ruflo writer prompt parallel update | Implemented | `src/pipeline/ruflo-phase-executor.ts` (`buildPhase3Tasks`, `loadAdrExemplarForRuflo`) |
| D2 — `adr-index.json` extractor | Implemented | `src/pipeline/phase4-adrs/adr-index-extractor.ts` |
| D2 — index format spec + tests | Implemented (16 tests) | `tests/unit/pipeline/phase4-adrs/adr-index-extractor.test.ts` |
| D3 — streamed `claude --print` subprocess | Implemented | `src/pipeline/phase2/phases/adr-generator.ts` (`runStreamedClaudePrint`) |
| D3 — heartbeat (10s default), idle-bound (60s), hard-cap (30min) | Implemented | env vars: `AGENTICS_ADR_HEARTBEAT_MS`, `AGENTICS_ADR_IDLE_MS`, `AGENTICS_ADR_TIMEOUT_MS` |
| D3 — partial-output salvage when streamed call killed | Implemented | `tryGenerateLLMADRs` salvage branch on `result.ok===false` |
| D4 — phase tagging in ADR generation | Implemented | `**Implementation Phase:**` field in prompt + extractor parse |
| D4 — `prompt-generator.ts` ADR-path injection | Implemented | `src/pipeline/phases/prompt-generator.ts` (`buildLayerPromptContent`) |
| D4 — phase-to-ADR filter + cross-cutting section | Implemented | layer-specific + Cross-Cutting Decisions sections |
| D4 — `inferAdrPhaseTags` heuristic for legacy ADRs | Implemented | `src/pipeline/phases/adr-ddd-generator.ts` |
| D5 — remove `buildADRsFromSPARC` from `phase4-adrs-coordinator.ts` fallback | Implemented | replaced with `buildLoudFailureADR` emitter |
| D5 — loud-failure ADR emitter | Implemented | `src/pipeline/phase2/phases/adr-generator.ts` (`buildLoudFailureADR`) |
| D5 — delete dead template-substitution code | Implemented | -979 lines from `adr-generator.ts` |
| D5 — remove `skipLLM` parameter and direct callers | Implemented | `src/pipeline/auto-chain.ts` (guarantee paths now call `buildLoudFailureADR` directly) |
| D5 — propagate async through `buildPhase2ADRs` → `persistAskResults` chain | Implemented | `ask-artifact-writer.ts`, `cli/index.ts` updated |

### Acceptance Criteria

This ADR is "Implemented" when **all** of the following hold on a fresh run:

1. `agentics ask "<arbitrary domain prompt>"` produces `phase4/adrs/ADR-*.md` files where each .md file is ≥ 500 lines and contains: header block, version history, context with comparison tables, decision with diagram, key components with code samples, alternatives with rejection reasons, consequences with risks table, performance targets, related decisions.
2. `phase4/adrs/adr-index.json` is regenerated and contains `id`, `title`, `status`, `date`, `phaseTags`, `filePath` for every emitted ADR.
3. `phase5a/prompts/impl-NNN-*.md` files reference ADRs by path (e.g., ``ADR-PIPELINE-XXX (docs/adrs/ADR-PIPELINE-XXX-foo.md)``) and do **not** inline `**Context:**`/`**Decision:**`/`**Consequences:**` paraphrases.
4. When the LLM call fails (forced via `AGENTICS_FORCE_ADR_FAIL=1`), `phase4/adrs/` contains exactly one file: `ADR-FAIL-001.md` with `Status: Failed` and a diagnostic body. No template boilerplate.
5. The 30-minute regression of 2026-04-27 is reproducible on a fresh checkout (LLM call times out → loud failure ADR emitted; user sees the failure within ~10s of the timeout).
6. The same `agentics ask` invocation, run against three different domain inputs (water cooling, supply chain, fleet logistics — chosen because they exercise different research-dossier shapes), produces ADRs that all hit the bar. No domain-specific tuning anywhere in the code path.

---

## Implementation Plan

Sequenced for landability. Each step ships independently and improves the pipeline.

### Step 1 — Markdown-direct LLM call (D1, D5 partial)

- Replace `buildADRPrompt` to instruct the LLM to emit markdown documents, separated by a UUID-based delimiter.
- Embed `docs/templates/ADR-Good-Example.md` in the prompt verbatim with the structural-exemplar instruction.
- Replace `parseRawADRs` with a delimiter-splitter that writes each chunk as `phase4/adrs/ADR-NNN-<slug>.md`.
- Remove the `buildADRsFromSPARC` call from the LLM-failure branch in `phase4-adrs-coordinator.ts`. Replace with the loud-failure ADR.
- Keep the existing Ruflo primary path (ADR-091) unchanged for now. Ruflo's writer prompt update is Step 4.
- **Deliverable:** when the LLM call succeeds, ADRs hit the bar. When it fails, a single failure ADR is emitted.

### Step 2 — Streaming subprocess + heartbeat (D3)

- Replace `execFileSync` with `child_process.spawn` and stream stdout/stderr.
- Add a 10-second heartbeat per ADR-099.
- Add a 30-minute hard bound and a 60-second idle bound.
- Forward Claude Code stderr live so the user sees its progress.
- **Deliverable:** Phase 4 is no longer silent for 30 minutes; the user sees streaming progress.

### Step 3 — `adr-index.json` extractor (D2)

- New module: `src/pipeline/phase4-adrs/adr-index-extractor.ts`.
- Walks `phase4/adrs/*.md`, extracts the flat fields, writes `adr-index.json`.
- Tolerant parser: matches H1/Status/Date patterns case-insensitively.
- Golden tests against 5 hand-crafted markdown ADRs covering the heading-variation surface.
- **Deliverable:** downstream consumers can navigate ADRs by ID without re-parsing markdown.

### Step 4 — Ruflo writer prompt parity (D1 for Ruflo path)

- Update Ruflo's `architecture-decisions` writer-agent prompt to use the same exemplar.
- Verify on the same three domain inputs as Step 1.
- **Deliverable:** ADR-091 Ruflo path produces output at the same quality bar as the direct Claude Code path.

### Step 5 — Phase-aware ADR injection in prompts (D4)

- Add `**Implementation Phase:** <tag>` to the ADR LLM prompt.
- Update `adr-index-extractor` to populate `phaseTags`.
- Modify `buildLayerPromptContent` to reference ADRs by relative path + section, not inline content.
- Add `Cross-Cutting Decisions` section in every prompt for ADRs without a phase match.
- **Deliverable:** Phase 5a prompts cite ADRs by path; downstream code generation reads source-of-truth.

### Step 6 — Dead-code removal (D5)

- Delete `buildADRsFromSPARC`, `extractDomainContext`, `detectAlgorithmicDecisions`, and the per-service template branches in `adr-generator.ts`.
- Remove the `skipLLM` parameter and its callers.
- Keep `tryGenerateADRsViaAPI` only if it's reachable from any path other than the deleted fallback; otherwise delete it too.
- **Deliverable:** ~600 lines of template-substitution code removed. The path is unambiguous: Ruflo or streamed Claude Code, or loud failure.

### Step 7 — Acceptance verification

- Run the three-domain regression suite (water cooling, supply chain, fleet logistics).
- Verify each criterion in the Acceptance Criteria section above.
- Update this ADR's Status to `Implemented` with a verification scorecard table.

---

## Related Decisions

- **ADR-PIPELINE-091** — Ruflo as primary engineering executor. This ADR keeps Ruflo primary; the changes in D1 and D3 apply equally to the Ruflo writer-agent prompt.
- **ADR-PIPELINE-098** — Phase 7 enrichment uses Claude Code Max only. This ADR generalises the same transport principle to Phase 4 ADR generation.
- **ADR-PIPELINE-099** — Coherent multi-prompt Phase 5a + continuous heartbeat. This ADR's D3 heartbeat reuses the same heartbeat utility; D4 makes the prompts Phase 5a emits actually link to ADRs by path.
- **ADR-PIPELINE-094** — Path-reality and degraded-mode completion. The D2 fallback path that ADR-094 introduced is replaced by the loud-failure ADR in this ADR's D5.
- **ADR-027** — LLM-Generated Architecture Decision Records. This ADR rebuilds the LLM path with a markdown-direct schema and an exemplar-grounded prompt.
- **ADR-PIPELINE-028** — Guaranteed ADR generation. The "guarantee" is preserved in spirit (every run produces something in `phase4/adrs/`), but the guarantee no longer covers fallback boilerplate — it covers either real ADRs or a visible failure.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-27 | nicholas-ruest + Claude (Opus 4.7) | Initial proposal — markdown-direct ADRs, thin index extractor, streaming subprocess, phase-aware prompt injection, loud failure replaces silent template. |
| 1.0 | 2026-04-27 | Claude (Opus 4.7) | Implementation landed: D1-D5 complete. 979 lines of template-substitution dead code removed; new `adr-index-extractor.ts` (~250 lines) + 16 passing unit tests; streamed subprocess with heartbeat/idle/hard-cap; phase-aware ADR injection with cross-cutting section. End-to-end validation against three domain inputs scheduled in Step 7. |
