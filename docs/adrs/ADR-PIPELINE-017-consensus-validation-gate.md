# ADR-PIPELINE-017: Consensus Validation Gate

**Status:** Accepted
**Date:** 2026-04-08
**Supersedes:** None

## Context

The multi-agent simulation pipeline invokes the `analytics-hub/consensus` agent to synthesize areas of agreement and disagreement across agents. The consensus agent returns structured output including `overall_confidence`, `agreement_areas[]`, `disagreement_areas[]`, and `dissenting_views[]`.

In a production readiness review, the consensus agent returned only 50% agreement (below the expected 60% threshold), but this was not detected, warned about, or surfaced in any pipeline artifact. The low consensus passed silently, and downstream artifacts were generated without any quality signal.

The existing 60% threshold in `simulation-artifact-generator.ts` was for hollow response detection (checking if numeric values are placeholders), not for agent consensus validation. These are distinct concerns.

## Decision

1. Add a `validateConsensusResults(results)` function to `simulation-artifact-generator.ts` that:
   - Finds the `analytics-hub/consensus` agent result
   - Extracts `overall_confidence` from `confidence_aggregation` or computes it from agreement/disagreement area counts
   - Compares against a configurable threshold (default 60%, overridable via `AGENTICS_CONSENSUS_THRESHOLD` env var)
   - Returns a structured validation result with agreement level, threshold, disagreement areas, and dissenting views

2. When consensus is below threshold, emit a `[pipeline-017] WARNING` to stderr with specifics.

3. Include `consensus_validation` metadata in `manifest.json` so downstream consumers and reviewers can see the quality signal.

4. The pipeline is NOT blocked by low consensus — it's a quality signal, not a gate. Blocking would prevent artifact generation for exploratory simulations where disagreement is expected.

## Alternatives Considered

- **Block pipeline on low consensus** (rejected): Would prevent artifact generation for valid exploratory scenarios. Low consensus doesn't mean the simulation is wrong — it means agents disagree, which itself is valuable information.
- **Ignore consensus entirely** (rejected): Current behavior. Low consensus is a meaningful quality signal that should be surfaced.
- **Require re-evaluation** (rejected): Adds latency and cost. Better to surface the warning and let the human decide.

## Consequences

- [+] Low consensus is surfaced in stderr and manifest.json — reviewers know to apply extra scrutiny
- [+] Threshold is configurable via environment variable for different deployment contexts
- [+] Consensus metadata in manifest.json enables downstream tooling to detect and flag low-consensus runs
- [-] Additional processing per simulation run (negligible: one array scan)
- [~] False positive: if only one agent disagrees about a minor point, overall confidence could dip below threshold

## Files Changed

- `src/synthesis/simulation-artifact-generator.ts` — Added `validateConsensusResults()`, consensus metadata in manifest, stderr warning
