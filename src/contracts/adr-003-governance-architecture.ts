/**
 * ADR-003: Governance Architecture for the Agentics CLI Control Plane
 *
 * STATUS: Accepted
 * DATE: 2026-01-28
 * AUTHORS: Platform Engineering
 * SUPERSEDES: None
 * DEPENDS ON: None (conceptual anchor for ADR-001 and ADR-002)
 * REFERENCED BY: ADR-001, ADR-002, all future implementation ADRs
 *
 * ============================================================================
 * POSITIONING STATEMENT
 * ============================================================================
 *
 * The Agentics CLI is a governed control plane, not a conversational
 * interface. It orchestrates enterprise simulation, planning, deployment,
 * and compliance workflows through a deterministic, auditable pipeline.
 *
 * Natural language exists solely to seed synthesis — the intentional,
 * bounded generation of structured artifacts. Outside of synthesis,
 * the CLI operates on stable identifiers that resolve to persisted
 * manifests, plans, simulations, and policies.
 *
 * This ADR defines the conceptual architecture that governs all CLI
 * behavior. It introduces no new commands, schemas, middleware, or
 * implementation artifacts. Its role is to establish the domain model,
 * bounded contexts, and invariants that all present and future
 * implementations must respect.
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * The Agentics CLI has two accepted ADRs:
 *
 *   ADR-001: Command Argument Semantics & Synthesis Governance
 *     Defines the argument type system (ID, NATURAL_LANGUAGE, SELECTOR),
 *     the synthesis governance matrix (REQUIRED, FORBIDDEN, COMMITMENT_GRADE),
 *     and the command registry that serves as the single source of truth.
 *
 *   ADR-002: Operational Enforcement of CLI Governance
 *     Defines how ADR-001's rules are mechanically enforced through
 *     the 5-gate pipeline, runtime validation middleware, CI checks,
 *     and regression prevention.
 *
 * What is missing is a DDD-level conceptual framing that explains:
 *
 *   - What the CLI control plane IS as an architectural concept
 *   - What bounded contexts exist and where their borders lie
 *   - Where governance logic BELONGS vs where it must NOT exist
 *   - What invariants must NEVER be violated, regardless of
 *     implementation choices
 *
 * Without this framing:
 *
 *   - New contributors cannot reason about where to add new behavior
 *   - Governance logic migrates into command handlers (wrong boundary)
 *   - Invariants are only implicit in code, not stated as design law
 *   - Future ADRs lack a conceptual anchor to reference
 *   - The distinction between "the CLI does X" and "this domain owns X"
 *     is unclear, leading to scattered responsibility
 *
 * This ADR fills that gap.
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * The Agentics CLI is organized into five bounded contexts (domains),
 * each with clear responsibilities, ownership rules, and invariants.
 * All governance is centralized. No domain may independently define
 * or override governance rules.
 *
 * The five domains are:
 *
 *   1. CLI Control Plane
 *   2. Command Semantics
 *   3. Synthesis Governance
 *   4. Execution & State Mutation
 *   5. Governance Source of Truth
 *
 * ============================================================================
 * DOMAIN 1: CLI CONTROL PLANE
 * ============================================================================
 *
 * DEFINITION:
 *
 * The CLI Control Plane is the outermost boundary of the Agentics CLI.
 * It is the execution surface through which all user intent enters the
 * system and all system responses exit.
 *
 * PURPOSE:
 *
 * The Control Plane exists to:
 *   - Accept user input as structured command invocations
 *   - Route validated input to the appropriate domain handler
 *   - Enforce governance rules BEFORE any side effects occur
 *   - Render deterministic output in the requested format
 *   - Exit with a well-defined exit code
 *
 * RESPONSIBILITIES:
 *
 *   - Argument parsing (string → CommandObject)
 *   - Gate pipeline orchestration (Gates 1–5 in sequence)
 *   - Command dispatch (validated CommandObject → handler)
 *   - Output rendering (result → formatted string)
 *   - Exit code management (SUCCESS, ARG_VALIDATION_ERROR, etc.)
 *
 * WHAT THE CONTROL PLANE EXPLICITLY DOES NOT DO:
 *
 *   - Business logic: It does not interpret, transform, or enrich
 *     the user's request beyond parsing and routing.
 *
 *   - State storage: It does not cache, persist, or remember anything
 *     between invocations. Every CLI run is stateless.
 *
 *   - Inference: It does not guess, suggest, or auto-correct. If input
 *     does not match a declared contract, execution is rejected.
 *
 *   - Negotiation: It does not ask clarifying questions, offer
 *     alternatives, or enter conversational modes. The user's
 *     command is accepted or rejected.
 *
 *   - Direct API calls: It delegates all network communication to
 *     adapter modules. The Control Plane never constructs HTTP
 *     requests or parses HTTP responses.
 *
 * BOUNDARY RULE:
 *
 * Nothing outside of src/cli/index.ts and src/gates/ constitutes the
 * Control Plane. Command handlers (src/commands/) are downstream of
 * the Control Plane — they receive pre-validated input and return
 * structured results.
 *
 * ============================================================================
 * DOMAIN 2: COMMAND SEMANTICS
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Command Semantics domain defines what each CLI command means:
 * its argument contract, its synthesis classification, and its
 * behavioral constraints (irreversibility, confirmation requirements).
 *
 * RELATIONSHIP TO ADR-001:
 *
 * ADR-001 is the canonical expression of this domain. The
 * COMMAND_REGISTRY is the domain's aggregate root — the single
 * object from which all command knowledge is derived.
 *
 * WHY SEMANTICS ARE DECLARATIVE, NOT INFERRED:
 *
 * Each command's meaning is declared upfront in a registry entry.
 * The system does not infer semantics from the user's input, from
 * the command handler's behavior, or from runtime context.
 *
 * This is a deliberate architectural choice:
 *
 *   - Declarative semantics are auditable. A reviewer can read the
 *     registry and know exactly what every command accepts.
 *
 *   - Declarative semantics are testable. Tests are mechanically
 *     derived from the registry — no manual test authoring needed
 *     for argument contract coverage.
 *
 *   - Declarative semantics are stable. Changing a command's behavior
 *     requires changing its registry entry, which is a reviewable,
 *     versioned, diff-friendly operation.
 *
 *   - Inferred semantics are fragile. If the system guesses what the
 *     user meant, it will sometimes guess wrong, and the user has
 *     no way to predict when that will happen.
 *
 * DOMAIN VOCABULARY:
 *
 *   CommandSpec     — The complete declaration of a command's contract
 *   ArgumentSpec    — The declaration of a single positional argument
 *   ArgumentType    — The classification of an argument: ID,
 *                     NATURAL_LANGUAGE, or SELECTOR
 *   SynthesisClass  — The synthesis governance classification:
 *                     SYNTHESIS_REQUIRED, SYNTHESIS_FORBIDDEN,
 *                     or COMMITMENT_GRADE
 *
 * OWNERSHIP:
 *
 * This domain is owned by the COMMAND_REGISTRY in
 * src/contracts/adr-command-semantics.ts. No other file may define
 * command semantics. No command handler may override its own
 * argument contract.
 *
 * ============================================================================
 * DOMAIN 3: SYNTHESIS GOVERNANCE
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Synthesis Governance domain defines the rules that control
 * when, where, and how LLM-powered synthesis may be invoked by
 * CLI commands.
 *
 * CONCEPTUAL RULES:
 *
 *   Rule 1: Synthesis is a controlled capability, not a default.
 *
 *     The CLI does not synthesize by default. Synthesis only occurs
 *     when a command is explicitly classified as SYNTHESIS_REQUIRED
 *     or COMMITMENT_GRADE. All other commands are synthesis-free.
 *
 *   Rule 2: Synthesis is scoped to creation and transformation.
 *
 *     Synthesis creates new artifacts (plans, simulations, policies)
 *     or transforms existing ones (export, map, surface). It never
 *     reads, lists, inspects, or deletes existing artifacts.
 *
 *   Rule 3: Synthesis boundaries are declared, not detected.
 *
 *     Whether a command may invoke synthesis is determined by its
 *     SynthesisClass in the registry — not by the content of the
 *     user's input, not by a runtime feature flag, and not by the
 *     command handler's implementation.
 *
 *   Rule 4: Synthesis is auditable.
 *
 *     Because synthesis classification is declared in the registry,
 *     any reviewer can enumerate exactly which commands invoke LLMs.
 *     This enables compliance audits, cost analysis, and security
 *     review without reading implementation code.
 *
 *   Rule 5: Synthesis governance cannot be relaxed at runtime.
 *
 *     There is no environment variable, flag, or configuration that
 *     converts a SYNTHESIS_FORBIDDEN command into one that allows
 *     synthesis. The classification is immutable at runtime.
 *
 * WHY THIS MATTERS:
 *
 * In an enterprise context, LLM invocation has cost, latency, and
 * compliance implications. Uncontrolled synthesis means:
 *
 *   - Unpredictable costs (read commands accidentally invoking LLMs)
 *   - Data leakage risk (sensitive context sent to inference endpoints)
 *   - Non-determinism (same input producing different outputs)
 *   - Audit failure (no clear record of which commands called LLMs)
 *
 * By making synthesis governance a first-class domain, the CLI
 * ensures that LLM invocation is intentional, bounded, and traceable.
 *
 * ============================================================================
 * DOMAIN 4: EXECUTION & STATE MUTATION
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Execution & State Mutation domain defines the conceptual phases
 * through which a command progresses from user intent to system effect.
 * It establishes a clear separation between planning what to do and
 * actually doing it.
 *
 * THE FOUR PHASES:
 *
 *   Phase 1: PLANNING
 *
 *     The user creates a plan, simulation, or policy. At this phase,
 *     no real-world state changes occur. The system generates artifacts
 *     that describe what WOULD happen.
 *
 *     Commands in this phase:
 *       plan create, simulate create, policy create, quantify create
 *
 *     Characteristics:
 *       - May invoke synthesis (SYNTHESIS_REQUIRED)
 *       - Produces persisted artifacts (plans, simulations, policies)
 *       - Artifacts are inert — they describe intent, not action
 *       - Reversible — artifacts can be deleted
 *
 *   Phase 2: EXECUTION
 *
 *     The user executes a previously planned action. This phase
 *     transitions artifacts from "intent" to "in-progress." The
 *     system begins performing real-world state changes.
 *
 *     Commands in this phase:
 *       simulate run, deploy run, policy enable
 *
 *     Characteristics:
 *       - COMMITMENT_GRADE — requires ID + confirmation
 *       - Irreversible — execution cannot be undone, only compensated
 *       - Requires the artifact to exist (ID must resolve)
 *       - May invoke synthesis as part of execution
 *
 *   Phase 3: COMMITMENT
 *
 *     The user approves or finalizes a result. This phase locks an
 *     artifact's state, preventing further modification.
 *
 *     Commands in this phase:
 *       plan approve
 *
 *     Characteristics:
 *       - COMMITMENT_GRADE — requires ID + confirmation
 *       - Irreversible — approval cannot be retracted
 *       - The artifact transitions to a terminal state
 *
 *   Phase 4: ROLLBACK (Compensating Action)
 *
 *     The user reverses the effects of a previous execution. Rollback
 *     does not undo — it applies a compensating action that
 *     counteracts the original execution's effects.
 *
 *     Commands in this phase:
 *       deploy rollback
 *
 *     Characteristics:
 *       - COMMITMENT_GRADE — requires ID + confirmation
 *       - Irreversible — the rollback itself cannot be rolled back
 *       - Creates a new state (post-rollback), not a restored state
 *
 * WHY THIS SEPARATION MATTERS:
 *
 *   - Users can plan without risk (Phase 1 is always safe)
 *   - Execution requires explicit commitment (Phase 2 demands IDs
 *     and confirmation)
 *   - Approval is a one-way gate (Phase 3 prevents retroactive
 *     changes to approved artifacts)
 *   - Rollback is a forward action (Phase 4 does not pretend to
 *     undo — it explicitly compensates)
 *
 * CRITICAL INVARIANT:
 *
 * No command may skip phases. You cannot execute without a plan.
 * You cannot approve without execution results. You cannot rollback
 * without a prior deployment. The phase model is monotonically
 * forward — there is no "go back to planning" from an executed state.
 *
 * ============================================================================
 * DOMAIN 5: GOVERNANCE SOURCE OF TRUTH
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Governance Source of Truth domain defines where authoritative
 * governance rules live and why they must never be duplicated.
 *
 * WHY GOVERNANCE MUST BE CENTRALIZED:
 *
 *   The COMMAND_REGISTRY in src/contracts/adr-command-semantics.ts is
 *   the single source of truth for command governance. This is not a
 *   preference — it is an architectural invariant.
 *
 *   Centralization ensures:
 *
 *   - ONE place to review command contracts
 *   - ONE place to audit synthesis boundaries
 *   - ONE place to verify argument type rules
 *   - ONE place to check irreversibility flags
 *
 *   If governance rules were scattered across command handlers, gate
 *   implementations, test files, and help text, there would be no
 *   reliable way to answer: "What does this command accept?"
 *
 * WHY DUPLICATION IS FORBIDDEN:
 *
 *   Duplicated governance always diverges. When a rule exists in two
 *   places, one of them will eventually be wrong, and there is no
 *   arbiter to determine which is authoritative.
 *
 *   Concretely, duplication means:
 *
 *   - A command handler that re-checks argument types duplicates
 *     the gate's logic and may apply different rules
 *   - A help string that hard-codes argument names duplicates the
 *     registry and may show different names than the validator uses
 *   - A test that hard-codes expected behavior duplicates the
 *     registry and may test for stale behavior after a schema change
 *
 *   The rule is: DERIVE, NEVER DUPLICATE.
 *
 *   All consumers (gates, help, tests, CI) must import from the
 *   COMMAND_REGISTRY. They must not maintain their own copies of
 *   governance data.
 *
 * GOVERNANCE HIERARCHY:
 *
 *   Level 1: ADR-003 (this document) — Conceptual model
 *     Defines WHAT domains exist and WHAT invariants hold.
 *     Does not contain implementation.
 *
 *   Level 2: ADR-001 — Command semantics
 *     Defines WHICH commands exist and WHAT their contracts are.
 *     Contains the COMMAND_REGISTRY as executable data.
 *
 *   Level 3: ADR-002 — Operational enforcement
 *     Defines HOW governance is enforced at runtime and in CI.
 *     Contains enforcement configuration and pipeline definitions.
 *
 *   Future ADRs must reference this hierarchy. New implementation
 *   ADRs (Level 3) must not redefine concepts from Level 1.
 *   New semantic ADRs (Level 2) must not violate invariants
 *   from Level 1.
 *
 * ============================================================================
 * INVARIANTS (NON-NEGOTIABLE)
 * ============================================================================
 *
 * The following are system-level truths that all implementations
 * must preserve. Violating any invariant is a bug, regardless of
 * the feature being built or the deadline being met.
 *
 * INVARIANT 1: IDs and natural language are conceptually distinct.
 *
 *   An ID resolves a persisted artifact. Natural language seeds
 *   synthesis. These are not interchangeable. No command may accept
 *   either type interchangeably. No heuristic may auto-detect
 *   which type the user intended.
 *
 * INVARIANT 2: Synthesis is opt-in, scoped, and auditable.
 *
 *   Synthesis (LLM invocation) occurs only when a command's
 *   SynthesisClass is SYNTHESIS_REQUIRED or COMMITMENT_GRADE.
 *   The scope of synthesis is the command's declared contract.
 *   The audit trail is the COMMAND_REGISTRY itself.
 *
 * INVARIANT 3: No command may mutate state without passing governance.
 *
 *   The 5-gate pipeline is the only path to command execution.
 *   There are no backdoors, no debug modes, no admin overrides
 *   that bypass governance validation.
 *
 * INVARIANT 4: Read-only commands never invoke synthesis.
 *
 *   Commands classified as SYNTHESIS_FORBIDDEN must not invoke
 *   LLMs under any circumstance. This includes list, inspect,
 *   whoami, usage, and help commands. No runtime condition may
 *   override this.
 *
 * INVARIANT 5: Help output cannot diverge from governance rules.
 *
 *   Help text is derived from the COMMAND_REGISTRY, not authored
 *   independently. If help says a command accepts an ID, the
 *   registry must declare that argument as type ID. Divergence
 *   between help and validation is a governance failure.
 *
 * INVARIANT 6: Governance is centralized in the registry.
 *
 *   The COMMAND_REGISTRY is the single source of truth for all
 *   command contracts. No other file, module, or artifact may
 *   independently define command semantics, argument types,
 *   synthesis classifications, or behavioral constraints.
 *
 * INVARIANT 7: Execution phases are monotonically forward.
 *
 *   A command's lifecycle progresses through Planning → Execution →
 *   Commitment. There is no mechanism to revert a committed artifact
 *   to a planning state. Rollback is a compensating action, not an
 *   undo operation.
 *
 * ============================================================================
 * RELATIONSHIP TO EXISTING ADRS
 * ============================================================================
 *
 * ADR-003 (this document) sits above ADR-001 and ADR-002 in the
 * governance hierarchy:
 *
 *   ADR-003 → defines the conceptual model (domains + invariants)
 *     ↓
 *   ADR-001 → instantiates the model (command registry + types)
 *     ↓
 *   ADR-002 → enforces the model (gates + CI + regression tests)
 *
 * ADR-003 does NOT modify, replace, or conflict with ADR-001 or
 * ADR-002. It provides the conceptual anchor that both ADRs
 * implicitly assumed but did not explicitly state.
 *
 * Specifically:
 *
 * - ADR-001's COMMAND_REGISTRY is an instance of Domain 2
 *   (Command Semantics) and Domain 3 (Synthesis Governance).
 *
 * - ADR-002's gate pipeline is the enforcement mechanism for
 *   Domain 1 (CLI Control Plane) and Domain 5 (Governance
 *   Source of Truth).
 *
 * - ADR-001's argument types (ID, NATURAL_LANGUAGE, SELECTOR)
 *   are the vocabulary of Domain 2, grounded in Invariant 1.
 *
 * - ADR-002's CI checks are the verification mechanism for
 *   Invariants 3, 5, and 6.
 *
 * No existing ADR needs to be edited as a result of ADR-003.
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * POSITIVE:
 *
 *   - New contributors can read this ADR and understand where
 *     governance lives (Domain 5), what domains exist (1–5),
 *     and what invariants are non-negotiable (1–7).
 *
 *   - Future ADRs can reference ADR-003 as a conceptual anchor.
 *     Instead of re-explaining why governance is centralized,
 *     they can cite "ADR-003, Invariant 6."
 *
 *   - Implementation details can change without violating
 *     invariants. The gate pipeline could be refactored, commands
 *     could be added or removed, and the CI system could be
 *     replaced — as long as the invariants hold.
 *
 *   - The distinction between "what the CLI does" (implementation)
 *     and "what the CLI IS" (architecture) is now explicit.
 *
 *   - The document reads as platform architecture, not tooling
 *     notes, making it appropriate for stakeholder review.
 *
 * NEGATIVE:
 *
 *   - This document adds a conceptual layer that must be
 *     maintained. If the domain model changes, ADR-003 must be
 *     updated before implementation ADRs.
 *
 *   - Contributors must understand three ADRs (003, 001, 002)
 *     instead of two. However, ADR-003 is the shortest and most
 *     conceptual, serving as an on-ramp rather than a burden.
 *
 * ============================================================================
 * EXPLICIT NON-GOALS
 * ============================================================================
 *
 *   1. This ADR does NOT introduce new commands or CLI behavior.
 *      It defines domains and invariants, not features.
 *
 *   2. This ADR does NOT contain schemas, types, or field definitions.
 *      Those belong in ADR-001 (semantics) and ADR-002 (enforcement).
 *
 *   3. This ADR does NOT specify middleware interfaces or gate
 *      implementations. Those belong in ADR-002.
 *
 *   4. This ADR does NOT define CI pipelines, test harnesses, or
 *      build configurations. Those belong in ADR-002.
 *
 *   5. This ADR does NOT contain pseudocode or implementation details.
 *      It describes what IS, not how it WORKS.
 *
 *   6. This ADR does NOT modify ADR-001 or ADR-002. It provides
 *      context that both ADRs already implicitly operate within.
 *
 * ============================================================================
 * CONCEPTUAL ARCHITECTURE (TEXT DIAGRAM)
 * ============================================================================
 *
 * The following describes the directional relationships between
 * domains. Arrows indicate "governs" or "flows into."
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │              GOVERNANCE SOURCE OF TRUTH (Domain 5)          │
 *   │                                                             │
 *   │   COMMAND_REGISTRY: the single authoritative definition     │
 *   │   of all command contracts, argument types, and synthesis   │
 *   │   classifications.                                          │
 *   │                                                             │
 *   │   Invariants 1–7 apply to all domains below.                │
 *   └────────────────────────┬────────────────────────────────────┘
 *                            │ governs
 *              ┌─────────────┴──────────────┐
 *              │                            │
 *              ▼                            ▼
 *   ┌─────────────────────┐     ┌─────────────────────────┐
 *   │ COMMAND SEMANTICS   │     │ SYNTHESIS GOVERNANCE     │
 *   │ (Domain 2)          │     │ (Domain 3)               │
 *   │                     │     │                          │
 *   │ What commands mean.  │     │ When synthesis may occur. │
 *   │ Argument contracts.  │     │ REQUIRED / FORBIDDEN /   │
 *   │ ID vs NL vs SELECTOR│     │ COMMITMENT_GRADE         │
 *   │                     │     │                          │
 *   │ Owned by: ADR-001   │     │ Owned by: ADR-001        │
 *   └────────┬────────────┘     └────────────┬────────────┘
 *            │ declares                      │ classifies
 *            └──────────┬────────────────────┘
 *                       │
 *                       ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                CLI CONTROL PLANE (Domain 1)                 │
 *   │                                                             │
 *   │   Parse → Gate 1 → Gate 2 → Gate 3 → Gate 4 → Gate 5      │
 *   │                                                    │        │
 *   │                                             Dispatch        │
 *   │                                                    │        │
 *   │                                             Render + Exit   │
 *   │                                                             │
 *   │   Owned by: src/cli/index.ts + src/gates/                   │
 *   │   Enforced by: ADR-002                                      │
 *   └────────────────────────┬────────────────────────────────────┘
 *                            │ dispatches to
 *                            ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │          EXECUTION & STATE MUTATION (Domain 4)              │
 *   │                                                             │
 *   │   Planning → Execution → Commitment → Rollback              │
 *   │                                                             │
 *   │   Each phase has different governance requirements.          │
 *   │   Phase transitions are irreversible.                       │
 *   │                                                             │
 *   │   Owned by: src/commands/ + src/adapters/                   │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * DIRECTIONAL RESPONSIBILITIES:
 *
 *   Domain 5 → Domain 2:  The registry defines command semantics.
 *   Domain 5 → Domain 3:  The registry defines synthesis boundaries.
 *   Domain 2 → Domain 1:  Semantics inform the gate pipeline.
 *   Domain 3 → Domain 1:  Synthesis classification gates NL input.
 *   Domain 1 → Domain 4:  The control plane dispatches to execution.
 *   Domain 4 → (external): Execution invokes downstream services.
 *
 * ============================================================================
 * ANTI-PATTERNS (WHAT FUTURE CONTRIBUTORS MUST NOT DO)
 * ============================================================================
 *
 * ANTI-PATTERN 1: GOVERNANCE DRIFT
 *
 *   What it looks like:
 *     A command handler checks argument types independently of the
 *     gate pipeline. The handler's check uses different rules than
 *     the Argument Guard gate.
 *
 *   Why it's wrong:
 *     Two validation layers with different rules means the CLI's
 *     behavior depends on which layer runs first and whether both
 *     agree. This is non-deterministic and unauditable.
 *
 *   What to do instead:
 *     Trust the gate pipeline. Command handlers receive pre-validated
 *     input. They must not re-validate argument types.
 *
 * ANTI-PATTERN 2: SHADOW REGISTRIES
 *
 *   What it looks like:
 *     A new module maintains its own list of "supported commands"
 *     or "synthesis-allowed commands" separate from COMMAND_REGISTRY.
 *
 *   Why it's wrong:
 *     Two registries will diverge. When they do, there is no arbiter.
 *     Users will experience inconsistent behavior depending on which
 *     registry a particular code path consulted.
 *
 *   What to do instead:
 *     Import from COMMAND_REGISTRY. If the registry doesn't have what
 *     you need, extend the CommandSpec type and add the field to the
 *     registry. One registry, one truth.
 *
 * ANTI-PATTERN 3: SYNTHESIS CREEP
 *
 *   What it looks like:
 *     A "read-only" command starts invoking an LLM "just to format
 *     the output" or "just to summarize the results."
 *
 *   Why it's wrong:
 *     If a command's SynthesisClass is SYNTHESIS_FORBIDDEN, it must
 *     not invoke LLMs for any reason. Formatting and summarization
 *     are still synthesis. The boundary is absolute.
 *
 *   What to do instead:
 *     If a command needs synthesis, change its SynthesisClass in the
 *     registry. This is a versioned, reviewed change that goes through
 *     the ADR process. Synthesis scope is never implicit.
 *
 * ANTI-PATTERN 4: PHASE SKIPPING
 *
 *   What it looks like:
 *     A "quick deploy" feature that creates a plan and immediately
 *     executes it in a single command, skipping the planning phase.
 *
 *   Why it's wrong:
 *     The phase model exists to give users a safe checkpoint between
 *     intent and action. Skipping phases removes that safety.
 *
 *   What to do instead:
 *     Maintain phase separation. If the user wants a fast path,
 *     they can pipe commands together. The CLI never collapses
 *     phases internally.
 *
 * ANTI-PATTERN 5: CONVERSATIONAL PATTERNS
 *
 *   What it looks like:
 *     Adding interactive prompts like "Did you mean X?", follow-up
 *     questions like "Which simulation?", or suggestions like
 *     "You might also want to run Y."
 *
 *   Why it's wrong:
 *     The CLI is a control plane, not a conversation. Interactive
 *     negotiation makes the CLI non-composable (cannot be piped),
 *     non-deterministic (different paths depending on user response),
 *     and non-auditable (audit trail cannot capture dialogues).
 *
 *   What to do instead:
 *     Reject invalid input with an instructional error. The error
 *     tells the user exactly what to type. No back-and-forth.
 *
 * ANTI-PATTERN 6: GATE BYPASS FOR CONVENIENCE
 *
 *   What it looks like:
 *     Adding a --no-validate flag, a DEBUG_SKIP_GATES environment
 *     variable, or an "admin mode" that skips governance checks.
 *
 *   Why it's wrong:
 *     Bypass mechanisms undermine the entire governance model.
 *     If governance can be skipped, it is not governance — it is
 *     a suggestion. Governance is either enforced or absent.
 *
 *   What to do instead:
 *     If a gate is wrong, fix the gate. If a rule is too strict,
 *     change the rule through the ADR process. Never bypass.
 *
 * ============================================================================
 * SUCCESS CRITERIA
 * ============================================================================
 *
 * This ADR is successful if:
 *
 *   1. A new contributor can read this document and understand
 *      where governance lives, what domains exist, and what
 *      invariants are non-negotiable — without reading code.
 *
 *   2. Future ADRs reference this document as a conceptual anchor.
 *      ("Per ADR-003, Domain 3, synthesis is opt-in and scoped.")
 *
 *   3. Implementations can change (refactored gates, new CI system,
 *      different adapter patterns) without violating the invariants.
 *
 *   4. No existing ADR (001, 002) needs to be edited as a result
 *      of this document's acceptance.
 *
 *   5. The document reads as platform architecture — appropriate
 *      for stakeholder review, onboarding material, and compliance
 *      documentation — not as tooling notes.
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Embed domain definitions in ADR-001 or ADR-002:
 *    Rejected — those ADRs already have clear scope (semantics and
 *    enforcement, respectively). Adding conceptual framing would
 *    dilute their focus and make them harder to review.
 *
 * B. Use a separate architecture documentation system (Arc42, C4):
 *    Rejected — the ADR format is already established in this
 *    codebase. Introducing a second documentation system would
 *    create the very duplication this ADR warns against.
 *
 * C. Skip the conceptual ADR and let implementations speak:
 *    Rejected — implicit architecture is undiscoverable architecture.
 *    New contributors cannot reason about domain boundaries if those
 *    boundaries are only visible in import graphs and file structure.
 *
 * D. Write this as a README or wiki page:
 *    Rejected — READMEs are not versioned with the same rigor as
 *    ADRs. This document must be reviewed, accepted, and maintained
 *    as a formal decision. The ADR format provides that discipline.
 */

// ============================================================================
// ADR-003 Metadata
// ============================================================================
// This ADR is purely conceptual. It exports only its own metadata
// for identification and cross-referencing by other ADRs.
// It contains no schemas, no middleware, no runtime code.
// ============================================================================

export const ADR_003_ID = 'ADR-003' as const;
export const ADR_003_TITLE = 'Governance Architecture for the Agentics CLI Control Plane' as const;
export const ADR_003_STATUS = 'Accepted' as const;
export const ADR_003_DATE = '2026-01-28' as const;
