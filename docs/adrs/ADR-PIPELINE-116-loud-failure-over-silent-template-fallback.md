# ADR-PIPELINE-116: Loud Failure Over Silent Template Fallback Across All Phases

**Status:** Proposed
**Date:** 2026-06-25
**Authors:** Nick Ruest
**Priority:** CRITICAL — The reference run exited with code 0, `engineering_tier: "template"`, `planPromotion: { sparc: 0, adrs: 0, ddd: 0, tdd: 0, prompts: 2, implementation: 0 }`, and no `deliverables/` directory. A degraded run that produced effectively no real output reported success. The `ADR-FAIL-001` loud failure pattern (ADR-PIPELINE-100 D5) already works correctly for the ADR phase. SPARC, DDD, TDD, implementation prompts, prototype, and Phase 7 (~85 executive deliverables) still emit canned templates silently when no engine is available, inflate the emitted-count metric, and allow the pipeline to exit 0. This ADR extends the `ADR-FAIL` pattern uniformly to every generation phase and enforces an honest manifest verdict and non-zero exit code whenever no real engine produced content.
**Builds on:** ADR-PIPELINE-100 (D5 — established the `ADR-FAIL-001` loud-failure pattern for the ADR phase; this ADR generalises it), ADR-PIPELINE-105 (deliverable output guarantee and acceptance gate — Phase 7 skipped-due-to-upstream and zero-deliverable cases must be reflected in status; this ADR provides the per-phase failure signal that ADR-105's gate reads), ADR-PIPELINE-111 (Phase 7 writer-agent field contract — `all-_TBD_` rows must not count as emitted; this ADR extends that principle to all phases), ADR-PIPELINE-112 (model backend policy — defines what counts as a "real engine"), ADR-PIPELINE-115 (Rust-default language — D5 delegates to this ADR's failure protocol for phase 5b).

---

## Context

### The reference run's false-success profile

The reference run manifest recorded:

```json
{
  "engineering_tier": "template",
  "tier_counts": { "ruflo-local": 0, "template": 3 },
  "planPromotion": {
    "sparc": 0, "adrs": 0, "ddd": 0, "tdd": 0,
    "prompts": 2, "implementation": 0
  },
  "phase5b_skipped": { "reason": "language-mismatch", "detected": "unknown", "template": "typescript" },
  "exitCode": 0
}
```

The run produced:
- Zero SPARC specifications promoted to plans.
- Zero ADRs promoted to plans (`ADR-FAIL-001` was emitted but did not trigger a non-zero exit).
- Zero DDD models promoted to plans.
- Zero TDD plans promoted to plans.
- Two implementation prompts (template-substituted, not LLM-generated).
- Zero prototype files (phase 5b skipped).
- Zero deliverables (Phase 7 `skipped-due-to-upstream` — no `deliverables/` directory produced).

The CLI reported completion. The user had no way to determine the run had failed without inspecting the manifest and the emitted files individually.

### Phase-by-phase audit of current fallback behaviour

| Phase | Loud failure on no-engine? | Current fallback | Commits that show this is wrong |
|-------|---------------------------|-----------------|--------------------------------|
| Phase 3 — SPARC | No | Template-substituted SPARC spec emitted silently | `engineering_tier: "template"` in reference run |
| Phase 4 — ADRs | Yes (`ADR-FAIL-001`) | `ADR-FAIL-001.md` emitted; but exit code still 0 | ADR-100 D5 correctly emits failure; exit code contract not enforced |
| Phase 4 — DDD | No | Template-substituted DDD model emitted silently | `planPromotion.ddd: 0` in reference run |
| Phase 4 — TDD | No | Template-substituted TDD plan emitted silently | `planPromotion.tdd: 0` in reference run |
| Phase 5a — prompts | No | Two template-substituted prompts emitted, counted as real | `planPromotion.prompts: 2` — inflated metric |
| Phase 5b — prototype | No | Skip recorded; exit code 0 | `phase5b_skipped` + exit 0 |
| Phase 7 — deliverables | No | `skipped-due-to-upstream`; no directory emitted; exit code 0 | ADR-105 D5 defines status semantics but gate not yet built |

The pattern is consistent: any phase without a working engine silently completes, contributes a canned artifact, and does not propagate its failure to the exit code.

### Why this matters beyond aesthetics

1. **Downstream consumers are deceived.** Implementation prompts cite ADR content; if the ADRs are canned templates, the prompts are incoherent. Code generators reading TDD plans from template-TDD produce tests for placeholder entities. The deception compounds through every downstream phase.

2. **Metrics are inflated.** `prompts: 2` in `planPromotion` counts two template-substituted prompts as promoted artifacts. Scorecard summaries, dashboards, and Phase 7 acceptance gate (ADR-105) read these counts and cannot distinguish real output from canned output without per-artifact inspection.

