# ADR-078: Build-Time Platform Service Usage During Pipeline Execution

## Status: IMPLEMENTED

## Date: 2026-03-31

## Context

The pipeline currently uses `agentics ask` to invoke agents for planning and architecture guidance during code generation. But it doesn't use the platform's build-time services for what they're designed for: quality validation, stress testing, SDK generation, latency profiling, and hypothesis verification.

The pipeline generates code, runs `tsc` and `vitest`, and ships. It never asks Test-Bench "is this code quality acceptable?" It never asks Simulator "will this system handle 100 concurrent simulation requests?" It never asks Forge "generate typed Oracle Fusion Cloud clients from their OpenAPI spec." It never asks Latency-Lens "what's the cold start profile of this Cloud Run service?"

These services exist to catch problems before deployment. Not using them is like having a CI pipeline that compiles but never runs tests.

### Services Covered

| # | Service | Agents | What It Should Do During Pipeline Execution |
|---|---------|--------|---------------------------------------------|
| 1 | **LLM-Test-Bench** | 14 agents | Validate generated code quality. Red-team the API. Benchmark simulation performance. Generate golden datasets for regression testing. Detect hallucination in LLM-generated code comments/docs. |
| 6 | **LLM-Latency-Lens** | 2 agents | Profile simulation engine latency. Identify cold start bottlenecks. Establish p50/p95/p99 baselines before deployment. |
| 7 | **LLM-Forge** | 4 agents | Generate typed TypeScript and Rust clients for Oracle Fusion Cloud from their OpenAPI spec. Generate CLI commands. Ensure version compatibility across external API versions. |
| 21 | **LLM-CoPilot-Agent** | 7 agents | Already partially used via `agentics ask`. Should be used more deliberately: Planner for implementation strategy, Decomposer for breaking complex requirements into bounded contexts, Clarifier for resolving ambiguous requirements, Meta-Reasoner for evaluating whether the architecture is sound. |
| 22 | **LLM-Simulator** | 2 agents | Stress-test the generated system without incurring external API costs. Generate what-if scenarios to validate the scenario engine handles edge cases. Simulate Oracle Fusion Cloud responses for integration testing. |
| 23 | **LLM-Benchmark-Exchange** | 1 agent | Publish simulation engine benchmarks. Compare against community baselines for similar workloads. |
| 26 | **LLM-Research-Lab** | 2 agents | Validate domain hypotheses before they're baked into code (e.g., "does the Pareto frontier computation handle >100 scenarios efficiently?"). Track experimental metrics on alternative risk scoring algorithms. |
| 18 | **LLM-Config-Manager** | 1 agent | Validate all generated configuration files (cloud-run-service.yaml, Dockerfile, environment variables) before deployment. |
| 19 | **LLM-Schema-Registry** | 1 agent | Validate generated API schemas, event contracts, and telemetry schemas. Register schemas for runtime validation. |

## Decision

### 1. Pipeline phases must call build-time services

The pipeline currently runs roughly as:
```
Phase 1: DDD extraction → Phase 2: Architecture → Phase 3: Simulation → Phase 4: Codegen → Phase 5: Tests → Deploy
```

Insert platform service calls at each phase:

```
Phase 1: DDD extraction
  └─ CoPilot/Clarifier: resolve ambiguous requirements
  └─ CoPilot/Decomposer: validate bounded context boundaries

Phase 2: Architecture
  └─ CoPilot/Meta-Reasoner: evaluate architecture soundness
  └─ CoPilot/Planner: create implementation strategy
  └─ Research-Lab/Hypothesis: validate domain assumptions

Phase 3: Simulation design
  └─ Simulator/Scenario-Generator: generate edge-case scenarios
  └─ Research-Lab/Hypothesis: validate simulation methodology

Phase 4: Codegen
  └─ Forge/SDK-Generator: generate typed clients for external APIs (Oracle, BigQuery)
  └─ Forge/Version-Compatibility: validate external API version compatibility
  └─ Config-Manager/Validate: validate generated config files
  └─ Schema-Registry/Validate: validate generated API and event schemas

Phase 5: Testing & Validation
  └─ Test-Bench/Quality-Scoring: score generated code quality
  └─ Test-Bench/Red-Team: adversarial testing of API endpoints
  └─ Test-Bench/Hallucination-Detection: check LLM-generated docs/comments
  └─ Test-Bench/Regression-Detection: establish regression baselines
  └─ Test-Bench/Golden-Dataset-Validator: create golden datasets for ongoing validation
  └─ Simulator/What-If: stress-test without external API costs
  └─ Latency-Lens/Latency-Analysis: profile cold start and request latency
  └─ Latency-Lens/Cold-Start: identify cold start mitigation opportunities

Phase 6: Pre-deployment
  └─ Config-Manager/Validate: final config validation
  └─ Benchmark-Exchange/Publish: publish benchmarks to platform leaderboard
  └─ Test-Bench/Benchmark-Runner: run full benchmark suite, compare against baselines
```

