/**
 * Phase 2 Pipeline — Prompt Generation Stage (ADR-PIPELINE-019)
 *
 * Converts Phase 2 ADRs + DDD bounded contexts into implementation prompts.
 * Each prompt targets one or more bounded contexts and includes the ADRs
 * that govern those contexts, providing a complete implementation brief.
 *
 * This stage was missing from Phase 2 — it existed only in the Phase 1
 * pipeline (src/pipeline/phases/prompt-generator.ts). Without it, the
 * pipeline produced ADRs and DDD models but zero actionable implementation
 * prompts, breaking the simulation → execution lineage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { OWNED_SCAFFOLD_MODULES } from '../../auto-chain.js';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2ADRRecord,
  Phase2DDDBoundedContext,
  Phase2DomainModel,
  Phase2SPARCOutput,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PROMPTS_SUBDIR = 'prompts';

/**
 * ADR-PIPELINE-039: Mandatory cross-cutting requirements appended to EVERY domain prompt.
 * The coding agent skips standalone cross-cutting prompts but can't skip requirements
 * embedded in the domain prompt it's actively working on.
 */
/**
 * ADR-PIPELINE-069: Build the "SCAFFOLD-OWNED MODULES" block from the
 * single source of truth in auto-chain.ts. Injected into every
 * implementation prompt so coding agents know which exports already
 * exist and MUST NOT be redeclared.
 *
 * Computed lazily inside getCrossCuttingFooter() to avoid the circular-
 * import TDZ between auto-chain.ts and the phase2 prompt generator.
 */
