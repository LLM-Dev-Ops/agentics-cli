# ADR-PIPELINE-036: Research Dossier Quality — Deduplicate Items, Sanitize Titles, Prevent Query Leakage

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** MEDIUM — Duplicate items and truncated titles in every evaluation

## Context

The research dossier has three recurring quality issues:

### Issue 1: Duplicate Items
In `research-dossier.ts`, `extractFromScenario()` concatenates arrays with themselves:
```typescript
const stakeholders = safeStringArray(scenario, 'stakeholders')
  .concat(safeStringArray(scenarioAny, 'stakeholders')); // scenarioAny IS scenario
```
Since `scenarioAny = scenario as Record<string, unknown>` is a type assertion (same object reference), this doubles every stakeholder, constraint, and success criterion. Result: RD-006 = RD-008, RD-007 = RD-009, etc.

### Issue 2: Truncated Title Fragments
The `extractSubobjectives()` function in `ask-artifact-writer.ts` uses raw titles from the copilot/decomposer agent. These can be sentence fragments extracted from the user's query:
- `"Capability: and fix issues. While we have some monitoring syst"` (truncated at 60 chars)
- `"evaluate is a simple working prototype that shows how AI can"` (query text as criteria)

### Issue 3: Raw Query Leakage
When the decomposer agent produces a subobjective with the entire user query as its description, that 40+ line query becomes a single dossier item. Multiple items can contain the same query text.

## Decision

### 1. Fix Self-Concatenation Bug

Replace `safeStringArray(scenarioAny, 'key')` with `safeStringArray(nestedScenario, 'key')` — use the actual nested object, not the same object with a type assertion. Add a `dedupe()` helper that filters by case-insensitive content.

### 2. Sanitize Subobjective Titles

`extractSubobjectives()` must apply `sanitizeTitle()`:
1. Strip leaking prefixes: "Capability:", "Requirement:", "Feature:", "Task:", "Objective:"
2. Detect sentence fragments (starts with lowercase conjunction/preposition) → replace with "Untitled Objective"
3. Truncate at sentence boundary for titles >100 chars
4. Capitalize first letter

### 3. Sanitize Criteria Content

`extractSubobjectives()` must apply `sanitizeCriteria()`:
1. If criteria >500 chars, it's likely raw query text → extract first meaningful sentence
2. If criteria starts with "I lead..." or "We are...", it's biographical context → strip or replace
3. Cap at 300 chars with word-boundary truncation

### 4. Dossier-Level Deduplication

After all items are collected, run a deduplication pass:
- Items with identical `content` (case-insensitive, whitespace-normalized) → keep first, drop rest
- Items with identical `title` → merge content, keep first ID

## Consequences

### Positive
- Research dossier items are unique and meaningful
- Titles are clean, readable, properly capitalized
- No raw query text leaks into structured dossier items
- Executive Output Quality improves (dossier feeds into executive documents)

### Negative
- Aggressive sanitization may occasionally strip legitimate content
- Deduplication adds a processing pass

## Implementation

Files to modify:
- `src/pipeline/phase2/phases/research-dossier.ts` — `extractFromScenario()` fix + `dedupe()` helper
- `src/synthesis/ask-artifact-writer.ts` — `extractSubobjectives()` + `sanitizeTitle()` + `sanitizeCriteria()`
