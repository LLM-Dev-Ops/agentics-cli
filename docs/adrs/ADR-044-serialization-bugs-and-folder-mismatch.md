# ADR-044: Eliminate All [object Object] Serialization Bugs and Folder Structure Mismatches

**Status**: Proposed
**Date**: 2026-03-26
**Severity**: P1 — Bugs appear in customer-visible artifacts (ADR titles, prompt titles, README)

## Context

The pipeline audit found `[object Object]` appearing in:
1. **ADR-P2-007 title**: "Performance: [object Object]; [object Object]"
2. **Implementation prompt #8 title**: "Performance: [object Object]; [object Object]"
3. **README architecture decisions section** (prior fix partially addressed this)

Root cause: SPARC refinement items (security considerations, performance targets) are stored as objects `{ text: string, priority: string }` but rendered with `String(item)` instead of `item.text`.

Additionally, the audit found a **folder structure mismatch**:
- README claims: `backend/`, `frontend/`, `erp/`, `integrations/`, `docs/`, `tests/`
- Actually created: only `src/` with sub-folders like `src/emissions-tracking/`
- Implementation prompts target `frontend/` as output folder for backend services
- The scaffold generator creates `.gitkeep` files in base folders, but Phase 4/5 code generators ignore these folders and write everything under `src/`

## Decision

### A. Ban `String()` on Unknown Types
Every location that converts SPARC/ADR/DDD data to strings must use a safe serializer:

```typescript
function safeText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    return String(obj['text'] ?? obj['description'] ?? obj['name'] ?? obj['title'] ?? JSON.stringify(item));
  }
  return String(item);
}
```

Apply this in:
- `adr-generator.ts` — security items, performance items, risk factors
- `simulation-renderers.ts` — recommendations, risk factors
- `deployment-finalizer.ts` — any dynamic content in README
- `auto-chain.ts` — prompt titles, phase descriptions

### B. Code Generators Must Use Base Folders
Phase 4 (`http-server-generator.ts`) and Phase 5 (`project-materializer.ts`, `domain-codegen.ts`) must write files into the base folder structure:
- `backend/` — API routes, service layer, business logic
- `frontend/` — UI application (only if frontend is part of the solution)
- `erp/` — ERP client and integration adapters
- `integrations/` — External system connectors
- `src/` — Shared types, utilities, core modules
- `tests/` — Test files

NOT everything dumped into `src/{service-name}/`.

### C. Implementation Prompts Must Target Correct Folders
The prompt generator must determine the correct target folder based on what the phase is building:
- If the phase builds API/backend logic → `backend/`
- If the phase builds simulation/compute logic → `src/` or `backend/`
- If the phase builds ERP integration → `erp/`
- Never target `frontend/` for backend services

### D. README Must Reflect Actual Structure
The README folder structure section must only list folders that actually exist in the generated project, not a hardcoded ideal.

## Consequences

### Positive
- No more `[object Object]` in customer-visible artifacts
- Folder structure matches what README describes
- Implementation prompts target correct directories

### Negative
- Requires audit of every `String()` call across the pipeline
- Code generators need refactoring to respect base folder convention

## Implementation

1. Create `safeText()` utility in a shared module
2. Grep for `String(` across pipeline code and replace with `safeText()`
3. Update `http-server-generator.ts` to write into `backend/` not `src/{service}/`
4. Update `domain-codegen.ts` to respect base folder structure
5. Update prompt generator folder assignment logic
6. Update README generator to check which folders actually exist
