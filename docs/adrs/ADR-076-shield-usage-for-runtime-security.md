# ADR-076: Shield Usage for Runtime Security

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

LLM-Shield (Phase 1) is deployed on GCP with 9 agents:
- **Prompt Injection Detection Agent**
- **PII Detection Agent**
- **Secrets Leakage Agent**
- **Toxicity Detection Agent**
- **Content Moderation Agent**
- **Model Abuse Detection Agent**
- **Credential Exposure Agent**
- **Safety Boundary Agent**
- **Data Redaction Agent**

The generated application validates request shapes with Zod schemas and the ERP mapper has regex-based PII redaction for SSN/passport/credit card patterns. But there is no content-level security scanning. A user can submit a simulation request with prompt injection in a supplier name field, PII in a description field, or leaked credentials in a contract notes field — and it passes through to processing, ERP writeback, and audit logs.

Shield exists precisely for this. It's deployed. Its agents are running. The generated code just doesn't call it.

### Specific Gaps

1. **No prompt injection scanning.** If any field in a simulation request contains injection payloads, they flow through to any downstream LLM call or logged output unchecked.
2. **PII detection is regex-only.** The mapper catches SSN and credit card patterns, but misses names, addresses, phone numbers, medical information, and non-US PII formats. Shield's PII agent handles all of these.
3. **No secrets scanning on ERP payloads.** A writeback payload could contain API keys, tokens, or passwords in free-text fields. Shield's Secrets Leakage agent catches these.
4. **No content moderation on outputs.** Simulation results and executive summaries are returned to users without any content check.

## Decision

### 1. Use Shield as the security scanning layer at API boundaries

Shield is a "must have" tier service (ADR-074). Generated code must call Shield at two points:

**Inbound — scan all user-supplied input before processing:**

```typescript
// Middleware: scan request bodies through Shield before route handlers execute
app.use('/api/v1/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    const body = await c.req.text();
    const scanResult = await callPlatformService(
      process.env.AGENTICS_SHIELD_URL,
      '/api/v1/scan',
      {
        content: body,
        checks: ['prompt_injection', 'pii', 'secrets', 'credential_exposure'],
        context: { endpoint: c.req.path, method: c.req.method },
      }
    );

    if (scanResult.blocked) {
      // Shield found something — reject the request
      return c.json({
        error: 'Request blocked by security policy',
        reasons: scanResult.findings.map(f => f.type),
        correlationId: c.get('correlationId'),
      }, 422);
    }

    // If Shield detected PII but didn't block, attach redacted version
    if (scanResult.redacted) {
      c.set('redactedBody', scanResult.redactedContent);
    }
  }
  await next();
});
```

**Outbound — scan ERP writeback payloads before they leave the system:**

```typescript
// In ERP client, before sending to Oracle
async sendToOracle(payload: unknown): Promise<void> {
  const scanResult = await callPlatformService(
    process.env.AGENTICS_SHIELD_URL,
    '/api/v1/scan',
    {
      content: JSON.stringify(payload),
      checks: ['pii', 'secrets', 'credential_exposure'],
      context: { destination: 'oracle_fusion', operation: 'writeback' },
    }
  );

  if (scanResult.blocked) {
    throw new SecurityError(
      `ERP writeback blocked: ${scanResult.findings.map(f => f.type).join(', ')}`
    );
  }

  // Proceed with (possibly redacted) payload
  const safePayload = scanResult.redacted ? scanResult.redactedContent : payload;
  await this.oracleClient.post(safePayload);
}
```

### 2. Shield is a blocking dependency

Unlike Observatory or CostOps, Shield is **not fire-and-forget**. If Shield is unavailable:
- **Block the request.** Return 503 Service Unavailable.
- **Do not process unscanned input.** The risk of processing injected/leaked content is higher than the cost of a temporary outage.
- **Log the Shield unavailability** as an incident (via Incident-Manager if available, locally otherwise).

### 3. Shield replaces local PII regex, not Zod validation

Zod validates structure (correct types, required fields, string lengths). Shield validates content (is this text safe to process). They're complementary:

- **Keep Zod** — structural validation at the boundary
- **Keep mapper PII regex** — defense-in-depth for the ERP-specific path
- **Add Shield** — comprehensive content scanning that catches what regex misses

### 4. Codegen prompt must specify Shield usage

```
SECURITY REQUIREMENT: All generated API endpoints that accept user input (POST/PUT/PATCH)
MUST scan request bodies through Shield before processing. All outbound payloads to external
systems (ERP, webhooks, etc.) MUST be scanned through Shield before transmission.

Shield is available at AGENTICS_SHIELD_URL. It is a blocking dependency — if Shield is
unavailable, return 503. Do not process unscanned input.
```

## Consequences

### Positive
- Prompt injection, PII leakage, secrets exposure, and credential leaks are caught at the boundary
- Shield's 9 agents cover security scenarios that regex and Zod cannot
- ERP writebacks to Oracle are scanned before leaving the system
- Security posture is consistent across all generated applications

### Negative
- Shield is on the request critical path — adds latency to every mutation request
- Shield unavailability blocks all mutation operations (by design, but has availability implications)
- Need to define what constitutes a "block" vs "warn" per scan type

## Implementation Priority

**CRITICAL — Days 1-2.** Shield is deployed and running. The generated code needs inbound and outbound scanning middleware. Estimated effort: 3-4 hours for the middleware + codegen prompt update.

## Related ADRs
- ADR-074: Pipeline Must Use Platform Services
- ADR-068: Domain Route RBAC and Telemetry Parity (Shield middleware sits in the same chain)
- ADR-049: RBAC Enforcement, Governance Gating, and Immutable Audit Trail