3. **ADR-111 and commits 48a83ef, a29ba0f, 43686f0 establish the principle.** The commit history records three consecutive fixes to prevent synthetic/stub data from being counted or presented as real: "never present synthetic agent data as real in deliverables," "stop counting synthetic agent stubs as passed build-time checks," "exclude synthetic@200 agent stubs from enterprise passes." This ADR applies the same principle to all generation phases.

4. **Phase 7 skipped means ~85 deliverables are absent.** ADR-105 guarantees that Phase 7 emits the ~80-document pack on every full run. A `skipped-due-to-upstream` status caused by upstream template failures is a violation of ADR-105's guarantee. Under the current policy the violation is invisible (exit code 0).

---

## Decision

### D1. Every generation phase emits a loud-failure artifact when no real engine produced content

The `ADR-FAIL-001` pattern (ADR-100 D5) is generalised into a per-phase `PHASE-FAIL-NNN.md` format and applied to all engineering-artifact phases:

| Phase | Failure artifact filename | Status field |
|-------|--------------------------|-------------|
| Phase 3 — SPARC | `SPARC-FAIL-001.md` in `<runDir>/phase3/sparc/` | `Status: Failed` |
| Phase 4 — ADRs | `ADR-FAIL-001.md` (existing pattern, unchanged) | `Status: Failed` |
| Phase 4 — DDD | `DDD-FAIL-001.md` in `<runDir>/phase4/ddd/` | `Status: Failed` |
| Phase 4 — TDD | `TDD-FAIL-001.md` in `<runDir>/phase4/tdd/` | `Status: Failed` |
| Phase 5a — prompts | `PROMPT-FAIL-001.md` in `<runDir>/phase5a/` | `Status: Failed` |
| Phase 5b — prototype | `PROTO-FAIL-001.md` in `<runDir>/phase5b/` | `Status: Failed` |
| Phase 7 — deliverables | `DELIVER-FAIL-001.md` in `<runDir>/deliverables/` | `Status: Failed` |

Each failure artifact contains:
- The phase name and failure reason.
- The backend resolver result (`tier: 'none'`, `reason`).
- The pipeline state at the time of failure (inputs available, phase dependencies met/unmet).
- Recovery instructions (which engine to configure, which ADR to consult).

Template boilerplate is never emitted in place of a failure artifact. The only artifact in a failed phase's output directory is the `PHASE-FAIL-NNN.md` file (or files, if multiple sub-phases fail independently).

### D2. The manifest carries a per-phase `engine_tier` and a top-level `degraded` / `failed` verdict

Each phase entry in the run manifest is extended:

```json
{
  "phases": {
    "phase3": {
      "status": "failed",
      "engine_tier": "none",
      "failure_artifact": "phase3/sparc/SPARC-FAIL-001.md",
      "reason": "no-engine-available"
    },
    "phase4_adrs": {
      "status": "failed",
      "engine_tier": "none",
      "failure_artifact": "phase4/adrs/ADR-FAIL-001.md",
      "reason": "no-engine-available"
    }
  },
  "run_verdict": "failed",
  "degraded": false
}
```

`run_verdict` semantics:

| Value | Meaning |
|-------|---------|
| `"success"` | All phases produced real engine-generated output. |
| `"degraded"` | Some phases produced real output; others failed (e.g. DDD succeeded but TDD failed). Partial value delivered. |
| `"failed"` | No phase produced real engine-generated output. The run delivered no content of value. |

The `engineering_tier: "template"` manifest field from the reference run is replaced by `run_verdict: "failed"`. The `tier_counts` field is retained for diagnostics but is not used to determine `run_verdict`.

### D3. CLI exit code reflects the run verdict

| `run_verdict` | CLI exit code |
|--------------|---------------|
| `"success"` | 0 |
| `"degraded"` | 1 |
| `"failed"` | 2 |

Exit code 0 means the run delivered real output. Exit code 1 means partial output was delivered and the user should inspect which phases failed. Exit code 2 means no real output was delivered.

The reference run would exit with code 2 under this policy. CI pipelines that check exit code will fail on code 2 (or 1 depending on CI policy) rather than silently passing.

### D4. Template content is NEVER counted as a promoted artifact

`planPromotion` counts are computed from artifacts produced by a real engine (`engine_tier` in `{ruflo, claude-print, codex}`). Template-generated artifacts (or failure artifacts) are excluded from all counts:

```typescript
// Updated planPromotion accumulator:
function incrementPromotion(phase: string, artifact: Artifact): void {
  if (artifact.engine_tier === 'none' || artifact.is_failure_artifact || artifact.is_template) {
    return;  // never count canned content as promoted
  }
  planPromotion[phase]++;
}
```

