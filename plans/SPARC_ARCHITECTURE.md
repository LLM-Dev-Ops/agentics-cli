# SPARC Architecture Document: agentics-cli

| Field           | Value                                      |
|-----------------|--------------------------------------------|
| **Version**     | 1.0.0                                      |
| **Date**        | 2026-01-03                                 |
| **Status**      | Draft                                      |
| **Classification** | Internal - Architecture                 |
| **Author**      | Architecture Team                          |
| **Reviewers**   | TBD                                        |

---

## Executive Summary

The `agentics-cli` repository serves as a **pure coordination layer** that orchestrates interactions between users and the agentics ecosystem. This document defines strict architectural boundaries, dependency constraints, and interface contracts to ensure the CLI remains a thin orchestration shell with no embedded business logic.

---

## 1. Architecture Principles

### 1.1 Single Responsibility: Orchestration Only

The CLI exists for one purpose: **command orchestration**. It translates user intent into downstream API calls and surfaces results. It does NOT:

- Interpret or transform business data
- Cache or store state between invocations
- Implement domain-specific algorithms
- Validate business rules beyond basic input sanitization

### 1.2 Dependency Inversion: Interfaces Over Implementations

All interactions with downstream repositories occur through **abstracted interfaces**. The CLI depends on:

```
+-------------------+
|  agentics-cli     |
+-------------------+
         |
         | depends on
         v
+-------------------+
|  Interface Layer  |  <-- Abstract contracts only
+-------------------+
         |
         | implemented by
         v
+-------------------+
|  Downstream Repos |  <-- Concrete implementations
+-------------------+
```

The CLI never imports concrete implementations, schemas, or utilities from downstream repositories.

### 1.3 Open/Closed: Extensible Commands, Frozen Logic

```
OPEN FOR:                          CLOSED FOR:
+------------------------+         +------------------------+
| - New CLI commands     |         | - Business logic       |
| - New output formats   |         | - Data transformation  |
| - New downstream       |         | - Schema definitions   |
|   adapters             |         | - Caching strategies   |
| - New authentication   |         | - State management     |
|   methods              |         |                        |
+------------------------+         +------------------------+
```

### 1.4 Interface Segregation: Minimal Required Interfaces

Each downstream repository exposes only the interfaces required by the CLI:

```
+------------------+     +------------------+     +------------------+
|   Repository A   |     |   Repository B   |     |   Repository C   |
+------------------+     +------------------+     +------------------+
| ICommandA        |     | IOperationB      |     | IServiceC        |
| - execute()      |     | - invoke()       |     | - call()         |
| - status()       |     | - cancel()       |     | - health()       |
+------------------+     +------------------+     +------------------+
         ^                        ^                        ^
         |                        |                        |
         +------------------------+------------------------+
                                  |
                          +-------+-------+
                          | agentics-cli  |
                          +---------------+
```

---

## 2. Module Boundaries

### 2.1 High-Level Module Diagram

```
+===========================================================================+
|                              agentics-cli                                  |
+===========================================================================+
|                                                                           |
|  +-------------------+                                                    |
|  | A. COMMAND        |                                                    |
|  |    PARSING        |----+                                               |
|  |    MODULE         |    |                                               |
|  +-------------------+    |                                               |
|                           v                                               |
|                    +-------------------+                                  |
|                    | B. ORCHESTRATION  |                                  |
|                    |    ENGINE         |                                  |
|                    |    MODULE         |                                  |
|                    +-------------------+                                  |
|                           |                                               |
|         +-----------------+-----------------+                             |
|         |                 |                 |                             |
|         v                 v                 v                             |
|  +-------------+   +-------------+   +-------------+                      |
|  | C. DOWNSTREAM   | C. DOWNSTREAM   | C. DOWNSTREAM                      |
|  |    ADAPTER  |   |    ADAPTER  |   |    ADAPTER  |                      |
|  |    (Repo A) |   |    (Repo B) |   |    (Repo N) |                      |
|  +-------------+   +-------------+   +-------------+                      |
|         |                 |                 |                             |
|         v                 v                 v                             |
|  +---------------------------------------------------+                    |
|  | D. ARTIFACT HANDOFF MODULE                        |                    |
|  +---------------------------------------------------+                    |
|         |                                                                 |
|         v                                                                 |
|  +-------------------+     +-------------------+                          |
|  | E. OUTPUT         |     | F. ERROR          |                          |
|  |    RENDERING      |     |    HANDLING       |                          |
|  |    MODULE         |     |    MODULE         |                          |
|  +-------------------+     +-------------------+                          |
|                                                                           |
+===========================================================================+
```

---

### 2.2 Module A: Command Parsing Module

