# ADR-PIPELINE-086: QE Kill-Switch and Gating Regression Policy

**Status:** Proposed
**Date:** 2026-04-18
**Priority:** HIGH — Operational safety for mandatory QE gating
**Originating Review:** AQE Integration Planning (plans/AQE_INTEGRATION.md §6 and §8)
**Builds on:** ADR-PIPELINE-080, ADR-PIPELINE-083 (Phase Capability Binding for QE), ADR-PIPELINE-084 (Observational-First Rollout)

## Context

ADR-PIPELINE-083 binds all 14 `quality_engineering` agents to phase 8 (Validation) as `mandatory_agents`. This means any QE agent returning `status: 502` halts the pipeline with exit 141. That is the right default for a gating phase, but it creates operational hazards:

1. **AQE upstream outage halts every pipeline run.** If the upstream AQE MCP server is down, every phase 8 invocation fails, every pipeline run halts. Without a kill-switch, the only recourse is an emergency PR to `ecosystem.graph.json` — minutes to hours of user-facing breakage.
2. **False-positive cascade.** A new AQE version with aggressive heuristics can push the false-positive rate above the 5% regression threshold (ADR-PIPELINE-084) in a single release, halting all pipelines until a regression PR lands.
3. **Customer-specific gating needs.** Some enterprise customers may need to bypass QE gating for time-sensitive runs (e.g., production hot-fix, compliance-deadline-driven deploys). Hard-coded gating doesn't serve them.

We need an operational kill-switch that:
- Works without code changes or deploys.
- Is auditable (every bypass is logged, correlated, and reported).
- Does not silently skip quality gates (bypass must be visible in outputs).
- Can be automatically triggered by measured regression conditions.
- Complements, not replaces, the ADR-084 regression procedure.

## Decision

### 1. Environment Variable Kill-Switch

Introduce `AGENTICS_QE_GATING` with three values:

| Value | Behavior | Intended use |
|-------|----------|--------------|
| `on` (default) | Phase 8 QE agents run as `mandatory_agents`; failures halt with exit 141 | Normal operation |
| `advisory` | Phase 8 QE agents run but failures are logged, not halting | Emergency bypass with oversight |
| `off` | Phase 8 QE agents skip entirely | Upstream outage, licensed-only runs, customer opt-out |

Default: `on`. Set at the CLI invocation boundary (env var, or `agentics config` stored setting). Respected by the phase 8 executor.

### 2. Bypass Logging and Visibility

Every bypass invocation MUST:
1. Emit a log line at `WARN` level: `"QE gating bypassed: mode=<value>, correlation_id=<id>, reason=<env_provided_or_auto>"`.
2. Stamp the pipeline `VALIDATION_REPORT.md` with a visible header:
   ```markdown
   > ⚠️ QE GATING BYPASSED
   > Mode: advisory
   > Reason: AQE upstream outage (auto-detected)
   > Timestamp: 2026-04-18T14:23:11Z
   > Correlation: abc-123
   ```
3. Write a record to the governance audit trail via the existing `governance-dashboard` domain, tagged `qe_gating_bypass`.
4. Emit a metric `qe_gating_bypass_total{mode, reason}` to observatory.

No silent bypass. Every skip is auditable.

### 3. Automatic Regression Triggers

The observatory pipeline monitors four triggers. When any fires, observatory sets `AGENTICS_QE_GATING=advisory` in the CLI's runtime config and notifies incident-manager:

| Trigger | Window | Threshold | Auto-action |
|---------|--------|-----------|-------------|
| Adapter crash rate | 24h rolling | >1% of invocations | Auto-flip to `advisory` |
| Adapter 502 rate | 1h rolling | >10% of invocations | Auto-flip to `advisory` |
| FP rate (sampled) | 7d rolling | >5% | Auto-flip to `advisory` |
| Upstream MCP unreachable | 15m continuous | 100% | Auto-flip to `off` |

Auto-flip is not silent: incident-manager opens an incident with playbook reference per ADR-PIPELINE-084.

### 4. Manual Override

On-call staff can manually set `AGENTICS_QE_GATING` via `agentics config set qe_gating <value> --reason "<text>"`. The CLI refuses to persist a bypass without a non-empty reason; the reason is included in all bypass logs and governance audit records.

Config changes flow to observatory within 30 seconds (via the standard config-change event stream).

### 5. Recovery Procedure

Recovery from `advisory` or `off` back to `on`:
1. Root cause identified and mitigated.
2. Observatory metrics demonstrate trigger conditions cleared for at least 2× the trigger window.
3. On-call manually sets `AGENTICS_QE_GATING=on` with reason `"recovered: <incident_id>"`.
4. Incident is closed via incident-manager; post-mortem filed.

No automatic recovery. Returning to gating requires human signoff.

### 6. Exit Code Semantics Under Bypass

When `AGENTICS_QE_GATING=advisory` and a QE agent returns 502:
- Phase 8 completes with status `completed_with_warnings` (new status, non-blocking).
- Pipeline continues.
- Exit code 0 if downstream phases succeed.
- `VALIDATION_REPORT.md` includes the failure details in a "Warnings" section.

