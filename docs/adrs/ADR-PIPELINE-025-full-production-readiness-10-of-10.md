# ADR-PIPELINE-025: Full Production Readiness — All Categories to 10/10

**Status:** Accepted
**Date:** 2026-04-09
**Priority:** CRITICAL — Business-blocking. Cloud costs accumulating without customer conversion.

## Context

After 7 months of development (since 2024-09-01), pipeline output scores remain at 6.3/10 overall. Individual category scores across multiple runs:

| Category | Run 1 | Run 2 | Run 3 | Run 4 | Target |
|----------|-------|-------|-------|-------|--------|
| Code Quality | 6 | 3 | 8 | 7.5 | **10** |
| Architecture | 7 | 6 | 7 | 7.0 | **10** |
| Governance | 7 | 5 | 5 | 8.0 | **10** |
| Simulation Alignment | 5 | 4 | 6 | 6.0 | **10** |
| ERP Readiness | 5 | 2 | 3 | 5.5 | **10** |
| Observability | 6 | 4 | 4 | 5.0 | **10** |
| Executive Output | — | — | 4 | 3.5 | **10** |

The gap is not in any single category — it's systemic. Every category has known fixes that haven't been implemented. This ADR covers ALL of them.

## Decision: Category-by-Category Fixes

### 1. CODE QUALITY (7.5 → 10)

**1a. Codegen must emit Zod validation at every external boundary**

The anti-corruption layer in generated code trusts external data without parsing. Every ERP client adapter must call `.safeParse()` on inbound data.

In `src/pipeline/phase3/phases/domain-codegen.ts`, the ACL/adapter template must include:
```typescript
// Generated anti-corruption layer
const parsed = ExternalDataSchema.safeParse(rawData);
if (!parsed.success) {
  throw new DomainValidationError('External data validation failed', parsed.error);
}
```

**1b. Codegen must emit a central config module**

Every generated project must include `src/config.ts` that:
- Reads ALL thresholds, weights, API URLs, and magic numbers from environment variables
- Provides typed defaults with documentation comments explaining each default
- Validates weights sum to 1.0 (for scoring systems)
- Is the ONLY source of configurable values — no inline constants

Add to `domain-codegen.ts` a `generateConfigModule()` function that scans the DDD model for scoring dimensions, thresholds, and configurable parameters.

**1c. Codegen must emit stronger tests**

Test generators must produce:
- Exact count assertions (not `toBeGreaterThanOrEqual`)
- Negative tests (invalid inputs, unknown enums, boundary values)
- Domain-specific assertions (not just "result exists" but "score is between 0 and 100")
- Integration tests that validate the full pipeline from input to recommendation

**1d. Codegen must emit typed error classes**

Every generated project must include `src/errors.ts` with domain-specific error types:
```typescript
export class DomainValidationError extends Error { ... }
export class ERPIntegrationError extends Error { ... }
export class GovernanceViolationError extends Error { ... }
```

### 2. ARCHITECTURE (7.0 → 10)

**2a. Every generated project must have environment-based configuration**

No hardcoded URLs, credentials, thresholds, or magic numbers. The codegen must:
- Emit a `.env.example` with all required variables
- Use `process.env.VARIABLE ?? default` pattern consistently
- Document each variable in the config module

**2b. Architecture documentation must match implementation**

The SPARC Architecture.md must be generated AFTER code generation, not before. It should reflect what was actually built — not a planning document with empty columns.

Alternatively, a post-generation pass should reconcile the architecture document against the actual file tree and update service capabilities/dependencies.

**2c. Integration stubs must be clearly marked**

ERP client methods that return empty arrays (mocks) must:
- Include a `// TODO: Replace with real ${SystemName} API call` comment
- Log a warning when called: `console.warn('[STUB] readTelemetry() returning mock data')`
- Accept a `MOCK_MODE` environment variable that enables/disables stubs

### 3. GOVERNANCE (8.0 → 10)

**3a. Role enforcement must be real**

The governance gate checks `requiredApproverRole` but never validates the actor's role. Fix:
- Add `actorRoles: string[]` to the approval request
- Validate `actorRoles.includes(requiredApproverRole)` before allowing approval
- Reject with clear error: "Actor lacks required role: ColdChainManager"

**3b. Approval expiration must be enforced**

Add `isExpired()` check:
```typescript
isExpired(): boolean {
  const elapsed = Date.now() - this.submittedAt.getTime();
  return elapsed > this.expirationMs;
}
```
Call this in `reviewApproval()` and `executeApproved()`. Expired approvals auto-transition to 'expired' status.

**3c. Multi-level approval for high-impact decisions**