```
+=======================================================================+
|                      COMMAND PARSING MODULE                            |
+=======================================================================+
|                                                                       |
|  PURPOSE: Parse CLI arguments and flags into structured objects       |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  INPUTS:                                                              |
|  +------------------+                                                 |
|  | Raw CLI Args     |  process.argv / sys.argv                        |
|  | - Positional     |  agentics run task                              |
|  | - Flags          |  --verbose --output=json                        |
|  | - Options        |  -o output.txt                                  |
|  +------------------+                                                 |
|                                                                       |
|  OUTPUTS:                                                             |
|  +------------------+                                                 |
|  | CommandObject    |  {                                              |
|  |                  |    command: "run",                              |
|  |                  |    subcommand: "task",                          |
|  |                  |    flags: { verbose: true },                    |
|  |                  |    options: { output: "json" }                  |
|  |                  |  }                                              |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  DEPENDENCIES:                                                        |
|  +------------------+                                                 |
|  | Standard Library |  Node.js native / Python stdlib ONLY           |
|  | ONLY             |  No external parsing libraries required         |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  FORBIDDEN:                                                           |
|  +------------------+                                                 |
|  | Business Logic   |  NO interpretation of command semantics        |
|  | Interpretation   |  NO validation of business rules               |
|  |                  |  NO downstream-specific logic                  |
|  +------------------+                                                 |
|                                                                       |
+=======================================================================+
```

**Interface Contract:**

```typescript
interface ICommandParser {
  parse(args: string[]): CommandObject;
}

interface CommandObject {
  command: string;
  subcommand?: string;
  flags: Record<string, boolean>;
  options: Record<string, string>;
  positionalArgs: string[];
}
```

---

### 2.3 Module B: Orchestration Engine Module

```
+=======================================================================+
|                      ORCHESTRATION ENGINE MODULE                       |
+=======================================================================+
|                                                                       |
|  PURPOSE: Sequence downstream calls based on command objects          |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  INPUTS:                                                              |
|  +------------------+                                                 |
|  | CommandObject    |  Structured command from Parser Module          |
|  +------------------+                                                 |
|                                                                       |
|  OUTPUTS:                                                             |
|  +------------------+                                                 |
|  | OrchestrationResult                                                |
|  | {                                                                  |
|  |   stages: [                                                        |
|  |     { name: "stage1", status: "complete", response: {...} },       |
|  |     { name: "stage2", status: "complete", response: {...} }        |
|  |   ],                                                               |
|  |   artifacts: [...],                                                |
|  |   timing: { total: 1234, breakdown: {...} }                        |
|  | }                                                                  |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  ORCHESTRATION FLOW:                                                  |
|                                                                       |
|    CommandObject                                                      |
|         |                                                             |
|         v                                                             |
|    +----------+     +----------+     +----------+                     |
|    | Stage 1  | --> | Stage 2  | --> | Stage N  |                     |
|    | Adapter  |     | Adapter  |     | Adapter  |                     |
|    +----------+     +----------+     +----------+                     |
|         |                |                |                           |
|         v                v                v                           |
|    [Response]       [Response]       [Response]                       |
|         |                |                |                           |
|         +----------------+----------------+                           |
|                          |                                            |
|                          v                                            |
|                  OrchestrationResult                                  |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  DEPENDENCIES:                                                        |
|  +---------------------+                                              |
|  | Downstream Adapters |  ONLY through adapter interfaces             |
|  | (interfaces only)   |  No direct HTTP/gRPC calls                   |
|  +---------------------+                                              |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  FORBIDDEN:                                                           |
|  +---------------------+                                              |
|  | Data Transformation |  NO modifying response data                  |
|  | Caching             |  NO storing results between calls            |
|  | Business Logic      |  NO conditional logic based on response      |
|  | Retry Logic         |  Delegated to adapters if needed             |
|  +---------------------+                                              |
|                                                                       |
+=======================================================================+
```

**Interface Contract:**

```typescript
interface IOrchestrationEngine {
  execute(command: CommandObject): Promise<OrchestrationResult>;
}

interface OrchestrationResult {
  stages: StageResult[];
  artifacts: ArtifactReference[];
  timing: TimingInfo;
  success: boolean;
}

interface StageResult {
  name: string;
  status: "pending" | "running" | "complete" | "failed";
  response: unknown; // Raw passthrough
  error?: ErrorInfo;
}
```

---

### 2.4 Module C: Downstream Adapter Module

