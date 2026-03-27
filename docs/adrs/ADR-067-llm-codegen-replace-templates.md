# ADR-067: Replace Template Code Generators with LLM-Driven Code Generation

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Phase 4 code generators (`http-server-generator.ts`, `erp-client-generator.ts`, `infra-adapter-generator.ts`, `deployment-generator.ts`, `schema-generator.ts`, `rust-optimizer-generator.ts`) are all **string template builders** — they push hardcoded lines into arrays and join them. This approach:

1. **Produces identical output regardless of domain** — a supplier transition system and a healthcare system get the same route structure, same adapter pattern, same error handling
2. **Embeds bugs permanently** — swapped confidence intervals, wrong switching cost calculations, governance auto-advance bypass are all baked into templates. Fixing one bug requires editing the generator, publishing a new npm version, and regenerating
3. **Cannot adapt to project-specific requirements** — templates can't reason about the domain model, they just stamp out patterns
4. **Contradicts the SPARC methodology** — SPARC produces specifications, pseudocode, and architecture decisions that should DRIVE code generation. Instead, templates ignore SPARC output and generate generic scaffolding
5. **Creates a maintenance nightmare** — 18 ADRs and 20+ versions just to fix template bugs that an LLM would never produce

The pipeline already has `claude --print` available (ADR-048 bypass, copilot agents). The ruflo swarm executor already sends prompts to coding agents. But Phase 4 bypasses all of this and stamps out templates.

### Round 4 Audit Findings (Bugs Baked Into Templates)

These are all hardcoded template bugs that an LLM-driven generator would not produce:

- **In-memory Map instead of Database** — template hardcodes `new Map()` instead of using the Database class that exists in the same project
- **Governance auto-advance** — template creates + submits + approves in one endpoint
- **hybrid → dual_source mapping** — template silently drops a strategy type the Rust engine supports
- **Swapped confidence intervals** — template has `lower = baseline * (1 + uncertainty)` (wrong)
- **Switching cost sums all edges** — template doesn't filter by target supplier
- **Hardcoded subsidiary ID '1'** — template doesn't read from config
- **Cost normalization /10M** — template uses a constant that doesn't scale to enterprise spend
- **Hash divergence TS↔Rust** — templates compute different hashes on each side

## Decision

### Replace Phase 4 template generators with LLM-driven generation via `claude --print`

Each Phase 4 stage that currently builds code via string templates will instead:

1. **Build a prompt** from SPARC output, DDD model, ADRs, simulation context, and tech stack
2. **Send the prompt to `claude --print`** (uses Claude Max — no API key needed)
3. **Parse the LLM output** into files
4. **Validate** the output compiles (run `tsc --noEmit` on generated code)
5. **Fall back to current templates** only if `claude --print` is unavailable

### Prompt Structure (per stage)

Each prompt includes:
- The SPARC specification (architecture, pseudocode, refinement sections)
- The DDD bounded contexts (aggregates, commands, queries, invariants, domain events)
- The ADRs (architectural decisions that constrain implementation)
- The simulation context (scenarios, cost model, risk signals)
- The tech stack (detected ERP, cloud provider, databases, languages)
- Explicit instructions for what the stage must produce

### Example: HTTP Server Generation

Instead of:
```typescript
// Current: 2800 lines of string template
function tsRoutes(erpSystem, contexts, simCtx, hasRustOptimizer) {
  const lines = [];
  lines.push("import { Hono } from 'hono';");
  lines.push("...");
  // 500 more lines of hardcoded strings
  return lines.join('\n');
}
```

Replace with:
```typescript
function generateRoutes(context: Phase4Context): string {
  const prompt = buildRoutesPrompt(context);
  const result = execFileSync('claude', ['--print', '--output-format', 'text', prompt], { ... });
  return extractCodeFromResponse(result);
}

function buildRoutesPrompt(context: Phase4Context): string {
  return `You are generating a production Hono HTTP server.

## SPARC Architecture
${context.sparc.architecture}

## Bounded Contexts (from DDD model)
${JSON.stringify(context.ddd.contexts, null, 2)}

## ADRs That Constrain This Implementation
${context.adrs.map(a => `- ${a.title}: ${a.decision}`).join('\n')}

## Simulation Context
${JSON.stringify(context.simulationContext)}

## Requirements
- Generate routes.ts with Hono framework
- Each bounded context gets POST (command) and GET (query) endpoints
- RBAC: GET=viewer, POST=writer, approve=approver, ERP=erp_writer
- Audit logging on ALL operations (success AND failure)
- Use the Database class for persistence (NOT in-memory Map)
- Governance state machine: separate endpoints for create, submit, approve, reject, execute
- Approver must be different from creator (separation of duties)
- Error responses sanitized in production, logged with correlationId
- Wire simulation endpoints if Rust optimizer is present
- Wire ERP writeback endpoints gated behind approved decision + lineage validation

Return ONLY the TypeScript code, no markdown fences.`;
}
```

### Stages to Convert

| Stage | Current | New Approach |
|-------|---------|-------------|
| `http-server-generator.ts` | 2800+ line string builder | LLM prompt from SPARC + DDD + ADRs |
| `erp-client-generator.ts` | 700+ line string builder | LLM prompt from tech stack + ERP type |
| `infra-adapter-generator.ts` | 500+ line string builder | LLM prompt from DDD bounded contexts |
| `schema-generator.ts` | 300+ line string builder | LLM prompt from DDD commands/queries |
| `deployment-generator.ts` | 800+ line string builder | LLM prompt from tech stack + cloud provider |
| `rust-optimizer-generator.ts` | 500+ line string builder | LLM prompt from SPARC pseudocode + domain model |

### Fallback Strategy

If `claude --print` is unavailable (no Claude binary, MCP constraints):
1. Try Anthropic API directly (if `ANTHROPIC_API_KEY` set)
2. Fall back to current template generators (last resort)
3. Log warning: "Using template fallback — LLM generation unavailable"

### Validation

After LLM generates code, validate before writing:
1. Write to temp directory
2. Run `tsc --noEmit` to verify TypeScript compiles
3. Check for required exports (app, createDependencies, etc.)
4. If validation fails, retry once with error feedback in prompt
5. If retry fails, fall back to template

## Consequences

- (+) Generated code is domain-specific — adapts to each project's requirements
- (+) SPARC output actually drives implementation (not ignored)
- (+) Template bugs eliminated — LLM reasons about the code, doesn't stamp patterns
- (+) ADRs are enforced in generated code (part of the prompt)
- (+) Simulation context embedded naturally (LLM reads it, templates can't)
- (+) One prompt change fixes all projects (no per-template bug hunting)
- (-) Generation takes 30-60s per stage (vs <1s for templates)
- (-) Requires claude binary or API key (template fallback mitigates)
- (-) LLM output varies between runs (validation step mitigates)
- (-) Larger prompts consume more tokens (but Claude Max is unlimited)

## Migration Path

1. Start with ONE stage: `schema-generator.ts` (simplest, lowest risk)
2. Validate LLM output matches or exceeds template quality
3. Convert remaining stages one at a time
4. Keep template generators as fallback (don't delete)
5. Remove templates only after 3+ successful production runs

## Audit References

- Round 4: 5/10 — five critical bugs all from template generators
- "Produces identical output regardless of domain"
- "Cannot adapt to project-specific requirements"
- 18 ADRs and 20+ versions spent fixing template bugs
- SPARC methodology demands specification-driven code generation
