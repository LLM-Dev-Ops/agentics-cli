# Domain Promotion Process

**Source ADR:** ADR-PIPELINE-084 (Observational-First Rollout Policy)
**Status:** Active
**Audience:** Domain owners, adapter-repo maintainers, on-call engineers

Every new domain capability — infrastructure domain added to
`docs/ecosystem.graph.json`, or a binding that moves from `optional_agents` to
`mandatory_agents` on a phase — follows the three-stage promotion model below.
Promotions are earned by measurement, not asserted. Regressions are procedural,
not panicked.

This policy applies to **future changes**. Existing domains at their current
bindings are grandfathered; any *future* change to their bindings follows this
process.

---

## 1. Three-Stage Promotion Model

| Stage | Binding shape | User-visible impact | Minimum duration | Promotion criteria |
|-------|---------------|---------------------|------------------|---------------------|
| **Observational** | Not bound to any phase — invokable only on-demand via `agentics agents invoke` | None (opt-in) | 7 days | 20+ successful invocations; zero adapter crashes |
| **Advisory** | `optional_agents` on one or more phases | Runs when problem tags match; failures logged, non-blocking | 30 days | False-positive rate < 5% over the window; P95 latency within tier cap |
| **Gating** | `mandatory_agents` on one or more phases | Always invokes when phase runs; failures halt pipeline (exit 141) | Permanent (regression-protected) | — (terminal stage) |

### 1.1 Stage Binding Shape Rules

- **Observational:** Domain is registered in `ecosystem.graph.json` but NOT
  referenced in any phase capability's `mandatory_agents[]` or
  `optional_agents[]`. Invocation is explicit and user-initiated.