```
+=======================================================================+
|                      DOWNSTREAM ADAPTER MODULE                         |
+=======================================================================+
|                                                                       |
|  PURPOSE: Invoke external repository APIs with minimal coupling        |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  ADAPTER ARCHITECTURE:                                                |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  |                    Adapter Interface                              ||
|  |  +-------------------------------------------------------------+  ||
|  |  | invoke(request: AdapterRequest): Promise<AdapterResponse>   |  ||
|  |  | health(): Promise<HealthStatus>                             |  ||
|  |  +-------------------------------------------------------------+  ||
|  +-------------------------------------------------------------------+|
|           ^               ^               ^               ^           |
|           |               |               |               |           |
|  +--------+--+   +--------+--+   +--------+--+   +--------+--+        |
|  | HTTP      |   | gRPC      |   | WebSocket |   | Mock      |        |
|  | Adapter   |   | Adapter   |   | Adapter   |   | Adapter   |        |
|  +-----------+   +-----------+   +-----------+   +-----------+        |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  INPUTS:                                                              |
|  +------------------+                                                 |
|  | AdapterRequest   |  {                                              |
|  |                  |    endpoint: "/api/v1/task",                    |
|  |                  |    method: "POST",                              |
|  |                  |    headers: {...},                              |
|  |                  |    body: {...}  // Opaque, not interpreted      |
|  |                  |  }                                              |
|  +------------------+                                                 |
|                                                                       |
|  OUTPUTS:                                                             |
|  +------------------+                                                 |
|  | AdapterResponse  |  {                                              |
|  |                  |    status: 200,                                 |
|  |                  |    headers: {...},                              |
|  |                  |    body: {...}  // Raw passthrough              |
|  |                  |  }                                              |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  DEPENDENCIES:                                                        |
|  +------------------+                                                 |
|  | HTTP Client      |  fetch / axios / http module                    |
|  | gRPC Client      |  grpc-js / grpcio                               |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  FORBIDDEN:                                                           |
|  +----------------------+                                             |
|  | Response Parsing     |  NO JSON schema validation                  |
|  | Response Transform   |  NO field mapping or conversion             |
|  | Business Logic       |  NO conditional handling based on data      |
|  | Caching              |  NO response storage                        |
|  | Error Recovery       |  Errors bubble up unchanged                 |
|  +----------------------+                                             |
|                                                                       |
+=======================================================================+
```

**Interface Contract:**

```typescript
interface IDownstreamAdapter {
  invoke(request: AdapterRequest): Promise<AdapterResponse>;
  health(): Promise<HealthStatus>;
  getEndpointConfig(): EndpointConfig;
}

interface AdapterRequest {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers: Record<string, string>;
  body?: unknown; // Opaque - never interpreted
  timeout?: number;
}

interface AdapterResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown; // Raw passthrough - never parsed
  timing: number;
}
```

---

### 2.5 Module D: Artifact Handoff Module

```
+=======================================================================+
|                      ARTIFACT HANDOFF MODULE                           |
+=======================================================================+
|                                                                       |
|  PURPOSE: Pass artifact REFERENCES between stages (not content)       |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  HANDOFF FLOW:                                                        |
|                                                                       |
|    Stage N                        Stage N+1                           |
|    +----------+                   +----------+                        |
|    | Produces |                   | Consumes |                        |
|    | Artifact |                   | Artifact |                        |
|    +----------+                   +----------+                        |
|         |                              ^                              |
|         |  ArtifactReference           |                              |
|         |  +-------------------+       |                              |
|         +->| id: "abc-123"     |-------+                              |
|            | type: "model"     |                                      |
|            | location: "s3://.."|                                     |
|            | checksum: "sha256"|                                      |
|            +-------------------+                                      |
|                                                                       |
|  CRITICAL: Only REFERENCES pass through - NEVER content               |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  INPUTS:                                                              |
|  +---------------------+                                              |
|  | ArtifactReference[] |  References from previous stage              |
|  +---------------------+                                              |
|                                                                       |
|  OUTPUTS:                                                             |
|  +---------------------+                                              |
|  | ArtifactReference[] |  Same references (unmodified) to next stage  |
|  +---------------------+                                              |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  DEPENDENCIES:                                                        |
|  +------------------+                                                 |
|  | NONE             |  Pure reference passing                         |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  FORBIDDEN:                                                           |
|  +----------------------+                                             |
|  | Content Access       |  NEVER download/read artifact content       |
|  | Content Validation   |  NEVER validate artifact data               |
|  | Content Transform    |  NEVER modify artifact content              |
|  | Content Caching      |  NEVER store artifact content               |
|  +----------------------+                                             |
|                                                                       |
+=======================================================================+
```

**Interface Contract:**

```typescript
interface IArtifactHandoff {
  forward(refs: ArtifactReference[]): ArtifactReference[];
  validate(ref: ArtifactReference): boolean; // Validates reference format only
}

interface ArtifactReference {
  id: string;
  type: string;
  location: string; // URI/path - never resolved by CLI
  checksum?: string;
  metadata?: Record<string, string>; // Opaque metadata
}
```

---

### 2.6 Module E: Output Rendering Module

