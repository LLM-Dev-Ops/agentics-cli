# ADR-PIPELINE-118: Phase 5.5 — MetaHarness Quality & Security Gate on the Generated Prototype

**Status:** Proposed
**Date:** 2026-07-06
**Authors:** Nick Ruest
**Priority:** HIGH — Phase 5 emits a full prototype (331 files, 12 bounded contexts, an ERP client, a server exposing 47–51 endpoints, and MCP-adjacent tool surfaces in the reference run) which Phase 6 then pushes to a live ERP surface **with no independent assessment of build-likelihood, tool safety, cost-per-run, or supply-chain composition.** MetaHarness exists to produce exactly this assessment as deterministic, no-execution static analysis. This ADR inserts a bounded Phase 5.5 gate between Build and ERP push that runs `score` + `mcp-scan` + `threat-model` + `sbom` on the generated prototype, writes the results as run artifacts, and feeds them into the Phase 7 executive brief. The gate is advisory by default and blocking under an explicit flag.
**Builds on:** ADR-PIPELINE-117 (MetaHarness resolution + placement — this ADR realises the Phase 5.5 slot from its D2 map), ADR-PIPELINE-116 (loud failure — a required gate that cannot run emits `METAHARNESS-FAIL-001.md`), ADR-PIPELINE-105 (deliverable guarantee — scorecard/threat-model/SBOM join the pack), ADR-PIPELINE-101 (structural harness checks — this gate is the security/quality analogue of the existing structural checks).

---

## Context

### What Phase 5 emits and why it needs a gate

The reference run's Phase 5 produced a deployable service: `project/src/server/routes.ts` (97KB), an `erp-client/` (client/mapper/retry/types), 12 bounded-context adapters, IAM helpers, and a full test suite. Phase 6 registered 47–51 endpoints to a live ERP surface. Between "here is generated code" and "push it to a live enterprise system," the pipeline currently performs only **structural** checks (ADR-101: does the file parse, does the ADR have the right sections). It performs **no**:

- **build-likelihood / fit score** — will this actually compile and run, and does it fit the stated intent?
- **tool-safety / MCP threat scan** — do the exposed tool/endpoint surfaces have injection, over-permission, or exfiltration risks?
- **cost-per-run estimate** — what will operating this prototype cost?
- **SBOM** — what is the dependency/supply-chain composition being pushed?

These are precisely the four axes of the MetaHarness scorecard ("how well a harness fits, how likely it is to build, how safe the tools are, and the rough cost per run") plus its `mcp-scan`, `threat-model`, and `sbom` commands.

### Why between Phase 5 and Phase 6 specifically

The gate must run **after** the artifact exists (Phase 5 output) and **before** the irreversible-ish outward action (Phase 6 pushes to a live ERP surface — an external side effect). A scan that runs after the push is forensics, not a gate. Phase 5.5 is the last point where a low tool-safety score can stop or flag the push before it reaches the enterprise system.

---

## Decision

### D1. A bounded Phase 5.5 gate runs four MetaHarness assessments on the prototype

After Phase 5 (Build) completes with a materialised project directory, and before Phase 6 (ERP push), run — via the ADR-117 resolver (`mcp` preferred, `cli` fallback):

| Assessment | MetaHarness capability | Output artifact |
|------------|------------------------|-----------------|
| Fit / build / cost / safety scorecard (0–100) | `score <projectDir>` / `metaharness_score` | `metaharness/scorecard.json` |
| MCP / tool-surface threat scan | `mcp-scan <projectDir>` / `metaharness_mcp_scan` | `metaharness/mcp-scan.json` |
| Threat model | `threat-model` / `metaharness_threat_model` | `metaharness/threat-model.md` |
| SBOM (SPDX-2.3) | `sbom` / `metaharness_sbom` | `metaharness/sbom.spdx.json` |

The target is the Phase 5 project directory (`<runDir>/phase5/project` or the Phase 6 `project/` if already assembled). All four are static, no-execution analyses (ADR-117 §D5). The gate runs **once** per run.

### D2. The gate is advisory by default, blocking under `AGENTICS_METAHARNESS_GATE=block`

| Mode (`AGENTICS_METAHARNESS_GATE`) | Behaviour |
|-----------------------------------|-----------|
| `off` | Gate skipped entirely (recorded in manifest as `ran: false`). |
| `advisory` (**default**) | All four assessments run; results recorded and surfaced in the exec brief; the pipeline proceeds to Phase 6 regardless of score. |
| `block` | The pipeline proceeds to Phase 6 **only if** `scorecard.overall >= AGENTICS_METAHARNESS_MIN_SCORE` (default 60) **and** `mcp-scan` reports no `critical` findings. Otherwise Phase 6 is `blocked-by-gate` and the run verdict reflects it. |

Default advisory honours the pipeline's decision-support purpose (surface the risk, let the human decide) while `block` supports CI/governed contexts that must not push an unsafe prototype.

### D3. Gate results are first-class artifacts and feed Phase 7

