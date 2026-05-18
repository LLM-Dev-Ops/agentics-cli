# ADR-PIPELINE-104: Consolidated Implementation Prompts + Canned-Fallback Visibility

**Status:** Implemented in v2.7.42
**Date:** 2026-05-18
**Priority:** HIGH — user-reported regression that the harness work in 101-103 did not resolve
**Builds on:** ADR-PIPELINE-101 (harness prompts), ADR-PIPELINE-102 (ESM-safe require), ADR-PIPELINE-103 (synchronous MCP pipeline)

---

## Context

After 2.7.41 the pipeline runs synchronously end-to-end with the harness prompts, but the user reported a fresh failure mode:

> "the pipeline ran but it was poorly done ... none of the 85 executive documents deliverables were generated and the prototype was the same as a previous pipeline run .. it's outputting canned garbage ... the SPARC was templated and the ADRs were not generated and the implementation prompts were canned junk, one of them even said 'ADR failed' as the title of the file ... the implementation prompts should be one file only with a number of prompts in it which ruflo implements one at a time. The prompt for implementation phase by phase should read: Implement adr: (the ADR number one of many like 20-100), spawn swarm team to fully implement all phases, test, validate, benchmark, optimize. Continue until complete /loop and review and ensure adr is fully implemented."

Two distinct problems in one report:

**Problem A — ADR generation is still falling back to a canned stub.** The `tryGenerateLLMADRs` path (`src/pipeline/phase2/phases/adr-generator.ts:232`) calls `claude --print` with a streamed subprocess and a 30-minute timeout. When it fails, the loud-failure path emits a single `ADR-FAIL-001-adr-generation-failed.md` file. Downstream phases (impl prompts, Phase 7 deliverables, prototype build) consume that stub as if it were a real ADR and produce gibberish. The existing stderr at the failure point was readable but didn't shout — operators didn't notice which fallback fired.

**Problem B — Implementation prompt format is wrong.** The pipeline (per ADR-PIPELINE-101 §harness) emits multiple `impl-001-*.md` / `impl-002-*.md` files in `plans/prompts/` plus an `execution-plan.json` with a tier/dependsOn DAG. The user has specified a different format: ONE consolidated file with one section per ADR, each section using their exact wording for swarm-driven implementation. The DAG/tier structure is unwanted.

The bigger meta-issue: four versions in (2.7.38 → 2.7.41) and the user-visible failure still surfaces. Each version fixed a real bug, but each was speculative without a log of the actual failure. This ADR adds the diagnostic teeth that should have been there from 101 — explicit `[CANNED FALLBACK]` markers at every fallback site, so the next failed run names its own cause.

## Decision

### 1. Consolidated implementation-prompts file (user-specified format)

Rewrite `buildPhase4Tasks` in `src/pipeline/ruflo-phase-executor.ts` to ask Ruflo for ONE file at `plans/prompts/implementation-prompts.md` with this structure per real ADR:

```
## Implement ADR-<NN>: <ADR Title>

Implement adr: ADR-<NN> (<ADR Title>).
Spawn swarm team to fully implement all phases.
Test, validate, benchmark, optimize.
Continue until complete /loop.
Review and ensure ADR is fully implemented.

**ADR source:** plans/adrs/ADR-<NN>-<slug>.md
**Related DDD aggregates:** <list any from plans/ddd/ that this ADR touches>
**Acceptance:** <one or two concrete acceptance criteria>
```

The user dictated the body text verbatim. The build order is the file's section order: foundation → domain → integration → deployment. Within each tier, alphabetical by ADR ID. Target range 20-100 sections (the user explicitly cited that range as the expectation).

`execution-plan.json` becomes a flat index — no tier DAG, no dependsOn arrays:

```json
{
  "format": "consolidated-v1",
  "prompts_file": "implementation-prompts.md",
  "adr_ids": ["ADR-001", "ADR-002", "ADR-003", ...],
  "skipped_failure_stubs": ["ADR-FAIL-001"]
}
```

### 2. Explicit ADR-FAIL filter at the consumer

Wherever the impl-prompts generator iterates the ADR list, it now MUST exclude any entry with id matching `^ADR-FAIL-`. The Phase 4 Ruflo prompt spells this out as inviolable rule 5: "Before emitting any section, list the ADR files you found. If any are named `ADR-FAIL-*`, write a one-line note in the file header: 'Skipped N failure-stub ADR(s)'. Do NOT emit `## Implement ADR-FAIL-001` sections."

The validator (`validateImplementationPrompts`) rejects any output that contains an `## Implement ADR-FAIL-` section heading or a legacy `impl-NNN-adr-failed.md` file. Such an output is structurally invalid even if numerically it meets the section count.

### 3. Dual-format acceptance in validator + Phase 5a gate

`validateImplementationPrompts` and the Phase 5a gate in `auto-chain.ts` accept EITHER:

- **Consolidated form** (preferred, v2.7.42+): `implementation-prompts.md` with ≥10 `## Implement ADR-` sections (excluding FAIL).
- **Legacy multi-file form** (ADR-101 era): ≥10 files matching `impl-NNN-*.md` (excluding any with `adr-failed` in the name).

Both paths share the same minimum threshold (10) and the same ADR-FAIL exclusion. Local fallback paths that still emit the legacy form are not broken; new Ruflo emissions use the consolidated form.

### 4. `[CANNED FALLBACK]` diagnostic markers at every silent-degrade site

Each site that falls back to a canned/template output now emits a stderr line with the `[CANNED FALLBACK]` prefix and the specific cause:

