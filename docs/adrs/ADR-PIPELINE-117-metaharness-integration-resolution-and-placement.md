# ADR-PIPELINE-117: MetaHarness Integration — Resolution Contract and Pipeline Placement

**Status:** Proposed
**Date:** 2026-07-06
**Authors:** Nick Ruest
**Priority:** HIGH — The pipeline already depends on two members of the MetaHarness family without naming the family: `ruflo` (the meta-harness itself — `.mcp.json` starts `ruflo mcp start`, and MetaHarness's own README describes ruflo as "the meta-harness this generator factors apart") and, transitively, `ruvector` (the vector + agentic memory backend). MetaHarness is the **factory/kernel** those descend from. Today the pipeline generates a high-fidelity prototype (Phase 5), pushes it to an ERP surface (Phase 6), and emits ~85 consulting deliverables (Phase 7) with **no independent fit/cost/safety assessment of what it built** and **no provenance signature** on the decision pack. MetaHarness supplies exactly those capabilities (`genome`, `score`, `mcp-scan`, `threat-model`, `sbom`, `sign`/`verify`) as deterministic, no-code-execution static analysis. This ADR makes MetaHarness a first-class, resolvable pipeline component and defines *where* it plugs in; ADR-118 and ADR-119 specify the concrete gates.
**Builds on:** ADR-PIPELINE-112 (model backend policy — establishes the single-resolver-with-cached-tier pattern this ADR mirrors for MetaHarness), ADR-PIPELINE-113 (ruflo PATH-independent resolution — the resolver design this ADR copies), ADR-PIPELINE-116 (loud failure over silent fallback — MetaHarness unavailability is surfaced, never silently skipped), ADR-PIPELINE-105 (deliverable output guarantee — MetaHarness artifacts join the Phase 7 pack).

---

## Context

### What MetaHarness provides

MetaHarness (https://github.com/ruvnet/metaharness) is a factory that scaffolds branded agent harnesses and ships a suite of **static, no-execution** assessment commands. Verified in this environment:

```
npx metaharness score <repo>      # fit / cost-per-run / tool-safety scorecard (0–100)   [ADR-041]
npx metaharness analyze <repo>    # recommend a harness plan (no-exec)
npx metaharness genome <repo>     # 7-section repo readiness report
npx metaharness learn ...         # GEPA learning run ($0 dry-run by default)
```

The same capabilities are exposed as MCP tools by the `ruflo`/claude-flow MCP server already configured in `.mcp.json`:

```
metaharness_genome     metaharness_score        metaharness_mcp_scan
metaharness_threat_model  metaharness_sbom      metaharness_redblue
metaharness_security_bench  metaharness_oia_audit  metaharness_similarity
metaharness_evolve     metaharness_gepa         metaharness_learn
metaharness_drift_from_history  metaharness_audit_list  metaharness_audit_trend
```

Critically, `genome`/`score`/`analyze` are **deterministic static analysis that never executes repository code** — inferred build/test commands are marked `trust: inferred · execution: disabled`. This aligns with the pipeline's existing "no billed provider connection, no arbitrary execution" posture (ADR-112 §D1).

### The gap today

| Pipeline stage | What it produces | Independent assessment today |
|----------------|------------------|------------------------------|
| Phase 5 (Build) | Full prototype (331 files in the reference run) | None — the prototype is emitted and trusted |
| Phase 6 (ERP push) | 47–51 registered endpoints | None — endpoints pushed without a tool-safety scan |
| Phase 7 (Deliverables) | ~85 consulting docs | None — no fit/cost/safety scorecard cited in the exec brief |
| Decision pack (overall) | Bundle handed to a decision-maker | **No provenance signature** |

The pipeline's own README frames it as a **decision-support** system ("pushes to the ERP surface so a decision can be reached"). A decision-support system that generates a prototype but never scores its build-likelihood, audits the tools it exposes, or signs the pack it hands over is missing the exact assurance layer MetaHarness was built to provide.

### Why name the family now

`.mcp.json` already runs `ruflo mcp start`; the backend resolver already prefers `ruflo` (ADR-112 §D2). The pipeline is *already* a MetaHarness-family consumer — implicitly. Naming the family makes the dependency explicit, gives it a single resolver (as ADR-113 did for ruflo), and unlocks the assessment commands that ship in the same kernel.

---

## Decision

### D1. A single, cached MetaHarness resolver — mirroring `resolveBackend()` (ADR-112/113)

Add `src/pipeline/metaharness-resolver.ts` exporting `resolveMetaHarness(): Promise<MetaHarnessResolution>`, memoised once per process, structurally identical to `resolveBackend()`:

```typescript
export interface MetaHarnessResolution {
  /** How MetaHarness capabilities are reached. */
  tier: 'mcp' | 'cli' | 'none';
  /** Resolved MCP server id (tier=mcp) or binary/npx sentinel (tier=cli). */
  handle: string | null;
  /** Logged in the run manifest; surfaced on ADR-116 loud failure. */
  reason: string;
}
```

Resolution order (first available wins):

1. **`mcp`** — the `ruflo`/claude-flow MCP server is connected and exposes `metaharness_*` tools. Preferred: no subprocess spawn, shares the pipeline's existing MCP session.
2. **`cli`** — `npx metaharness` (or `AGENTICS_METAHARNESS_BIN`) resolves. Used when MCP is unavailable (headless/cron).
3. **`none`** — neither available. Per ADR-116, the dependent gate emits a loud-failure artifact; it never silently skips or fabricates a score.

The resolver performs filesystem/connection checks only (no code execution, no repo analysis) so it stays within the ADR-113 latency budget.

### D2. MetaHarness placement in the pipeline (the phase map)

| Insertion point | MetaHarness capability | Specified in | Blocking? |
|-----------------|------------------------|--------------|-----------|
| Pre-flight (optional, before Phase 1) | `genome <targetRepo>` — is the target repo harness-ready? | this ADR (D3) | Advisory |
| **Phase 5.5** (after Build, before ERP push) | `score` + `mcp-scan` + `threat-model` + `sbom` of the generated prototype | **ADR-118** | Gate (advisory→blocking, configurable) |
| Phase 6/7 (decision pack) | `sign` / `verify` — Ed25519 witness over the deliverable bundle | **ADR-119** | Non-blocking, provenance |

All MetaHarness outputs are written under `<runDir>/metaharness/` and copied into the deliverable pack (`.agentics/plans/`) alongside existing artifacts, and referenced from the Phase 7 executive summary.

### D3. Pre-flight genome is advisory, deterministic, and never blocks the run

When `AGENTICS_METAHARNESS_GENOME=1` (default off), a pre-flight step runs `genome` on the working repo and writes `<runDir>/metaharness/genome.json`. It never gates Phase 1 — a low genome score is *information for the exec brief*, not a stop condition, because the pipeline's job is to generate a decision, and "this repo is not harness-ready" is itself a decision-relevant finding.

### D4. Manifest carries a `metaharness` block; loud failure on `tier: 'none'` where a gate requires it

The run manifest gains:

```json
{
  "metaharness": {
    "tier": "mcp",
    "reason": "ruflo MCP connected; metaharness_* tools available",
    "genome": { "ran": true, "score": 72, "artifact": "metaharness/genome.json" },
    "gate":   { "ran": true, "score": 84, "mcp_scan": "pass", "artifact": "metaharness/scorecard.json" },
    "witness":{ "signed": true, "algorithm": "ed25519", "artifact": "metaharness/witness.json" }
  }
}
```

Consistent with ADR-116: when a *required* MetaHarness gate (ADR-118 blocking mode) cannot run because `tier: 'none'`, the phase emits a `METAHARNESS-FAIL-001.md` loud-failure artifact and contributes to `run_verdict`. In advisory mode, unavailability is recorded (`"ran": false, "reason": ...`) without affecting the verdict.

### D5. No new billed transport; no code execution

MetaHarness `genome`/`score`/`analyze`/`mcp-scan` are static analysis. This ADR introduces **no** billed provider connection and **no** execution of generated or target-repo code. `metaharness_evolve`/`gepa`/`learn` (which *can* spend/execute) are explicitly **out of scope** for the default pipeline and are gated behind separate, explicit opt-in flags — never invoked by `agentics ask`.

---

## Alternatives Considered

### Alternative 1: Keep MetaHarness as a manual, out-of-band tool the user runs themselves

Leave the pipeline as-is; document that users may run `npx metaharness score` on the generated prototype.

**Rejected because:** the pipeline's value proposition is a *single command* that goes from prompt to signed decision pack. Requiring a manual scoring step outside the pipeline breaks that proposition and means the exec brief (Phase 7) can never cite an assessment that ran as part of the same trace. The assurance layer must be inside the run to be trustworthy and reproducible.

### Alternative 2: Reimplement scoring/threat-modelling inside agentics-cli

Build native fit/cost/safety scoring rather than calling MetaHarness.

**Rejected because:** this duplicates a maintained kernel (the same anti-duplication rationale as ADR-001's agentic-flow integration). MetaHarness's scorecard (ADR-041 in its own repo), MCP threat scan, and Ed25519 witness are non-trivial and evolving; consuming them keeps agentics-cli an orchestration layer, not a re-implementation.

### Alternative 3: CLI-only resolution (no MCP tier)

Always shell out to `npx metaharness`.

**Rejected because:** `.mcp.json` already runs the `ruflo` MCP server that exposes `metaharness_*` tools in-session. Preferring the MCP tier avoids a cold `npx` spawn per gate and reuses the authenticated session — mirroring why ADR-112 prefers ruflo-local over a fresh subprocess. CLI remains the fallback for headless/cron contexts where MCP is absent.

---

## Consequences

### Benefits

1. **The family is named and resolvable.** ruflo (meta-harness), ruvector (memory), and MetaHarness (factory/assessment) become an explicit, single-resolver dependency instead of an implicit one.
2. **The decision pack gains an assurance layer.** Fit/cost/safety scores, an MCP threat scan, an SBOM, and an Ed25519 signature — the things a decision-maker needs to trust the pack — become first-class run artifacts.
3. **Consistent with existing patterns.** The resolver mirrors ADR-112/113; loud failure mirrors ADR-116; artifacts join the ADR-105 deliverable pack. No new architectural concept is introduced.
4. **No safety regression.** Static analysis only; no billed transport; no code execution; evolve/gepa/learn explicitly excluded from the default path.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MetaHarness MCP tools absent in headless/cron runs (interactively-authenticated MCP) | Medium | Low | CLI tier (`npx metaharness`) is the fallback; `tier: 'none'` is recorded and, in advisory mode, does not fail the run |
| Added wall-clock from genome/score/scan | Medium | Low | Phase 5.5 gate (ADR-118) is bounded and runs once; genome is opt-in; all are static/fast relative to LLM phases |
| Scope creep into evolve/gepa/learn (which can spend/execute) | Low | Medium | D5 explicitly excludes them from the default path behind separate opt-in flags |
| Version skew between `npx metaharness` and the MCP tool surface | Low | Low | Resolver records the resolved tier + version in the manifest for diagnosis; gates degrade gracefully |

### Performance Targets

| Metric | Target |
|--------|--------|
| `resolveMetaHarness()` p95 latency (no code exec) | < 200ms (same budget as ADR-112 `resolveBackend`) |
| Billed transports introduced | 0 |
| Generated/target code executed by MetaHarness in the default path | 0 (static analysis only) |
| Manifest `metaharness` block present on a full run | Required |

---

## Related Decisions

- **ADR-PIPELINE-112** — Model backend policy. The single-cached-resolver pattern this ADR mirrors for MetaHarness.
- **ADR-PIPELINE-113** — Ruflo PATH-independent resolution. The resolver design copied here; also establishes that ruflo (the meta-harness) is already the primary engine.
- **ADR-PIPELINE-116** — Loud failure over silent fallback. MetaHarness unavailability where a gate requires it is surfaced, never silently skipped.
- **ADR-PIPELINE-105** — Deliverable output guarantee. MetaHarness artifacts join the Phase 7 pack.
- **ADR-PIPELINE-118** — Phase 5.5 MetaHarness quality & security gate (this ADR's D2 placement, specified).
- **ADR-PIPELINE-119** — Ed25519 witness-signed decision pack (this ADR's D2 placement, specified).

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-07-06 | Nick Ruest | Initial proposal — name the MetaHarness family, single cached resolver (mcp→cli→none), pipeline phase map, manifest block, loud-failure alignment, static-only/no-billed-transport safety constraints |
