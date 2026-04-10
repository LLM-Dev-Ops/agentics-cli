# ADR-PIPELINE-064: Typed Hono Context Variables in Generated HTTP Servers

**Status:** Accepted
**Date:** 2026-04-10
**Priority:** MEDIUM — Code Quality 7.5 → 10/10
**Originating Review:** Production Readiness Review (2026-04-10)

## Context

The HTTP server generator emits Hono apps **without the `Variables` generic type parameter**, forcing every context read to use an `as string` cast. Hand-verified 2026-04-10 in `src/pipeline/phase4/phases/http-server-generator.ts`.

### Evidence

**Untyped Hono instantiation:**
```
grep -n "new Hono" src/pipeline/phase4/phases/http-server-generator.ts
1289:    'const app = new Hono();'
2322:    '  const healthRouter = new Hono();'
2385:    '    const app = new Hono().route(\'/health\', healthRouter);'
```

All four `new Hono()` sites omit the generic.

**Forced casts because context is `unknown`:**
```
grep -n "c.get(.correlationId.) as string" src/pipeline/phase4/phases/http-server-generator.ts
1191: '    const correlationId = c.get(\'correlationId\') as string ?? \'unknown\';'
1309: '  }, { tier: \'should-have\', correlationId: c.get(\'correlationId\') as string }).catch(() => {});'
1317: '    const correlationId = c.get(\'correlationId\') as string ?? \'unknown\';'
1386: '  const correlationId = c.get(\'correlationId\') as string;'
```

Plus `c.get('iamClaims') as Record<string, unknown>` at line 1387 and similar patterns.

### Why This Matters for 10/10

1. **Code Quality:** `as string` casts at the API boundary are precisely the anti-pattern the code quality reviewer flags. The generator is teaching every customer's codebase to sidestep TypeScript at the most important layer.
2. **Refactor safety:** when a middleware adds a new context key (e.g., `req.userRole`), developers have to audit every call site; with typed Variables, the compiler does it for them.
3. **Consistency:** the generator already uses strict typing everywhere else (Zod schemas, typed DDD entities, typed ERP payloads). The Hono context is the one leak.

## Decision

### 1. Declare a `ContextVariables` Type at the Top of the Generated Server

The generator MUST emit this block at the top of `src/server/app.ts` (or equivalent):

```typescript
import type { Hono as HonoType } from 'hono';

// ADR-PIPELINE-064: Typed context variables eliminate `c.get('x') as string` casts.
// Every middleware that calls c.set() MUST add its key here.
export interface ContextVariables {
  correlationId: string;
  iamClaims?: {
    sub: string;
    roles: string[];
    [claim: string]: unknown;
  };
  // Add new keys in alphabetical order.
}

export type TypedHono = HonoType<{ Variables: ContextVariables }>;
```

### 2. Parameterize All `new Hono()` Instantiations

The generator MUST emit:

```typescript
const app = new Hono<{ Variables: ContextVariables }>();
```

instead of `const app = new Hono();`. Same change for `healthRouter`, test app instances, and any other routers.

### 3. Drop the `as string` Casts

With the generic, `c.get('correlationId')` returns `string` (not `unknown`), and `c.get('iamClaims')` returns `ContextVariables['iamClaims']`. The generator must emit:

```typescript
// Before (line 1191):
const correlationId = c.get('correlationId') as string ?? 'unknown';

// After:
const correlationId = c.get('correlationId') ?? 'unknown';
```

And for iamClaims:
```typescript
// Before (line 1387):
const actor = ((c.get('iamClaims') as Record<string, unknown>) ?? {})['sub'] as string ?? 'unknown';

// After:
const actor = c.get('iamClaims')?.sub ?? 'unknown';
```

### 4. Add to Post-Generation Validator

ADR-PIPELINE-065 (post-generation validator) must include a rule that fails generation if any of:
- `new Hono()` without a generic appears in the generated `src/server/*.ts`
- `c.get('correlationId') as string` appears anywhere in generated code
- `c.get('iamClaims') as` appears anywhere in generated code

## Acceptance Criteria

1. `grep "new Hono()" src/pipeline/phase4/phases/http-server-generator.ts` returns zero matches (all replaced with `new Hono<{ Variables: ContextVariables }>()`).
2. `grep "c.get(.correlationId.) as string" src/pipeline/phase4/phases/http-server-generator.ts` returns zero matches.
3. Generated `src/server/app.ts` exports a `ContextVariables` interface and `TypedHono` type alias.
4. A fresh generated project compiles under TypeScript strict mode with zero `as string` casts on context reads.

## Consequences

### Positive
- Eliminates a class of API-boundary type leaks in every generated project
- Adding a new middleware key is a compile-time-safe operation
- Small, self-contained change (single generator file)

### Negative
- Developers extending the generated server must remember to add new keys to `ContextVariables`
- Slightly more boilerplate at the top of `app.ts` (~15 lines)

## Related
- ADR-PIPELINE-065 (Post-Generation Validator — enforces the no-`as string` rule)
- ADR-PIPELINE-060 (10/10 Scorecard)
- ADR-067 (LLM Codegen Replacement — future work; once Phase 4 goes LLM-driven, this ADR still applies as a prompt rule)