### 2. Forge replaces hand-built external API clients

The generated `erp-client/client.ts` is 331 lines of hand-built Oracle Fusion Cloud client code. Forge's SDK Generator agent can produce typed clients from Oracle's OpenAPI spec, with:
- Complete type coverage (not just the handful of endpoints the hand-built client covers)
- Version compatibility checking when Oracle releases new API versions
- Automatic regeneration when specs change

```bash
# During Phase 4 codegen
agentics agents invoke forge sdk '{"spec_url":"oracle-fusion-cloud-openapi.json","language":"typescript","output":"src/erp-client/generated/"}'
```

### 3. Test-Bench validates before deployment, not just unit tests

Unit tests verify the code works as written. Test-Bench verifies the code is *good*:

```bash
# Quality scoring on generated code
agentics agents invoke test-bench quality '{"path":"src/","language":"typescript"}'

# Red-team the API endpoints
agentics agents invoke test-bench red-team '{"target":"http://localhost:8080/api/v1/","focus":"injection,auth_bypass,data_leak"}'

# Generate golden datasets for regression testing
agentics agents invoke test-bench golden-dataset '{"domain":"climate_risk","scenarios":["baseline","rcp45","rcp85"]}'

# Benchmark simulation engine
agentics agents invoke test-bench benchmark '{"target":"scenario_orchestrator","iterations":100}'
```

### 4. Simulator validates without external costs

Instead of needing a live Oracle Fusion Cloud connection for integration testing:

```bash
# Simulate Oracle responses for integration testing
agentics agents invoke simulator scenario '{"system":"oracle_fusion","scenarios":["success","timeout","rate_limit","schema_mismatch"]}'

# Stress-test concurrent simulation runs
agentics agents invoke simulator what-if '{"target":"simulation_api","concurrent_users":50,"duration":"5m"}'
```

### 5. Latency-Lens establishes baselines

Before deployment, know what performance looks like:

```bash
# Profile cold start
agentics agents invoke latency-lens cold-start '{"target":"cloud-run-service","region":"us-central1"}'

# Profile per-endpoint latency
agentics agents invoke latency-lens latency '{"endpoints":["/api/v1/climate/simulate","/api/v1/climate/supplier-impact/1/baseline"],"iterations":50}'
```

### 6. Some build-time services also run at runtime

Test-Bench, Latency-Lens, Simulator, and Research-Lab are also useful at runtime for continuous validation:

| Service | Runtime Use |
|---|---|
| Test-Bench/Regression-Detection | Compare current simulation outputs against golden datasets on a schedule |
| Test-Bench/Output-Consistency | Verify determinism — same inputs should produce same outputs |
| Latency-Lens/Latency-Analysis | Continuous p50/p95/p99 tracking per endpoint |
| Simulator/What-If | Users can ask "what if" questions that generate scenarios dynamically |
| Research-Lab/Experimental-Metric | A/B test different risk scoring approaches in production |

## Consequences

### Positive
- Code quality is validated by the platform, not just unit tests
- API security is red-teamed before deployment
- External API clients are generated from specs, not hand-built
- Performance baselines are established before users see the system
- Golden datasets enable ongoing regression detection
- Stress testing happens without incurring external API costs

### Negative
- Pipeline execution time increases (mitigated by parallel service calls)
- Forge-generated clients may need domain-specific customization
- Test-Bench quality thresholds need calibration per domain

## Implementation Priority

**HIGH — Days 2-4.** Most impactful first:
1. Forge for Oracle client generation (replaces 331 lines of hand-built code)
2. Test-Bench red-team + quality scoring (catch problems before deployment)
3. Latency-Lens profiling (establish baselines)
4. Simulator stress testing (validate at scale)

## Related ADRs
- ADR-074: Pipeline Must Use the Full Agentics Platform
- ADR-067: LLM-Driven Code Generation
