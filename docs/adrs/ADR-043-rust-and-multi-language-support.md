# ADR-043: Pipeline Must Honor User-Specified Languages Including Rust

**Status**: Proposed
**Date**: 2026-03-26
**Severity**: P1 — Users explicitly request Rust and receive zero Rust output

## Context

In the carbon strategy audit, the user explicitly requested:
> "This should be implemented using TypeScript for orchestration and service layers, with Rust used for financial modeling, stochastic simulation, and optimization components."

The pipeline produced:
- Zero `.rs` files
- No `Cargo.toml`
- No WASM bindings
- One ADR mention of Rust ("Use Rust for compute-intensive modules") with no implementation guidance
- All generated code is TypeScript

The pipeline's language detection (in `auto-chain.ts`) does detect Rust via regex, but the scaffold generator and code generators only produce TypeScript or Rust — never both. The user's prompt requires a hybrid TypeScript + Rust project.

## Decision

### A. Detect Multi-Language Requirements
When the user prompt specifies multiple languages (e.g., "TypeScript for X, Rust for Y"), the pipeline must:
1. Detect BOTH languages and their intended roles
2. Generate a project structure that supports both
3. Scaffold both build systems (package.json + Cargo.toml)
4. Create implementation prompts that specify which language to use per phase

### B. Rust Scaffold for Compute Modules
When Rust is specified for compute-intensive components:
1. Create a `rust/` directory with `Cargo.toml` workspace
2. Create crate stubs for each Rust module identified in the prompt
3. Add WASM or FFI binding configuration for TypeScript interop
4. Include Rust-specific ADRs (memory management, error handling across FFI boundary)

### C. Implementation Prompts Must Specify Language Per Phase
Each implementation prompt must state: "Implement this phase in {language} because {rationale from ADR}."
- Simulation engine → Rust
- API orchestration → TypeScript
- ERP integration → TypeScript
- Optimization solver → Rust

### D. Phase 5 Task Builder Must Support Hybrid
The `buildPhase5Tasks` function must generate both TypeScript and Rust tasks when both are detected, with proper dependency ordering (Rust modules first, then TypeScript code that imports them via WASM/FFI).

## Consequences

### Positive
- Pipeline output matches what the user asked for
- Compute-intensive modules benefit from Rust performance
- Users see their technology preferences respected

### Negative
- Scaffold generator must handle two build systems
- Implementation prompts become more complex
- Ruflo swarm must handle Rust code generation

## Implementation

1. `auto-chain.ts` — Parse prompt for multi-language specifications (regex for "X for ... Y for ...")
2. `scaffold-generator.ts` — Generate both package.json and Cargo.toml when Rust is detected
3. `ruflo-phase-executor.ts` — `buildPhase5Tasks` must create Rust-specific tasks
4. ADR generator — Must produce ADRs for the Rust/TypeScript boundary (FFI, WASM, error handling)