- **Advisory:** Domain agents appear in one or more phases' `optional_agents[]`.
  They fire only when the capability classifier matches the phase (which
  happens via tag overlap with the user's query).
- **Gating:** Domain agents appear in one or more phases' `mandatory_agents[]`.
  They fire on every pipeline run that reaches those phases. A failure from
  any mandatory agent halts the phase and the pipeline (Ruvector Acceptance
  Gate, exit 141).

---

## 2. False-Positive Rate

A **false positive** for a domain agent is any finding that:

1. The agent marked as blocking (`severity: "critical"`, `status: "failed"`, or
   equivalent), AND
2. A human reviewer later labels `valid=false` — meaning noise, redundant with
   another finding, or a legitimate design choice the agent incorrectly
   flagged.

### 2.1 Sampling

During the advisory window:

- **Weekly cadence:** `tools/promotion-sampler.ts` draws a 10% random sample of
  findings emitted by the domain, with a floor of 30 and ceiling of 200
  findings per week.
- **Review:** A domain expert (adapter owner or their delegate) labels each
  sampled finding `valid` or `false-positive` in the CSV.
- **Computation:** FP rate = (FP count in sample) / (total sampled). Projected
  to the window with standard-error reporting.

### 2.2 Insufficient-Sample Rule

If sampled volume is < 30 findings/week for 3 consecutive weeks, the domain
stays in advisory. Not enough signal to promote responsibly. Options:
- Extend the advisory window.
- Relax activation tags so more user queries trigger the domain.
- Keep it in advisory indefinitely — not every domain needs to become gating.

### 2.3 FP-rate Definition Is Per-Binding

FP rate is computed per (domain, phase) pair. A domain may be gating on one
phase and advisory on another with different FP rates.

---

## 3. Promotion Procedure

### 3.1 Observational → Advisory

**Prerequisites:**
- ≥ 7 days since registration.
- Observatory telemetry shows ≥ 20 successful invocations and 0 adapter crashes.
- Adapter bundle passes conformance checks (ADR-PIPELINE-081).

**Procedure:**
1. Adapter owner opens a PR editing `docs/ecosystem.graph.json` to add the
   domain's agents to the target phases' `optional_agents[]`.
2. PR includes:
   - ADR update reflecting the binding change (may be a new sub-ADR or edit to
     the domain's implementation ADR, e.g., ADR-PIPELINE-083).
   - CHANGELOG entry using `docs/templates/promotion-changelog.md`.
   - Observatory metrics screenshot or exported query showing the 20+
     invocation prerequisite.
3. CI runs `promotion-guard.yml` — ensures ADR + CHANGELOG accompany graph
   changes (this promotion is to advisory, so the guard treats it as
   non-mandatory and only checks for documentation).
4. Standard code review; two reviewers: domain owner + platform owner.
5. Merge → deploy via normal release process.

### 3.2 Advisory → Gating

**Prerequisites:**
- ≥ 30 days in advisory.
- Measured FP rate < 5% over the window, across all sampled weeks.
- P95 latency within the tier cap defined in ADR-PIPELINE-081 §5 (300 s for
  gating).
- Kill-switch env var wired (ADR-PIPELINE-086 pattern:
  `AGENTICS_<DOMAIN>_GATING`).

**Procedure:**
1. Adapter owner opens a PR editing `docs/ecosystem.graph.json` to move agents
   from `optional_agents[]` to `mandatory_agents[]` on the target phases.
2. PR includes:
   - ADR update promoting the binding.
   - CHANGELOG entry with measured FP rate and P95 latency.
   - Observatory sampler CSVs for the full window (4+ weeks).
3. CI runs `promotion-guard.yml`:
   - Detects the optional→mandatory move.
   - Requires matching changes under `docs/adrs/` AND `CHANGELOG.md`.
   - Fails the PR if either is missing.
4. Code review; three reviewers required: domain owner, platform owner,
   on-call lead (since on-call inherits the kill-switch).
5. Runbook update: `docs/runbooks/` must reference the new kill-switch env var.
6. Merge → deploy to dev → smoke → staging → prod per release procedure.

---

## 4. Regression Procedure

Gating can regress to advisory when:

- FP rate exceeds 5% over any rolling 7-day window, OR
- Adapter crash rate exceeds 1% of invocations over 24 hours, OR
- Adapter 502 rate exceeds 10% of invocations over 1 hour, OR
- Upstream MCP server is unreachable for > 15 min continuously, OR
- Incident-manager flags a manual regression.

### 4.1 Immediate Response (Automatic or On-Call)

1. Observatory auto-trigger flips the relevant kill-switch env var to
   `advisory` (or `off` for upstream outages).
2. If automatic: on-call is paged via incident-manager. If manual: on-call
   takes the `agentics config set <domain>_gating <value> --reason "..."` action.
3. In both cases, bypass is logged to governance audit trail and emits a
   metric. The pipeline continues; mandatory agent failures become warnings.

### 4.2 Recovery (< 24 hours)

1. PR editing `docs/ecosystem.graph.json` to move the domain's agents from
   `mandatory_agents[]` back to `optional_agents[]`.
2. PR includes:
   - Pointer to the incident report in incident-manager.
   - CHANGELOG entry using `docs/templates/regression-changelog.md`.
   - ADR update flipping the binding status.
3. CI runs `promotion-guard.yml` — passes because regression is documented.
4. Merge with emergency-change label; single reviewer (on-call lead).

### 4.3 Root Cause Analysis (< 7 days)

- Post-mortem filed in incident-manager.
- RCA identifies whether upstream bug, adapter bug, threshold miscalibration,
  or domain-scope mismatch caused the regression.
- Follow-up work (fix, re-sample, re-promote) tracked in the RCA ticket.

### 4.4 Re-Promotion

Re-promotion follows the standard advisory → gating procedure (§3.2). The
previous gating period does not count toward the 30-day minimum — the 30-day
clock restarts from the post-regression advisory deployment.

---

## 5. Required Metrics

Every domain adapter MUST export the following metrics to the observatory
pipeline via standard envelope metadata (ADR-PIPELINE-081 §8):

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `agent_invocations_total` | counter | domain, agent, status | Per-agent invocation count |
| `agent_invocation_duration_ms` | histogram | domain, agent | Latency distribution |
| `agent_invocation_status` | counter | domain, agent, status (200/502) | Success/error breakdown |
| `agent_findings_total` | counter | domain, agent, severity | Finding emission rate |
| `agent_findings_fp_marked` | counter | domain, agent | Populated by sampler during review |
| `agent_timeout_total` | counter | domain, agent, tier | Timeout-cap hits |

These flow through the existing observatory pipeline — no new telemetry path.

---

## 6. Documentation Requirements

Every promotion AND regression MUST produce:

1. **CHANGELOG entry** using the matching template in `docs/templates/`. No
   silent changes.
2. **ADR update** — either editing the domain's implementation ADR (e.g.,
   ADR-PIPELINE-083 for QE) or a new sub-ADR. The ADR's "Status" field and
   the binding descriptions must reflect the new stage.
3. **Observatory dashboard refresh** — the domain's entry on the "Domain
   Promotion Status" panel shows the new stage within 60 seconds of deploy.
4. **Runbook touchpoints** — if the promotion affects on-call response
   (adding a new kill-switch, new escalation path), the relevant runbook in
   `docs/runbooks/` is updated in the same PR.

---

## 7. Exceptions

### 7.1 Pre-Declared Exceptions

Some promotions intentionally bypass the standard 30-day advisory window
because the phase's purpose IS the domain's function. The only current
exception is:

- **quality_engineering on phase 8 (validation)**: Phase 8 IS the validation
  phase; advisory-only QE at validation defeats the purpose. Accelerated
  promotion to gating per ADR-PIPELINE-083 §5 and ADR-PIPELINE-084 §7.

Future pre-declared exceptions must be named in the ADR that establishes the
binding. Silent exceptions are not permitted.

### 7.2 Emergency Additions

If a regulatory, compliance, or security emergency requires bypassing the
advisory window, the adapter owner opens a PR labeled `emergency-promotion`.
Required:

- Written justification from an executive sponsor.
- Time-limited commitment: emergency gating is valid for 30 days; after that,
  the binding either regresses or graduates via the standard process.
- Incident-manager ticket tracking the emergency.

Emergency promotions are audited quarterly.

---

## 8. Anti-Patterns (Don't)

- **Self-promotion.** Same PR that registers the domain AND binds it as
  `mandatory_agents`. Register observational first.
- **Metric-free claims.** Promotion PR with no observatory data. The
  promotion-guard CI rejects this.
- **Silent regression.** Rolling back a binding without CHANGELOG + ADR
  update. The promotion-guard catches the CHANGELOG; reviewers must catch
  the ADR.
- **Threshold drift.** Domain owner reduces FP-rate threshold from 5% to 10%
  to pass promotion. Thresholds are policy; changes require an ADR amendment.
- **Single-phase audit.** Measuring FP rate on one phase and promoting to
  gating on multiple phases. FP rate is per-binding (§2.3).

---

## Related

- ADR-PIPELINE-080 (Quality Engineering Domain) — first consumer of this process
- ADR-PIPELINE-083 (Phase Capability Binding for QE) — the bindings this process governs
- ADR-PIPELINE-086 (Kill-Switch & Gating Regression) — operational mechanism
- `docs/templates/promotion-changelog.md`
- `docs/templates/regression-changelog.md`
- `docs/runbooks/regression-playbook.md`
- `tools/promotion-sampler.ts`
- `.github/workflows/promotion-guard.yml`
