# ADR-PIPELINE-011: Command Handler Domain Logic from DDD Model

## Status
Implemented

## Context
The domain codegen generates command handlers with a stub body that merges input into an empty aggregate:

```typescript
const step2Result = {
  ...(aggregate as Record<string, unknown> ?? {}),
  ...Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v != null))
};
```

This "merge input with aggregate" pattern produces no real domain logic. The DDD model provides:
- `cmd.preconditions[]` — conditions that must be true before executing
- `cmd.postconditions[]` — conditions that must be true after executing
- `cmd.input[]` — typed input fields
- `cmd.description` — what the command does

The SPARC pseudocode modules also provide algorithmic guidance for each bounded context. None of this is used in the generated handler.

In the `081f90a2` run, the `handleEarlyOperationalSignalsThatATurnaroundDelayIsLikelyToOccur` command handler does nothing meaningful — it merges input, saves, and emits a success event regardless of business rules.

## Decision
Generate command handlers that implement real domain logic from the DDD model:

1. **Precondition validation**: Generate typed checks from `cmd.preconditions[]`, not just `input.requestPayload != null`
2. **Input destructuring**: Destructure `cmd.input[]` fields into typed local variables
3. **Aggregate mutation**: Load aggregate, apply input fields to it, validate invariants
4. **Domain event emission**: Emit events with all `event.payload[]` fields populated from actual state, not `String((input as any).result ?? '')`
5. **Postcondition assertion**: Assert postconditions after mutation
6. **SPARC guidance**: If pseudocode modules are matched to this command, include their logic as structured comments or scaffolded code

## Files to Change
- `src/pipeline/phase3/phases/domain-codegen.ts` — update `tsCommand()` and `rustCommand()` to generate handlers with typed input destructuring, real precondition checks, aggregate mutation, and typed event payloads

## Consequences
- Command handlers destructure typed inputs instead of spreading `Record<string, unknown>`
- Preconditions are real checks derived from DDD precondition strings
- Domain events carry typed payload fields from the DDD event definitions
- Handlers follow the command pattern: validate → load → mutate → save → publish
