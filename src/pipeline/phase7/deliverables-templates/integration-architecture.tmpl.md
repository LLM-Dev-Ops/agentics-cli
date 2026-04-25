# {{title}}

{{consensusBanner}}

**Date:** {{date}}
**Trace ID:** `{{traceId}}`

---

## 1. Integration Frame

{{integrationFrame}}

### Strategic Drivers for the Integration Layer

{{integrationDrivers}}

### Integration Principles

{{integrationPrinciples}}

## 2. Integration Style

{{integrationStyle}}

| Style | Where Used | Rationale |
|-------|-----------|-----------|
| Synchronous (REST / GraphQL) | {{syncWhere}} | {{syncRationale}} |
| Event-driven (pub/sub) | {{eventWhere}} | {{eventRationale}} |
| Batch / file | {{batchWhere}} | {{batchRationale}} |
| Streaming (CDC / Kafka) | {{streamWhere}} | {{streamRationale}} |
| ETL / ELT | {{etlWhere}} | {{etlRationale}} |

## 3. Integration Map

{{integrationMap}}

## 4. Integration Catalog

| # | Integration | Source → Target | Style | Payload | Volume | Frequency | Owner |
|---|------------|------------------|-------|---------|--------|-----------|-------|
{{integrationCatalogTable}}

## 5. ERP / System-of-Record Surfaces

{{erpSurfaces}}

### Authentication

{{authStrategy}}

### Concurrency / Locking

{{concurrencyStrategy}}

### Idempotency

{{idempotencyStrategy}}

### Reconciliation

{{reconciliationStrategy}}

## 6. API / Contract Management

{{apiContractMgmt}}

## 7. Error Handling, Retry, Dead-Letter

{{errorHandling}}

## 8. Observability of the Integration Layer

{{integrationObservability}}

## 9. Throughput & Scaling

{{throughputScaling}}

## 10. Integration Risks

{{integrationRisks}}

## 11. Integration KPIs

{{integrationKpis}}

## 12. Cost Implications

{{fcvBlock}}

{{integrationCost}}

## 13. Confidence & Caveats

{{confidenceCommentary}}

{{dissentingAgents}}

---

{{agentAttributionFooter}}