`prompts: 2` in the reference run would become `prompts: 0` under this policy (the two template prompts are not real output). This reduces the reported count but makes it accurate.

### D5. Phase 7 `skipped-due-to-upstream` is a loud failure honoring ADR-PIPELINE-105

When Phase 7 is skipped because upstream phases (Phase 3, 4, 5a) all failed (no real engine output):

- `DELIVER-FAIL-001.md` is emitted in `<runDir>/deliverables/` with `reason: "skipped-due-to-upstream"`.
- The Phase 7 entry in the manifest carries `status: "failed"`, `acceptance: "unmet"`, `deliverables_pass: 0`, `deliverables_weak: 0`, `deliverables_failed: N_target`.
- `run_verdict: "failed"` (not `"success"` or `"partial"`).
- The `deliverables/` directory exists and contains only `DELIVER-FAIL-001.md` — not empty, not absent. Its presence allows tooling to detect the failure without requiring knowledge of whether the directory should exist.

This directly honors ADR-105 D5: `completed` means ≥90% of documents are PASS-grade; a skipped Phase 7 is `failed`, never `completed`.

### D6. Existing canned-fallback code paths are removed from all phases

The following template-fallback code paths, analogous to the `buildADRsFromSPARC` code that ADR-100 removed (-979 lines), are deleted from all engineering-artifact phases:

| Phase | Code to remove | Location |
|-------|---------------|---------|
| Phase 3 SPARC | `buildSPARCFromTemplate()` and its domain-substitution branches | `src/pipeline/phase3/phases/sparc-generator.ts` |
| Phase 4 DDD | Template DDD generator (identified as ADR-091 §3 "deterministic templates") | `src/pipeline/phase4-adrs/ddd-generator.ts` |
| Phase 4 TDD | Template TDD plan generator | `src/pipeline/phase4-adrs/tdd-generator.ts` |
| Phase 5a prompts | Template prompt-substitution path that currently inflates `planPromotion.prompts` | `src/pipeline/phases/prompt-generator.ts` |
| Phase 5b prototype | `language-mismatch` skip path and its TypeScript fallback emission | `src/pipeline/auto-chain.ts:5317–5370` |
| Phase 7 | All-`_TBD_` row counted as emitted (ADR-111 D7 fix already mandated; enforced here) | `src/pipeline/phase7/coordinator.ts` |

Removal of these paths is gated on the engine fixes in ADR-112/113/114 landing first. Until those land, removing the template paths would cause loud failures on every run — which is correct and honest, but operationally disruptive. The recommended implementation order is: ADR-112 → ADR-113 → ADR-114 → ADR-116.

---

## Alternatives Considered

### Alternative 1: Keep silent templates but add a warning banner to each canned artifact

Retain the template-substitution paths but prepend a `> WARNING: This content was generated from a template, not from an LLM engine. It does not reflect your specific use case.` banner to each emitted file.

**Rejected because:**
- ADR-104 (canned-fallback visibility) already implemented this approach. The reference run post-dates ADR-104. Banners are ignored; the template artifacts still propagate to downstream consumers (prompt-generator reads SPARC; exec-summary reads ADRs) which cannot distinguish a bannered template from real content.
- ADR-111 (commit 48a83ef, a29ba0f, 43686f0) already established that synthetic data must not appear in deliverables at all — not even with a warning. A banner is a warning, not a removal.

### Alternative 2: Keep silent templates but set `run_verdict: "degraded"` and exit code 1

Allow template output but change the reported status from `"success"` to `"degraded"`.

**Rejected because:**
- "Degraded" implies partial value was delivered. Template-only output delivers no engineering value — it is boilerplate the user could have written in five minutes without running the pipeline. Calling it "degraded" misrepresents the severity.
- Downstream CI pipelines checking for exit code 1 would fail, which is the right outcome — but it then re-raises the question of why template output is being emitted at all if the outcome is a failure.
- The correct policy is: real output → success; no real output → failure; partial real output → degraded.

### Alternative 3: Let each phase independently decide whether to fail loudly or fall back to templates

Allow phase coordinators to configure their own fallback policy. Some phases (ADRs) fail loudly; others (SPARC) silently template.

**Rejected because:**
- This is the current state, and it is the problem. The inconsistency means the user cannot predict which failures are loud and which are silent.
- A coherent policy — all phases loud-fail on no-engine — is more maintainable and more honest. An implementer adding a new phase does not need to decide the policy; it is inherited.

### Alternative 4: Reintroduce template fallbacks under an explicit `AGENTICS_ALLOW_TEMPLATES=true` flag

Allow template fallback in designated "offline" or "demo" modes.

