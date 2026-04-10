# ADR-PIPELINE-045: Prototype Generation Guarantee — MCP Response Must Produce Working Code, Fix Domain Leakage

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** CRITICAL — Code Quality scored 3/10 (no prototype generated), Executive Summary had wrong domain

## Context

Two critical failures in the latest run:

### Failure 1: No Prototype Generated
The MCP tool response told Claude Code to "copy scaffold files" and "read implementation prompts" but Claude Code presented the planning artifacts as the deliverable instead of building a working prototype. The handler code was a TODO stub (`console.log('Executing analyze...')`). Code Quality scored 3/10.

Root cause: The MCP response has too many steps (0-8) and Claude Code treats the planning artifacts as sufficient. It needs a stronger directive that a WORKING PROTOTYPE with passing tests is the required output.

### Failure 2: Executive Summary Domain Leakage
The executive summary referenced "supplier packaging optimization" and used shipment/packaging financial variables ($4.50/shipment, 18% excess rate) for a renewable energy sourcing query. The `tryDomainSpecificFinancials()` function matched the packaging domain pattern instead of the energy domain.

Root cause: The packaging pattern `/packag|supplier.*waste|excess.*material/i` matches too broadly — "supplier" appears in many queries. And there's no renewable energy domain model.

## Decision

### 1. MCP Response Must Demand Working Code
The MCP tool response must end with:
```
YOU MUST produce a working TypeScript prototype with:
- All source files in src/
- All tests passing (npm test)
- Clean compilation (npx tsc --noEmit)
- A demo script (src/demo.ts) that runs the full pipeline

If you only present planning artifacts without working code, the evaluation will score Code Quality at 0/10.
```

### 2. Add Renewable Energy Domain Financial Model
Add to `tryDomainSpecificFinancials()`:
- Trigger: renewable, energy sourcing, REC, PPA, on-site generation, clean energy
- Unit economics: facilities × avg energy cost × renewable premium/savings × achievable transition %

### 3. Fix Packaging Pattern Over-Matching
Tighten the packaging regex to require packaging-specific signals, not just "supplier":
- Before: `/packag|supplier.*waste|excess.*material/i`
- After: `/packag.*waste|packag.*optim|excess.*packag|over.?pack/i`

### 4. Add Domain Mismatch Detection
After `tryDomainSpecificFinancials()` returns, verify the detected domain matches the query's primary intent. If "renewable energy" is in the query but the model returned "packaging", reject and fall through to the generic model.

## Implementation

Files to modify:
- `src/mcp/mcp-server.ts` — Stronger prototype requirement in MCP response
- `src/synthesis/simulation-renderers.ts` — Renewable energy model, fix packaging pattern, domain mismatch guard