When estimated impact exceeds a configurable threshold (e.g., >$50K annual), require additional approval level. The governance gate should support an `approvalChain: string[]` where each role must approve in sequence.

### 4. SIMULATION ALIGNMENT (6.0 → 10)

**4a. Simulation must produce domain-specific financial data**

The enterprise simulation engine returns a generic pass-through with `success: true` and no financial fields. The simulation must extract financial projections from the what-if agent and planner agent results and embed them in the simulation result:

```json
{
  "success": true,
  "result": { ... },
  "financial_projection": {
    "estimated_annual_savings": "$216K",
    "estimated_investment": "$2.8M",
    "payback_period": "14 months",
    "npv_5year": "$8.75M"
  }
}
```

This data must come from agent results (what-if, planner, costops) — not be hardcoded.

**4b. Success probability must have decomposition**

The 88% success probability is asserted without methodology. Add a decomposition:
```json
{
  "success_probability": 0.88,
  "decomposition": {
    "technical_feasibility": 0.92,
    "organizational_readiness": 0.85,
    "data_availability": 0.88,
    "integration_complexity": 0.87
  },
  "methodology": "Weighted average of 4 dimensions, calibrated by simulation coverage"
}
```

### 5. ERP READINESS (5.5 → 10)

**5a. Replace regex-based system detection with string matching**

Regex sucks for this. Replace the dynamic extraction patterns in `tech-stack-detector.ts` with a simple string-matching approach:

```typescript
function extractSystemFromPrompt(text: string): string | null {
  // Look for "managed through/by/with/via/using SYSTEM_NAME"
  // Use indexOf + substring instead of regex
  const triggers = ['managed through ', 'managed by ', 'managed via ', 'managed with ',
    'managed using ', 'managed in ', 'operations are managed through ',
    'inside ', 'records inside ', 'plans inside ', 'actions inside '];
  
  const lower = text.toLowerCase();
  for (const trigger of triggers) {
    const idx = lower.indexOf(trigger);
    if (idx === -1) continue;
    const after = text.substring(idx + trigger.length).trim();
    // Take words until we hit a period, comma, newline, or lowercase word
    const words: string[] = [];
    for (const word of after.split(/\s+/)) {
      if (word.match(/^[a-z]/) && words.length > 0) break; // lowercase word = end of system name
      if (word.match(/[.,;:\n]$/)) { words.push(word.replace(/[.,;:\n]+$/, '')); break; }
      words.push(word);
      if (words.length >= 4) break; // max 4 words for system name
    }
    const name = words.join(' ').trim();
    if (name.length >= 3 && name.length <= 50) return name;
  }
  return null;
}
```

This handles "Manhattan Active ERP", "Shopify Plus", "Infor CloudSuite", "Yardi Voyager" — any system name the user writes after a trigger phrase.

**5b. ERP surface must use the detected system name**

The ERP surface analysis must use the prompt-detected system name throughout, not default to SAP/Oracle. When the system is not in the known registry, the surface analysis should:
- State clearly: "Target system: Manhattan Active ERP (not in pre-configured registry)"
- List generic integration patterns applicable to any REST API system
- Flag that system-specific API documentation is required for detailed mapping

**5c. NLP extraction for system names in ALL renderers**

Every renderer that references "the target platform" or "enterprise platform" must use the extracted system name. Add a `primarySystem` field to `ExtractedScenario` that uses the string-matching extractor above.

### 6. OBSERVABILITY (5.0 → 10)

**6a. Codegen must emit structured logging**

Every generated project must include a logger module that:
- Emits JSON with `{ level, timestamp, correlationId, component, message, data }`
- Supports log levels (debug, info, warn, error)
- Injects correlation IDs matching the audit trail
- Is configurable via `LOG_LEVEL` environment variable

**6b. Codegen must emit health check endpoints**

When an HTTP API is generated, include:
- `GET /health` — returns `{ status: 'ok', timestamp, uptime }`
- `GET /health/ready` — checks database + ERP connectivity
- `GET /health/live` — lightweight liveness probe

**6c. Codegen must emit retry logic in ERP clients**

ERP client adapters must include:
- Exponential backoff with jitter (3 retries, 1s/2s/4s base)
- Circuit breaker (5 failures in 60s → open for 30s)
- Timeout configuration via environment variable
- Error classification (retryable vs. non-retryable)

**6d. Codegen must emit metrics collection**

Generated projects must expose basic operational metrics:
- Recommendation count (total, by type)
- Approval latency (time from submission to decision)
- ERP writeback success rate
- Processing time per analysis run

### 7. EXECUTIVE OUTPUT QUALITY (3.5 → 10)

**7a. Financial analysis must generate real numbers when agents don't provide them**

When costops agents don't fire OR the simulation doesn't produce financial fields, the renderer must estimate from query context:

```typescript
function estimateFinancials(query: string, extracted: ExtractedScenario): FinancialData {
  // Extract employee count from query
  const empMatch = query.match(/(\d[\d,]*)\s*employees/i);
  const employees = empMatch ? parseInt(empMatch[1].replace(/,/g, '')) : 10000;
  
  // Industry-based estimation
  const pilotCost = Math.round(employees * 15); // $15/employee for pilot
  const annualSavings = Math.round(employees * 50); // $50/employee potential savings
  const paybackMonths = Math.round((pilotCost / (annualSavings / 12)));
  
  return {
    budget: `$${(pilotCost / 1000).toFixed(0)}K - $${(pilotCost * 2 / 1000).toFixed(0)}K (estimated)`,
    roi: `${Math.round((annualSavings / pilotCost) * 100)}% (projected)`,
    npv: `$${(annualSavings * 3.5 / 1000000).toFixed(1)}M (5-year, 10% discount)`,
    payback: `${paybackMonths}-${paybackMonths + 6} months (estimated)`,
    revenue: `$${(annualSavings / 1000).toFixed(0)}K annual savings potential`,
    costSavings: '',
    hasData: true,
  };
}
```

These are estimates clearly labeled as such. They give a CFO something to react to instead of "To be quantified."

**7b. System name must appear in every document**

Replace ALL instances of:
- "the target platform" → the detected system name
- "enterprise platform" → the detected system name
- "Target systems: To be identified" → the detected system name
- "Employees" (as stakeholder placeholder) → actual role names from stakeholder extraction

**7c. Security assessment must include applicable regulations**

Detect from query context:
- Pharmaceutical → FDA 21 CFR Part 11, EU GxP Annex 11, GDP
- Healthcare → HIPAA, HITECH
- Financial → SOX, PCI-DSS
- EU operations → GDPR
- Multi-region → data residency requirements per jurisdiction

Generate a regulations table with applicability assessment.

**7d. Integration assessment must reference the correct system**

Use the string-matching extractor to get the system name, then:
- Reference the system by name throughout
- List generic REST API integration patterns
- Flag that detailed API mapping requires system documentation
- Never say "Target systems: To be identified" when the user named the system

**7e. Cross-document consistency**

All documents must use the same:
- System name (from extractor)
- Financial figures (from shared `extractFinancials` + `estimateFinancials`)
- Risk register (from shared `generateDomainRisks`)
- Success probability (from shared `extractSuccessProbability`)
- Timeline (from simulation or default)
- Stakeholder names (from NLP extraction, not "Employees")

## Files to Change

### Pipeline / Detection
- `src/pipeline/phase2/phases/tech-stack-detector.ts` — Replace regex with string matching for dynamic ERP extraction
- `src/pipeline/phase2/phases/adr-generator.ts` — Same string-matching fix for ERP name in ADRs
- `src/synthesis/simulation-renderers.ts` — Add `estimateFinancials()`, fix system name in all renderers, add regulation detection, fix integration assessment

### Simulation Engine
- `src/synthesis/simulation-artifact-generator.ts` — Extract financial projections from agent results into simulation output
- `src/synthesis/simulation-renderers.ts` — Add success probability decomposition

### Codegen Templates
- `src/pipeline/phase3/phases/domain-codegen.ts` — Emit config module, typed errors, Zod at boundaries, stronger tests, structured logging, health checks, retry logic, metrics
- `src/pipeline/phase4/phases/http-server-generator.ts` — Emit health endpoints, structured logging middleware, env-based config
- Test generators — Exact assertions, negative tests, domain-specific checks

## Success Criteria

After implementation, every pipeline run must score:
- Code Quality: 9+ (typed, validated, tested, configurable)
- Architecture: 9+ (env-configured, documented, clean boundaries)
- Governance: 9+ (role-enforced, expiration-checked, multi-level)
- Simulation Alignment: 8+ (financial data flows, probability decomposed)
- ERP Readiness: 8+ (correct system identified, generic patterns when unknown)
- Observability: 8+ (structured logging, health checks, retry, metrics)
- Executive Output: 8+ (real numbers, correct system name, regulations, consistency)
- **Overall: 8.5+**

## Consequences

- [+] Pipeline output is enterprise-deployable without manual remediation
- [+] Executive documents are boardroom-ready with real financial estimates
- [+] Any ERP/platform mentioned in the prompt is correctly identified without hardcoding
- [+] Generated code compiles, passes tests, and includes production infrastructure
- [-] Financial estimates are labeled projections — customers must validate against actuals
- [-] Codegen templates grow more complex (~500 additional lines)
- [-] Unknown systems get generic integration patterns, not system-specific API mappings