```
+=======================================================================+
|                      OUTPUT RENDERING MODULE                           |
+=======================================================================+
|                                                                       |
|  PURPOSE: Format results for human/machine consumption                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  RENDERING PIPELINE:                                                  |
|                                                                       |
|  OrchestrationResult                                                  |
|         |                                                             |
|         v                                                             |
|    +----------+                                                       |
|    | Format   |                                                       |
|    | Selector |                                                       |
|    +----------+                                                       |
|         |                                                             |
|    +----+----+----+----+                                              |
|    |    |    |    |    |                                              |
|    v    v    v    v    v                                              |
|  +----+----+----+----+----+                                           |
|  |JSON|YAML|Table|Text|Custom|                                        |
|  +----+----+----+----+----+                                           |
|         |                                                             |
|         v                                                             |
|    +----------+                                                       |
|    | stdout   |                                                       |
|    | stderr   |                                                       |
|    | file     |                                                       |
|    +----------+                                                       |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  INPUTS:                                                              |
|  +---------------------+                                              |
|  | OrchestrationResult |  Raw result from engine                      |
|  | OutputOptions       |  { format: "json", pretty: true }            |
|  +---------------------+                                              |
|                                                                       |
|  OUTPUTS:                                                             |
|  +---------------------+                                              |
|  | Formatted String    |  Ready for output destination                |
|  +---------------------+                                              |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  DEPENDENCIES:                                                        |
|  +------------------+                                                 |
|  | NONE             |  Standard formatters only                       |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  FORBIDDEN:                                                           |
|  +----------------------+                                             |
|  | Result Modification  |  NO changing data values                    |
|  | Result Filtering     |  NO hiding/removing fields                  |
|  | Result Aggregation   |  NO computing derived values                |
|  | Business Logic       |  NO conditional formatting by content       |
|  +----------------------+                                             |
|                                                                       |
+=======================================================================+
```

**Interface Contract:**

```typescript
interface IOutputRenderer {
  render(result: OrchestrationResult, options: OutputOptions): string;
  getSupportedFormats(): string[];
}

interface OutputOptions {
  format: "json" | "yaml" | "table" | "text" | "csv";
  pretty?: boolean;
  colorize?: boolean;
  destination?: "stdout" | "stderr" | string; // filename
}
```

---

### 2.7 Module F: Error Handling Module

```
+=======================================================================+
|                      ERROR HANDLING MODULE                             |
+=======================================================================+
|                                                                       |
|  PURPOSE: Surface errors with context (no recovery)                    |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  ERROR FLOW:                                                          |
|                                                                       |
|    Any Module Error                                                   |
|         |                                                             |
|         v                                                             |
|    +-------------------+                                              |
|    | Error Normalizer  |  Wraps in standard ErrorInfo                 |
|    +-------------------+                                              |
|         |                                                             |
|         v                                                             |
|    +-------------------+                                              |
|    | Context Enricher  |  Adds stack trace, timing, module info       |
|    +-------------------+                                              |
|         |                                                             |
|         v                                                             |
|    +-------------------+                                              |
|    | Error Renderer    |  Formats for output                          |
|    +-------------------+                                              |
|         |                                                             |
|         v                                                             |
|    stderr / exit code                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  ERROR CATEGORIES:                                                    |
|                                                                       |
|  +------------------+------------------+------------------+           |
|  | INPUT_ERROR      | NETWORK_ERROR    | DOWNSTREAM_ERROR |           |
|  | - Invalid args   | - Timeout        | - 4xx/5xx        |           |
|  | - Missing flags  | - Connection     | - Parse failure  |           |
|  | - Type mismatch  | - DNS            | - Protocol error |           |
|  +------------------+------------------+------------------+           |
|  | INTERNAL_ERROR   | CONFIG_ERROR     | AUTH_ERROR       |           |
|  | - Assertion fail | - Missing config | - Invalid creds  |           |
|  | - Unexpected     | - Invalid config | - Expired token  |           |
|  +------------------+------------------+------------------+           |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  DEPENDENCIES:                                                        |
|  +------------------+                                                 |
|  | NONE             |  Pure error formatting                          |
|  +------------------+                                                 |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  FORBIDDEN:                                                           |
|  +----------------------+                                             |
|  | Error Recovery       |  NO retry logic                             |
|  | Error Suppression    |  NO swallowing errors                       |
|  | Error Transformation |  NO changing error semantics                |
|  | Fallback Logic       |  NO alternative paths on error              |
|  +----------------------+                                             |
|                                                                       |
+=======================================================================+
```

**Interface Contract:**

