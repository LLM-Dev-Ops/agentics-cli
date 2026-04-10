# ADR-PIPELINE-047: Architecture 9/10 — DI Container, Scheduled Ingestion, No Hidden Globals

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** HIGH — Architecture stuck at 6-7.5/10

## Gap Analysis (7.5 → 9)

| Issue | Impact | Fix |
|-------|--------|-----|
| No dependency injection — manual wiring in index.ts | Brittle, untestable composition | Simple DI container or factory |
| Singleton EventBus as module-level global | Hidden coupling, no visibility in constructors | Inject via constructor |
| No scheduler for batch ingestion | ADR specifies 15-min polling, no trigger exists | node-cron or setInterval with config |
| Routes file combines validation + orchestration + state | Fat controller pattern | Extract service/orchestrator layer |

## Decision

### 1. Constructor Injection Pattern
```
RULE: Every service receives its dependencies via constructor:
- ScoringService(config, logger, eventBus)
- ApprovalService(repository, erpClient, auditLogger, eventBus)
- IngestionService(erpClient, repository, logger)

The composition root (src/index.ts or src/container.ts) wires everything.
No module-level singletons except config.
```

### 2. Thin Route Handlers
```
RULE: Route handlers do ONLY:
1. Parse and validate request (Zod)
2. Call service method
3. Format and return response

Business logic, orchestration, and state management live in application services.
```

### 3. Scheduled Batch Processing
```
RULE: If the domain requires periodic data sync (ingestion, reconciliation):
- Use node-cron or a simple setInterval
- Interval MUST come from config (not hardcoded)
- Log every invocation with start/end/duration/records-processed
- Graceful shutdown stops the scheduler before closing connections
```

## Implementation

Add to foundation prompt and API layer prompt.
