# Promotion CHANGELOG Entry — Template

Copy this block into `CHANGELOG.md` under the current release header when
promoting a domain binding per ADR-PIPELINE-084.

---

### Domain Promotion: `<domain-name>` — <from-stage> → <to-stage>

- **Date:** YYYY-MM-DD
- **Adapter owner:** @github-handle
- **Binding:** `<phase-name>` (phase <N>) / `<mandatory_agents|optional_agents>`
- **Agents affected:** `<Agent A>`, `<Agent B>`, ...
- **From stage:** observational | advisory
- **To stage:** advisory | gating

**Measurement window:**
- Duration in prior stage: <days>
- Total invocations: <n>
- Successful invocations: <n> (<rate>%)
- Adapter crashes: <n>
- 502 responses: <n> (<rate>%)

**False-positive rate (for → gating only):**
- Windows sampled: <count>
- Total findings in sample: <n>
- False positives: <n>
- FP rate: <rate>% (< 5% required)
- Sample CSV: `<path or attachment link>`

**Latency (for → gating only):**
- P50: <ms>
- P95: <ms> (< tier cap: 300_000 ms)
- P99: <ms>

**Kill-switch (for → gating only):**
- Env var: `AGENTICS_<DOMAIN>_GATING={on,advisory,off}`
- Runbook: `docs/runbooks/<domain>-gating-recovery.md`

**Related ADR updates:**
- `<ADR-PIPELINE-NNN>` — <brief description of edit>

**Related incident tickets:** <none | link>

**Reviewer approvals:**
- [ ] Domain owner: @
- [ ] Platform owner: @
- [ ] On-call lead (for → gating only): @

---

## Example

### Domain Promotion: `quality_engineering` — advisory → gating

- **Date:** 2026-05-15
- **Adapter owner:** @alice
- **Binding:** `validation` (phase 8) / `mandatory_agents`
- **Agents affected:** all 14 QE agents per ADR-PIPELINE-080
- **From stage:** advisory
- **To stage:** gating (accelerated per ADR-084 §7.1)

**Measurement window:**
- Duration in prior stage: 14 days (accelerated exception)
- Total invocations: 1847
- Successful invocations: 1823 (98.7%)
- Adapter crashes: 0
- 502 responses: 24 (1.3%)

**False-positive rate:**
- Windows sampled: 2
- Total findings in sample: 312
- False positives: 11
- FP rate: 3.5% (< 5% required)
- Sample CSV: `observatory-exports/qe-advisory-2026-w18-w19.csv`

**Latency:**
- P50: 42_000 ms
- P95: 187_000 ms (< 300_000 ms tier cap)
- P99: 241_000 ms

**Kill-switch:**
- Env var: `AGENTICS_QE_GATING={on,advisory,off}`
- Runbook: `docs/runbooks/qe-gating-recovery-086.md`

**Related ADR updates:**
- ADR-PIPELINE-083 — flip phase 8 bindings from optional (advisory) to mandatory (gating)

**Related incident tickets:** none

**Reviewer approvals:**
- [x] Domain owner: @alice
- [x] Platform owner: @bob
- [x] On-call lead: @carol
