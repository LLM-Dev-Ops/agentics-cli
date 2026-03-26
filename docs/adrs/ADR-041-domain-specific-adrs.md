# ADR-041: ADRs Must Contain Domain-Specific Implementation Decisions

**Status**: Proposed
**Date**: 2026-03-26
**Severity**: P0 — ADRs drive implementation prompts which drive code generation

## Context

The pipeline audit revealed that ADR-P2-001 through ADR-P2-006 are structurally identical templates:

> "Build {service-name} as a modular service with clear interfaces. Implement: Manage {Entity} domain logic, CRUD operations, business rules, and event handling. Expose a clean API surface for other services to consume."

This tells a developer nothing about:
- What an EmissionsRecord contains (scopes, facilities, time series?)
- How carbon market prices should be modeled
- What strategy comparison logic looks like
- What regulatory scenarios matter
- Why Rust should be used for simulation

The ADR generator has two paths:
1. **LLM path** (`tryGenerateLLMADRs`) — 30s timeout, often fails, falls back to templates
2. **Fallback path** (`buildADRsFromSPARC`) — produces the generic templates above

Both paths are failing to produce domain-specific decisions.

## Root Causes

### 1. Fallback ADRs are infrastructure templates
The `buildADRsFromSPARC` function generates ADRs from SPARC service names but only fills in generic decisions: "Use adapter pattern", "Defense-in-depth", "Caching at service boundaries."

### 2. LLM prompt asks for infrastructure topics
The LLM prompt's "required ADR topics" are: data persistence, integration pattern, architecture choice, security, batch vs real-time. These are all infrastructure. There are no required topics for domain-specific decisions.

### 3. SPARC service descriptions are generic
The SPARC specification produces service descriptions like "Manage EmissionsRecord domain logic, CRUD operations" — so ADRs built from these inherit the generic descriptions.

### 4. [object Object] serialization bugs
ADR-P2-007 title contains `[object Object]` because the performance items from SPARC are objects, not strings, and are serialized with `String()` instead of accessing `.text` or `.description`.

## Decision

### A. ADRs Must Cover Two Categories

**Domain-Specific Decisions (minimum 5 per project):**
- How to model the core domain entities (with field-level specificity)
- Algorithm/methodology choices for computations the user described
- Business rule enforcement and validation logic
- Workflow and process design decisions
- Domain-specific data structures and relationships

**Infrastructure Decisions (3-5 per project):**
- Data persistence (database choice + schema rationale)
- ERP integration approach (specific to the detected ERP)
- Deployment architecture (specific to the user's cloud platform)
- Security model (specific to the domain's compliance needs)

### B. LLM Timeout Must Be Increased
The 30s timeout causes frequent fallbacks to generic templates. Increase to 60s. The LLM-generated ADRs are dramatically better than the fallback templates — it's worth waiting for them.

### C. Fallback ADRs Must Use the Scenario Query
When the LLM times out, the fallback must:
1. Parse the scenario query for domain concepts (not just service names)
2. Generate decisions that reference actual business requirements
3. Include the user's technology choices (Rust, specific cloud services, etc.)

### D. Fix All Serialization Bugs
Every place that renders ADR/SPARC data into strings must handle objects:
- `String(obj)` → `obj.text ?? obj.description ?? JSON.stringify(obj)`
- Template literals with arrays of objects → map to `.name` or `.text` first

## Consequences

### Positive
- ADRs become actionable implementation guidance
- Each ADR decision tells a developer what to build, not just what technology to use
- Implementation prompts inherit domain specificity from ADRs

### Negative
- Longer LLM call (60s vs 30s) adds ~30s to Phase 2
- Fallback path requires more sophisticated query parsing

## Implementation

1. `adr-generator.ts` — Increase LLM timeout from 30s to 60s
2. `adr-generator.ts` — LLM prompt: require 5+ domain-specific decisions with implementation detail
3. `adr-generator.ts` — Fallback: parse scenario query for domain concepts, generate decisions that reference the user's actual requirements
4. `adr-generator.ts` — Fix all `String(obj)` serialization patterns
5. `simulation-renderers.ts` — Fix remaining `String(obj)` patterns for performance/risk items
