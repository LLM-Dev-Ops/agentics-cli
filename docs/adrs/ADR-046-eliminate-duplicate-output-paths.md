# ADR-046: Single Output Path — Eliminate Duplicate Artifacts and External Branch Creation

**Status**: Accepted (partially implemented in v1.5.35)
**Date**: 2026-03-26
**Severity**: P1 — Duplication confuses users and creates conflicting artifacts

## Context

The `agentics ask` command produces output through TWO independent paths:

1. **Auto-chain pipeline** (`executeAutoChain`): Writes to `~/.agentics/runs/<traceId>/` and copies to `.agentics/plans/` in the repo. Produces SPARC, ADRs, DDDs, implementation prompts, generated code.

2. **Ask artifact writer** (`persistAskResults`): Creates a separate git branch, commits duplicate engineering artifacts (`engineering/sparc-specification.md`, `engineering/architecture-decisions.md`, `engineering/domain-model.md`), and prints a GitHub/Codespace link.

Problems:
- The ask artifact writer's engineering artifacts are GENERIC summaries from Phase 1 agent outputs — they conflict with the richer Phase 2-4 artifacts
- Users see two sets of artifacts with different content (one in `.agentics/plans/`, one on a branch)
- The Codespace link opens to generic Phase 1 output, not the pipeline's refined output
- Creates unnecessary git branches in the user's repo

## Decision

When the auto-chain pipeline runs successfully, skip `persistAskResults` entirely. The pipeline's `.agentics/plans/` output is the canonical artifact set.

`persistAskResults` should only run when:
- The auto-chain did NOT run (e.g., simulation failed, single-agent query)
- The result is from a non-engineering query (analysis, cost report, etc.)

## Status

Partially implemented in v1.5.35: `persistAskResults` is now skipped when `chainResult` is truthy. Monitor for edge cases where `chainResult` is set but the pipeline partially failed.

## Consequences

### Positive
- Single source of truth for pipeline artifacts
- No conflicting engineering summaries
- No unnecessary git branches
- Cleaner user experience

### Negative
- Users who relied on the Codespace link for quick browsing lose that feature
- Need to ensure `.agentics/plans/` is always browsable as a replacement