When `AGENTICS_QE_GATING=off`:
- QE agents do not invoke at phase 8.
- Phase 8 completes with status `bypassed`.
- `VALIDATION_REPORT.md` is minimal (only non-QE validation output).
- Exit code 0 if downstream phases succeed.

When `AGENTICS_QE_GATING=on` and a QE agent returns 502:
- Phase 8 fails.
- Pipeline halts.
- Exit 141.
- `VALIDATION_REPORT.md` reports the failure.

### 7. Customer-Specific Opt-Out (Deferred)

Some customers may contractually require QE gating bypass. The mechanism for customer-specific gating is deferred to a future ADR, not implemented here. Current approach: such customers set `AGENTICS_QE_GATING=off` at their invocation level and accept the governance-audit trail.

### 8. Scope Limit

This ADR's kill-switch applies only to `quality_engineering` at phase 8. Other mandatory domains (if/when they appear at other phases) follow the same pattern but each gets its own env var: `AGENTICS_<DOMAIN>_GATING`. No global "skip all gates" env var exists; each domain opts in separately. This prevents accidental wholesale disabling.

## Implementation

1. Add `AGENTICS_QE_GATING` parsing to `src/config/env.ts` with three-value validation.
2. Phase 8 executor (`src/pipeline/phase5-build/` or wherever validation runs) checks the env var at entry:
   - `on` → existing mandatory invocation path
   - `advisory` → invoke but treat 502 as warning, not failure
   - `off` → skip QE invocations; write bypassed status to output
3. Bypass logging in `src/pipeline/phase5-build/validation-executor.ts` (new file if needed): WARN log + VALIDATION_REPORT header + governance audit write + observatory metric emit.
4. Observatory triggers implemented in the `observatory` domain repo: new alert rules for crash/502/FP/unreachable thresholds, each wired to a config-mutation action.
5. Config-mutation API: extend `agentics config set` to accept `qe_gating=<value>` with `--reason` required; validate reason is non-empty.
6. Recovery workflow documented in `docs/runbooks/qe-gating-recovery-086.md`.
7. Integration tests:
   - `tests/integration/pipeline/qe-gating-on-086.test.ts` — gating on, QE failure halts
   - `tests/integration/pipeline/qe-gating-advisory-086.test.ts` — advisory, QE failure warns
   - `tests/integration/pipeline/qe-gating-off-086.test.ts` — off, QE skipped, report bypassed
   - `tests/integration/pipeline/qe-gating-auto-regression-086.test.ts` — observatory trigger flips env

## Acceptance Criteria

1. `AGENTICS_QE_GATING=off agentics simulate <query>` runs the full pipeline skipping QE at phase 8; VALIDATION_REPORT.md contains the bypass header.
2. `AGENTICS_QE_GATING=advisory` with a deliberately-failing QE agent produces exit 0 and a warning in VALIDATION_REPORT.md.
3. `AGENTICS_QE_GATING=on` (default) with a deliberately-failing QE agent produces exit 141.
4. Observatory dashboard shows `qe_gating_bypass_total{mode}` metric incrementing on every bypass.
5. Governance audit trail contains an entry for every bypass with mode, reason, timestamp, correlation_id.
6. Synthetic crash-rate spike >1% over 24h window triggers auto-flip to `advisory` and opens an incident-manager ticket within 5 minutes.
7. Manual `agentics config set qe_gating off` without a `--reason` flag is rejected with exit code 2 (usage error).
8. `docs/runbooks/qe-gating-recovery-086.md` exists with a complete runbook for on-call staff.

## Consequences

### Positive

- Upstream AQE outages stop becoming ecosystem outages. On-call can bypass in seconds without code changes.
- False-positive explosions trigger automatic protection, not manual firefighting.
- Every bypass is auditable — governance posture preserved even during bypass.
- Pattern scales: any future mandatory domain gets its own kill-switch using the same shape.

### Negative

- Operational complexity increases. On-call staff must know the env var, the thresholds, the recovery procedure.
- The `advisory` mode is a deliberately silent-in-exit-code but loud-in-output state. Users who grep exit codes for pipeline quality will miss warnings. Mitigated by the conspicuous report header.
- Observatory auto-flip can misfire if thresholds are miscalibrated; thresholds must be tuned during ADR-084's advisory window.

### Neutral

- Customer-specific gating is deferred. For now, opt-out customers get the same `off` mode as outage bypass; differentiation comes later.

## Related

- **ADR-PIPELINE-080** (QE Domain Registration) — defines the gating this ADR modulates
- **ADR-PIPELINE-083** (Phase Capability Binding for QE) — establishes phase 8 as the gating anchor
- **ADR-PIPELINE-084** (Observational-First Rollout) — regression procedure this ADR's auto-triggers invoke
- **plans/AQE_INTEGRATION.md** §6 and §8 — source rollout and risk discussion
- **ADR-030** (Ecosystem Capability Graph) — bypass modifies runtime behavior without graph edits
