# ADR-065: Cloud Agent Payload Mismatch — 27 Deployed Services Returning Errors Due to Schema Mismatch

## Status: ACCEPTED

## Date: 2026-03-27

## Context

### The Infrastructure Exists and Is Running

All 28 Cloud Run agent services are deployed and active on `agentics-dev` (GCP project):

```
analytics-hub-agents       auto-optimizer-agents     benchmark-exchange-agents
config-manager-agents      connector-hub-agents      copilot-agents
costops-agents             data-vault-agents         edge-agents
forge-agents               governance-dashboard-agents  incident-manager-agents
inference-gateway-agents   latency-lens-agents       marketplace-agents
memory-graph-agents        observatory-agents        orchestrator-agents
platform-agents            policy-engine-agents      registry-agents
research-lab-agents        schema-registry-agents    sentinel-agents
shield-agents              simulator-agents          test-bench-agents
```

Plus 1 Cloud Function: `connector-hub-agents`

### The Problem: Payload Schema Mismatch

The CLI's `buildDomainPayload()` function transforms user text into agent-specific payloads, but the schemas **don't match what the cloud functions expect**. This causes:

1. **400 INVALID_INPUT errors** — agent receives wrong fields, Zod validation rejects
2. **CLI catches the error** → triggers local fallback → returns synthetic result
3. **User sees `[local]` or `[FB]` markers** — thinks agents aren't working
4. **Pipeline consumes synthetic results** instead of real cloud agent analysis

### Evidence

**costops/roi** — expects structured schema, receives `{ text: "..." }`:
```
HTTP 400: INVALID_INPUT — validation failed
  Required: analysis_scope (enum), period_start, period_end, request_id
  Received: { text: "analyze ROI..." }
```

**copilot/planner** — needs Anthropic API key forwarded:
```
HTTP 400: Missing Anthropic API key
  The X-Anthropic-Api-Key header is only sent for copilot-agents service
```

**shield/prompt-injection** — works correctly with `{ text: "..." }`:
```
HTTP 200: { threats_detected: false, risk_score: 0, severity: "none" }
```

### Root Cause

`buildDomainPayload()` in `src/commands/agents.ts` builds payloads per domain, but:

1. **Schema drift** — cloud functions were updated with stricter Zod schemas, CLI payloads weren't updated to match
2. **Missing required fields** — agents expect domain-specific fields (e.g., `analysis_scope`, `period_start`) that `buildDomainPayload()` doesn't generate
3. **Auth token not forwarded** — Cloud Run services require identity tokens, but the adapter may not be sending them for all services
4. **API key forwarding limited** — `X-Anthropic-Api-Key` only sent for `copilot-agents`, but other agents (e.g., `platform-agents`) may also need LLM inference

### Impact

- **~90% of agents fall back to local compute** during pipeline execution
- **Simulation integrity degraded** — synthetic results instead of real analysis
- **Cost analysis missing** — costops agents return errors, local fallback is basic
- **Security scan incomplete** — some shield agents work, others don't
- **User perception** — "110 agents dispatched" looks like a show when most fall back

## Decision

### Phase 1: Audit and Document (ADR-065)

For each of the 27 domains, document:
- Expected payload schema (from cloud function Zod validation)
- Current `buildDomainPayload()` output
- Whether agent responds successfully or errors
- What fields are missing/wrong

### Phase 2: Fix Payload Transformation (ADR-066)

For each domain, update `buildDomainPayload()` to:
1. Generate the correct schema fields from the user's query text
2. Include all required fields (with sensible defaults where appropriate)
3. Forward auth tokens (identity token + API keys) to all services
4. Validate payload locally before sending to avoid unnecessary 400s

### Domains to Fix (Priority Order)

| Priority | Domain | Agents | Issue | Impact |
|----------|--------|--------|-------|--------|
| P0 | costops | attribution, forecast, budget, roi, tradeoff | Missing required fields | No cost analysis |
| P0 | copilot | planner, decomposer, clarifier, intent, config, reflection, meta-reasoner | Missing API key | No AI planning |
| P0 | platform | decision, executive-summary, decision-memo, risk-score | Missing required fields | No decision support |
| P1 | simulator | what-if, scenario | Missing simulation context | No scenario modeling |
| P1 | research-lab | hypothesis, metrics | Missing backend URL | No research analysis |
| P1 | governance-dashboard | audit, impact, oversight | Missing execution context | No governance |
| P1 | connector-hub | erp-surface, database-query, webhook-ingest, event-normalize, auth-identity | Schema mismatch | No ERP integration |
| P2 | orchestrator | workflow, scheduler, dependencies, retry, parallel, state-machine, swarm | Missing structured input | No workflow orchestration |
| P2 | sentinel | anomaly, drift, alert, correlation, rca | Missing telemetry data | No monitoring |
| P2 | observatory | telemetry, usage-patterns, failures, health-check, slo, post-mortem, visualization | Missing metrics data | No observability |
| P2 | test-bench | benchmark, compare, regression, quality, hallucination, faithfulness, bias, etc. | Server-side bugs | No evaluation |
| P3 | shield | prompt-injection (works), pii, secrets, toxicity, moderation, abuse, redaction, safety-boundary, credential-exposure | Partial — some work | Partial security |
| P3 | edge | tool-invoke, circuit-breaker, failover, execution-guard, caching | Missing tool context | No edge computing |
| P3 | auto-optimizer | token, model-select, self-optimize | Missing optimization context | No auto-optimization |
| P3 | Others | memory-graph, latency-lens, forge, incident-manager, policy-engine, registry, marketplace, analytics-hub, config-manager, schema-registry, inference-gateway, benchmark-exchange, data-vault | Various | Various |

### Auth Token Forwarding

The CLI must send GCP identity tokens to all Cloud Run services:

```typescript
// In adapter.invoke():
const token = await getGCPIdentityToken(config.baseUrl);
headers['Authorization'] = `Bearer ${token}`;
```

Currently only some adapters do this. All Cloud Run services require it.

### Validation Before Send

Add local pre-validation to catch schema mismatches before hitting the network:

```typescript
// In buildDomainPayload():
const payload = buildCostopsPayload(agent, text, correlationId);
const valid = DOMAIN_SCHEMAS[domain]?.[agent]?.safeParse(payload);
if (!valid?.success) {
  console.warn(`[payload] ${domain}/${agent} payload validation failed locally: ${valid?.error.message}`);
}
```

## Consequences

- (+) Fixing payload schemas activates 27 deployed Cloud Run services
- (+) Real cloud agent analysis replaces synthetic local fallback
- (+) Cost analysis, security scans, governance checks become real
- (+) Pipeline output quality dramatically improves
- (-) Requires auditing each domain's Zod schema (27 domains × 1-7 agents)
- (-) Cloud functions may need cold-start optimization (first call slow)
- (-) API key management becomes critical (Anthropic key for LLM agents)

## Verification

After ADR-066 implementation, verify:
```bash
# Test each domain returns 200 (not 400/500)
for domain in costops copilot platform simulator shield sentinel; do
  agentics agents invoke $domain attribution '{"text":"test"}' --verbose
done

# Check fallback rate drops from ~90% to <10%
agentics ask "test query" --verbose 2>&1 | grep -c '\[FB\]'
```

## Audit References

- "110 agents dispatched but most fall back to local compute"
- "Don't think they're actually being used — looks like a show"
- CQ: Local fallback produces synthetic results, not real analysis
- SI: Simulation integrity degraded by synthetic agent responses