- All four artifacts are written under `<runDir>/metaharness/` and copied into `.agentics/plans/` with the rest of the deliverable pack (ADR-105).
- The Phase 7 executive summary and risk-assessment deliverables **cite** the scorecard (overall score, the four sub-scores) and the top `mcp-scan`/`threat-model` findings. A decision pack that recommends "go" now carries the independent safety/fit evidence for that recommendation.
- The manifest `metaharness.gate` block (ADR-117 §D4) records `{ ran, score, sub_scores, mcp_scan: pass|warn|critical, artifacts[] }`.

### D4. Loud failure when a *required* gate cannot run

Per ADR-116: in `block` mode, if `resolveMetaHarness()` returns `tier: 'none'` (neither MCP nor CLI available), the gate cannot make a safety determination. It emits `<runDir>/metaharness/METAHARNESS-FAIL-001.md` (reason, resolver result, recovery: install/authenticate MetaHarness), Phase 6 is `blocked-by-gate`, and the run verdict is `degraded` (build succeeded; safety unverified). In `advisory` mode, unavailability is recorded (`ran: false, reason`) and the run proceeds — the absence of a score is itself noted in the exec brief.

### D5. The gate never mutates the prototype and never executes it

Consistent with ADR-117 §D5, all four commands are static analyses run against files on disk (`execution: disabled`). The gate reads the project directory; it does not `npm install`, run tests, or start the server. This keeps Phase 5.5 fast, deterministic, and side-effect-free.

---

## Alternatives Considered

### Alternative 1: Fold the assessment into Phase 6

Run `score`/`mcp-scan` as the first step inside the Phase 6 command.

**Rejected because:** Phase 6's contract is "register the ERP surface." Mixing a quality/security gate into it conflates two concerns and makes the gate invisible to runs that stop before Phase 6 (e.g. `--depth` variants). A distinct Phase 5.5 keeps the gate legible in the manifest and the phase table, and lets it run even when ERP push is disabled.

### Alternative 2: Blocking by default

Make `block` the default so no unsafe prototype ever proceeds.

**Rejected because:** the pipeline is decision-support, not a deployment gate — its output goes to a *human* who reaches a go/no-go decision (per the project README and ADR-105). A hard block by default would suppress the very risk information the human needs to weigh. `block` is available for CI/governed pipelines that opt in.

### Alternative 3: Only run the scorecard, skip mcp-scan/threat-model/sbom

Minimise wall-clock by running just `score`.

**Rejected because:** the four assessments answer different decision questions (fit vs. tool-safety vs. attack surface vs. supply chain). The scorecard alone cannot tell a decision-maker whether the 47 pushed endpoints have an injection risk. All four are static and fast; the marginal cost is small relative to the LLM phases, and the marginal decision value is high.

---

## Consequences

### Benefits

1. **The go/no-go pack carries independent evidence.** A "go" recommendation is backed by a fit/build/cost/safety score, a tool-surface threat scan, a threat model, and an SBOM — not just generated code.
2. **The gate is where it can act.** Between Build and the live ERP push, a critical tool-safety finding can stop or flag the push before it reaches the enterprise system.
3. **Advisory-by-default respects the product.** Risk is surfaced, not suppressed; `block` is one env var away for governed contexts.
4. **Reuses the ADR-117 resolver and ADR-105 pack.** No new plumbing; artifacts flow into the existing deliverable pipeline and exec brief.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Added wall-clock before ERP push | Medium | Low | Four static analyses, run once, bounded; fast relative to the LLM phases; `off` disables entirely |
| False-positive `critical` in `block` mode stalls a legitimate push | Low | Medium | Default is `advisory` (never blocks); `block` is explicit opt-in; findings are recorded for override review |
| MetaHarness unavailable in `block` mode | Medium | Medium | ADR-116 loud failure: `METAHARNESS-FAIL-001.md`, Phase 6 `blocked-by-gate`, verdict `degraded` — never a silent pass |
| Scorecard/scan schema drift across MetaHarness versions | Low | Low | Gate stores raw artifacts verbatim and reads only the documented top-level fields; unknown fields ignored |

### Performance Targets

| Metric | Target |
|--------|--------|
| Phase 5.5 gate wall-clock (static, tier=mcp) | < 30s typical |
| Prototype files mutated by the gate | 0 |
| Prototype code executed by the gate | 0 |
| Runs where a `block`-mode gate silently passes without a score | 0 (loud failure enforced) |
| Phase 7 exec brief citing the scorecard when the gate ran | Required |

---

## Related Decisions

- **ADR-PIPELINE-117** — MetaHarness resolution + placement. This ADR realises the Phase 5.5 slot from its phase map and uses its resolver + manifest block.
- **ADR-PIPELINE-116** — Loud failure. A required gate that cannot run emits `METAHARNESS-FAIL-001.md`.
- **ADR-PIPELINE-105** — Deliverable guarantee. Scorecard/threat-model/SBOM join the Phase 7 pack.
- **ADR-PIPELINE-101** — Structural harness checks. This gate is the security/quality analogue running on the built prototype.
- **ADR-PIPELINE-119** — Witness signing. The signed bundle (ADR-119) includes the scorecard and SBOM produced here.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-07-06 | Nick Ruest | Initial proposal — Phase 5.5 gate (score + mcp-scan + threat-model + sbom), advisory-default/block-opt-in modes, artifacts into the ADR-105 pack and Phase 7 brief, ADR-116 loud failure in block mode, static/no-execution constraints |
