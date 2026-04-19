# ADR-PIPELINE-084: Observational-First Rollout Policy for New Domain Capabilities

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** MEDIUM — Generalizable rollout policy
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md §6)
**Builds on:** ADR-PIPELINE-080, ADR-PIPELINE-083 (Phase Capability Binding for QE)

## Context

Registering a new domain capability in `ecosystem.graph.json` and immediately binding it as `mandatory_agents` on a phase creates risk: an unproven capability that false-positives in the 5-20% range can halt every pipeline run, drowning users in noise and forcing emergency rollbacks.

Current practice has been ad-hoc: whoever adds a domain chooses the binding mode. There is no policy requiring measurement before promotion. When AQE integrates at phase 8 as mandatory (per ADR-PIPELINE-083), we need a formal promotion policy so:
- Mandatory bindings are earned, not assumed.
- Regressions from mandatory back to optional are procedural, not panicked.
- The same policy covers future domain additions (security-focused products, alternative test frameworks, observability upgrades).

This ADR defines that policy.

## Decision

### 1. Three-Stage Promotion Model

Every new domain capability follows three stages before reaching mandatory/gating binding:

| Stage | Binding | User-visible impact | Duration gate | Promotion criteria |
|-------|---------|---------------------|---------------|---------------------|
| **Observational** | Not bound to any phase | Agents invokable only via `agentics agents invoke` | Minimum 7 days | 20+ successful invocations; zero adapter crashes |
| **Advisory** | `optional_agents` on target phases | Invokes when tags match; failures logged, non-blocking | Minimum 30 days | False-positive rate <5% over the window; P95 latency within tier cap |
| **Gating** | `mandatory_agents` on one or more phases | Always invokes; failures halt pipeline | Permanent (regression-protected) | — (terminal stage) |

### 2. False-Positive Rate Definition

A **false positive** for a QE/domain agent is an agent output that:
- Marks a finding as blocking (`severity: "critical"` or equivalent), AND
- Is determined by human review to not be a real blocker (noise, redundant with another finding, or a legitimate design choice incorrectly flagged).

The denominator is **total findings emitted** in the window. FP rate = (FP findings) / (total findings).

Human review happens during the advisory stage via a lightweight sampling process:
- Weekly: sample 10% of findings emitted (minimum 30 per week, maximum 200).
- Review labels each as `valid` or `false-positive`.
- FP rate computed from the sample, projected to the window.

If sample size is insufficient (<30 findings/week for 3 consecutive weeks), the domain stays in advisory — not enough signal to promote responsibly.

### 3. Promotion Procedure

From observational → advisory:
1. Adapter owner confirms 7-day operational window with zero crashes and 20+ successful invocations (from observatory telemetry).
2. Owner files a promotion PR editing `ecosystem.graph.json` to add the optional bindings.
3. ADR update: the domain's implementation ADR (e.g., ADR-083 for QE) flips `status` of the relevant phase bindings from "observational" to "advisory".
4. Deployment via normal release process.

From advisory → gating:
1. 30-day window has elapsed since advisory deployment.
2. Observatory reports FP rate <5% sustained for the window; P95 latency within tier cap.
3. Owner files a promotion PR editing `ecosystem.graph.json` to move agents from `optional_agents` to `mandatory_agents` on the target phase.
4. ADR update and CHANGELOG entry noting the gating change, including measured FP rate.
5. Kill-switch env var (per ADR-PIPELINE-086) must be wired before deployment.

### 4. Regression Procedure

Gating can regress to advisory when:
- FP rate exceeds 5% over any rolling 7-day window, OR
- Adapter crash rate exceeds 1% of invocations over 24 hours, OR
- Incident-manager triggers a manual regression.

Regression procedure:
1. Incident-manager (or on-call) flips the kill-switch env var to `off` → gating bypass takes effect immediately.
2. Within 24 hours: PR editing `ecosystem.graph.json` to move the agents from `mandatory_agents` back to `optional_agents`.
3. Root cause analysis within 7 days.
4. Re-promotion follows the standard advisory → gating procedure.

Regression is not a failure state; it is the policy working correctly.

### 5. Metrics and Telemetry

Required metrics per domain, exported by the adapter and ingested by `observatory`:
- `agent_invocations_total{domain, agent}` — counter
- `agent_invocation_duration_ms{domain, agent}` — histogram
- `agent_invocation_status{domain, agent, status}` — counter with labels 200/502
- `agent_findings_total{domain, agent, severity}` — counter
- `agent_findings_fp_marked{domain, agent}` — counter populated by human review sampling