```typescript
interface IErrorHandler {
  handle(error: Error, context: ErrorContext): ErrorInfo;
  format(info: ErrorInfo, options: OutputOptions): string;
}

interface ErrorInfo {
  code: string;
  category: ErrorCategory;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
  timestamp: string;
  module: string;
  correlationId?: string;
}

type ErrorCategory =
  | "INPUT_ERROR"
  | "NETWORK_ERROR"
  | "DOWNSTREAM_ERROR"
  | "INTERNAL_ERROR"
  | "CONFIG_ERROR"
  | "AUTH_ERROR";
```

---

## 3. Dependency Graph

### 3.1 Allowed Dependencies (Directional)

```
+=======================================================================+
|                      ALLOWED DEPENDENCY GRAPH                          |
+=======================================================================+
|                                                                       |
|                          +-------------------+                        |
|                          |   ENTRY POINT     |                        |
|                          |   (main/cli)      |                        |
|                          +-------------------+                        |
|                                   |                                   |
|                                   v                                   |
|                          +-------------------+                        |
|                          | A. COMMAND        |                        |
|                          |    PARSING        |                        |
|                          +-------------------+                        |
|                                   |                                   |
|                                   v                                   |
|                          +-------------------+                        |
|                          | B. ORCHESTRATION  |                        |
|                          |    ENGINE         |                        |
|                          +-------------------+                        |
|                                   |                                   |
|              +--------------------+--------------------+              |
|              |                    |                    |              |
|              v                    v                    v              |
|       +-------------+      +-------------+      +-------------+       |
|       | C. ADAPTER  |      | C. ADAPTER  |      | C. ADAPTER  |       |
|       |    (Repo A) |      |    (Repo B) |      |    (Repo N) |       |
|       +-------------+      +-------------+      +-------------+       |
|              |                    |                    |              |
|              +--------------------+--------------------+              |
|                                   |                                   |
|                                   v                                   |
|                          +-------------------+                        |
|                          | D. ARTIFACT       |                        |
|                          |    HANDOFF        |                        |
|                          +-------------------+                        |
|                                   |                                   |
|                    +--------------+--------------+                    |
|                    |                             |                    |
|                    v                             v                    |
|           +-------------------+         +-------------------+         |
|           | E. OUTPUT         |         | F. ERROR          |         |
|           |    RENDERING      |         |    HANDLING       |         |
|           +-------------------+         +-------------------+         |
|                                                                       |
|  LEGEND:                                                              |
|  ------> : Allowed dependency direction                               |
|                                                                       |
+=======================================================================+
```

### 3.2 Cross-Module Communication Rules

