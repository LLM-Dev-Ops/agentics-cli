# ADR-PIPELINE-040: LLM Synthesis Pass for Executive Documents — Template Skeleton + Claude Rewrite

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** HIGH — Executive Output Quality stuck at 3-5/10; template extraction can't produce consulting-grade narrative

## Context

The executive document renderers (`renderExecutiveSummary`, `renderDecisionMemo`, `renderFinancialAnalysis`) are deterministic template engines. They extract fragments from the query using regex, arrange them in markdown templates, and produce the output. This produces "extracted" text, not "synthesized" insight.

A McKinsey deliverable takes raw data, applies domain judgment, and produces novel narrative. The current renderers cannot do this — they have no reasoning capability. Result: every evaluation flags "template-driven, not insight-driven" and "would not survive boardroom scrutiny."

The domain-specific financial models (ADR-029) and contextual risks (ADR-030) improved the numbers, but the narrative around them is still mechanical.

## Decision

### 1. Two-Pass Rendering: Template + LLM Synthesis

**Pass 1 (existing):** Template engine generates a structured skeleton with all data points:
- Financial model with methodology
- Risk register with scores
- Stakeholder impact matrix
- Recommendation with confidence

**Pass 2 (new):** LLM synthesis rewrites the skeleton into consulting-grade prose:
- Transforms bullet points into narrative flow
- Adds domain-specific insight and judgment
- Frames "do nothing" risk with competitive/regulatory context
- Ensures cross-document consistency (timeline, financials, recommendation)
- Cites specific data points from the analysis (not generic benchmarks)

### 2. LLM Call Design

```typescript
async function synthesizeExecutiveDocument(
  skeleton: string,      // The template-generated markdown
  query: string,         // Original user query for domain context
  agentResults: AgentResult[], // Raw agent data for evidence
  documentType: 'executive-summary' | 'decision-memo' | 'financial-analysis',
): Promise<string>
```

- Use Claude with a system prompt: "You are a senior partner at McKinsey writing a board-ready document."
- Input: the skeleton + query + agent data
- Output: rewritten document maintaining the same structure but with consulting-grade prose
- Fallback: if LLM call fails, return the skeleton unchanged (graceful degradation)

### 3. Tier System (Consistent with ADR-028)

| Tier | Method | Quality | Fallback |
|------|--------|---------|----------|
| 1 | Claude binary `--print` | Consulting-grade narrative | → Tier 2 |
| 2 | Anthropic API direct | Same quality | → Tier 3 |
| 3 | Template skeleton only | Structured but mechanical | Always available |

### 4. Prompt for LLM Synthesis

```
You are rewriting an enterprise decision document to meet McKinsey/BCG/Bain quality standards.

Rules:
- Lead with the recommendation and impact (Pyramid Principle)
- Every financial figure must show its derivation
- Frame "do nothing" as a quantified business risk, not a vague warning
- Reference specific data from the analysis, not generic benchmarks
- Ensure timeline consistency across all sections
- Name specific stakeholder roles, not "Workforce" or "Team"
- Include regulatory and competitive context relevant to the domain
- No sentence fragments, no prompt echo, no template placeholders

Input document (skeleton):
{skeleton}

Original business context:
{query}

Rewrite this document to be credible in a boardroom setting.
```

## Consequences

### Positive
- Executive Output Quality jumps from 5 to 8-9
- Documents become genuinely insight-driven, not just data-arranged
- Cross-document consistency enforced by a single LLM pass
- Graceful degradation means template quality is the floor, not the ceiling

### Negative
- LLM call adds 10-30s latency per document
- Requires Claude binary or API key (same as ADR-028 Tier 1/2)
- LLM output quality varies — skeleton provides guardrails

## Implementation

Files to modify:
- `src/synthesis/simulation-renderers.ts` — Add `synthesizeExecutiveDocument()` wrapper
- `src/synthesis/simulation-artifact-generator.ts` — Call synthesis pass after template rendering
- `src/synthesis/ask-artifact-writer.ts` — Same for ask flow path
