# ADR-058: Populate DDD Context Map and Generate Domain Event Infrastructure

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit found:

- **ARCH**: "DDD context-map.json is empty ([]). No bounded context relationships defined despite 12 contexts declared."
- **ARCH**: "ADR-P2-001 requires domain events for cross-context communication. No event bus, no event schemas, no handlers exist."
- **ARCH**: "SPARC pseudocode phase is empty stubs — no algorithmic guidance produced despite being marked completed."

The DDD model correctly identifies 12 bounded contexts, but:
1. The context map (which defines how contexts communicate) is empty
2. Domain events (which implement cross-context communication) have no infrastructure
3. The SPARC pseudocode phase produces no algorithmic content

## Decision

### 1. Phase 2 DDD generator must populate context-map.json

`ddd-generator.ts` must produce relationships between bounded contexts based on:
- Command dependencies (if context A's command references context B's entity)
- Data flow patterns from SPARC architecture
- ERP integration points (contexts that share ERP data)

```json
{
  "relationships": [
    {
      "upstream": "supplier",
      "downstream": "transition-strategies",
      "pattern": "Published Language",
      "description": "Supplier data consumed by transition strategy evaluation"
    },
    {
      "upstream": "transition-strategies",
      "downstream": "tradeoffs-carbon-reduction",
      "pattern": "Anti-Corruption Layer",
      "description": "Strategy outputs translated into tradeoff analysis inputs"
    },
    {
      "upstream": "tradeoffs-carbon-reduction",
      "downstream": "decision-governance",
      "pattern": "Conformist",
      "description": "Tradeoff results feed directly into approval workflow"
    }
  ]
}
```

### 2. Phase 4 must generate domain event types from DDD model

For each domain event defined in the DDD model's aggregates:

```typescript
// Generated in src/events/domain-events.ts
export interface DomainEvent<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateType: string;
  payload: T;
  timestamp: string;
  correlationId: string;
  causationId: string;  // ID of the command that caused this event
}

// Per-context events generated from DDD domainEvents[]
export interface SupplierCreatedEvent extends DomainEvent<{
  supplierId: string;
  name: string;
  region: string;
}> {
  eventType: 'SupplierCreated';
}

export interface TransitionStrategyApprovedEvent extends DomainEvent<{
  strategyId: string;
  supplierId: string;
  approvedBy: string;
}> {
  eventType: 'TransitionStrategyApproved';
}
```

### 3. Phase 4 must generate event bus infrastructure

```typescript
// Generated in src/events/event-bus.ts
export interface IEventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): void;
}

// Console implementation (replace with Kafka/PubSub in production)
export class ConsoleEventBus implements IEventBus {
  private handlers = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();

  async publish(event: DomainEvent): Promise<void> {
    // Structured log for event sourcing / replay
    console.log(JSON.stringify({ type: 'DOMAIN_EVENT', ...event }));
    const handlers = this.handlers.get(event.eventType) ?? [];
    for (const handler of handlers) {
      await handler(event);
    }
  }

  subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }
}
```

### 4. Phase 4 adapters must emit events after state changes

Each adapter's `execute()` method must emit the relevant domain event:

```typescript
// In the generated command dispatch (from ADR-048)
case 'CreateSupplier': {
  // ... precondition checks, INSERT ...
  await this.eventBus.publish({
    eventId: randomUUID(),
    eventType: 'SupplierCreated',
    aggregateId: id,
    aggregateType: 'Supplier',
    payload,
    timestamp: now,
    correlationId: /* from request context */,
    causationId: command,
  });
  break;
}
```

### 5. SPARC pseudocode must contain real algorithmic content

Phase 2/3 SPARC generator must produce pseudocode with:
- Algorithm descriptions (not empty stubs)
- Data structure definitions
- Complexity analysis
- TDD anchor points

If the LLM-generated SPARC pseudocode is empty, the generator must derive algorithms from:
- DDD commands (each command implies a procedure)
- DDD queries (each query implies a data access pattern)
- Simulation requirements (graph traversal, optimization algorithms)

## Consequences

- (+) Context map enables understanding of system-wide data flow
- (+) Domain events enable loose coupling between bounded contexts
- (+) Event bus provides foundation for event sourcing and CQRS
- (+) SPARC pseudocode provides algorithmic guidance for implementation
- (-) Event bus adds infrastructure that must be configured for production (Kafka/PubSub)
- (-) Context map generation requires inference from command/entity relationships

## Audit References

- ARCH: "DDD context-map.json is empty"
- ARCH: "No event bus, no event schemas, no handlers"
- ARCH: "SPARC pseudocode phase is empty stubs"
- ADR-P2-001: Requires domain events for cross-context communication
