# Regression CHANGELOG Entry — Template

Copy this block into `CHANGELOG.md` under the current release header when
regressing a domain binding per ADR-PIPELINE-084 §4.

---

### Domain Regression: `<domain-name>` — <from-stage> → <to-stage>

- **Date:** YYYY-MM-DD
- **On-call / initiating engineer:** @github-handle
- **Binding:** `<phase-name>` (phase <N>) / `<mandatory_agents|optional_agents>`
- **Agents affected:** `<Agent A>`, `<Agent B>`, ...
- **From stage:** gating
- **To stage:** advisory | off (kill-switch applied)
- **Regression label on PR:** `emergency-change`

**Trigger:**
- Rule: <fp-rate-exceeded | adapter-crash-rate | 502-rate | upstream-outage | manual>
- Window: <7d | 24h | 1h | 15m>
- Observed value: <e.g., FP rate 7.2%, crash rate 1.4%, 502 rate 14%>
- Threshold breached: <threshold>

**Kill-switch state at time of regression:**
- Env var: `AGENTICS_<DOMAIN>_GATING=<value>`
- Applied by: <auto | @on-call-handle>
- Applied at: YYYY-MM-DDTHH:MM:SSZ
- Applied reason: "<free-text reason required by CLI>"

**Incident reference:**
- Incident-manager ticket: <link>
- Severity: <P0 | P1 | P2>
- Pages dispatched: <n>

**Recovery plan:**
- RCA due by: YYYY-MM-DD (7 days from regression)
- Re-promotion target window: <e.g., 2026-05-28 earliest>
- Owner: @domain-owner-handle

**Related ADR updates:**
- `<ADR-PIPELINE-NNN>` — <brief description of edit, typically flipping binding status>

**Reviewer approval:**
- [ ] On-call lead: @

---

## Example

### Domain Regression: `quality_engineering` — gating → advisory

- **Date:** 2026-05-22
- **On-call / initiating engineer:** @dave
- **Binding:** `validation` (phase 8) / `mandatory_agents`
- **Agents affected:** Flaky Test Detection Agent, Defect Prediction Agent
- **From stage:** gating
- **To stage:** advisory (full binding moved back to optional_agents[])
- **Regression label on PR:** `emergency-change`

**Trigger:**
- Rule: fp-rate-exceeded
- Window: 7d
- Observed value: FP rate 6.1% (Flaky Test Detection contributing 4.8%; Defect Prediction contributing 1.3%)
- Threshold breached: 5.0%

**Kill-switch state at time of regression:**
- Env var: `AGENTICS_QE_GATING=advisory`
- Applied by: auto (observatory trigger at 2026-05-22T14:03:12Z)
- Applied at: 2026-05-22T14:03:12Z
- Applied reason: "auto: FP rate 6.1% exceeds 5% threshold over 7d window"

**Incident reference:**
- Incident-manager ticket: INC-2026-0518
- Severity: P2
- Pages dispatched: 1 (on-call@agentics.dev)

**Recovery plan:**
- RCA due by: 2026-05-29
- Re-promotion target window: 2026-06-22 earliest (30-day advisory restart)
- Owner: @alice

**Related ADR updates:**
- ADR-PIPELINE-083 — flip phase 8 QE bindings from mandatory back to optional pending RCA

**Reviewer approval:**
- [x] On-call lead: @dave