function buildScaffoldOwnedBlock(): string {
  const lines: string[] = [
    '## 🛑 SCAFFOLD-OWNED MODULES — DO NOT REIMPLEMENT (ADR-PIPELINE-069)',
    '',
    'The following modules already exist in the project at the listed paths.',
    'You MUST import from them. You MUST NOT create files with overlapping',
    'exports. If your implementation needs one of these types, import it.',
    'Do not redefine it. The post-generation validator (PGV-012) will fail',
    'the build if it finds duplicate declarations.',
    '',
  ];
  for (const mod of OWNED_SCAFFOLD_MODULES) {
    lines.push(`- \`${mod.path}\` → ${mod.exports.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Cached, lazily-built footer body. */
let _crossCuttingFooterCache: string | null = null;
function getCrossCuttingFooter(): string {
  if (_crossCuttingFooterCache !== null) return _crossCuttingFooterCache;
  _crossCuttingFooterCache = `\n${buildScaffoldOwnedBlock()}\n${CROSS_CUTTING_FOOTER_BODY}`;
  return _crossCuttingFooterCache;
}

const CROSS_CUTTING_FOOTER_BODY = `
## Mandatory Cross-Cutting Requirements (EVERY module must implement these)

### Logging
- Create \`src/logger.ts\` (if it does not exist) with \`createLogger(service: string)\` that outputs JSON to stderr
- Every log entry: \`{ timestamp, level, service, event, correlationId?, ...data }\`
- Import and use the logger in THIS module. Log: function entry with key params, completion with duration, errors with context

### Configuration
- Create \`src/config.ts\` (if it does not exist) with typed \`AppConfig\` read from environment variables
- NEVER hardcode: ports, URLs, thresholds, weights, API keys, timeouts
- Import config in THIS module for any configurable value

### Input Validation (ADR-046: Zod at EVERY boundary)
- EVERY function receiving external data MUST Zod-parse it before use:
  \`\`\`typescript
  // API request bodies:
  const CreateSchema = z.object({ name: z.string().min(1), value: z.number().positive() });
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

  // Database rows — NEVER use \`as\` to cast DB results:
  const RowSchema = z.object({ id: z.string(), score: z.number(), status: z.enum(['pending','approved']) });
  const row = RowSchema.parse(rawDbRow); // throws on schema mismatch

  // ERP/API responses:
  const ERPResponseSchema = z.object({ sys_id: z.string(), result: z.string() });
  const erpData = ERPResponseSchema.parse(response.data);
  \`\`\`
- NEVER use \`as SomeType\` to cast external data — always Zod-parse first

### Error Handling
- Define error classes extending \`AppError\` (create in \`src/errors.ts\` if needed)
- Never \`catch (e: any)\` — always narrow error types
- Log errors with logger.error() including stack trace and context
- If using an event bus/emitter: wrap EACH handler in try/catch so one failure doesn't block others

### Config-Driven (ADR-046: zero hardcoded magic numbers)
- EVERY threshold, weight, factor, timeout, and constant MUST come from config
- The config module MUST validate all values with Zod at startup
- If config is invalid, the service MUST refuse to start with a clear error message
- Example: scoring weights, emission factors, retry counts, batch intervals — ALL from config, NONE hardcoded

### Deterministic Code (ADR-046)
- No \`Math.random()\` in any production code path
- Use UUIDs (crypto.randomUUID()) for IDs, not Math.random()
- Seed data generators may use seeded random, but service code must be deterministic

### Architecture (ADR-047: constructor injection, thin handlers)
- Every service class receives dependencies via constructor — NOT module-level imports of singletons
- Route/controller handlers must be THIN: (1) Zod-validate request (2) call service method (3) format response
- Business logic, orchestration, multi-step workflows → application service layer, NOT route handlers
- If the domain needs periodic sync/ingestion: use setInterval or cron with interval from config, log every run
- Composition root (src/container.ts or src/index.ts) is the ONLY place services are instantiated

### ERP Integration (ADR-050: resilience, idempotency, schema as code)
- Retry with exponential backoff: 1s → 2s → 4s, max 3 attempts, on 429/503/timeout
- Idempotency key per write: \`hash(decisionId + timestamp)\` — prevents duplicates on retry
- Check-before-write: query for existing record before creating
- Circuit breaker: open after 5 consecutive failures, half-open after 30s, log state changes
- All ERP operations logged with correlationId and responseTimeMs
- Schema as code: define \`src/erp/schema.ts\` mapping domain fields → ERP fields:
  \`\`\`typescript
  // Example: ServiceNow custom table mapping
  interface ERPRecordSchema {
    u_decision_id: string;        // → decision.id
    u_recommendation_type: string; // → recommendation.type
    u_score: number;              // → score.overallScore
    u_rationale: string;          // → decision.rationale
    u_approved_by: string;        // → approval.approvedBy
    u_approved_at: string;        // → approval.timestamp (ISO)
  }
  \`\`\`

### Governance (ADR-048: RBAC, immutable audit, separation of duties)
- Approval endpoints MUST enforce roles via middleware:
  \`\`\`typescript
  // Read role from X-User-Role header (prototype) or JWT claim (production)
  function requireRole(...roles: string[]) {
    return (req, res, next) => {
      const role = req.headers['x-user-role'] ?? 'viewer';
      if (!roles.includes(role)) return res.status(403).json({ error: 'Insufficient role' });
      next();
    };
  }
  // Usage: router.post('/approve/:id', requireRole('approver', 'admin'), handler);
  \`\`\`
- Separation of duties: the approver MUST NOT be the recommendation creator
  \`\`\`typescript
  if (recommendation.createdBy === req.headers['x-user-id']) {
    return res.status(403).json({ error: 'Cannot approve own recommendation' });
  }
  \`\`\`
- Audit trail MUST be immutable — implement SHA-256 hash chain:
  \`\`\`typescript
  // Each audit entry hashes the previous entry's hash
  const previousHash = lastEntry?.hash ?? 'genesis';
  const entryData = JSON.stringify({ ...entry, previousHash });
  entry.hash = crypto.createHash('sha256').update(entryData).digest('hex');
  \`\`\`
- Verification endpoint: GET /api/audit/verify checks chain integrity
- Every state transition records: who (userId+role), what (from→to), when (server timestamp), why (rationale min 10 chars), correlationId

### Simulation Alignment (ADR-049: consume sim outputs, explain confidence)
- Key domain types (Decision, Recommendation, ERPTransaction) MUST include:
  \`simulationId?: string\`, \`traceId?: string\`, \`pipelineVersion?: string\`
- **Copy \`src/simulation-lineage.ts\` from scaffold (ADR-PIPELINE-068).** It exports
  \`loadSimulationLineage()\` (permissive) and \`requireSimulationLineage()\` (strict).
  At startup, call \`loadSimulationLineage()\` to get \`{ simulationId, traceId, runId, source }\`
  and thread \`simulationId\` through every service constructor, audit entry, and ERP post.
- **DO NOT write your own lineage loader.** Do NOT use \`require()\` — the generated
  project is ESM (\`"type": "module"\`) and \`require()\` throws at runtime, producing a
  silent \`sim-unknown\` fallback that severs lineage. The scaffolded file uses
  \`readFileSync\` + \`fileURLToPath\` and walks up the tree looking for
  \`.agentics/plans/manifest.json\` or \`.agentics/runs/latest/manifest.json\`.
- Pass \`simulationId\` to all service constructors — every record carries lineage.
- Log simulationId in every analysis run: \`logger.info("analysis.start", { simulationId })\`
- Demo script MUST call \`loadSimulationLineage()\` at startup and print
  \`formatLineageBanner(lineage)\` (also exported from \`src/simulation-lineage.ts\`).
  When \`lineage.source === 'fallback'\` the banner prints a loud warning so the
  break is visible at demo time instead of landing in an executive summary.
- Demo script MUST print "Analysis Confidence" section:
  - If confidence < 60%: "The pilot resolves remaining uncertainty"
  - If confidence >= 80%: "High confidence — proceed with standard monitoring"

## Anti-Patterns to AVOID (evaluation checks for these — violations REDUCE score)
- Do NOT use console.log/console.error — use createLogger() from src/logger.ts
- Do NOT use \`as SomeType\` to cast DB rows, API responses, or request bodies — Zod-parse instead
- Do NOT put business logic in route handlers — extract to service layer
- Do NOT hardcode thresholds, weights, or magic numbers — read from config
- Do NOT use Math.random() in production code — use crypto.randomUUID() for IDs
- Do NOT list unused dependencies in package.json — if listed, USE them
- Do NOT let event/message handlers fail silently — wrap each in try/catch with logging
- Do NOT initialize required fields to empty string '' — use defaults or make optional

## Observability Enforcement (ADR-051: correlation IDs, metrics, circuit breaker)

### Logger — EVERY module:
Import \`createLogger\` from \`../logger.js\`. Log:
- Function entry: \`logger.info('fn.start', { correlationId, params })\`
- Function exit: \`logger.info('fn.complete', { correlationId, durationMs })\`
- Errors: \`logger.error('fn.failed', error, { correlationId, context })\`
- NEVER: \`logger.error({ error: err })\` — logs [object Object]
- ALWAYS: \`logger.error('op.failed', err, { correlationId, context })\`

### Correlation IDs — NON-NEGOTIABLE:
- Copy \`src/middleware.ts\` from scaffold (provides correlationId + requestLogger + metricsHandler + CircuitBreaker)
- Wire: \`app.use(correlationId); app.use(requestLogger); app.get('/metrics', metricsHandler);\`
- Every request gets UUID from X-Correlation-Id header or generated
- Pass correlationId through all service calls, include in every log/audit/ERP entry
- Return in response header

### Metrics — GET /metrics:
- Wire \`metricsHandler\` from middleware.ts to \`GET /metrics\`
- Call \`incrementCounter('http_requests_total', { method, path, status })\` in request logger
- Call \`recordHistogram('scoring_duration_seconds', durationMs)\` in scoring service

### Circuit Breaker — all external calls:
- Import \`CircuitBreaker\` from middleware.ts
- Wrap ERP client: \`const breaker = new CircuitBreaker('erp'); await breaker.call(() => erpClient.sync(data));\`
`;

/**
 * ADR-PIPELINE-039: Foundation infrastructure that must be created FIRST.
 * Included in the foundation prompt so logger/config/errors exist before domain code.
 */
const FOUNDATION_INFRASTRUCTURE = `
## FIRST: Create these shared modules (before domain types)

### src/logger.ts
\`\`\`typescript
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}
export function createLogger(service: string): Logger {
  return {
    info: (event, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service, event, ...data })),
    warn: (event, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', service, event, ...data })),
    error: (event, err, data) => console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', service, event, error: err.message, stack: err.stack, ...data })),
  };
}
\`\`\`

### src/config.ts
\`\`\`typescript
export interface AppConfig {
  env: 'development' | 'staging' | 'production';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  erp: { baseUrl: string; apiVersion: string; timeoutMs: number; maxRetries: number };
}
export const config: AppConfig = {
  env: (process.env.NODE_ENV ?? 'development') as AppConfig['env'],
  port: parseInt(process.env.PORT ?? '3000', 10),
  logLevel: (process.env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'],
  erp: {
    baseUrl: process.env.ERP_BASE_URL ?? 'https://api.example.com',
    apiVersion: process.env.ERP_API_VERSION ?? 'v1',
    timeoutMs: parseInt(process.env.ERP_TIMEOUT_MS ?? '30000', 10),
    maxRetries: parseInt(process.env.ERP_MAX_RETRIES ?? '3', 10),
  },
};
\`\`\`

### src/errors.ts
\`\`\`typescript
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly statusCode = 500) {
    super(message); this.name = 'AppError';
  }
}
export class ValidationError extends AppError {
  constructor(message: string) { super(message, 'VALIDATION_ERROR', 400); }
}
export class NotFoundError extends AppError {
  constructor(entity: string, id: string) { super(\`\${entity} \${id} not found\`, 'NOT_FOUND', 404); }
}
\`\`\`

## THEN: Create the composition root (src/container.ts or in src/index.ts)

ADR-047: Wire all services via constructor injection — no module-level singletons:
\`\`\`typescript
// src/container.ts — composition root
import { createLogger } from './logger.js';
import { config } from './config.js';

export function createContainer() {
  const logger = createLogger('app');
  const eventBus = new EventBus(logger); // injected, not global
  const repository = new Repository(config.db, logger);
  const erpClient = new ERPClient(config.erp, logger);
  const scoringService = new ScoringService(config.scoring, logger, eventBus);
  const approvalService = new ApprovalService(repository, erpClient, logger, eventBus);
  return { logger, eventBus, repository, erpClient, scoringService, approvalService };
}
\`\`\`

Every service receives dependencies via constructor. The composition root is the ONLY place where services are instantiated. No module-level singletons except config.

## THEN: Create domain types and project structure
`;

// ============================================================================
// Types
// ============================================================================

interface ImplementationPrompt {
  id: string;
  title: string;
  boundedContext: string;
  relatedADRs: string[];
  content: string;
  dependencies: string[];
  order: number;
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateImplementationPrompts(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('prompt-generation', 'generate-prompts', { phase2Dir: context.phase2Dir });

  try {
    // Load ADRs from prior stage
    const adrStage = context.stageOutputs.get('adr-generation');
    if (!adrStage || adrStage.status !== 'completed') {
      throw new Error('ECLI-P2-030: ADR output not available for prompt generation.');
    }
    const adrs = adrStage.data as Phase2ADRRecord[];

    if (!adrs || adrs.length === 0) {
      throw new Error('ECLI-P2-030: No ADRs available — cannot generate implementation prompts.');
    }

    // Load DDD model from prior stage
    const dddStage = context.stageOutputs.get('ddd-generation');
    const domainModel = dddStage?.status === 'completed'
      ? dddStage.data as Phase2DomainModel
      : null;

    // Load SPARC for service definitions
    const sparcStage = context.stageOutputs.get('sparc-specification');
    const sparc = sparcStage?.status === 'completed'
      ? sparcStage.data as Phase2SPARCOutput
      : null;

    // Extract query for prompt context
    const query = context.phase1Artifacts?.scenario?.query
      ?? (context.phase1Artifacts?.manifest as unknown as Record<string, unknown>)?.['query'] as string
      ?? '';

    // Extract simulation ID for lineage
    const simulationId = context.phase1Artifacts?.manifest?.execution_id
      ?? context.phase1Artifacts?.manifest?.run_id
      ?? '';

    // Generate prompts
    const prompts = domainModel && domainModel.contexts.length > 0
      ? generateFromDDDContexts(adrs, domainModel, sparc, query, simulationId)
      : generateFromADRsOnly(adrs, query, simulationId);

    // ADR-039: Inject foundation infrastructure (logger, config, errors) into the first prompt
    if (prompts.length > 0) {
      prompts[0]!.content = prompts[0]!.content.replace(
        /## (?:Project Objective|Scope|Implementation Requirements)/,
        (match) => `${FOUNDATION_INFRASTRUCTURE}\n\n${match}`,
      );
    }

    // Write prompt files
    const promptsDir = path.join(context.phase2Dir, PROMPTS_SUBDIR);
    fs.mkdirSync(promptsDir, { recursive: true, mode: DIR_MODE });
    const writtenPaths: string[] = [];

    for (const prompt of prompts) {
      const filename = `impl-${String(prompt.order).padStart(3, '0')}-${slugify(prompt.boundedContext)}.md`;
      const filePath = path.join(promptsDir, filename);
      fs.writeFileSync(filePath, prompt.content, { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(filePath);
    }

    // Write execution plan
    const plan = {
      prompts: prompts.map(p => ({ id: p.id, title: p.title, order: p.order, boundedContext: p.boundedContext, relatedADRs: p.relatedADRs, dependencies: p.dependencies })),
      totalSteps: prompts.length,
      simulationId: simulationId || undefined,
    };
    const planPath = path.join(promptsDir, 'execution-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    writtenPaths.push(planPath);

    endSpan(rootSpan, 'ok', { promptCount: prompts.length });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;
    const output: Phase2StageOutput = {
      stage: 'prompt-generation',
      status: 'completed',
      data: plan,
      artifacts: writtenPaths,
      timing,
      summary: `     Prompts: ${prompts.length} implementation prompts (${writtenPaths.length - 1} markdown + 1 execution plan)`,
    };

    context.stageOutputs.set('prompt-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const output: Phase2StageOutput = {
      stage: 'prompt-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing: rootSpan.durationMs ?? 0,
      summary: `Prompt generation failed: ${errorMessage}`,
    };
    context.stageOutputs.set('prompt-generation', output);
    return output;
  }
}

// ============================================================================
// Prompt Generation: DDD-based (preferred path)
// ============================================================================

function generateFromDDDContexts(
  adrs: Phase2ADRRecord[],
  domainModel: Phase2DomainModel,
  sparc: Phase2SPARCOutput | null,
  query: string,
  simulationId: string,
): ImplementationPrompt[] {
  const contexts = domainModel.contexts;
  const relations = domainModel.contextMap ?? [];
  const prompts: ImplementationPrompt[] = [];

  // Topological sort by dependency depth
  const depthOf = computeContextDepths(contexts, relations);
  const sorted = [...contexts].sort((a, b) => (depthOf.get(a.name) ?? 0) - (depthOf.get(b.name) ?? 0));

  // Assign ADRs to their most relevant context
  const adrAssignment = assignADRsToContexts(adrs, contexts);

  const completedSteps: string[] = [];
  let stepCounter = 0;

  // Phase 1: Per-context foundation prompts — each context gets a types + core logic prompt
  for (const ctx of sorted) {
    const contextAdrs = adrAssignment.get(ctx.name) ?? [];
    const service = sparc?.architecture?.services?.find(
      s => s.name.toLowerCase() === ctx.name.toLowerCase(),
    );

    stepCounter++;
    const content = buildContextPrompt(ctx, contextAdrs, service, query, completedSteps, sorted.length, stepCounter, simulationId);

    prompts.push({
      id: `prompt-${String(stepCounter).padStart(3, '0')}`,
      title: `Build: ${ctx.name} — Domain Types & Core Logic`,
      boundedContext: ctx.name,
      relatedADRs: contextAdrs.map(a => a.id),
      content,
      dependencies: completedSteps.slice(),
      order: stepCounter,
    });
    completedSteps.push(ctx.name);

    // Phase 2: Per-aggregate decomposition — contexts with multiple aggregates get
    // one additional prompt per aggregate for detailed implementation
    if (ctx.aggregates.length > 1) {
      for (const agg of ctx.aggregates) {
        stepCounter++;
        const aggContent = buildAggregatePrompt(ctx, agg, contextAdrs, query, completedSteps, stepCounter, simulationId);
        prompts.push({
          id: `prompt-${String(stepCounter).padStart(3, '0')}`,
          title: `Build: ${ctx.name} — ${agg.root} Aggregate`,
          boundedContext: `${slugify(ctx.name)}-${slugify(agg.root)}`,
          relatedADRs: contextAdrs.map(a => a.id),
          content: aggContent,
          dependencies: [ctx.name, ...completedSteps.filter(s => s !== ctx.name)],
          order: stepCounter,
        });
      }
    }
  }

  // Phase 3: Cross-cutting prompts for integration, observability, and API layer
  const crossCuttingPrompts = buildCrossCuttingPrompts(sorted, adrs, sparc, query, completedSteps, stepCounter, simulationId);
  for (const p of crossCuttingPrompts) {
    stepCounter++;
    prompts.push({ ...p, id: `prompt-${String(stepCounter).padStart(3, '0')}`, order: stepCounter });
  }

  // Ensure minimum 10 prompts by adding granular infrastructure prompts if needed
  if (prompts.length < 10) {
    const infraPrompts = buildInfrastructurePrompts(sorted, adrs, query, completedSteps, stepCounter, simulationId);
    for (const p of infraPrompts) {
      if (prompts.length >= 12) break;
      stepCounter++;
      prompts.push({ ...p, id: `prompt-${String(stepCounter).padStart(3, '0')}`, order: stepCounter });
    }
  }

  // Renumber all prompts sequentially
  for (let i = 0; i < prompts.length; i++) {
    prompts[i]!.order = i + 1;
    prompts[i]!.id = `prompt-${String(i + 1).padStart(3, '0')}`;
  }

  return prompts;
}

// ============================================================================
// Prompt Generation: ADR-only fallback (when DDD model is empty)
// ============================================================================

function generateFromADRsOnly(
  adrs: Phase2ADRRecord[],
  query: string,
  simulationId: string,
): ImplementationPrompt[] {
  const prompts: ImplementationPrompt[] = [];

  // Group ADRs into logical clusters by keyword similarity
  const clusters = clusterADRs(adrs);

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i]!;
    const order = i + 1;
    const clusterName = cluster.name;

    const lines: string[] = [
      `# Build Step ${order} of ${clusters.length}: ${clusterName}`,
      '',
      '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
      '',
      `## Project Objective`,
      '',
      query.slice(0, 500),
      '',
    ];

    if (simulationId) {
      lines.push(`## Simulation Lineage`, '', `Originating simulation: \`${simulationId}\``, '');
    }

    lines.push('## Architecture Decisions Governing This Step', '');
    for (const adr of cluster.adrs) {
      lines.push(`### ${adr.id}: ${adr.title}`, '');
      lines.push(`**Context:** ${adr.context}`, '');
      lines.push(`**Decision:** ${adr.decision}`, '');
      if (adr.consequences.length > 0) {
        lines.push('**Consequences:**');
        for (const c of adr.consequences) {
          const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
          lines.push(`- [${icon}] ${c.description}`);
        }
        lines.push('');
      }
    }

    lines.push('## Implementation Requirements', '');
    lines.push('- Use London School TDD: write failing test first, then minimal implementation');
    lines.push('- No stubs or placeholders — every function must have real logic');
    lines.push('- All business rules from the ADRs above must be enforced in code');
    lines.push('- Include error handling for edge cases identified in the ADRs');
    lines.push('');
    lines.push(getCrossCuttingFooter());

    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build: ${clusterName}`,
      boundedContext: slugify(clusterName),
      relatedADRs: cluster.adrs.map(a => a.id),
      content: lines.join('\n'),
      dependencies: clusters.slice(0, i).map(c => c.name),
      order,
    });
  }

  // Ensure minimum 10 prompts by adding standard cross-cutting prompts
  const standardExtras: { title: string; bc: string; content: string }[] = [
    { title: 'API Layer & Request Handling', bc: 'api-layer', content: '- REST API endpoints for core operations\n- Input validation (Zod or equivalent)\n- Authentication middleware\n- Structured error responses' },
    { title: 'Observability & Structured Logging', bc: 'observability', content: 'ADR-PIPELINE-034: Full observability infrastructure.\n\n1. Create src/logger.ts with createLogger(service) factory outputting JSON to stderr. Fields: timestamp, level, service, event, correlationId, data.\n2. Thread correlationId (UUID) through analysis → decision → ERP sync. Use parameter passing or AsyncLocalStorage.\n3. Minimum instrumentation: analysis.started, analysis.completed (with durationMs), decision.created, erp.sync.attempted, erp.sync.succeeded, erp.sync.failed.\n4. ERP error handling: 30s timeout, 429 exponential backoff (3 retries), schema validation quarantine, idempotency keys.\n5. Health check: GET /health returning {status, service, version, uptime, lastAnalysisRun}.\n6. Tests: logger outputs valid JSON, correlationId flows end-to-end, ERP retries on 429.' },
    { title: 'Configuration & Environment Management', bc: 'configuration', content: '- Environment-based config (dev/staging/prod)\n- Config validation at startup\n- Secret management via env vars\n- Typed config objects' },
    { title: 'Persistence & Data Access', bc: 'persistence', content: '- Repository interfaces per aggregate\n- Database adapter implementations\n- Audit trail persistence (append-only)\n- Transaction management' },
    { title: 'Deployment & Infrastructure', bc: 'deployment', content: '- Dockerfile with multi-stage build\n- Docker Compose for local dev\n- CI/CD pipeline configuration\n- Health check integration' },
    { title: 'Demo Script & Architecture Documentation', bc: 'demo', content: 'ADR-PIPELINE-037: Create src/demo.ts that loads seed data, runs the full analysis pipeline, prints formatted results (tables), demonstrates decision/approval workflow, and shows ERP sync payload (dry run). Must run without external dependencies. Also create docs/ADR-001-monolithic-prototype.md documenting why the prototype is a monolith despite SPARC prescribing microservices.' },
  ];

  for (const extra of standardExtras) {
    if (prompts.length >= 12) break;
    // Skip if a cluster already covers this topic
    if (prompts.some(p => p.boundedContext === extra.bc)) continue;
    const order = prompts.length + 1;
    prompts.push({
      id: `prompt-${String(order).padStart(3, '0')}`,
      title: `Build: ${extra.title}`,
      boundedContext: extra.bc,
      relatedADRs: [],
      content: [
        `# Build Step ${order}: ${extra.title}`,
        '',
        '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
        '',
        '## Project Objective', '', query.slice(0, 400), '',
        simulationId ? `## Simulation Lineage\n\nOriginating simulation: \`${simulationId}\`\n` : '',
        '## Requirements', '', extra.content, '',
        '- Use London School TDD: write failing test first, then minimal implementation',
        '- No stubs or placeholders — every function must have real logic',
        '',
      ].filter(Boolean).join('\n'),
      dependencies: clusters.map(c => c.name),
      order,
    });
  }

  // Renumber all prompts sequentially
  for (let i = 0; i < prompts.length; i++) {
    prompts[i]!.order = i + 1;
    prompts[i]!.id = `prompt-${String(i + 1).padStart(3, '0')}`;
  }

  return prompts;
}

// ============================================================================
// Per-Aggregate Prompt Builder
// ============================================================================

function buildAggregatePrompt(
  ctx: Phase2DDDBoundedContext,
  agg: Phase2DDDBoundedContext['aggregates'][0],
  adrs: Phase2ADRRecord[],
  query: string,
  _completedSteps: string[],
  order: number,
  simulationId: string,
): string {
  const lines: string[] = [
    `# Build Step ${order}: ${ctx.name} — ${agg.root} Aggregate`,
    '',
    '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
    '',
    '## Project Objective', '',
    query.slice(0, 400),
    '',
  ];

  if (simulationId) {
    lines.push('## Simulation Lineage', '', `Originating simulation: \`${simulationId}\``, '');
  }

  lines.push(`## Aggregate: ${agg.root}`, '');
  lines.push(`Name: ${agg.name}`);
  if (agg.entities.length > 0) {
    lines.push('', '### Entities');
    for (const e of agg.entities) lines.push(`- **${e.name}**: ${e.description}`);
  }
  if (agg.valueObjects.length > 0) {
    lines.push('', '### Value Objects');
    for (const vo of agg.valueObjects) {
      lines.push(`- **${vo.name}**: ${vo.description}`);
      if (vo.invariants.length > 0) lines.push(`  Invariants: ${vo.invariants.join('; ')}`);
    }
  }
  lines.push('');

  // Filter ADRs relevant to this aggregate
  const aggKeywords = [agg.root, agg.name, ...agg.entities.map(e => e.name)].map(k => k.toLowerCase());
  const relevantAdrs = adrs.filter(a => {
    const txt = `${a.title} ${a.decision}`.toLowerCase();
    return aggKeywords.some(kw => txt.includes(kw.replace(/[^a-z]+/g, '')));
  });
  if (relevantAdrs.length > 0) {
    lines.push('## Relevant Architecture Decisions', '');
    for (const adr of relevantAdrs.slice(0, 3)) {
      lines.push(`### ${adr.id}: ${adr.title}`, '', `**Decision:** ${adr.decision}`, '');
    }
  }

  lines.push('## Implementation Requirements', '');
  lines.push('- Use London School TDD: write failing test first, then minimal implementation');
  lines.push('- Implement all entity validation, invariant enforcement, and domain event emission');
  lines.push('- No stubs or placeholders — every function must have real logic');
  lines.push(`- This aggregate is part of the ${ctx.name} bounded context — respect its boundaries`);
  lines.push('');
  lines.push(getCrossCuttingFooter());

  return lines.join('\n');
}

// ============================================================================
// Cross-Cutting Prompt Builders
// ============================================================================

function buildCrossCuttingPrompts(
  contexts: readonly Phase2DDDBoundedContext[],
  adrs: Phase2ADRRecord[],
  _sparc: Phase2SPARCOutput | null,
  query: string,
  _completedSteps: string[],
  _startOrder: number,
  simulationId: string,
): ImplementationPrompt[] {
  const prompts: ImplementationPrompt[] = [];
  const contextNames = contexts.map(c => c.name);
  const simLine = simulationId ? `\n## Simulation Lineage\n\nOriginating simulation: \`${simulationId}\`\n` : '';

  // Integration / Context Map prompt
  const integrationAdrs = adrs.filter(a => /integrat|erp|api|gateway|adapter|connect/i.test(`${a.title} ${a.decision}`));
  prompts.push({
    id: 'temp', title: 'Build: Integration Layer & Context Map',
    boundedContext: 'integration-layer',
    relatedADRs: integrationAdrs.map(a => a.id),
    dependencies: contextNames,
    order: 0,
    content: [
      '# Build Step: Integration Layer & Context Map',
      '',
      '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
      '', '## Project Objective', '', query.slice(0, 400), '', simLine,
      '## Scope', '',
      'Implement the integration layer that connects bounded contexts and external systems.',
      `Bounded contexts to integrate: ${contextNames.join(', ')}`,
      '',
      '## Requirements', '',
      '- Anti-corruption layers between contexts where needed',
      '- Adapter interfaces for external system communication (ERP, APIs)',
      '- Event translation between context-specific domain events',
      '- Error handling and retry logic for cross-boundary communication',
      '- Use London School TDD',
      '',
      integrationAdrs.length > 0 ? `## Relevant ADRs\n\n${integrationAdrs.slice(0, 4).map(a => `### ${a.id}: ${a.title}\n**Decision:** ${a.decision}`).join('\n\n')}\n` : '',
    ].filter(Boolean).join('\n'),
  });

  // Observability prompt — ADR-PIPELINE-034: detailed code patterns
  prompts.push({
    id: 'temp', title: 'Build: Observability & Structured Logging',
    boundedContext: 'observability',
    relatedADRs: [],
    dependencies: contextNames,
    order: 0,
    content: [
      '# Build Step: Observability & Structured Logging',
      '',
      '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
      '', '## Project Objective', '', query.slice(0, 400), '', simLine,
      '## Scope', '',
      'Implement complete observability infrastructure per ADR-PIPELINE-034.',
      '',
      '## 1. Structured Logger (src/logger.ts)', '',
      'Create a logger factory that outputs single-line JSON to stderr:',
      '```typescript',
      'export interface Logger {',
      '  info(event: string, data?: Record<string, unknown>): void;',
      '  warn(event: string, data?: Record<string, unknown>): void;',
      '  error(event: string, error: Error, data?: Record<string, unknown>): void;',
      '}',
      'export function createLogger(service: string): Logger;',
      '```',
      'Every entry must include: timestamp (ISO), level, service, event, correlationId (when available), and optional data.',
      '',
      '## 2. Correlation ID Threading', '',
      'Generate a correlationId (UUID) at the start of each analysis run.',
      'Thread it through: analysis → detection → recommendation → decision → ERP sync.',
      'Use parameter passing or AsyncLocalStorage. Every log entry must include it.',
      '',
      '## 3. Instrumentation Points', '',
      '| Event | When | Data Fields |',
      '|-------|------|-------------|',
      '| analysis.started | Pipeline begins | correlationId, entityCount, recordCount |',
      '| analysis.completed | Pipeline finishes | correlationId, durationMs, flagCount, opportunityCount |',
      '| decision.created | Decision recorded | correlationId, decisionId, status |',
      '| erp.sync.attempted | ERP write begins | correlationId, transactionId, targetSystem |',
      '| erp.sync.succeeded | ERP write succeeds | correlationId, transactionId, responseTimeMs |',
      '| erp.sync.failed | ERP write fails | correlationId, transactionId, error, retryCount |',
      '',
      '## 4. ERP Error Handling', '',
      '- Network timeout: configurable (default 30s), log erp.sync.failed with timeout error',
      '- Rate limiting (429): exponential backoff (1s, 2s, 4s, max 3 retries), log each retry attempt',
      '- Schema validation: log and quarantine invalid records, do not crash the pipeline',
      '- Idempotency: generate idempotency key per transaction to prevent duplicate writes',
      '',
      '## 5. Health Check', '',
      'If the project has an API layer, add GET /health returning:',
      '{ status: "ok", service: "<name>", version: "0.1.0", uptime: <seconds>, lastAnalysisRun: "<ISO>" }',
      '',
      '## Requirements', '',
      '- Structured JSON logging with correlation IDs across all service calls',
      '- Health check endpoint',
      '- Metrics collection for key operations (latency, error rate, throughput)',
      '- Log levels: ERROR, WARN, INFO, DEBUG',
      '- Request/response tracing across bounded context boundaries',
      '- Use London School TDD',
      '',
    ].join('\n'),
  });

  // Configuration & environment prompt
  prompts.push({
    id: 'temp', title: 'Build: Configuration & Environment Management',
    boundedContext: 'configuration',
    relatedADRs: [],
    dependencies: [],
    order: 0,
    content: [
      '# Build Step: Configuration & Environment Management',
      '',
      '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
      '', '## Project Objective', '', query.slice(0, 400), '', simLine,
      '## Scope', '',
      'Implement environment-based configuration management for all services.',
      '',
      '## Requirements', '',
      '- Environment-based config (dev, staging, production) via environment variables',
      '- Config validation at startup with clear error messages for missing values',
      '- Secret management (API keys, credentials) via environment variables — never hardcoded',
      '- Typed configuration objects with runtime validation',
      '- Use London School TDD',
      '',
    ].join('\n'),
  });

  return prompts;
}

function buildInfrastructurePrompts(
  contexts: readonly Phase2DDDBoundedContext[],
  adrs: Phase2ADRRecord[],
  query: string,
  _completedSteps: string[],
  _startOrder: number,
  simulationId: string,
): ImplementationPrompt[] {
  const prompts: ImplementationPrompt[] = [];
  const simLine = simulationId ? `\n## Simulation Lineage\n\nOriginating simulation: \`${simulationId}\`\n` : '';
  const contextNames = contexts.map(c => c.name);

  // API / REST layer
  prompts.push({
    id: 'temp', title: 'Build: API Layer & Request Handling',
    boundedContext: 'api-layer',
    relatedADRs: [],
    dependencies: contextNames,
    order: 0,
    content: [
      '# Build Step: API Layer & Request Handling',
      '', '**The implementation must be production ready.**',
      '', '## Project Objective', '', query.slice(0, 300), '', simLine,
      '## Requirements', '',
      '- REST API endpoints exposing core domain operations',
      '- Input validation at API boundary (Zod or equivalent)',
      '- Authentication and authorization middleware',
      '- Error serialization (structured error responses)',
      '- Use London School TDD',
      '',
    ].join('\n'),
  });

  // Persistence layer
  const persistAdrs = adrs.filter(a => /persist|storage|database|audit|immutab/i.test(`${a.title} ${a.decision}`));
  prompts.push({
    id: 'temp', title: 'Build: Persistence & Data Access Layer',
    boundedContext: 'persistence',
    relatedADRs: persistAdrs.map(a => a.id),
    dependencies: contextNames,
    order: 0,
    content: [
      '# Build Step: Persistence & Data Access Layer',
      '', '**The implementation must be production ready.**',
      '', '## Project Objective', '', query.slice(0, 300), '', simLine,
      '## Requirements', '',
      '- Repository interfaces per aggregate (ports)',
      '- Database adapter implementations',
      '- Audit trail persistence (append-only, tamper-evident)',
      '- Transaction management for multi-aggregate operations',
      '- Use London School TDD',
      '',
      persistAdrs.length > 0 ? `## Relevant ADRs\n\n${persistAdrs.slice(0, 3).map(a => `### ${a.id}: ${a.title}\n**Decision:** ${a.decision}`).join('\n\n')}\n` : '',
    ].filter(Boolean).join('\n'),
  });

  // Deployment / Docker
  prompts.push({
    id: 'temp', title: 'Build: Deployment & Infrastructure',
    boundedContext: 'deployment',
    relatedADRs: [],
    dependencies: [...contextNames, 'api-layer', 'configuration'],
    order: 0,
    content: [
      '# Build Step: Deployment & Infrastructure',
      '', '**The implementation must be production ready.**',
      '', '## Project Objective', '', query.slice(0, 300), '', simLine,
      '## Requirements', '',
      '- Dockerfile with multi-stage build',
      '- Docker Compose for local development',
      '- CI/CD pipeline configuration',
      '- Health check integration',
      '- Environment variable documentation',
      '',
    ].join('\n'),
  });

  // ADR-PIPELINE-037: Demo script + architecture divergence ADR
  prompts.push({
    id: 'temp', title: 'Build: Demo Script & Architecture Documentation',
    boundedContext: 'demo',
    relatedADRs: [],
    dependencies: [...contextNames, 'api-layer'],
    order: 0,
    content: [
      '# Build Step: Demo Script & Architecture Documentation',
      '', '**The implementation must be production ready.**',
      '', '## Project Objective', '', query.slice(0, 300), '', simLine,
      '## 1. Demo Script (src/demo.ts) — REQUIRED', '',
      'Create a runnable demo (`npx tsx src/demo.ts`) that:',
      '1. Loads all seed data',
      '2. Runs the complete analysis pipeline end-to-end',
      '3. Prints formatted results to stdout (tables, not raw JSON)',
      '4. Demonstrates the decision/approval workflow (create draft, approve)',
      '5. Shows the ERP sync payload (dry run)',
      '',
      'Must run without external dependencies (no DB, no API keys, no network).',
      '',
      '## 2. Architecture Divergence ADR — REQUIRED', '',
      'Create `docs/ADR-001-monolithic-prototype.md` explaining:',
      '- SPARC architecture prescribes microservices',
      '- Prototype uses monolithic library with module boundaries',
      '- Module boundaries enable future decomposition',
      '- This is the correct choice for a 3-7 day evaluation period',
      '',
      '## Tests', '',
      '- Test that demo.ts runs without errors',
      '- Test that it produces non-empty output',
      '',
    ].join('\n'),
  });

  return prompts;
}

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function computeContextDepths(
  contexts: readonly Phase2DDDBoundedContext[],
  relations: readonly { upstream: string; downstream: string; type: string }[],
): Map<string, number> {
  const depthOf = new Map<string, number>();
  const deps = new Map<string, Set<string>>();

  for (const ctx of contexts) {
    deps.set(ctx.name, new Set());
  }
  for (const rel of relations) {
    deps.get(rel.downstream)?.add(rel.upstream);
  }

  function resolve(name: string, visited: Set<string>): number {
    if (depthOf.has(name)) return depthOf.get(name)!;
    if (visited.has(name)) return 0;
    visited.add(name);
    const d = deps.get(name) ?? new Set();
    const maxUp = d.size === 0 ? -1 : Math.max(...[...d].map(u => resolve(u, visited)));
    const depth = maxUp + 1;
    depthOf.set(name, depth);
    return depth;
  }

  for (const ctx of contexts) {
    resolve(ctx.name, new Set());
  }
  return depthOf;
}

function assignADRsToContexts(
  adrs: Phase2ADRRecord[],
  contexts: readonly Phase2DDDBoundedContext[],
): Map<string, Phase2ADRRecord[]> {
  const assignment = new Map<string, Phase2ADRRecord[]>();
  for (const ctx of contexts) {
    assignment.set(ctx.name, []);
  }

  for (const adr of adrs) {
    const adrText = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase();
    let bestCtx = contexts[0]?.name ?? '';
    let bestScore = 0;

    for (const ctx of contexts) {
      const keywords = ctx.name.toLowerCase().split(/[-_\s]+/).filter(k => k.length > 2);
      const score = keywords.filter(kw => adrText.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCtx = ctx.name;
      }
    }

    if (bestCtx) {
      assignment.get(bestCtx)?.push(adr);
    }
  }

  return assignment;
}

interface ADRCluster {
  name: string;
  adrs: Phase2ADRRecord[];
}

function clusterADRs(adrs: Phase2ADRRecord[]): ADRCluster[] {
  if (adrs.length === 0) {
    return [{ name: 'Implementation', adrs: [] }];
  }

  // Fine-grained clustering with 8+ categories for better prompt decomposition
  const clusterDefs: { name: string; pattern: RegExp }[] = [
    { name: 'Domain Model & Types', pattern: /domain|model|entity|aggregate|type|schema|value.?object/i },
    { name: 'Core Algorithms & Scoring', pattern: /scor|algo|optim|weight|rank|threshold|estimat|calculat|formula/i },
    { name: 'Data Ingestion & Processing', pattern: /ingest|pipeline|import|transform|normaliz|parse|extract|data.?flow/i },
    { name: 'ERP & External Integration', pattern: /erp|maximo|sap|oslc|api|gateway|adapter|connect|webhook|integrat/i },
    { name: 'Governance & Audit Trail', pattern: /govern|audit|approv|complian|regulat|trail|immutab|tamper/i },
    { name: 'Security & Access Control', pattern: /secur|auth|rbac|role|permiss|encrypt|credential|iam/i },
    { name: 'Persistence & Storage', pattern: /persist|storage|database|repositor|cache|retention|backup/i },
    { name: 'Simulation & Scenario Engine', pattern: /simul|scenario|what.?if|forecast|predict|compar/i },
    { name: 'Observability & Monitoring', pattern: /observ|monitor|log|metric|health|trace|alert|dashboard/i },
    { name: 'Deployment & Infrastructure', pattern: /deploy|infra|docker|ci.?cd|environment|config|scale|perform/i },
  ];

  const assigned = new Set<Phase2ADRRecord>();
  const clusters: ADRCluster[] = [];

  for (const def of clusterDefs) {
    const matching = adrs.filter(a => !assigned.has(a) && def.pattern.test(`${a.title} ${a.context} ${a.decision}`));
    if (matching.length > 0) {
      clusters.push({ name: def.name, adrs: matching });
      for (const a of matching) assigned.add(a);
    }
  }

  // Remaining ADRs get their own cluster or distribute into smallest existing cluster
  const remaining = adrs.filter(a => !assigned.has(a));
  if (remaining.length > 0) {
    if (remaining.length >= 2) {
      clusters.push({ name: 'Cross-Cutting Concerns', adrs: remaining });
    } else if (clusters.length > 0) {
      const smallest = clusters.reduce((min, c) => c.adrs.length < min.adrs.length ? c : min, clusters[0]!);
      smallest.adrs.push(...remaining);
    } else {
      clusters.push({ name: 'Implementation', adrs: remaining });
    }
  }

  // Ensure minimum cluster count by splitting large clusters
  while (clusters.length < 5 && clusters.some(c => c.adrs.length >= 3)) {
    const largest = clusters.reduce((max, c) => c.adrs.length > max.adrs.length ? c : max, clusters[0]!);
    if (largest.adrs.length < 3) break;
    const mid = Math.ceil(largest.adrs.length / 2);
    const split = largest.adrs.splice(mid);
    clusters.push({ name: `${largest.name} — Advanced`, adrs: split });
  }

  return clusters;
}

function buildContextPrompt(
  ctx: Phase2DDDBoundedContext,
  adrs: Phase2ADRRecord[],
  service: { name: string; responsibility: string; api: string[]; dependencies: string[] } | undefined,
  query: string,
  completedContexts: string[],
  totalSteps: number,
  order: number,
  simulationId: string,
): string {
  const lines: string[] = [
    `# Build Step ${order} of ${totalSteps}: ${ctx.name}`,
    '',
    '**The implementation must be production ready, enterprise grade, commercially viable, bug and error free, without compilation errors.**',
    '',
    '## Project Objective',
    '',
    query.slice(0, 500),
    '',
  ];

  if (simulationId) {
    lines.push('## Simulation Lineage', '', `Originating simulation: \`${simulationId}\``, '');
  }

  if (completedContexts.length > 0) {
    lines.push('## Already Built (import from these)', '');
    for (const prev of completedContexts) {
      lines.push(`- ${prev}`);
    }
    lines.push('');
  }

  // Bounded context definition
  lines.push(`## Bounded Context: ${ctx.name}`, '');
  lines.push(ctx.description, '');

  if (ctx.aggregates.length > 0) {
    lines.push('### Aggregates', '');
    for (const agg of ctx.aggregates) {
      lines.push(`**${agg.root}** (Aggregate Root): ${agg.name}`);
      if (agg.entities.length > 0) {
        lines.push('  Entities:');
        for (const e of agg.entities) lines.push(`  - ${e.name}: ${e.description}`);
      }
      if (agg.valueObjects.length > 0) {
        lines.push('  Value Objects:');
        for (const vo of agg.valueObjects) {
          lines.push(`  - ${vo.name}: ${vo.description}`);
          if (vo.invariants.length > 0) {
            lines.push(`    Invariants: ${vo.invariants.join('; ')}`);
          }
        }
      }
      lines.push('');
    }
  }

  if (ctx.domainEvents.length > 0) {
    lines.push('### Domain Events', '');
    for (const ev of ctx.domainEvents) {
      lines.push(`- **${ev.name}**: ${ev.description} (payload: ${ev.payload.join(', ')})`);
    }
    lines.push('');
  }

  if (ctx.commands.length > 0) {
    lines.push('### Commands', '');
    for (const cmd of ctx.commands) {
      lines.push(`- **${cmd.name}**: ${cmd.description}`);
    }
    lines.push('');
  }

  // Service specification
  if (service) {
    lines.push('### Service Specification', '');
    lines.push(`Responsibility: ${service.responsibility}`);
    if (service.api.length > 0) lines.push(`API: ${service.api.join(', ')}`);
    if (service.dependencies.length > 0) lines.push(`Dependencies: ${service.dependencies.join(', ')}`);
    lines.push('');
  }

  // Architecture decisions
  if (adrs.length > 0) {
    lines.push('## Architecture Decisions Governing This Context', '');
    for (const adr of adrs) {
      lines.push(`### ${adr.id}: ${adr.title}`, '');
      lines.push(`**Context:** ${adr.context}`, '');
      lines.push(`**Decision:** ${adr.decision}`, '');
      if (adr.consequences.length > 0) {
        lines.push('**Consequences:**');
        for (const c of adr.consequences) {
          const icon = c.type === 'positive' ? '+' : c.type === 'negative' ? '-' : '~';
          lines.push(`- [${icon}] ${c.description}`);
        }
        lines.push('');
      }
    }
  }

  lines.push('## Implementation Requirements', '');
  lines.push('- Use London School TDD: write failing test first, then minimal implementation');
  lines.push('- No stubs or placeholders — every function must have real logic');
  lines.push('- All business rules from the ADRs above must be enforced in code');
  lines.push('- Include error handling for edge cases identified in the ADRs');
  lines.push('- Hexagonal architecture: ports (interfaces) + adapters (implementations)');
  lines.push('');
  lines.push(getCrossCuttingFooter());

  return lines.join('\n');
}