**Considered and deferred:** an explicit opt-in for template output in offline/demo contexts is a legitimate feature. The key word is "opt-in": the default must be loud failure, and a template result under `AGENTICS_ALLOW_TEMPLATES=true` must be labelled as such in the manifest and must not count as a promoted artifact. This feature is not implemented in this ADR; it is deferred until the loud-failure baseline is established.

---

## Consequences

### Benefits

1. **Exit code tells the truth.** A run that produced no real output exits 2; a run that produced all real output exits 0. CI pipelines detect failures without inspecting manifest files.
2. **`planPromotion` counts are accurate.** Template artifacts are excluded; the count reflects real promoted content.
3. **Phase 7 failure is visible.** `DELIVER-FAIL-001.md` in `deliverables/` closes the "~85 deliverables absent, exit 0" failure mode from the reference run.
4. **ADR-105 guarantee is enforceable.** The per-phase failure artifacts and manifest `engine_tier` fields give the ADR-105 acceptance gate the signal it needs to distinguish real output from canned output.
5. **Consistent policy across all phases.** Every phase follows the same rule: real engine → promoted; no engine → loud failure. New phases inherit the policy.
6. **Commits 48a83ef / a29ba0f / 43686f0 are formalised.** The principle established by those commits is now a standing architectural decision, not a series of one-off fixes.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Loud failure on every run until engine fixes (ADR-112–114) land | High (during transition) | Medium | Implement in order: ADR-112 → 113 → 114 → 116. The loud failure is correct; the mitigation is fixing the engines, not softening the failure signal. |
| CI pipelines that previously succeeded on exit 0 now fail on exit 2 | High (existing CI) | Medium | Document the migration; CI pipelines should be updated to treat exit 2 as a failure (they already should). |
| Per-phase failure artifacts accumulate in the run directory and confuse users about what failed | Low | Low | Each `PHASE-FAIL-NNN.md` has a clear section listing what failed and what to do; the manifest `run_verdict` gives a top-level summary |
| `DELIVER-FAIL-001.md` in `deliverables/` causes tools that scan the directory to count it as a deliverable | Low | Low | The file's name (`DELIVER-FAIL`) and its `Status: Failed` front-matter are machine-readable; the acceptance gate (ADR-105) already filters by `status !== 'Failed'` |
| Removing template paths before engine fixes causes all runs to fail loudly during development | Medium | Low | Feature flag `AGENTICS_KEEP_TEMPLATES=true` preserves the old paths temporarily during the transition window; deprecated and removed after ADR-112–114 are verified green |

### Performance Targets

| Metric | Target |
|--------|--------|
| `run_verdict` presence in manifest | Required; missing → validation error |
| Exit code 0 for runs where `engineering_tier: "template"` | 0 (policy violation) |
| `planPromotion` count inflation from template artifacts | 0 |
| Template-substitution code paths remaining after full implementation | 0 (except behind `AGENTICS_KEEP_TEMPLATES` during transition) |
| Phase failure artifacts emitted for runs where the engine is unavailable | 1 per failed phase |
| Phase 7 `deliverables/` directory absent on a non-skipped run | 0 (directory always created; DELIVER-FAIL-001.md emitted on failure) |

---

## Related Decisions

- **ADR-PIPELINE-100** — D5 established the `ADR-FAIL-001` loud-failure pattern for the ADR phase. This ADR generalises it to all phases.
- **ADR-PIPELINE-105** — Deliverable output guarantee and acceptance gate. Phase 7 `failed` status (D5 of this ADR) directly feeds the ADR-105 `acceptance: "unmet"` verdict.
- **ADR-PIPELINE-111** — Phase 7 writer-agent field contract. D7 mandates that `all-_TBD_` rows not count as emitted; D4 of this ADR generalises the same principle to all phases.
- **ADR-PIPELINE-112** — Model backend policy. Defines what constitutes a "real engine" (`tier` in `{ruflo, claude-print, codex}`); this ADR uses that definition to gate artifact promotion.
- **ADR-PIPELINE-113** — Ruflo PATH-independent resolution. Ruflo availability (or confirmed unavailability) feeds the `engine_tier` field that this ADR's failure decision reads.
- **ADR-PIPELINE-114** — Harden `claude --print` transport. Tier-2 availability (or confirmed unavailability) similarly feeds `engine_tier`.
- **ADR-PIPELINE-115** — Rust-default implementation language. D5 of that ADR delegates to this ADR's `PROTO-FAIL-001` protocol when phase 5b cannot produce real Rust output.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-06-25 | Nick Ruest | Initial proposal — generalise ADR-FAIL pattern to all phases, per-phase engine_tier and failure artifacts, run_verdict taxonomy, non-zero exit codes, remove canned-fallback paths, Phase 7 skipped-due-to-upstream as loud failure |
