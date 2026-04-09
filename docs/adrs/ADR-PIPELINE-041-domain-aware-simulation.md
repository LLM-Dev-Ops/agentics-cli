# ADR-PIPELINE-041: Domain-Aware Simulation — ruvector Must Model the Actual Problem, Not Just Generate Metadata

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Simulation Alignment stuck at 5/10; simulation runs in <10ms with zero domain-specific output

## Context

The ruvector simulation engine runs in every pipeline invocation but produces generic metadata:
- Execution proof hashes (structural, not domain-specific)
- 5 execution layers that always "pass" regardless of domain
- Success probability that appears to be a static default (0.75)
- Scenario agent returns "Baseline analysis with no specific indicators detected"
- Consensus agent reports 50% confidence / "consensus not achieved" — signal buried

The simulation does not model the actual domain. A fleet electrification query should produce fuel cost projections, route feasibility scores, and charging infrastructure requirements. A packaging optimization query should model waste volumes and supplier response curves. Instead, both get the same generic metadata.

## Decision

### 1. Domain-Specific Simulation Steps

When the simulation engine detects domain signals in the query, it should inject domain-specific simulation steps:

| Domain Signal | Simulation Step | Output |
|---|---|---|
| fleet, vehicle, electrification | Fuel cost differential modeling | Per-class savings projection |
| packaging, waste, supplier | Waste volume modeling | Addressable waste by supplier tier |
| water, pipe, leak, pressure | Network loss modeling | Loss rate by zone, intervention ROI |
| travel, emission, carbon | Carbon footprint modeling | Reduction scenarios by travel mode |
| procurement, spend, sourcing | Spend analysis modeling | Addressable spend by category |

### 2. Simulation Output Contract

The simulation must produce a `domain_analysis` field in its output:

```json
{
  "simulation_id": "sim-...",
  "domain_analysis": {
    "domain": "fleet-electrification",
    "key_metrics": {
      "total_fleet_size": 4850,
      "ev_suitable_pct": 62,
      "annual_fuel_cost": 58200000,
      "potential_savings": 37830000,
      "charging_infra_required": 25
    },
    "scenarios": [
      { "name": "gradual", "capex": 145000000, "annual_savings": 37830000, "payback_years": 3.8 },
      { "name": "pilot", "capex": 29000000, "annual_savings": 7566000, "payback_years": 3.8 },
      { "name": "full", "capex": 145000000, "annual_savings": 37830000, "payback_years": 3.8 }
    ],
    "confidence": 0.72,
    "methodology": "Monte Carlo simulation with 1000 iterations over 5-year horizon"
  }
}
```

### 3. Renderer Consumes Simulation Domain Analysis

When `domain_analysis` is present in `simData`, the financial renderers use its figures instead of query-derived estimates. This creates genuine simulation → execution traceability.

### 4. Consensus Signal Disclosure

When the consensus agent reports <60% confidence, the executive summary must include:

```markdown
**Analysis Confidence Note:** The multi-agent consensus process achieved [X]%
agreement ([Y] of [Z] signals aligned). Areas of divergence: [list]. This
suggests [interpretation]. The recommendation accounts for this uncertainty
by proposing a scoped pilot rather than full commitment.
```

## Consequences

### Positive
- Simulation Alignment jumps from 5 to 8-9
- Financial figures trace to actual simulation, not regex extraction
- Executive documents cite simulation evidence, not template heuristics
- Divergent consensus signals are transparently disclosed

### Negative
- Requires changes to ruvector simulation engine (separate codebase)
- Domain detection in simulation layer duplicates some query extraction logic
- Simulation latency increases from <10ms to 1-5s for domain-specific modeling

## Implementation

Files to modify:
- `ruvector-service` — Domain-specific simulation steps (separate repo)
- `src/synthesis/simulation-renderers.ts` — Consume `domain_analysis` from simData
- `src/synthesis/simulation-renderers.ts` — Consensus signal disclosure in exec summary
