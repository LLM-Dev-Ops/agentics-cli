# ADR-PRR-002: Define Phase Gate Go/No-Go Criteria for Pilot Roadmap

## Status: IMPLEMENTED

## Date: 2026-04-10

## Priority: HIGH — Address before pilot

## Effort: 1 hour

## Context

Production readiness review (2026-04-10) found that the executive decision memo and roadmap describe a phased rollout but do not define specific, measurable go/no-go criteria at each phase gate. Without these, decision-makers cannot objectively evaluate whether to proceed, adjust, or halt. Top-tier consulting deliverables always include quantified gate criteria.

The current roadmap references "phase gates" in general terms but leaves criteria unspecified — this reduces board confidence and creates ambiguity for the pilot execution team.

## Decision

### Add explicit phase gate criteria to the decision memo and roadmap

Each gate must specify:
- **Metric**: What is measured
- **Threshold**: The pass/fail value
- **Data Source**: Where the metric comes from
- **Decision Authority**: Who makes the go/no-go call

### Gate 1: Week 4 — Pilot Technical Validation

| Metric | Threshold | Data Source |
|---|---|---|
| SAP API field coverage | ≥80% of required fields validated | ERP adapter integration test results |
| Scoring model accuracy | ≥75% agreement with manual assessment baseline (50-device sample) | Side-by-side comparison with IT asset team |
| System uptime during pilot | ≥99% during business hours | Health check endpoint logs |
| Audit trail integrity | 100% hash chain verification pass | Automated audit verification endpoint |

**Decision**: CTO + IT Director approve continuation or request remediation sprint.

### Gate 2: Week 8 — Pilot Business Validation

| Metric | Threshold | Data Source |
|---|---|---|
| Cost savings realized vs. projected | Within ±30% of Monte Carlo base case | Finance reconciliation of actual vs. projected |
| User adoption | ≥60% of pilot department using system for decisions | Usage telemetry (API request logs) |
| False positive rate (unnecessary replacements) | <10% of recommendations | Post-decision audit by IT asset team |
| ERP transaction success rate | ≥95% (excluding planned dry-run failures) | Circuit breaker metrics + ERP response logs |

**Decision**: CFO + CTO approve scale-up or extend pilot.

### Gate 3: Week 12 — Scale Readiness

| Metric | Threshold | Data Source |
|---|---|---|
| Projected fleet-wide ROI | ≥150% (with sensitivity analysis) | Updated Monte Carlo with pilot actuals |
| Security audit | Zero critical/high findings | Security scan report (ADR-049 compliance) |
| Change management readiness | Training completed for ≥80% of target users | HR/Training completion records |
| Database performance | <200ms p95 query latency at projected scale | Load test results |

**Decision**: Steering committee approves full deployment or phases by region.

## Consequences

### Positive
- Executives can make data-driven go/no-go decisions at each phase
- Pilot team has clear success criteria to work toward
- Eliminates ambiguity about what "successful pilot" means
- Standard consulting practice — increases credibility of the business case

### Negative
- Gate criteria must be reviewed and adjusted if pilot scope changes
- Some thresholds may need calibration during the first pilot (acceptable — document adjustments)

## Related ADRs
- ADR-PRR-009: Add Sensitivity Analysis Table
- ADR-PIPELINE-024: Consulting-Grade Executive Documents
- ADR-PIPELINE-025: Full Production Readiness
