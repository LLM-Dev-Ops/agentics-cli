# QE Gating Recovery Runbook

**Source ADR:** ADR-PIPELINE-086 (QE Kill-Switch and Gating Regression Policy)
**Complement runbook:** `docs/runbooks/regression-playbook.md` (ADR-PIPELINE-084) — covers the broader regression procedure; this file drills into the QE-gating-specific controls.
**Audience:** On-call engineers, domain owners, release managers
**Last reviewed:** 2026-04-18

This runbook covers the mechanics of the `AGENTICS_QE_GATING` kill-switch. Use this when you need to **change the gating mode** quickly — during upstream outages, FP-rate spikes, or customer-specific bypasses — or **verify the current state**.

---

## 1. Mode Reference

| Mode | Effect at phase 8 | When to use |
|------|-------------------|-------------|
| `on` (default) | All 14 mandatory QE agents run. Any 502 halts the pipeline with exit code 141 via the Ruvector Acceptance Gate. | Normal operation. |
| `advisory` | All 14 agents run. 502s become warnings in `VALIDATION_REPORT.md`; pipeline continues with exit 0. | Emergency bypass when FP rate has spiked or adapter is unstable but still reachable. |
| `off` | No QE agents invoke. VALIDATION_REPORT still produced (without QE sections). Pipeline continues with exit 0. | Upstream AQE outage; licensed-only runs; customer opt-out. |

Every non-`on` mode stamps a visible `⚠️ QE GATING BYPASSED` header on the produced `VALIDATION_REPORT.md` with mode, source, reason, timestamp, correlation ID, and affected agents.

---

## 2. Config Precedence

The resolver in `src/config/qe-gating.ts` reads sources in order and the first one wins:

1. **`AGENTICS_QE_GATING` env var** — takes precedence over everything.
2. **Persisted file** at `~/.agentics/qe-gating.json` — for managed deployments where env is baked into the image.
3. **Default `on`** — when nothing is set.

The env var is best for local development and CI overrides; the persisted file is best for on-call responses in prod.

---

## 3. Setting the Mode

### 3.1 Env var (ephemeral, current shell only)

```bash
# Bypass gating for one command
AGENTICS_QE_GATING=advisory agentics simulate "your query"

# Or export for the session
export AGENTICS_QE_GATING=off
```

### 3.2 Persisted file (durable, on-call path)

There is no `agentics config set` command (deferred by scope of ADR-086). On-call staff write the file directly:

```bash
mkdir -p ~/.agentics
cat > ~/.agentics/qe-gating.json <<EOF
{
  "mode": "advisory",
  "reason": "on-call: upstream AQE FP rate 6.2%, incident INC-2026-XXXX",
  "applied_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "applied_by": "$(git config user.email 2>/dev/null || echo on-call)"
}
EOF
```

Required fields:
- `mode` — `on` | `advisory` | `off`
- `reason` — non-empty when mode is not `on` (enforced by loader validation)
- `applied_at` — ISO-8601 UTC timestamp
- `applied_by` — github handle / email (optional but recommended)
- `correlation_id` — optional, if responding to a specific incident

The resolver rejects `mode` values that are not in the allowed set and ignores invalid files (treated as "no persisted config").

### 3.3 Via CI/CD secrets

For managed prod environments, set `AGENTICS_QE_GATING` in the CI secrets panel and redeploy. Changes propagate on next pipeline run.

---

## 4. Verifying the Current Mode

No CLI command exists yet. Check directly:

```bash
# Which source is active?
if [ -n "$AGENTICS_QE_GATING" ]; then
  echo "mode=$AGENTICS_QE_GATING source=env"
elif [ -f ~/.agentics/qe-gating.json ]; then
  jq -r '. | "mode=\(.mode) source=persisted reason=\(.reason)"' ~/.agentics/qe-gating.json
else
  echo "mode=on source=default"
fi
```

In a pipeline run, the `VALIDATION_REPORT.md` header is authoritative — if it has no `⚠️ QE GATING BYPASSED` block, gating is on.

---

## 5. Recovery to `on`

After a regression is resolved (RCA done, root cause fixed, adapter redeployed):

```bash
# If env var was set:
unset AGENTICS_QE_GATING

# If persisted file was set:
rm ~/.agentics/qe-gating.json
# OR — write the explicit `on` record so the reason trail persists:
cat > ~/.agentics/qe-gating.json <<EOF
{
  "mode": "on",
  "reason": "recovered post-rollback: incident INC-2026-XXXX",
  "applied_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "applied_by": "$(git config user.email 2>/dev/null || echo on-call)"
}
EOF
```

Confirm with §4 verification.

---

## 6. Observability Checklist

When any bypass is active, these signals should appear downstream:

- [ ] `qe_gating_bypass` JSON log line on stderr (emitted by
  `src/pipeline/phase5-build/qe-gating-executor.ts#emitBypassLog`).
- [ ] `VALIDATION_REPORT.md` produced by the run begins with the
  `⚠️ QE GATING BYPASSED` header block (from `buildValidationReportBypassHeader`).
- [ ] Observatory's `qe_gating_bypass_total{mode, source}` counter increments
  (external, observatory-side wiring).
- [ ] Governance audit trail has an entry correlating the bypass to the
  `correlation_id` (external, governance-dashboard-side wiring).

If any of 1-2 are missing after a bypass-mode pipeline run, the CLI-side
instrumentation is broken — treat as a P1 infrastructure issue. Open an
incident and pin `AGENTICS_QE_GATING=on` until diagnosed (see §5).

---

## 7. What NOT to Do

- **Do not** omit `reason` when setting `advisory` or `off`. The loader
  ignores files with empty reasons (falls through to env/default), which
  silently undoes your bypass.
- **Do not** set `on` while the regression trigger is still active. Verify
  via §4 that the root cause is resolved first.
- **Do not** delete the persisted file mid-incident. The file IS the audit
  trail. If you need to flip modes, overwrite with a new record so the
  timeline is preserved in the audit log.
- **Do not** treat `advisory` as a permanent state. Every bypass must have a
  corresponding regression procedure per ADR-084 §4.

---

## 8. Programmatic Integration

Adapters and pipeline code use:

```ts
import { resolveQeGatingMode } from '../../config/qe-gating.js';
import { executePhase8Qe } from './qe-gating-executor.js';

const outcome = await executePhase8Qe(MANDATORY_QE_AGENTS, invokeAgent, {
  correlationId,
});

if (outcome.exitCode) process.exit(outcome.exitCode);
if (outcome.bypassRecord) reportHeader = buildValidationReportBypassHeader(outcome.bypassRecord);
```

The executor encapsulates the full decision tree — callers only need to
supply an `invokeAgent` callback and a correlation id.

---

## Related

- ADR-PIPELINE-086 (source)
- ADR-PIPELINE-083 (Phase Capability Binding for QE — the 14 mandatory agents this runbook gates)
- ADR-PIPELINE-084 (Observational-First Rollout — the broader regression procedure)
- `docs/runbooks/regression-playbook.md` — complement runbook for the general regression workflow
- `src/config/qe-gating.ts` — resolver implementation
- `src/pipeline/phase5-build/qe-gating-executor.ts` — phase-8 execution logic