```
+=======================================================================+
|                      COMMUNICATION RULES                               |
+=======================================================================+
|                                                                       |
|  ALLOWED:                                                             |
|  +-------------------------------------------------------------------+|
|  | Direction        | From Module       | To Module                  ||
|  +------------------+-------------------+----------------------------+|
|  | Downward         | Entry             | A. Command Parsing         ||
|  | Downward         | A. Command        | B. Orchestration           ||
|  | Downward         | B. Orchestration  | C. Adapters                ||
|  | Downward         | B. Orchestration  | D. Artifact Handoff        ||
|  | Downward         | B. Orchestration  | E. Output Rendering        ||
|  | Lateral (error)  | Any Module        | F. Error Handling          ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  FORBIDDEN:                                                           |
|  +-------------------------------------------------------------------+|
|  | Direction        | From Module       | To Module                  ||
|  +------------------+-------------------+----------------------------+|
|  | Upward           | Any               | Entry Point                ||
|  | Lateral          | C. Adapter        | C. Adapter (different)     ||
|  | Circular         | Any               | Self (via other modules)   ||
|  | Skip-level       | A. Command        | C. Adapters                ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

---

## 4. Forbidden Dependencies

### 4.1 Absolute Prohibitions

```
+=======================================================================+
|                      FORBIDDEN DEPENDENCIES                            |
+=======================================================================+
|                                                                       |
|  THE FOLLOWING ARE STRICTLY PROHIBITED:                               |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  | Category                  | Examples                              ||
|  +---------------------------+---------------------------------------+|
|  | Direct Schema Imports     | import { TaskSchema } from            ||
|  |                           | 'agentics-core/schemas'               ||
|  +---------------------------+---------------------------------------+|
|  | Shared Utility Libraries  | import { utils } from                 ||
|  |                           | '@agentics/shared'                    ||
|  +---------------------------+---------------------------------------+|
|  | Common Data Models        | import { Agent } from                 ||
|  |                           | 'agentics-models'                     ||
|  +---------------------------+---------------------------------------+|
|  | Cross-Cutting Concerns    | import { logger } from                ||
|  | (beyond basic logging)    | '@agentics/observability'             ||
|  +---------------------------+---------------------------------------+|
|  | Runtime Type Validation   | import { validate } from              ||
|  | Libraries (for responses) | 'agentics-validator'                  ||
|  +---------------------------+---------------------------------------+|
|  | ORM/Database Libraries    | import { db } from                    ||
|  |                           | 'agentics-persistence'                ||
|  +---------------------------+---------------------------------------+|
|  | State Management          | import { store } from                 ||
|  |                           | 'agentics-state'                      ||
|  +---------------------------+---------------------------------------+|
|  | Business Rule Engines     | import { rules } from                 ||
|  |                           | 'agentics-rules'                      ||
|  +---------------------------+---------------------------------------+|
|                                                                       |
+=======================================================================+
```

### 4.2 Dependency Boundary Enforcement

```
+=======================================================================+
|                      BOUNDARY ENFORCEMENT                              |
+=======================================================================+
|                                                                       |
|  ENFORCEMENT MECHANISMS:                                              |
|                                                                       |
|  1. Package.json Constraints:                                         |
|     +---------------------------------------------------------------+ |
|     | {                                                             | |
|     |   "dependencies": {                                           | |
|     |     // ONLY allowed:                                          | |
|     |     "commander": "^x.x.x",     // CLI parsing stdlib          | |
|     |     "node-fetch": "^x.x.x"     // HTTP client only            | |
|     |   },                                                          | |
|     |   "peerDependencies": {},       // NONE                       | |
|     |   "bundledDependencies": []     // NONE                       | |
|     | }                                                             | |
|     +---------------------------------------------------------------+ |
|                                                                       |
|  2. Import Linting Rules:                                             |
|     +---------------------------------------------------------------+ |
|     | // eslint-plugin-import rules                                 | |
|     | "no-restricted-imports": [                                    | |
|     |   "error",                                                    | |
|     |   {                                                           | |
|     |     "patterns": [                                             | |
|     |       "agentics-*",                                           | |
|     |       "@agentics/*",                                          | |
|     |       "**/schemas/*",                                         | |
|     |       "**/models/*"                                           | |
|     |     ]                                                         | |
|     |   }                                                           | |
|     | ]                                                             | |
|     +---------------------------------------------------------------+ |
|                                                                       |
|  3. CI/CD Dependency Scanning:                                        |
|     +---------------------------------------------------------------+ |
|     | # .github/workflows/dependency-check.yml                      | |
|     | - name: Check forbidden dependencies                          | |
|     |   run: |                                                      | |
|     |     if grep -r "from 'agentics-" src/; then                   | |
|     |       echo "FORBIDDEN: Direct agentics imports found"         | |
|     |       exit 1                                                  | |
|     |     fi                                                        | |
|     +---------------------------------------------------------------+ |
|                                                                       |
+=======================================================================+
```

---

## 5. Interface Contracts

### 5.1 Downstream Repository Interface Template

```
+=======================================================================+
|                      DOWNSTREAM INTERFACE CONTRACT                     |
+=======================================================================+
|                                                                       |
|  REPOSITORY: [Repository Name]                                        |
|  VERSION: 1.0.0                                                       |
|  PROTOCOL: HTTP/REST | gRPC | WebSocket                               |
|                                                                       |
+-----------------------------------------------------------------------+
|                                                                       |
|  ENDPOINTS:                                                           |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  | Method | Path              | Request Body    | Response Body     ||
|  +--------+-------------------+-----------------+-------------------+||
|  | POST   | /api/v1/execute   | Opaque JSON     | Opaque JSON       ||
|  | GET    | /api/v1/status/:id| None            | Opaque JSON       ||
|  | DELETE | /api/v1/cancel/:id| None            | Opaque JSON       ||
|  | GET    | /health           | None            | { status: "ok" }  ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  HEADERS:                                                             |
|  +-------------------------------------------------------------------+|
|  | Header            | Required | Description                       ||
|  +-------------------+----------+-----------------------------------+||
|  | Authorization     | Yes      | Bearer token (passthrough)        ||
|  | X-Correlation-ID  | Yes      | Request tracing ID                ||
|  | X-API-Version     | No       | API version negotiation           ||
|  | Content-Type      | Yes      | application/json                  ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  ERROR RESPONSES:                                                     |
|  +-------------------------------------------------------------------+|
|  | Status | Meaning           | CLI Behavior                        ||
|  +--------+-------------------+-------------------------------------+||
|  | 400    | Bad Request       | Surface error, no retry             ||
|  | 401    | Unauthorized      | Surface error, no retry             ||
|  | 403    | Forbidden         | Surface error, no retry             ||
|  | 404    | Not Found         | Surface error, no retry             ||
|  | 429    | Rate Limited      | Surface error, no retry (no backoff)||
|  | 5xx    | Server Error      | Surface error, no retry             ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

### 5.2 Version Negotiation Protocol

