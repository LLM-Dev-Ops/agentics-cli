# ADR-057: Generate Rust Compute Layer When Specified in Requirements

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Production audit (AR-4) found: "ADR-P2-010 mandates Rust for graph modeling and optimization. Zero Rust code exists. The entire compute layer that justifies the architecture is missing."

When the user specifies "Rust for graph modeling, dependency simulation, and optimization components," Phase 4/5 must generate actual Rust source code — not just TypeScript. The tech-stack-detector correctly identifies Rust as a specified language, but no code generator produces Rust files.

The simulation engine (RuVector) handles pipeline-time simulation, but the generated project needs its OWN embedded compute engine for runtime graph modeling and optimization.

## Decision

### 1. Phase 4 must detect Rust requirement and generate Rust project

When `techStack` includes Rust, Phase 4 must generate:

```
optimizer-engine/
├── Cargo.toml
├── src/
│   ├── lib.rs          — public API (graph model, simulate, optimize)
│   ├── graph.rs        — directed graph with typed nodes/edges
│   ├── simulation.rs   — scenario runner (upgrade, replace, dual-source)
│   ├── optimizer.rs    — multi-objective optimization (Pareto frontier)
│   ├── types.rs        — shared domain types (Supplier, Material, etc.)
│   └── main.rs         — CLI entry point for standalone testing
├── tests/
│   └── integration.rs  — end-to-end test with sample graph
└── README.md
```

### 2. TypeScript ↔ Rust bridge via subprocess JSON

The generated TypeScript orchestration layer communicates with Rust via stdin/stdout JSON:

```typescript
// Generated in src/services/optimizer-bridge.ts
import { execFile } from 'node:child_process';

export async function runOptimization(input: OptimizationInput): Promise<OptimizationResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('./optimizer-engine/target/release/optimizer-engine', ['--json'], {
      timeout: 120_000,
    });
    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();

    let stdout = '';
    child.stdout!.on('data', chunk => stdout += chunk);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Optimizer exited with code ${code}`));
      resolve(JSON.parse(stdout));
    });
  });
}
```

### 3. Rust graph module must model the domain

```rust
// Generated in optimizer-engine/src/graph.rs
use petgraph::graph::DiGraph;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupplierNode {
    pub id: String,
    pub name: String,
    pub region: String,
    pub carbon_maturity: CarbonMaturity,
    pub annual_emissions_tonnes: f64,
    pub reliability_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub material: String,
    pub volume_pct: f64,
    pub lead_time_days: u32,
    pub switching_cost: f64,
}

pub type SupplierNetwork = DiGraph<SupplierNode, DependencyEdge>;
```

### 4. Phase 5 build must compile Rust

Phase 5 materialization must include a build step or Makefile:

```makefile
# Generated Makefile
.PHONY: build-optimizer
build-optimizer:
	cd optimizer-engine && cargo build --release

.PHONY: test-optimizer
test-optimizer:
	cd optimizer-engine && cargo test
```

### 5. Codegen prompt for Rust must reference domain model

The Phase 4 generator must pass DDD bounded contexts to the Rust code generator so entities, value objects, and commands are reflected in Rust types — not generic scaffolding.

## Consequences

- (+) Generated projects include the Rust compute layer when specified
- (+) Graph modeling and optimization run at native speed
- (+) TypeScript ↔ Rust bridge is clean (JSON over subprocess)
- (-) Requires Rust toolchain on build machine
- (-) Dual-language project increases CI/CD complexity
- (-) Rust code generation is more complex than TypeScript (ownership, lifetimes)

## Audit References

- AR-4: "No Rust component generated despite being specified"
- SI-1: "No graph modeling of supplier networks" — Rust graph module provides this
- ADR-P2-010: Mandates Rust for optimization — now generated
