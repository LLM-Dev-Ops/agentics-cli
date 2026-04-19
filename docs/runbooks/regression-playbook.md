# Regression Playbook — Domain Gating Rollback

**Source ADR:** ADR-PIPELINE-084 §4 (regression procedure), ADR-PIPELINE-086 (kill-switch mechanics)
**Audience:** On-call engineers, domain owners
**When to use:** A domain binding has breached a regression trigger (FP rate, crash rate, 502 rate, upstream outage) and the kill-switch has flipped — auto or manual.

This runbook has three phases: **Stabilize**, **Investigate**, **Recover**. Do them in order. Do not skip to Recover without completing Stabilize.

---

## 0. Pre-Flight

Before doing anything, confirm:

- [ ] You are on-call for the affected domain's rotation (check incident-manager).
- [ ] You have the right env vars and GCP / kube context for the environment experiencing the regression (prod vs. staging).
- [ ] You have access to the governance-dashboard audit trail to record bypass actions.

If any of these is no, escalate to a teammate who does.

---

## 1. Stabilize (T+0 to T+10 min)

### 1.1 Confirm the trigger

Open the observatory dashboard. Confirm which trigger fired:

| Trigger | What to check | Expected sign |
|---------|---------------|---------------|
| FP rate > 5% / 7d | `agent_findings_fp_marked / agent_findings_total` (7d rolling) | Line above 0.05 threshold |
| Crash rate > 1% / 24h | `agent_crashes_total / agent_invocations_total` (24h) | Line above 0.01 threshold |
| 502 rate > 10% / 1h | `agent_invocation_status{status=502} / total` (1h) | Line above 0.10 threshold |
| Upstream unreachable > 15m | MCP health endpoint | Red for 15+ continuous minutes |
| Manual regression | incident-manager ticket comment | Ticket references manual trigger |

If the trigger is ambiguous or you suspect false alarm, page the domain owner
before bypassing. If clear-cut, proceed.

### 1.2 Apply the kill-switch

**If auto-triggered (automatic flip already happened):**
- Verify env var is set: `agentics config get <domain>_gating` should return `advisory` or `off`.
- Proceed to §1.3.

**If manual bypass is needed:**
```bash
agentics config set <domain>_gating advisory --reason "on-call: <trigger>, incident <INC-ID>"
```

For upstream outages, use `off` instead of `advisory`:
```bash
agentics config set <domain>_gating off --reason "on-call: upstream MCP unreachable, incident <INC-ID>"
```

The CLI rejects a bypass without a non-empty `--reason`.

### 1.3 Verify the bypass is live

Within 30 seconds of the config change:
- `agentics config get <domain>_gating` returns the new value.
- Observatory dashboard's "Active Bypasses" panel lists the new entry.
- Any in-flight pipeline runs log a WARN-level `<domain> gating bypassed` line.

If not live in 60 seconds: escalate to platform on-call (config propagation broken — treat as P1).

### 1.4 Page the domain owner (if not already)

Page the adapter owner via incident-manager. They take lead on investigation
while you hold stabilization.

---

## 2. Investigate (T+10 min to T+4 hours)

### 2.1 Classify the failure mode

From observatory + adapter logs, determine which applies:

1. **Upstream bug** — the wrapped MCP server returned invalid or over-zealous findings.
2. **Adapter bug** — the adapter's envelope, timeout, or exclusion logic misbehaved.
3. **Threshold miscalibration** — FP rate was computed against too small a sample, or the threshold was set too aggressively in the first place.
4. **Domain-scope mismatch** — the agents are flagging things they shouldn't (e.g., QE flagging security issues — see ADR-082 for boundary).
5. **Flaky signal** — intermittent infra issue (GCP region, vendor, rate limit) not truly domain-related.

Log the classification in the incident-manager ticket.

### 2.2 Preserve evidence

Before any rollback:
- Snapshot the last 7 days of observatory telemetry for the domain.
- Export the finding sample that drove the FP-rate alert (run `tools/promotion-sampler.ts` with the alert's window).
- Capture adapter logs from GCP Cloud Functions (or local-mode logs if relevant).
- Save the pipeline run's `VALIDATION_REPORT.md` outputs from the past window.

These go into the incident ticket as attachments.

---

## 3. Recover (T+4 hours to T+24 hours)

### 3.1 Open the regression PR

Use `docs/templates/regression-changelog.md` to draft the CHANGELOG entry.

PR contents:
- Edit `docs/ecosystem.graph.json` — move agents from `mandatory_agents[]` back to `optional_agents[]` on affected phases.
- Edit the domain's implementation ADR (e.g., ADR-PIPELINE-083 for QE) — flip binding status from "gating" back to "advisory".
- Add CHANGELOG entry.
- Reference the incident ticket.

Label the PR `emergency-change`.

### 3.2 Expedited review

- Single reviewer approval required (on-call lead).
- CI must pass (`promotion-guard.yml` confirms ADR + CHANGELOG accompany the graph change).
- Merge immediately after green CI.
- Deploy via normal release process.

### 3.3 Restore kill-switch to `on`

Once the PR is deployed AND observatory confirms the binding is back to
advisory:

```bash
agentics config set <domain>_gating on --reason "recovered post-rollback: incident <INC-ID>"
```

This turns the kill-switch back on for the NOW-advisory binding — which is a
no-op semantically (advisory bindings never gate), but it keeps the env var
clean for future re-promotions.

### 3.4 Close the incident

- Incident-manager ticket: state = resolved.
- Post-mortem due date recorded (§4).

---

## 4. Post-Mortem (< 7 days)

Follow the standard post-mortem template in incident-manager. Required
sections:

1. Timeline (from trigger to recovery).
2. Root cause (using the classification from §2.1).
3. What the bypass cost (pipeline runs affected, false-positive severity, user impact).
4. Fix plan — bug fixes upstream, adapter fixes, threshold recalibration, or scope-boundary clarifications.
5. Re-promotion target date (30 days after post-rollback advisory deploy, per ADR-084 §4.4).

---

## 5. What NOT to Do

- **Do not** set `<domain>_gating=on` while the regression condition is still active. The bypass is protecting users; turning it off before recovery re-exposes them.
- **Do not** edit `ecosystem.graph.json` directly on `main`. Always use a PR so `promotion-guard.yml` runs.
- **Do not** skip the post-mortem. Re-promotion without RCA is how we learn nothing.
- **Do not** lower FP-rate thresholds to "pass" a future promotion. That's threshold drift (ADR-084 §8). Thresholds change via ADR amendment only.
- **Do not** silently promote back. Re-promotion follows §3 of the promotion process. No shortcuts.

---

## 6. Quick Reference

```bash
# Kill-switch states
agentics config set <domain>_gating advisory --reason "..."   # stop gating, keep running
agentics config set <domain>_gating off --reason "..."        # stop running entirely
agentics config set <domain>_gating on --reason "..."         # resume gating (post-recovery)

# Check current state
agentics config get <domain>_gating

# Sampler
npx tsx tools/promotion-sampler.ts --domain <name> --window-days 7 --out sample.csv
```

---

## Related

- ADR-PIPELINE-084 (Observational-First Rollout Policy)
- ADR-PIPELINE-086 (Kill-Switch and Gating Regression Policy)
- `docs/processes/domain-promotion.md`
- `docs/templates/regression-changelog.md`
- `tools/promotion-sampler.ts`
- `.github/workflows/promotion-guard.yml`