```
+=======================================================================+
|                      VERSION NEGOTIATION                               |
+=======================================================================+
|                                                                       |
|  REQUEST:                                                             |
|  +-------------------------------------------------------------------+|
|  | GET /api/versions HTTP/1.1                                       ||
|  | Host: downstream-service.example.com                             ||
|  | Accept: application/json                                         ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  RESPONSE:                                                            |
|  +-------------------------------------------------------------------+|
|  | {                                                                ||
|  |   "supported": ["v1", "v2", "v3"],                               ||
|  |   "deprecated": ["v1"],                                          ||
|  |   "current": "v3",                                               ||
|  |   "minimum": "v2"                                                ||
|  | }                                                                ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  CLI BEHAVIOR:                                                        |
|  +-------------------------------------------------------------------+|
|  | 1. Request version list from downstream                          ||
|  | 2. Select highest mutually supported version                     ||
|  | 3. Include X-API-Version header in subsequent requests           ||
|  | 4. If no compatible version, fail with clear error               ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

---

## 6. Deployment Topology

### 6.1 Distribution Model

```
+=======================================================================+
|                      DEPLOYMENT TOPOLOGY                               |
+=======================================================================+
|                                                                       |
|  DISTRIBUTION: CLI Binary Only                                        |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  |                                                                   ||
|  |   +---------------+                                               ||
|  |   |  User Machine |                                               ||
|  |   +---------------+                                               ||
|  |          |                                                        ||
|  |          v                                                        ||
|  |   +---------------+                                               ||
|  |   | agentics-cli  |  <-- Single binary / npm package              ||
|  |   | executable    |                                               ||
|  |   +---------------+                                               ||
|  |          |                                                        ||
|  |          | HTTP/gRPC (outbound only)                              ||
|  |          v                                                        ||
|  |   +-------------------+-------------------+-------------------+   ||
|  |   |                   |                   |                   |   ||
|  |   v                   v                   v                   v   ||
|  | [Downstream A]   [Downstream B]   [Downstream C]   [Downstream N] ||
|  |                                                                   ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

### 6.2 Deployment Constraints

```
+=======================================================================+
|                      DEPLOYMENT CONSTRAINTS                            |
+=======================================================================+
|                                                                       |
|  ALLOWED:                                                             |
|  +-------------------------------------------------------------------+|
|  | Constraint           | Description                                ||
|  +----------------------+--------------------------------------------+|
|  | Single Binary        | One executable file per platform           ||
|  | npm Package          | Distributed via npm registry               ||
|  | Homebrew Formula     | macOS distribution channel                 ||
|  | Container Image      | For containerized execution only           ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  FORBIDDEN:                                                           |
|  +-------------------------------------------------------------------+|
|  | Constraint           | Reason                                     ||
|  +----------------------+--------------------------------------------+|
|  | Sidecar Services     | No background processes                    ||
|  | Daemon Mode          | CLI is request-response only               ||
|  | Persistent State     | No local databases or caches               ||
|  | Background Processes | No long-running operations                 ||
|  | Local Servers        | No HTTP/gRPC servers                       ||
|  | Watch Mode           | No file system watchers                    ||
|  | Queue Workers        | No message queue consumers                 ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

### 6.3 Execution Model

```
+=======================================================================+
|                      EXECUTION MODEL                                   |
+=======================================================================+
|                                                                       |
|  LIFECYCLE:                                                           |
|                                                                       |
|    +-------+     +-------+     +-------+     +-------+     +-------+  |
|    | Start | --> | Parse | --> | Execute --> | Output| --> | Exit  |  |
|    +-------+     +-------+     +-------+     +-------+     +-------+  |
|                                                                       |
|  TIMING CONSTRAINTS:                                                  |
|  +-------------------------------------------------------------------+|
|  | Phase            | Max Duration | Notes                           ||
|  +------------------+--------------+----------------------------------+|
|  | Startup          | < 100ms      | No lazy loading, no warm-up     ||
|  | Argument Parsing | < 50ms       | Synchronous only                ||
|  | Execution        | Configurable | --timeout flag, default 30s     ||
|  | Output           | < 100ms      | Streaming for large outputs     ||
|  | Shutdown         | < 50ms       | No cleanup tasks                ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  RESOURCE CONSTRAINTS:                                                |
|  +-------------------------------------------------------------------+|
|  | Resource         | Limit        | Notes                           ||
|  +------------------+--------------+----------------------------------+|
|  | Memory           | < 100MB      | No in-memory caching            ||
|  | File Handles     | < 10         | Stdio + network only            ||
|  | Network Conns    | < 5 per call | One per downstream              ||
|  | Disk I/O         | None         | No local file writes            ||
|  | CPU              | Single-core  | No parallel processing          ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

---

## 7. Security Boundaries

### 7.1 Credential Handling