These flow to the existing observatory telemetry pipeline via the standard envelope metadata — no new telemetry path.

### 6. Documentation Requirements

Every promotion and regression MUST produce:
- A CHANGELOG entry with timestamp, domain, from-stage, to-stage, and measured FP rate (if applicable).
- An updated domain ADR reflecting the new binding status.
- If regression: an incident report in the `incident-manager` domain.

No silent promotions. No silent regressions.

### 7. Application to QE Rollout

The QE-specific timeline from `plans/AQE_INTEGRATION.md` §6 is reconciled with this policy:

| Week | QE Stage | Binding | Policy stage |
|------|----------|---------|--------------|
| 1 | Adapter scaffold | None | Pre-observational (development) |
| 2 | Domain registered | None (invokable ad-hoc) | Observational |
| 3 | Phase 3, 5, 6 bindings | `optional_agents` | Advisory |
| 4-7 | Phase 7 bindings added; Phase 8 shadow mode | `optional_agents` (phase 7); shadow (phase 8) | Advisory (phase 7); observational-on-critical-path (phase 8) |
| 8+ | Phase 8 mandatory; phase 9 advisory | `mandatory_agents` (phase 8); `optional_agents` (phase 9) | Gating (phase 8); Advisory (phase 9) |
| 12+ | Phase 9 promoted | `mandatory_agents` (phase 9) | Gating |

Phase 8's promotion to gating is deliberately accelerated (week 4 vs. the general 30-day rule) because phase 8 IS the validation phase — advisory-only QE at validation would defeat the purpose. This exception is pre-declared here rather than handled ad-hoc.

## Implementation

1. Create `docs/processes/domain-promotion.md` documenting the three-stage model, promotion procedure, regression procedure, and documentation requirements.
2. Template CHANGELOG entries: `docs/templates/promotion-changelog.md`, `docs/templates/regression-changelog.md`.
3. Observatory dashboard: add a "Domain Promotion Status" panel listing every domain with its current stage, days at current stage, and FP rate (where measured).
4. CI check: a new workflow `.github/workflows/promotion-guard.yml` that fails if an `ecosystem.graph.json` PR moves agents to `mandatory_agents` without an accompanying ADR update and CHANGELOG entry.
5. Sampling tooling: `tools/promotion-sampler.ts` that queries observatory, draws the weekly 10% sample, and emits a CSV for human review.
6. Runbook: `docs/runbooks/regression-playbook.md` for on-call staff to execute the regression procedure under incident conditions.

## Acceptance Criteria

1. `docs/processes/domain-promotion.md` exists and is referenced from every domain ADR's rollout section.
2. An ecosystem.graph.json PR moving agents to `mandatory_agents` without a matching ADR update fails the `promotion-guard` workflow.
3. The observatory dashboard shows QE domain status progressing through observational → advisory → gating stages during the rollout.
4. A synthetic regression test (intentionally flipping the kill-switch) succeeds: gating is bypassed within 30 seconds of env var change.
5. The weekly 10% sample is produced for at least 4 consecutive weeks during QE advisory phase; the FP rate calculation is reproducible from the sample CSV.
6. ADR-PIPELINE-080, -083 each reference this ADR for promotion policy.

## Consequences

### Positive

- Promotions become evidence-based, not opinion-based. "It works on my machine" does not qualify a domain for gating.
- Regressions become procedural, not chaotic. On-call staff have a runbook and a kill-switch.
- Policy is reusable across future domain additions — no per-domain process invention.
- User trust is preserved: gating means "we measured this is reliable," not "someone thought this was a good idea."

### Negative

- Slower rollout for new domains. 30-day advisory window before gating is a deliberate brake.
- Human review for FP-rate sampling costs ~1-2 hours/week of engineering time per domain in advisory. Scales linearly with active rollouts.
- Dashboard and sampling tooling are additional infrastructure to maintain.

### Neutral

- Policy is backward-compatible: existing domains (shield, observatory, etc.) are grandfathered at their current bindings. Future *changes* to their bindings follow this policy.

## Related

- **ADR-PIPELINE-080** (QE Domain Registration) — first domain subject to this policy
- **ADR-PIPELINE-083** (Phase Capability Binding for QE) — the QE-specific bindings this policy governs
- **ADR-PIPELINE-086** (Kill-Switch and Gating Regression) — the operational mechanism enabling regression
- **ADR-030** (Ecosystem Capability Graph) — the schema promotions modify
- **plans/AQE_INTEGRATION.md** §6 — source rollout timeline
