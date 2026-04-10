# ADR-PIPELINE-046: Code Quality 9/10 — Zod at Every Boundary, No Unsafe Casts, Config-Driven

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Code Quality stuck at 7/10 across all runs

## Gap Analysis (7 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| Database row mapping uses `as` casts (15+ in repository.ts) | Silent runtime failure on schema change | Zod parse every DB row |
| API request bodies not schema-validated | Malformed input passes to services | Zod middleware on all POST/PUT routes |
| EventBus swallows handler errors | Lost audit events in critical system | Per-handler try/catch with logging |
| Config defines values code ignores | Drift between config and behavior | Read all thresholds from config, zero hardcoded magic numbers |
| Math.random() in production code paths | Non-reproducible scoring | Seeded/deterministic stubs |

## Decision

Implementation prompts must specify these as REQUIREMENTS, not suggestions:

### 1. Zod at Every Boundary
```
RULE: Every function that receives external data MUST Zod-parse it:
- API request bodies → Zod schema before handler logic
- Database rows → Zod schema before returning to domain layer
- ERP/external API responses → Zod schema before processing
- Config file values → Zod schema at startup

NEVER use `as` to cast external data to domain types.
```

### 2. Zero Hardcoded Magic Numbers
```
RULE: Every threshold, weight, factor, and constant MUST come from config:
- Scoring weights → config/scoring-weights.json
- Emission factors → config/emission-factors.json
- Retry counts, timeouts → config/infrastructure.json
- Feature flags → config/features.json

The config module validates ALL values at startup with Zod.
If config is invalid, the service refuses to start with a clear error.
```

### 3. Event Bus Resilience
```
RULE: The event bus MUST NOT lose events:
- Each handler wrapped in try/catch
- Failed handlers logged with full error context
- Remaining handlers continue executing
- Failed events written to a dead-letter queue (even if just a file)
```

### 4. Deterministic Code
```
RULE: No Math.random() in any production code path.
Use seeded random for test data generation.
Use deterministic IDs (UUID v5 from input, or sequential).
```

## Implementation

Add to CROSS_CUTTING_FOOTER and to MCP response STEP 5.
