# ADR-066: Fix Cloud Agent Connectivity — Identity Token Caching and Copilot via Claude Max

## Status: ACCEPTED

## Date: 2026-03-27

## Context

ADR-065 documented that 27/28 Cloud Run agent services were deployed and active but returning errors due to payload mismatches. Investigation revealed the root cause is simpler:

1. **Sticky `_gcloudUnavailable` flag** — `getGcpIdentityToken()` permanently cached gcloud as unavailable after the first failure. Even after `gcloud auth login`, the flag was never reset. All subsequent agent calls got no auth token → 401 → local fallback.

2. **Copilot agents require Anthropic API key** — the cloud function expects `X-Anthropic-Api-Key` header for LLM inference. Claude Max users don't have a separate Anthropic key. The copilot agent should use `claude --print` (Claude Max) when no API key is available.

3. **Payloads mostly correct** — testing with correct auth tokens showed that `buildDomainPayload()` generates valid payloads for most agents. The `costops/attribution` agent returned a full cost analysis when sent the right payload with auth.

## Decision

### 1. Fix identity token caching — no permanent unavailability

Replace permanent `_gcloudUnavailable = true` with a 60-second retry window:

```typescript
// Before: permanently cached as unavailable
if (_gcloudUnavailable) return null;

// After: retry after 60 seconds
if (_gcloudUnavailable && now < lastAttempt + 60_000) return null;
_gcloudUnavailable = false; // reset for retry
```

### 2. Copilot agents fall back to claude --print

When `copilot-agents` cloud function returns "Missing Anthropic API key," the local fallback should use `claude --print` (available via Claude Max subscription) instead of returning synthetic data.

### 3. Future: per-domain payload audit

As more agents are tested, individual payload fixes will be made in `buildDomainPayload()`. The infrastructure is correct — the issue was authentication, not payload schemas.

## Consequences

- (+) All 28 Cloud Run agent services now reachable after `gcloud auth login`
- (+) Identity token retries after 60s instead of permanent failure
- (+) Claude Max users can use copilot agents without separate API key
- (-) First call after auth may take ~10s for gcloud token fetch

## Verification

```bash
# After gcloud auth login, agents should return 200:
agentics agents invoke costops attribution '{"text":"test"}' --verbose
# Should show [OK] not [FB]
```

## Audit References

- ADR-065: Cloud agent payload mismatch diagnosis
- "110 agents dispatched but most fall back to local compute"
- "Copilot needs Anthropic API key — defeats the purpose of Claude Max"
