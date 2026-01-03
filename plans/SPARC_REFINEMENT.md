# SPARC Refinement: agentics-cli Governance Document

| Attribute       | Value                                      |
|-----------------|--------------------------------------------|
| Version         | 1.0.0                                      |
| Date            | 2026-01-03                                 |
| Status          | DRAFT                                      |
| Classification  | Technical Governance - Internal            |
| Document Owner  | Architecture Review Board                  |
| Review Cycle    | Quarterly                                  |

---

## 1. Executive Summary

This document establishes the technical governance framework for agentics-cli, defining strict guardrails to ensure the CLI remains a **pure coordination layer**. The CLI acts exclusively as a thin orchestration interface that routes commands to downstream services without implementing business logic, data transformation, or intelligent processing.

**Core Principle**: agentics-cli is a **passthrough coordinator**, not a processing engine.

---

## 2. Version Compatibility Rules

### 2.1 Semantic Versioning Policy

agentics-cli follows [Semantic Versioning 2.0.0](https://semver.org/):

| Version Component | Increment Criteria                                      |
|-------------------|---------------------------------------------------------|
| MAJOR (X.0.0)     | Breaking CLI interface changes, removed commands        |
| MINOR (0.X.0)     | New commands, new flags, backward-compatible features   |
| PATCH (0.0.X)     | Bug fixes, documentation updates, dependency patches    |

### 2.2 Downstream Version Compatibility Matrix

```
+-------------------+------------------+------------------+------------------+
| agentics-cli      | claude-flow      | ruv-swarm        | flow-nexus       |
+-------------------+------------------+------------------+------------------+
| 1.0.x             | >=2.0.0 <3.0.0   | >=1.5.0 <2.0.0   | >=1.0.0 <2.0.0   |
| 1.1.x             | >=2.0.0 <3.0.0   | >=1.5.0 <2.0.0   | >=1.0.0 <2.0.0   |
| 2.0.x             | >=3.0.0 <4.0.0   | >=2.0.0 <3.0.0   | >=2.0.0 <3.0.0   |
+-------------------+------------------+------------------+------------------+
```

### 2.3 Breaking Change Detection Criteria

A change is **BREAKING** if it:

1. Removes or renames a command or subcommand
2. Removes or renames a required flag
3. Changes the semantics of an existing flag
4. Modifies exit codes for existing error conditions
5. Changes the structure of machine-readable output (JSON/YAML)
6. Removes support for a downstream service version

### 2.4 Deprecation Timeline Requirements

```
Phase 1 (MINOR release): Deprecation warning emitted to stderr
Phase 2 (MINOR+1):       Warning promoted to visible notice
Phase 3 (MAJOR):         Feature removed
```

**Minimum deprecation period**: 6 months or 2 MINOR releases, whichever is longer.

### 2.5 Version Negotiation Protocol

```
CLI Startup Sequence:
1. Parse command and flags
2. Determine target downstream service
3. Query downstream service version endpoint (if available)
4. Validate compatibility against matrix
5. If incompatible:
   - Exit with code 78 (ECONFIG)
   - Emit structured error with version requirements
6. If compatible: Proceed with command execution
```

---

## 3. Dependency Graph Enforcement

### 3.1 Allowed Dependency Categories

| Category          | Examples                                   | Justification            |
|-------------------|--------------------------------------------|--------------------------|
| Standard Library  | `fs`, `path`, `child_process`, `crypto`    | Core Node.js runtime     |
| HTTP Client       | `node-fetch`, `undici`                     | Service communication    |
| CLI Framework     | `commander`, `yargs`, `clipanion`          | Command parsing          |
| Schema Validation | `zod`, `ajv` (schema-only)                 | Input validation         |
| Output Formatting | `chalk`, `ora`, `cli-table3`               | User experience          |
| Configuration     | `dotenv`, `cosmiconfig`                    | Environment handling     |

### 3.2 Forbidden Dependency Patterns

The following dependency categories are **EXPLICITLY FORBIDDEN**:

```
FORBIDDEN:
  - Machine Learning: tensorflow, onnx, pytorch, transformers
  - Data Processing: pandas, numpy, lodash (heavy utilities)
  - Databases: pg, mysql, mongodb, redis (direct connections)
  - Caching: node-cache, lru-cache (beyond request scope)
  - Retry Libraries: async-retry, p-retry (delegate to downstream)
  - Circuit Breakers: opossum, cockatiel
  - ORM/ODM: prisma, typeorm, mongoose
  - Template Engines: handlebars, ejs, pug
  - Web Frameworks: express, fastify, koa
  - Queue Systems: bull, bee-queue
```

### 3.3 Dependency Audit Requirements

```yaml
Audit Schedule:
  - Pre-release: Full audit required
  - Weekly: Automated vulnerability scan
  - Monthly: License compliance review

Audit Tooling:
  - npm audit --audit-level=moderate
  - snyk test --severity-threshold=medium
  - license-checker --onlyAllow="MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC"

Blocking Criteria:
  - Any HIGH or CRITICAL vulnerability
  - Any GPL/LGPL/AGPL licensed dependency
  - Any dependency with no license
```

### 3.4 License Compatibility Requirements

```
ALLOWED Licenses:
  - MIT
  - Apache-2.0
  - BSD-2-Clause
  - BSD-3-Clause
  - ISC
  - CC0-1.0
  - Unlicense

FORBIDDEN Licenses:
  - GPL-2.0, GPL-3.0
  - LGPL-2.1, LGPL-3.0
  - AGPL-3.0
  - SSPL
  - Any "Commons Clause" licensed software
```

### 3.5 Supply Chain Security Requirements

```yaml
Requirements:
  - All dependencies must be from npm registry
  - Git dependencies are FORBIDDEN
  - URL dependencies are FORBIDDEN
  - Local file dependencies are FORBIDDEN
  - Package-lock.json must be committed and enforced
  - npm ci must be used in CI (not npm install)

Verification:
  - Enable npm package signing when available
  - Audit lockfile integrity on every build
  - Use SLSA Level 2 compliant build pipeline
```

---

## 4. Forbidden Call Paths

### 4.1 Explicit Anti-Patterns

The following operations are **FORBIDDEN** within agentics-cli:

#### 4.1.1 CLI MUST NOT: Validation Logic Beyond Schema

```typescript
// FORBIDDEN: Business rule validation
function validateUserCredits(user: User): boolean {
  return user.credits >= MINIMUM_CREDITS;
}

// ALLOWED: Schema validation only
const schema = z.object({
  credits: z.number().nonnegative()
});
```

#### 4.1.2 CLI MUST NOT: Optimization Routines

```typescript
// FORBIDDEN: Query optimization
function optimizeQuery(query: Query): OptimizedQuery {
  return applyIndexHints(reorderJoins(query));
}

// ALLOWED: Pass query to downstream as-is
async function executeQuery(query: Query): Promise<Result> {
  return await downstream.execute(query);
}
```

#### 4.1.3 CLI MUST NOT: ML Inference

```typescript
// FORBIDDEN: Local inference
function classifyIntent(text: string): Intent {
  return model.predict(text);
}

// ALLOWED: Delegate to downstream
async function classifyIntent(text: string): Promise<Intent> {
  return await aiService.classify(text);
}
```

#### 4.1.4 CLI MUST NOT: Data Transformation

```typescript
// FORBIDDEN: Data transformation
function transformResponse(data: RawData): FormattedData {
  return {
    ...data,
    timestamp: parseDate(data.timestamp),
    metrics: aggregateMetrics(data.metrics)
  };
}

// ALLOWED: Passthrough with optional field selection
function selectFields(data: RawData, fields: string[]): Partial<RawData> {
  return pick(data, fields);
}
```

#### 4.1.5 CLI MUST NOT: Business Rule Evaluation

```typescript
// FORBIDDEN: Business logic
function canUserAccessResource(user: User, resource: Resource): boolean {
  return user.role === 'admin' ||
         resource.ownerId === user.id ||
         user.permissions.includes(resource.requiredPermission);
}

// ALLOWED: Delegate to authorization service
async function checkAccess(userId: string, resourceId: string): Promise<boolean> {
  return await authService.checkAccess(userId, resourceId);
}
```

#### 4.1.6 CLI MUST NOT: Retry with Backoff

```typescript
// FORBIDDEN: Retry logic
async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      await sleep(Math.pow(2, i) * 1000);
    }
  }
  throw new Error('Max retries exceeded');
}

// ALLOWED: Single attempt, downstream handles retry
async function fetchOnce(url: string): Promise<Response> {
  return await fetch(url);
}
```

#### 4.1.7 CLI MUST NOT: Circuit Breaker Patterns

```typescript
// FORBIDDEN: Circuit breaker
const breaker = new CircuitBreaker(async () => {
  return await service.call();
}, { timeout: 3000, errorThresholdPercentage: 50 });

// ALLOWED: Timeout only (no state)
async function callWithTimeout(timeout: number): Promise<Result> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
```

#### 4.1.8 CLI MUST NOT: Caching Layers

```typescript
// FORBIDDEN: Response caching
const cache = new LRUCache({ max: 1000 });
async function fetchCached(key: string): Promise<Data> {
  if (cache.has(key)) return cache.get(key);
  const data = await fetch(key);
  cache.set(key, data);
  return data;
}

// ALLOWED: No caching, always fresh
async function fetchFresh(key: string): Promise<Data> {
  return await fetch(key);
}
```

### 4.2 Enforcement Mechanism

```yaml
Static Analysis Rules:
  - eslint-plugin-no-retry: Detect retry patterns
  - eslint-plugin-no-cache: Detect caching patterns
  - custom-rule-no-ml: Detect ML library imports
  - custom-rule-no-db: Detect database connections

Pre-commit Hooks:
  - Run forbidden pattern scanner
  - Block commits with violations

CI Pipeline:
  - Architectural fitness function tests
  - Dependency graph validation
  - Pattern detection scan
```

---

## 5. Error Semantics

### 5.1 Error Code Taxonomy

```
Error Code Format: ECLI-[CATEGORY]-[SPECIFIC]

Categories:
  ECLI-ARG-*    : Argument/flag errors
  ECLI-CFG-*    : Configuration errors
  ECLI-NET-*    : Network/connectivity errors
  ECLI-AUTH-*   : Authentication/authorization errors
  ECLI-SVC-*    : Downstream service errors
  ECLI-INT-*    : Internal CLI errors

Specific Codes:
  ECLI-ARG-001  : Missing required argument
  ECLI-ARG-002  : Invalid argument value
  ECLI-ARG-003  : Mutually exclusive arguments
  ECLI-CFG-001  : Missing configuration file
  ECLI-CFG-002  : Invalid configuration format
  ECLI-CFG-003  : Missing required environment variable
  ECLI-NET-001  : Connection refused
  ECLI-NET-002  : Connection timeout
  ECLI-NET-003  : DNS resolution failed
  ECLI-AUTH-001 : Missing credentials
  ECLI-AUTH-002 : Invalid credentials
  ECLI-AUTH-003 : Insufficient permissions
  ECLI-SVC-001  : Service unavailable
  ECLI-SVC-002  : Service returned error
  ECLI-SVC-003  : Service version incompatible
  ECLI-INT-001  : Unexpected internal error
```

### 5.2 Error Message Format Specification

```typescript
interface CLIError {
  code: string;           // ECLI-XXX-NNN format
  message: string;        // Human-readable message
  details?: string;       // Additional context
  hint?: string;          // Suggested remediation
  upstream?: {            // Passthrough from downstream
    service: string;
    code: string;
    message: string;
    trace_id?: string;
  };
  timestamp: string;      // ISO 8601 format
  version: string;        // CLI version
}
```

### 5.3 Error Context Requirements

All errors MUST include:

1. **Error code** from taxonomy
2. **Timestamp** in ISO 8601 format
3. **CLI version** that generated the error
4. **Trace ID** if available from downstream
5. **Hint** for user remediation when possible

### 5.4 Error Propagation Rules

```
Passthrough Semantics:
  1. Preserve upstream error code and message
  2. Wrap in CLI error structure
  3. Add CLI context (timestamp, version)
  4. Do NOT interpret or transform upstream errors
  5. Do NOT retry on upstream errors
  6. Do NOT suppress upstream errors

Example:
  Upstream returns: { "error": "rate_limit_exceeded", "retry_after": 60 }
  CLI emits: {
    "code": "ECLI-SVC-002",
    "message": "Downstream service returned error",
    "upstream": {
      "service": "claude-flow",
      "code": "rate_limit_exceeded",
      "message": "Rate limit exceeded, retry after 60 seconds"
    }
  }
```

### 5.5 Exit Code Mapping

```
Exit Code | Meaning                          | Category
----------|----------------------------------|----------
0         | Success                          | Success
1         | General error                    | Generic
2         | Misuse of command                | ECLI-ARG-*
64        | Command line usage error         | ECLI-ARG-*
65        | Data format error                | ECLI-CFG-*
66        | Cannot open input                | ECLI-CFG-*
69        | Service unavailable              | ECLI-SVC-*
70        | Internal software error          | ECLI-INT-*
74        | I/O error                        | ECLI-NET-*
75        | Temporary failure                | ECLI-NET-*
77        | Permission denied                | ECLI-AUTH-*
78        | Configuration error              | ECLI-CFG-*

Reserved for agentics-cli:
100-109   | Argument validation errors       | ECLI-ARG-*
110-119   | Configuration errors             | ECLI-CFG-*
120-129   | Network errors                   | ECLI-NET-*
130-139   | Authentication errors            | ECLI-AUTH-*
140-149   | Service errors                   | ECLI-SVC-*
150-159   | Internal errors                  | ECLI-INT-*
```

---

## 6. Guardrails Against Logic Creep

### 6.1 Code Review Checklist for PRs

Every PR MUST be reviewed against this checklist:

```markdown
## Coordination Layer Compliance Checklist

### Forbidden Patterns
- [ ] No retry logic with backoff
- [ ] No circuit breaker patterns
- [ ] No caching layers
- [ ] No ML inference
- [ ] No data transformation beyond field selection
- [ ] No business rule evaluation
- [ ] No database connections
- [ ] No queue processing

### Dependency Compliance
- [ ] No new forbidden dependencies
- [ ] All new dependencies from allowed categories
- [ ] License compliance verified
- [ ] No security vulnerabilities

### Architecture Compliance
- [ ] Function complexity under threshold
- [ ] Module size under limit
- [ ] No state persistence beyond request
- [ ] All downstream calls are passthrough

### Documentation
- [ ] CLI help text updated
- [ ] Error codes documented
- [ ] Breaking changes noted (if any)
```

### 6.2 Static Analysis Rules

```yaml
ESLint Configuration:
  rules:
    # Complexity limits
    complexity: ["error", 10]
    max-depth: ["error", 4]
    max-lines-per-function: ["error", 50]
    max-params: ["error", 4]

    # Forbidden patterns
    no-restricted-imports:
      - error
      - patterns:
          - group: ["tensorflow*", "onnx*", "pytorch*"]
            message: "ML libraries are forbidden in CLI"
          - group: ["pg", "mysql*", "mongodb", "redis"]
            message: "Database clients are forbidden in CLI"
          - group: ["bull", "bee-queue", "amqplib"]
            message: "Queue libraries are forbidden in CLI"

    no-restricted-syntax:
      - error
      - selector: "ForStatement"
        message: "Use array methods instead of for loops for clarity"
      - selector: "WhileStatement[test.type='Literal'][test.value=true]"
        message: "Infinite loops are forbidden"

Custom Rules:
  - no-retry-pattern: Detect exponential backoff implementations
  - no-cache-pattern: Detect LRU/TTL cache implementations
  - no-circuit-breaker: Detect circuit breaker patterns
  - no-state-persistence: Detect cross-request state
```

### 6.3 Architectural Fitness Functions

```typescript
// Fitness Function: No Heavy Dependencies
function testNoDependencyBloat(): void {
  const allowedCategories = ['cli', 'http', 'validation', 'formatting'];
  const dependencies = getDependencies();

  for (const dep of dependencies) {
    const category = categorizeDependency(dep);
    if (!allowedCategories.includes(category)) {
      throw new ArchitectureViolation(
        `Dependency ${dep} is not in allowed categories`
      );
    }
  }
}

// Fitness Function: No Business Logic
function testNoBusinessLogic(): void {
  const sourceFiles = glob('src/**/*.ts');

  for (const file of sourceFiles) {
    const ast = parse(file);
    const hasBusinessLogic = detectBusinessLogicPatterns(ast);

    if (hasBusinessLogic) {
      throw new ArchitectureViolation(
        `File ${file} contains business logic patterns`
      );
    }
  }
}

// Fitness Function: Pure Passthrough
function testPurePassthrough(): void {
  const httpCalls = findAllHttpCalls();

  for (const call of httpCalls) {
    const responseHandling = analyzeResponseHandling(call);

    if (responseHandling.transforms.length > 0) {
      throw new ArchitectureViolation(
        `HTTP response is transformed, should be passthrough`
      );
    }
  }
}
```

### 6.4 Complexity Metrics and Thresholds

```yaml
Thresholds:
  Cyclomatic Complexity:
    per-function: 10
    per-module: 50

  Cognitive Complexity:
    per-function: 15
    per-module: 100

  Lines of Code:
    per-function: 50
    per-module: 300
    per-file: 500

  Dependency Depth:
    max-depth: 3

  Coupling:
    max-afferent: 10
    max-efferent: 5

Enforcement:
  - Pre-commit: Warn on threshold approach (80%)
  - CI: Block on threshold violation
  - Monthly: Trend analysis and refactoring sprints
```

### 6.5 Line-of-Code Limits per Module

```
Module                          | Max LOC | Current | Status
--------------------------------|---------|---------|--------
src/cli/index.ts                | 200     | -       | -
src/cli/commands/*.ts           | 150     | -       | -
src/services/http.ts            | 100     | -       | -
src/services/downstream/*.ts    | 100     | -       | -
src/utils/*.ts                  | 100     | -       | -
src/config/*.ts                 | 100     | -       | -
src/errors/*.ts                 | 150     | -       | -

Total CLI Codebase Limit: 3000 LOC
```

---

## 7. Enterprise-Scale Considerations

### 7.1 Concurrent Execution Limits

```yaml
Defaults:
  max-concurrent-commands: 10
  max-concurrent-requests-per-service: 5
  request-queue-size: 100

Configuration:
  Environment Variables:
    AGENTICS_MAX_CONCURRENT: Override max-concurrent-commands
    AGENTICS_REQUEST_QUEUE: Override request-queue-size

  CLI Flags:
    --concurrency <n>: Per-invocation override

Behavior on Limit:
  - Queue excess requests (up to queue size)
  - Reject with ECLI-NET-003 when queue full
  - Log warning at 80% capacity
```

### 7.2 Rate Limiting Passthrough

```typescript
// Rate limit handling: PASSTHROUGH ONLY
interface RateLimitResponse {
  error: 'rate_limit_exceeded';
  retry_after: number;      // Seconds until retry allowed
  limit: number;            // Request limit
  remaining: number;        // Remaining requests
  reset: number;            // Unix timestamp of reset
}

// CLI behavior:
// 1. Detect rate limit response from downstream
// 2. Emit structured error with all rate limit info
// 3. Set exit code to 75 (temporary failure)
// 4. DO NOT retry automatically
// 5. DO NOT implement token bucket locally

async function handleResponse(response: Response): Promise<void> {
  if (response.status === 429) {
    const rateLimitInfo = await response.json();
    throw new CLIError({
      code: 'ECLI-SVC-002',
      message: 'Rate limit exceeded',
      upstream: rateLimitInfo,
      hint: `Retry after ${rateLimitInfo.retry_after} seconds`
    });
  }
}
```

### 7.3 Bulk Operation Patterns

```yaml
Supported Bulk Patterns:
  - Batch file input: --input-file <path>
  - Line-delimited JSON: --format ndjson
  - CSV input: --format csv --delimiter ","

Bulk Processing Behavior:
  - Stream input file (do not load entirely into memory)
  - Process items sequentially (no parallel by default)
  - Optional parallelism: --parallel <n>
  - Progress reporting: --progress
  - Continue on error: --continue-on-error
  - Error summary at end

Output Modes:
  - Stream results as processed: --stream
  - Collect and output at end: --collect
  - Write to file: --output-file <path>

Memory Constraints:
  - Max single item size: 10MB
  - Max output buffer: 100MB
  - Streaming required above thresholds
```

### 7.4 Timeout Configuration

```yaml
Timeout Hierarchy (in order of precedence):
  1. Command-line flag: --timeout <ms>
  2. Environment variable: AGENTICS_TIMEOUT
  3. Config file: timeout_ms
  4. Default: 30000 (30 seconds)

Granular Timeouts:
  AGENTICS_CONNECT_TIMEOUT: Connection establishment (default: 5000)
  AGENTICS_READ_TIMEOUT: Response read (default: 30000)
  AGENTICS_TOTAL_TIMEOUT: Total operation (default: 60000)

Timeout Behavior:
  - On timeout: Exit with code 75
  - Emit ECLI-NET-002 error
  - Include elapsed time in error
  - Abort in-flight requests cleanly
```

### 7.5 Resource Cleanup

```typescript
// Resource cleanup requirements
class CLIContext {
  private cleanupHandlers: Array<() => Promise<void>> = [];

  registerCleanup(handler: () => Promise<void>): void {
    this.cleanupHandlers.push(handler);
  }

  async cleanup(): Promise<void> {
    // Execute in reverse order (LIFO)
    for (const handler of this.cleanupHandlers.reverse()) {
      try {
        await handler();
      } catch (error) {
        // Log but don't throw during cleanup
        console.error('Cleanup error:', error);
      }
    }
  }
}

// Signal handling
process.on('SIGINT', async () => {
  await context.cleanup();
  process.exit(130); // 128 + SIGINT(2)
});

process.on('SIGTERM', async () => {
  await context.cleanup();
  process.exit(143); // 128 + SIGTERM(15)
});

// Cleanup requirements:
// - Close all HTTP connections
// - Flush any buffered output
// - Remove any temporary files
// - Release any file locks
```

---

## 8. Automation and CI Usage

### 8.1 Exit Code Specifications for CI Integration

```yaml
CI-Friendly Exit Codes:
  0:   Success - operation completed successfully
  1:   General failure - unspecified error
  2:   Invalid usage - wrong arguments/flags

  # Actionable failures (CI should fail build)
  64:  Usage error - command syntax incorrect
  65:  Data error - input data malformed
  77:  Permission error - authentication failed
  78:  Config error - configuration invalid

  # Retriable failures (CI may retry)
  69:  Service unavailable - downstream unreachable
  74:  I/O error - network issues
  75:  Temporary failure - rate limiting, timeouts

  # Internal errors (CI should alert)
  70:  Internal error - bug in CLI

CI Integration Patterns:

  # GitHub Actions
  - run: agentics-cli deploy --env production
    continue-on-error: false

  # GitLab CI
  script:
    - agentics-cli deploy --env production
  allow_failure: false
  retry:
    max: 2
    when:
      - runner_system_failure
      - stuck_or_timeout_failure
```

### 8.2 Machine-Readable Output Formats

```yaml
Supported Formats:
  --format json:    JSON output (default for piping)
  --format yaml:    YAML output
  --format csv:     CSV output (tabular data only)
  --format table:   Human-readable table (default for TTY)
  --format ndjson:  Newline-delimited JSON (streaming)

Format Detection:
  if (process.stdout.isTTY) {
    defaultFormat = 'table';
  } else {
    defaultFormat = 'json';
  }

JSON Output Structure:
  {
    "success": boolean,
    "data": <command-specific>,
    "metadata": {
      "timestamp": "ISO8601",
      "duration_ms": number,
      "version": "semver",
      "trace_id": "string"
    },
    "errors": [
      {
        "code": "ECLI-XXX-NNN",
        "message": "string",
        "details": "string"
      }
    ]
  }

CSV Output Requirements:
  - Header row always included
  - RFC 4180 compliant
  - UTF-8 encoding
  - Configurable delimiter: --delimiter <char>
```

### 8.3 Idempotency Guarantees for Automation

```yaml
Idempotent Commands:
  - agentics-cli status *     # Read-only, always idempotent
  - agentics-cli get *        # Read-only, always idempotent
  - agentics-cli list *       # Read-only, always idempotent

Conditionally Idempotent:
  - agentics-cli create --if-not-exists
  - agentics-cli delete --if-exists
  - agentics-cli update --if-changed

Non-Idempotent Commands:
  - agentics-cli create (without --if-not-exists)
  - agentics-cli execute (side-effect commands)

Idempotency Keys:
  --idempotency-key <uuid>: Client-provided idempotency key
  Behavior: If downstream supports, pass through; otherwise ignore

Detection Flags:
  --dry-run: Show what would happen without executing
  --check: Verify current state matches desired state
```

### 8.4 Pipeline Integration Patterns

```yaml
# Pattern 1: Status Check Pipeline
steps:
  - name: Check service health
    run: agentics-cli health --format json | jq '.healthy'

  - name: Validate configuration
    run: agentics-cli config validate --strict

  - name: Deploy if healthy
    run: agentics-cli deploy --env $ENVIRONMENT
    if: steps.health.outputs.healthy == 'true'

# Pattern 2: Bulk Processing Pipeline
steps:
  - name: Generate manifest
    run: agentics-cli manifest generate > manifest.json

  - name: Validate manifest
    run: agentics-cli manifest validate manifest.json

  - name: Apply manifest
    run: agentics-cli manifest apply manifest.json --parallel 5

# Pattern 3: Rollback Pipeline
steps:
  - name: Deploy
    id: deploy
    run: agentics-cli deploy --env production
    continue-on-error: true

  - name: Rollback on failure
    if: steps.deploy.outcome == 'failure'
    run: agentics-cli rollback --to-previous

# Pattern 4: Multi-Environment Pipeline
strategy:
  matrix:
    environment: [dev, staging, production]
steps:
  - name: Deploy to ${{ matrix.environment }}
    run: agentics-cli deploy --env ${{ matrix.environment }}
    env:
      AGENTICS_API_KEY: ${{ secrets[format('API_KEY_{0}', matrix.environment)] }}
```

### 8.5 Environment Variable Handling

```yaml
Standard Environment Variables:
  AGENTICS_API_KEY:       API key for authentication
  AGENTICS_API_URL:       Base URL override for API
  AGENTICS_CONFIG_FILE:   Path to configuration file
  AGENTICS_LOG_LEVEL:     Logging verbosity (error|warn|info|debug)
  AGENTICS_TIMEOUT:       Default timeout in milliseconds
  AGENTICS_NO_COLOR:      Disable colored output
  AGENTICS_FORMAT:        Default output format

CI-Specific Variables:
  CI:                     Detected automatically (GitHub, GitLab, etc.)
  AGENTICS_CI_MODE:       Force CI mode (no prompts, machine output)

Variable Precedence (highest to lowest):
  1. Command-line flags
  2. Environment variables
  3. Configuration file
  4. Built-in defaults

Security Requirements:
  - API keys MUST be from environment or secure file
  - CLI MUST NOT log API keys
  - CLI MUST mask API keys in error output
  - CLI MUST NOT store API keys in history

Variable Validation:
  - AGENTICS_TIMEOUT: Must be positive integer
  - AGENTICS_LOG_LEVEL: Must be valid level
  - AGENTICS_FORMAT: Must be supported format
```

---

## 9. Audit and Compliance

### 9.1 Audit Log Format Specification

```typescript
interface AuditLogEntry {
  // Identification
  id: string;                    // UUID v4
  timestamp: string;             // ISO 8601 with timezone
  version: string;               // CLI version

  // Actor
  actor: {
    type: 'user' | 'service' | 'automation';
    id: string;                  // User ID, service account, or CI job ID
    ip?: string;                 // Source IP if available
    user_agent?: string;         // CLI identifier
  };

  // Action
  action: {
    command: string;             // Full command (args redacted)
    operation: string;           // Normalized operation name
    target_type: string;         // Resource type
    target_id?: string;          // Resource identifier
  };

  // Outcome
  outcome: {
    status: 'success' | 'failure' | 'error';
    exit_code: number;
    error_code?: string;         // ECLI-XXX-NNN if applicable
    duration_ms: number;
  };

  // Context
  context: {
    environment: string;         // dev|staging|production
    trace_id: string;            // Distributed trace ID
    session_id?: string;         // Interactive session ID
    ci_job_id?: string;          // CI/CD job identifier
  };

  // Redaction markers
  redacted_fields: string[];     // List of redacted field paths
}
```

### 9.2 Retention Requirements

```yaml
Retention Policy:
  Standard Operations:
    retention_days: 90
    storage: hot (first 30 days), warm (remaining)

  Security Events:
    retention_days: 365
    storage: hot (first 90 days), warm (remaining)
    events:
      - authentication_failure
      - authorization_failure
      - configuration_change
      - service_account_usage

  Compliance Events:
    retention_days: 2555 (7 years)
    storage: hot (first 30 days), warm (next 335 days), cold (remaining)
    events:
      - data_access
      - data_modification
      - data_deletion
      - audit_log_access

Storage Requirements:
  - Immutable storage after write
  - Tamper-evident (hash chain or similar)
  - Encrypted at rest (AES-256)
  - Encrypted in transit (TLS 1.3)
  - Geographically redundant
```

### 9.3 Chain of Custody for Artifacts

```yaml
Artifact Types:
  - Configuration files
  - Deployment manifests
  - Generated outputs
  - Exported data

Chain of Custody Requirements:

  1. Generation:
     - Record generator (CLI version, user, timestamp)
     - Compute content hash (SHA-256)
     - Sign with generation key

  2. Storage:
     - Immutable storage with versioning
     - Access logging enabled
     - Encryption at rest

  3. Transfer:
     - TLS 1.3 minimum
     - Verify hash on receipt
     - Log transfer event

  4. Modification:
     - Create new version (no in-place modification)
     - Link to previous version
     - Record modifier and timestamp

  5. Deletion:
     - Soft delete with retention period
     - Hard delete only after retention
     - Record deletion authorization

Artifact Manifest Format:
  {
    "artifact_id": "uuid",
    "artifact_type": "string",
    "content_hash": "sha256:...",
    "created_at": "ISO8601",
    "created_by": {
      "type": "user|service",
      "id": "string"
    },
    "signature": "base64",
    "chain": [
      {
        "action": "created|modified|transferred",
        "timestamp": "ISO8601",
        "actor": "string",
        "hash_before": "sha256:...",
        "hash_after": "sha256:..."
      }
    ]
  }
```

### 9.4 Compliance Evidence Generation

```yaml
Supported Compliance Frameworks:
  - SOC 2 Type II
  - ISO 27001
  - GDPR (data processing records)
  - HIPAA (audit controls)
  - PCI-DSS (access logging)

Evidence Generation Commands:

  # Generate audit report
  agentics-cli compliance report \
    --framework soc2 \
    --period 2024-Q1 \
    --output report.pdf

  # Export audit logs
  agentics-cli compliance export-logs \
    --start 2024-01-01 \
    --end 2024-03-31 \
    --format csv

  # Generate access review
  agentics-cli compliance access-review \
    --period 2024-Q1 \
    --include-service-accounts

Evidence Package Contents:
  - audit_logs.csv: All audit events for period
  - access_summary.csv: User access summary
  - configuration_changes.csv: All config changes
  - error_summary.csv: Error events and resolutions
  - metadata.json: Report generation metadata
  - signature.sig: Digital signature of package
```

---

## 10. Performance Constraints

### 10.1 Startup Time Requirements

```yaml
Startup Time Budgets:
  Cold Start (no cache):
    target: < 500ms
    maximum: 1000ms

  Warm Start (with cache):
    target: < 100ms
    maximum: 250ms

Measurement Points:
  T0: Process spawn
  T1: Module load complete
  T2: Configuration parsed
  T3: Command parsed
  T4: Ready to execute

  Startup Time = T4 - T0

Optimization Requirements:
  - Lazy-load non-essential modules
  - Cache parsed configuration
  - Defer validation until needed
  - No network calls during startup
  - No file I/O beyond config loading

Measurement Command:
  time agentics-cli --version  # Should complete in <100ms warm

CI Gate:
  - Fail build if startup > 1000ms cold
  - Warn if startup > 500ms cold
```

### 10.2 Memory Footprint Limits

```yaml
Memory Budgets:
  Baseline (idle):
    target: < 50MB
    maximum: 75MB

  Active (processing):
    target: < 100MB
    maximum: 200MB

  Peak (bulk operations):
    target: < 250MB
    maximum: 500MB

Heap Constraints:
  --max-old-space-size: 512 (enforced)

Streaming Requirements:
  - Stream files > 10MB (do not buffer)
  - Stream responses > 1MB (do not buffer)
  - Use transform streams for processing

Memory Leak Detection:
  - Run memory profiler in CI
  - Fail if heap growth > 10% over 1000 iterations
  - Alert if baseline > 75MB

Measurement:
  node --expose-gc -e "
    global.gc();
    console.log(process.memoryUsage().heapUsed / 1024 / 1024);
  "
```

### 10.3 No Background Processes

```yaml
Forbidden Patterns:
  - Spawning child processes that outlive CLI
  - Creating detached processes
  - Setting up file watchers
  - Creating timers that prevent exit
  - Opening network listeners

Allowed Patterns:
  - Synchronous child processes (spawnSync)
  - Short-lived async operations with cleanup
  - AbortController-managed timeouts

Verification:
  # After CLI exit, no orphaned processes
  pgrep -f agentics  # Should return nothing

  # No listening ports
  lsof -i -P | grep agentics  # Should return nothing

Enforcement:
  - Process cleanup handler required
  - SIGTERM/SIGINT handlers required
  - Unref() forbidden on timers
  - Detached spawn forbidden
```

### 10.4 No Daemon Modes

```yaml
Forbidden:
  - agentics-cli daemon start
  - agentics-cli serve
  - agentics-cli watch
  - Any --daemon or --background flag
  - Process forking to background

Rationale:
  - CLI is a coordination layer, not a service
  - Background processes require monitoring infrastructure
  - Daemon mode adds complexity and failure modes
  - Use proper service managers for long-running processes

Alternative Patterns:

  # Instead of watch mode:
  while true; do
    agentics-cli sync --once
    sleep 60
  done

  # Instead of daemon mode:
  # Use systemd, supervisord, or container orchestration

  # Instead of serve mode:
  # Deploy the actual service, not the CLI

Error on Daemon Attempt:
  Exit code: 2
  Message: "Daemon mode is not supported. Use a process manager
           like systemd or supervisord for long-running operations."
```

---

## 11. Enforcement and Compliance

### 11.1 Automated Enforcement

```yaml
Pre-commit Hooks:
  - Forbidden pattern scanner
  - Dependency validator
  - Complexity checker
  - Line count validator

CI Pipeline Gates:
  - Architecture fitness tests
  - Startup time measurement
  - Memory footprint test
  - Exit code compliance test
  - Audit log format validation

Release Gates:
  - Full compliance scan
  - Security audit
  - License compliance
  - Documentation review
  - Breaking change assessment
```

### 11.2 Exception Process

```yaml
Exception Request:
  1. Document the need
  2. Propose alternatives considered
  3. Define scope and duration
  4. Identify risks and mitigations
  5. Obtain Architecture Review Board approval

Exception Tracking:
  - Logged in EXCEPTIONS.md
  - Time-limited (default: 90 days)
  - Reviewed quarterly
  - Must be resolved or renewed
```

### 11.3 Governance Updates

```yaml
Document Updates:
  - Proposed via PR to governance repository
  - Require Architecture Review Board approval
  - 2-week comment period for non-urgent changes
  - Communicated to all stakeholders

Version History:
  - All changes tracked in git
  - Semantic versioning for document
  - Changelog maintained
```

---

## Appendix A: Quick Reference Card

```
+------------------------------------------------------------------+
|                    AGENTICS-CLI GOVERNANCE                        |
+------------------------------------------------------------------+
| ALLOWED                        | FORBIDDEN                        |
|--------------------------------|----------------------------------|
| HTTP client calls              | Retry with backoff               |
| Schema validation              | Circuit breakers                 |
| Output formatting              | Caching layers                   |
| Error passthrough              | ML inference                     |
| Timeout handling               | Data transformation              |
| Streaming I/O                  | Business logic                   |
| Configuration parsing          | Database connections             |
| Environment variables          | Background processes             |
| CLI argument parsing           | Daemon modes                     |
| Exit code mapping              | File watchers                    |
+------------------------------------------------------------------+
| METRICS                        | THRESHOLDS                       |
|--------------------------------|----------------------------------|
| Startup time (cold)            | < 1000ms                         |
| Startup time (warm)            | < 250ms                          |
| Memory baseline                | < 75MB                           |
| Memory peak                    | < 500MB                          |
| Function complexity            | < 10                             |
| Function lines                 | < 50                             |
| Module lines                   | < 300                            |
| File lines                     | < 500                            |
| Total codebase                 | < 3000 LOC                       |
+------------------------------------------------------------------+
```

---

## Appendix B: Checklist for New Features

```markdown
## New Feature Compliance Checklist

### Architecture
- [ ] Feature is pure coordination (no business logic)
- [ ] All processing delegated to downstream services
- [ ] No new forbidden dependencies added
- [ ] Complexity within thresholds

### Performance
- [ ] Startup time impact < 50ms
- [ ] Memory impact < 10MB
- [ ] No background processes
- [ ] Streaming for large data

### Interface
- [ ] Exit codes follow specification
- [ ] Error codes documented
- [ ] Machine-readable output supported
- [ ] Idempotency documented

### Compliance
- [ ] Audit logging implemented
- [ ] Sensitive data redacted
- [ ] Version compatibility documented
- [ ] Breaking changes assessed

### Documentation
- [ ] CLI help updated
- [ ] Error messages clear
- [ ] Examples provided
- [ ] Changelog updated
```

---

**Document End**

*This document is authoritative for agentics-cli development. All contributors must adhere to these specifications. Questions or proposed changes should be directed to the Architecture Review Board.*
