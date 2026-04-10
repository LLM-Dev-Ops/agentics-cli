# ADR-PIPELINE-062: Structured Competitive Analysis Section in Executive Summary

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Executive Output 7.5 → 10/10
**Implements:** ADR-PIPELINE-057 §3 (which was Accepted but unimplemented)

## Context

ADR-PIPELINE-057 §3 accepted the need for "quantitative competitive positioning" in the executive summary, but the implementation never landed. Hand-verified 2026-04-10:

### Evidence of Gap

```bash
$ grep -rn "competitive_analysis\|capability_maturity\|peer_comparison\|competitor" src/synthesis/
src/synthesis/simulation-renderers.ts:1293:8. Include competitive context — what are 2-3 named competitors/peers doing in this space?
```

**That's the only match across the entire synthesis layer.** And it's a comment inside a fallback helper that instructs the LLM to "include competitive context" — there is no structured field the LLM can emit into, no renderer section that consumes it, and no guarantee it appears in the output.

### `simulate_create` Prompt (the LLM spec)

`src/synthesis/prompts/index.ts:120–178` enumerates the 9 required output sections from the synthesis LLM:

1. routing  2. scenario  3. phases[]  4. financial_model  5. risk_matrix[]  6. organizational_impact  7. technology_architecture  8. kpi_framework[]  9. execution_metadata

**There is no competitive analysis section.** The LLM is never asked for one.

### `renderExecutiveSummary` (the deterministic renderer)

`src/synthesis/simulation-renderers.ts:1424–1592` emits these sections: Recommendation, Success Probability, The Opportunity, Key Findings, Financial Impact, Risk Profile, Recommended Next Steps, Analysis Confidence Note (conditional), Provenance.

**No competitive or peer section.** A consulting deliverable without competitive context is credibility-incomplete.

## Decision

### 1. Extend the `simulate_create` Prompt

Add section 10 to `src/synthesis/prompts/index.ts:simulate_create`:

```
10. competitive_analysis: object with:
    - peer_firms: [{ name, industry_position, public_evidence_link_or_source }]
    - capability_maturity: array of { capability, current_level, peer_levels: {peer: level},
      post_pilot_level } where levels ∈ ["none", "manual", "rule_based", "automated", "ai_optimized"]
    - gap_to_close: [{ capability, from, to, levels_jumped, vs_top_peer }]
    - risks_of_inaction: [{ risk, driver, timeframe }]
    - sources: [...citations]

The peer_firms MUST be real companies operating in the same industry as the scenario.
The capability_maturity table MUST have at least 4 rows and 3 peer columns.
The gap_to_close array length MUST equal capability_maturity length.
At least one risk_of_inaction MUST reference a named regulatory framework if the scenario
touches any regulated domain (ESG, finance, healthcare, data privacy).
```

### 2. Extend `renderExecutiveSummary`

Add a new section between Risk Profile and Recommended Next Steps:

```markdown
## Competitive Position

**Peer Firms:** ${peer_firms.map(p => p.name).join(', ')}

### Capability Maturity Comparison
Scale: None → Manual → Rule-Based → Automated → AI-Optimized

| Capability | Current | Peer 1 | Peer 2 | Peer 3 | Post-Pilot |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

### Gap to Close
- **{capability}**: {from} → {to} (+{levels_jumped} levels). {vs_top_peer}
- ...

### Risks of Inaction
- **{risk}** — {driver}. Timeframe: {timeframe}
- ...

*Sources: {sources.join('; ')}*
```

### 3. Fallback Builder When LLM Doesn't Return the Field

The renderer must not throw if `competitive_analysis` is missing from the LLM response. Implement `buildFallbackCompetitiveAnalysis(query, extracted, platformResults)` in `simulation-renderers.ts` that produces a minimum-viable version by:
- Pulling peer names from `extractPeersFromQuery(query)` (already exists for benchmarking helpers in the same file — line 580 onwards)
- Defaulting all current_level to "manual" and post_pilot_level to "automated"
- Generating one regulatory risk from `detectApplicableRegulations(query)`

This ensures **every** executive summary has a competitive section, even under LLM failures.

### 4. Add Determinism Guardrails

`competitive_analysis` is consulting content — it must be reproducible:
- `peer_firms` are sorted alphabetically by name before rendering
- `capability_maturity` rows are sorted by current_level severity (worst first)
- The fallback builder is deterministic for a given query string

## Acceptance Criteria

1. `src/synthesis/prompts/index.ts:simulate_create` contains a `10. competitive_analysis:` section in its required output list.
2. `renderExecutiveSummary` emits a `## Competitive Position` heading for every input (verified by unit test over 5 seed queries).
3. Fallback builder returns a non-empty `competitive_analysis` object even when `simData['competitive_analysis']` is `undefined`.
4. Rendered output includes ≥3 peer firms, ≥4 capability rows, and ≥1 regulatory risk of inaction (given a regulated-domain query).
5. `grep -rn "competitive_analysis\|capability_maturity" src/synthesis/` returns matches in both the prompt file and the renderer file.

## Consequences

### Positive
- Closes the last major gap in consulting-grade executive output
- Gives the executive summary a "why act now" section grounded in external reality
- Fallback builder guarantees the section is always present, not best-effort

### Negative
- Synthesis prompt grows by ~15 lines
- Fallback competitive data may look thin for unusual domains — acceptable trade-off vs. section missing entirely

## Related
- ADR-PIPELINE-057 §3 (original competitive positioning design — unimplemented)
- ADR-PIPELINE-052 (Executive Output 9/10)
- ADR-PIPELINE-060 (10/10 Scorecard)
