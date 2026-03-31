# ADR-069: Cloud Run Deployment Configuration Hardening

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

Production readiness audit (2026-03-31) found three deployment configuration issues:

1. **Unresolved placeholders**: `cloud-run-service.yaml` contains `IMAGE_URL` and `PROJECT_ID` placeholders that must be substituted before deployment. No automated substitution step exists in the Makefile or CI pipeline.

2. **Missing health probes**: The application exposes `/health/healthz` (liveness) and `/health/readyz` (readiness with downstream dependency checks) endpoints, but `cloud-run-service.yaml` does not reference them. Cloud Run will use TCP-based health checks by default, which only verify the port is open — not that the application can serve requests or reach its dependencies.

3. **Insufficient memory allocation**: The service is configured with 512MB memory. The Node.js runtime (~150-200MB baseline) plus the Rust optimizer subprocess (spawned via `child_process`) under concurrent load may exceed this. A single simulation with 8 suppliers × 5 scenarios triggers the Rust subprocess which allocates petgraph structures in memory.

## Decision

### 1. Add `envsubst` to the deployment pipeline

```makefile
# In Makefile deploy target
deploy:
	envsubst < cloud-run-service.yaml | gcloud run services replace -
```

Required environment variables:
- `IMAGE_URL` — full container image path (e.g., `gcr.io/$(PROJECT_ID)/climate-risk-api:$(VERSION)`)
- `PROJECT_ID` — GCP project ID
- `REGION` — deployment region (default: `us-central1`)

Add a validation step that fails if any placeholder remains unsubstituted:

```bash
# Pre-deploy check
if grep -q 'IMAGE_URL\|PROJECT_ID' rendered-service.yaml; then
  echo "ERROR: Unresolved placeholders in service YAML" && exit 1
fi
```

### 2. Configure liveness and readiness probes

```yaml
spec:
  template:
    spec:
      containers:
        - image: IMAGE_URL
          ports:
            - containerPort: 8080
          startupProbe:
            httpGet:
              path: /health/healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 10
          livenessProbe:
            httpGet:
              path: /health/healthz
              port: 8080
            periodSeconds: 15
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/readyz
              port: 8080
            periodSeconds: 10
            failureThreshold: 2
```

The readiness probe hits `/health/readyz` which checks PostgreSQL connectivity and (optionally) Oracle Fusion Cloud reachability. If a downstream dependency is down, Cloud Run stops routing traffic to that instance — the circuit breaker in `erp-client/client.ts` handles retries internally.

### 3. Increase memory to 1GB

```yaml
resources:
  limits:
    memory: 1Gi
    cpu: "1"
```

Rationale:
- Node.js baseline: ~150-200MB
- V8 heap under load: ~200-300MB
- Rust subprocess (petgraph + optimization): ~50-150MB per invocation
- Safety margin for concurrent requests: ~200MB
- Total estimated peak: ~700-800MB

For the pilot with limited concurrency, 1GB provides adequate headroom. Monitor actual usage via Cloud Run metrics and adjust.

### 4. Add resource request minimums

```yaml
resources:
  limits:
    memory: 1Gi
    cpu: "1"
  requests:
    memory: 512Mi
    cpu: "0.5"
```

This ensures Cloud Run allocates sufficient baseline resources and avoids cold-start throttling.

## Consequences

### Positive
- Deployment pipeline fails fast on configuration errors
- Cloud Run correctly routes traffic only to healthy instances
- Memory headroom prevents OOM kills during simulation workloads

### Negative
- `envsubst` requires environment variables to be set in CI — add them as GitHub Actions secrets or Cloud Build substitutions
- 1GB memory increases per-instance cost by ~2x (but prevents OOM-related restarts which are more expensive)

## Implementation Priority

**HIGH — Day 1 of pilot preparation.** Estimated effort: 1-2 hours.

## Related ADRs
- ADR-063: Deployment Artifacts and Dockerfile