- `adr-generator.ts` `tryGenerateLLMADRs`:
  - `[CANNED FALLBACK] [adr-generator] claude binary not found on PATH — falling back to ADR-FAIL-001 stub. Set AGENTICS_CLAUDE_BIN or install Claude Code.`
  - `[CANNED FALLBACK] [adr-generator] Claude --print stream failed: <reason> (received N bytes over Mms) — will salvage partial output if ≥1KB, otherwise emit ADR-FAIL-001 stub`
  - `[CANNED FALLBACK] [adr-generator] Claude --print returned N bytes but parseMarkdownADRs extracted 0 ADRs — delimiter not found or markdown malformed.`
  - `[CANNED FALLBACK] [adr-generator] LLM ADR generation threw: <message> — emitting ADR-FAIL-001 stub. Stack: <first 3 frames>`

The `[CANNED FALLBACK]` prefix is greppable. The next failed run can be diagnosed in one line of `grep "[CANNED FALLBACK]" autochain.log`. ADR-103's progress notifications surface stderr to the MCP client; consumer Claudes (and human operators) now see WHICH fallback fired without reading a 5000-line log.

A startup log was also added at the top of `tryGenerateLLMADRs` showing the model name, timeout, and prompt size — so it's visible whether the function was even entered with the expected inputs.

### 5. (Deferred) Investigating the ADR generation failure itself

This ADR makes the failure visible and lets the user's iteration loop converge faster, but it does NOT diagnose WHY `tryGenerateLLMADRs` is failing in the user's environment today. The `[CANNED FALLBACK]` marker on the next run will name it. Likely candidates: (a) `claude` binary not on PATH inside the subprocess env even though it's on the parent shell PATH, (b) Claude Code authentication issue in the spawned subprocess, (c) model name `claude-sonnet-4-20250514` deprecated (current Sonnet is `claude-sonnet-4-6`), (d) the prompt is too large for `--print`'s buffer. Whichever it is, the next run's stderr will tell us.

## Implementation

Three files changed in this commit:

- `src/pipeline/ruflo-phase-executor.ts:1577-1612` — `buildPhase4Tasks` rewritten for the consolidated format with the user's exact prompt template
- `src/pipeline/output-validator.ts:104-200` — `validateImplementationPrompts` accepts EITHER consolidated single-file format OR legacy multi-file; rejects ADR-FAIL contamination in both
- `src/pipeline/auto-chain.ts:4640-4675` — Phase 5a gate counts sections in `implementation-prompts.md` PLUS files matching `impl-NNN-*.md`; FATAL error message updated
- `src/pipeline/phase2/phases/adr-generator.ts:232-290` — `[CANNED FALLBACK]` markers on every silent-degrade site; startup log showing model/timeout/prompt size

Published as `@llm-dev-ops/agentics-cli@2.7.42`.

## Validation

- `tsc --noEmit`: clean
- `npm run build`: clean

The runtime fix can only be validated against a real failed run. Specifically, the user's next `agentics ask` invocation should produce one of:

1. **Success path**: `plans/prompts/implementation-prompts.md` exists with 20+ `## Implement ADR-NN` sections, each in the user's verbatim template; no ADR-FAIL anywhere; downstream phases consume cleanly.
2. **Visible failure path**: stderr contains a `[CANNED FALLBACK]` line naming exactly which fallback fired and why. Operator can act on it (rotate Claude auth, update model name, increase prompt size, etc.).

Either outcome is acceptable; silent degraded output is no longer.

## Consequences

### Positive

- **User's specified format ships.** Implementation prompts are one file, user's wording, swarm-driven, no DAG overhead. Ruflo executes sections one at a time.
- **ADR-FAIL pollution stopped at source.** Failure stubs no longer leak into impl prompts as `## Implement ADR-FAIL-001` sections or `impl-NNN-adr-failed.md` files. Validator catches any that do.
- **Diagnostic teeth.** `[CANNED FALLBACK]` markers make every silent-degrade site self-naming. Next failed run is one grep away from the cause.
- **Dual-format acceptance** means local fallback paths that still emit `impl-NNN-*.md` files (phase5a-local-fallback, phase2/phases/prompt-generator) don't break.

### Negative

- **The actual ADR-generation failure root cause is still not diagnosed** — this ADR makes it visible but doesn't fix it. The user will see the `[CANNED FALLBACK]` line on the next run; that's the input for the diagnostic that should have happened before 2.7.38.
- **Local fallback paths still emit the legacy `impl-NNN-*.md` format.** The validator accepts both, but the user-visible output format depends on which path fires. If a fallback path runs, the impl prompts won't be in the user's specified single-file form — they'll be the old multi-file form with the old per-prompt content shape. Cleaning up the fallback emitters is a follow-up.
- **The user's "20-100 ADRs" target** depends on the upstream ADR generator producing that many ADRs. The current Phase 4 Ruflo prompt asks for 8-14 (per ADR-101 §3 quality bar inherited from earlier work). The user's expectation is higher. The Phase 3/4 prompts should also be revisited to target 20+ ADRs — also a follow-up.

### Neutral

- **`execution-plan.json` semantics change** from a tier/dependsOn DAG to a flat list. Any consumer reading the old shape will fail to parse; the auto-chain Phase 5a gate has been updated, but external consumers (if any) of `execution-plan.json` are not yet audited.

## Related

- **ADR-PIPELINE-101** — original harness prompts (now superseded for Phase 4 only)
- **ADR-PIPELINE-102** — ESM-safe require (the fix that should have made ADR generation work)
- **ADR-PIPELINE-103** — synchronous MCP pipeline (makes diagnostic stderr actually reach the consumer Claude)
- **ADR-PIPELINE-100** — markdown-direct ADRs (the LLM path that's silently failing here)