```
+=======================================================================+
|                      CREDENTIAL HANDLING                               |
+=======================================================================+
|                                                                       |
|  PRINCIPLE: Passthrough Only - No Storage, No Refresh                 |
|                                                                       |
|  CREDENTIAL FLOW:                                                     |
|                                                                       |
|    +----------+     +----------+     +----------+     +----------+    |
|    | User     | --> | CLI      | --> | Adapter  | --> | Downstream    |
|    | Provides |     | Passes   |     | Forwards |     | Validates|    |
|    +----------+     +----------+     +----------+     +----------+    |
|                                                                       |
|  ALLOWED CREDENTIAL SOURCES:                                          |
|  +-------------------------------------------------------------------+|
|  | Source               | Example                                    ||
|  +----------------------+--------------------------------------------+|
|  | Environment Variable | AGENTICS_TOKEN=xxx                         ||
|  | Command Flag         | --token xxx                                ||
|  | Config File          | ~/.agentics/config (token field)           ||
|  | Stdin                | echo $TOKEN | agentics --token-stdin       ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

### 7.2 Security Prohibitions

```
+=======================================================================+
|                      SECURITY PROHIBITIONS                             |
+=======================================================================+
|                                                                       |
|  THE FOLLOWING ARE STRICTLY FORBIDDEN:                                |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  | Prohibition             | Reason                                  ||
|  +-------------------------+-----------------------------------------+|
|  | Credential Storage      | No keychain, no file storage            ||
|  | Token Refresh Logic     | Delegated to downstream or user         ||
|  | Token Validation        | Only downstream validates               ||
|  | Token Generation        | Only auth service generates             ||
|  | Credential Caching      | Fresh credentials each invocation       ||
|  | OAuth Flows             | Use external auth tools                 ||
|  | Certificate Management  | Use system certificate store            ||
|  | Secret Encryption       | No local encryption                     ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  SECURE DEFAULTS:                                                     |
|  +-------------------------------------------------------------------+|
|  | Setting                 | Default                                 ||
|  +-------------------------+-----------------------------------------+|
|  | TLS                     | Required (no --insecure flag)           ||
|  | Certificate Validation  | Always enabled                          ||
|  | Credential Logging      | Never (masked in debug output)          ||
|  | Error Details           | No credential info in errors            ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+=======================================================================+
```

### 7.3 Security Architecture Diagram

```
+=======================================================================+
|                      SECURITY ARCHITECTURE                             |
+=======================================================================+
|                                                                       |
|    +------------------+                                               |
|    | User Environment |                                               |
|    +------------------+                                               |
|           |                                                           |
|           | Credentials (env var / flag / stdin)                      |
|           v                                                           |
|    +------------------+                                               |
|    | agentics-cli     |                                               |
|    +------------------+                                               |
|    | - Reads creds    |                                               |
|    | - NEVER stores   |                                               |
|    | - NEVER modifies |                                               |
|    | - NEVER validates|                                               |
|    +------------------+                                               |
|           |                                                           |
|           | TLS + Bearer Token (passthrough)                          |
|           v                                                           |
|    +------------------+                                               |
|    | Downstream APIs  |                                               |
|    +------------------+                                               |
|    | - Validates token|                                               |
|    | - Manages refresh|                                               |
|    | - Handles auth   |                                               |
|    +------------------+                                               |
|                                                                       |
+=======================================================================+
```

---

## 8. Appendices

### Appendix A: Module Interface Summary

| Module | Primary Interface | Dependencies | Forbidden |
|--------|------------------|--------------|-----------|
| A. Command Parsing | `ICommandParser` | stdlib only | Business logic |
| B. Orchestration Engine | `IOrchestrationEngine` | Adapters | Data transform, caching |
| C. Downstream Adapter | `IDownstreamAdapter` | HTTP/gRPC clients | Response parsing |
| D. Artifact Handoff | `IArtifactHandoff` | None | Content access |
| E. Output Rendering | `IOutputRenderer` | None | Result modification |
| F. Error Handling | `IErrorHandler` | None | Error recovery |

### Appendix B: Compliance Checklist

- [ ] No direct imports from agentics-* packages
- [ ] No shared utility libraries
- [ ] No persistent state between invocations
- [ ] No credential storage
- [ ] No background processes
- [ ] All responses passed through unchanged
- [ ] All errors surfaced without recovery
- [ ] All artifacts passed as references only

### Appendix C: Review Process

1. **Architecture Review**: All module boundary changes require architecture team review
2. **Dependency Review**: Any new dependency requires security and architecture approval
3. **Interface Review**: Interface changes require downstream team notification
4. **Security Review**: Credential handling changes require security team approval

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-03 | Architecture Team | Initial release |

---

*This document defines the architectural boundaries for agentics-cli. All implementation must adhere to these constraints. Deviations require formal architecture review and approval.*
