/**
 * ADR-004: Enterprise Integration & Memory Architecture
 *
 * STATUS: Accepted
 * DATE: 2026-01-28
 * AUTHORS: Platform Engineering
 * SUPERSEDES: None
 * DEPENDS ON: ADR-003 (conceptual anchor), ADR-001 (command semantics)
 * REFERENCED BY: Future implementation ADRs for Ruvector, Integrations, ERP Surface
 *
 * ============================================================================
 * POSITIONING STATEMENT
 * ============================================================================
 *
 * Enterprise integrations and ERP mappings in Agentics are outcomes of
 * governed simulations, not ad-hoc automation.
 *
 * Every integration proposal, every ERP mapping, and every enterprise
 * artifact in the Agentics platform originates from a simulation that
 * was initiated through the governed CLI control plane, persisted into
 * Ruvector as the authoritative memory layer, and surfaced as a
 * proposed implementation — never as a live mutation.
 *
 * This ADR defines the conceptual architecture that governs how the
 * Agentics CLI interacts with three enterprise-scale subsystems:
 *
 *   - Ruvector (memory, persistence, lineage, replay)
 *   - The Integrations repository (approximately 75 enterprise systems)
 *   - The ERP Surface repository (enterprise-wide modeling abstraction)
 *
 * It establishes domain boundaries, ownership rules, and invariants
 * that ensure enterprise simulations, proposed implementations, and
 * integration artifacts remain coherent, traceable, and governable
 * across the entire platform.
 *
 * This ADR introduces no new commands, schemas, middleware, tables,
 * queries, or implementation details. It is a conceptual framing
 * document that future implementation ADRs must reference and respect.
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * The Agentics platform now includes:
 *
 *   - A governed CLI control plane (ADR-003, Domain 1) with a 5-gate
 *     pipeline that enforces governance before any side effects occur.
 *
 *   - Explicit synthesis vs execution boundaries (ADR-003, Domain 3)
 *     that control when LLM-powered generation may be invoked.
 *
 *   - A command semantics model (ADR-001) that declares every command's
 *     argument contract, synthesis classification, and behavioral
 *     constraints.
 *
 *   - Operational enforcement (ADR-002) that mechanically validates
 *     governance rules at runtime and in CI.
 *
 * What is missing is a DDD-level conceptual framing for the enterprise
 * integration layer — the subsystems that exist downstream of CLI
 * command execution and upstream of real-world enterprise effects.
 *
 * Without this framing:
 *
 *   - Integrations risk becoming ad-hoc scripts rather than governed
 *     enterprise capabilities. A contributor might add a new integration
 *     that bypasses simulation entirely, producing artifacts with no
 *     lineage and no traceability.
 *
 *   - Memory usage becomes inconsistent. Some commands might persist
 *     into Ruvector while others use local files or in-memory state.
 *     Without a clear rule, the platform loses its audit substrate.
 *
 *   - ERP Surface evolution decouples from simulations. If ERP mappings
 *     can be created outside of the simulation lifecycle, they become
 *     untraceable assertions about enterprise state rather than
 *     derivable consequences of governed decisions.
 *
 *   - Integration proposals and simulation artifacts exist in
 *     separate domains with no conceptual bridge. A reviewer cannot
 *     answer: "Where did this integration proposal come from?" without
 *     reading implementation code.
 *
 *   - The distinction between "proposed" and "live" blurs. Without
 *     a clear conceptual boundary, future contributors may introduce
 *     integration flows that mutate enterprise state during what
 *     should be a simulation-only phase.
 *
 * This ADR fills that gap by defining the enterprise integration and
 * memory domains, their relationships, and the invariants that bind
 * them to the governed CLI control plane.
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * The enterprise integration and memory architecture is organized into
 * five bounded contexts (domains), each with clear responsibilities,
 * ownership rules, and invariants. These domains exist downstream of
 * the CLI Control Plane defined in ADR-003 and are subject to all
 * governance rules established in ADRs 001-003.
 *
 * The five domains are:
 *
 *   1. Enterprise Simulation Domain
 *   2. Memory & Lineage Domain (Ruvector)
 *   3. Integration Domain
 *   4. ERP Surface Domain
 *   5. CLI as Orchestrator (Conceptual Role)
 *
 * ============================================================================
 * DOMAIN 1: ENTERPRISE SIMULATION
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Enterprise Simulation domain defines what constitutes an
 * enterprise simulation within the Agentics platform and what
 * artifacts a simulation produces. A simulation is the fundamental
 * unit of enterprise reasoning — a bounded, governed process that
 * transforms natural language intent into structured enterprise
 * decisions.
 *
 * WHAT CONSTITUTES AN ENTERPRISE SIMULATION:
 *
 *   An enterprise simulation is a governed process that:
 *
 *   - Originates from a CLI command classified as SYNTHESIS_REQUIRED
 *     (simulate create, plan create, quantify create)
 *
 *   - Receives natural language input that seeds synthesis (per
 *     ADR-001, the argument type is NATURAL_LANGUAGE, not ID)
 *
 *   - Produces structured artifacts that describe what WOULD happen
 *     in an enterprise context, without performing real-world
 *     state changes
 *
 *   - Is assigned a stable identifier upon creation, through which
 *     all downstream artifacts are traceable
 *
 *   A simulation is NOT:
 *
 *   - A live execution against real enterprise systems
 *   - An ad-hoc query or exploratory conversation
 *   - A standalone report disconnected from a decision context
 *   - A batch job or background process without CLI initiation
 *
 * ARTIFACTS PRODUCED BY SIMULATIONS:
 *
 *   An enterprise simulation produces one or more of the following
 *   artifact categories. All artifacts are inert proposals — they
 *   describe intent, not action.
 *
 *   Plans:
 *     Structured descriptions of enterprise migration, deployment,
 *     or transformation strategies. Plans describe what will change,
 *     in what order, with what dependencies, and at what risk.
 *
 *   Risk Assessments:
 *     Structured evaluations of what could go wrong. Risk assessments
 *     enumerate failure modes, estimate probabilities, and propose
 *     mitigations. They are derived from the simulation context.
 *
 *   Cost Projections:
 *     Structured estimates of financial impact. Cost projections
 *     cover infrastructure, licensing, labor, and transition costs.
 *     They are derived from the simulation context.
 *
 *   Integration Mappings:
 *     Structured descriptions of which enterprise systems are
 *     affected, what data flows change, and what integration
 *     points must be modified. These are proposals, not
 *     configurations.
 *
 *   ERP Proposals:
 *     Structured descriptions of how ERP-surface entities
 *     (processes, data models, workflows) would be affected
 *     by the simulated change. These are downstream of the
 *     simulation, not inputs to it.
 *
 * WHY SIMULATIONS MUST BE TRACEABLE:
 *
 *   Every artifact produced by the platform must trace back to the
 *   simulation that created it. This traceability is not optional
 *   because:
 *
 *   - Audit: Enterprise decisions must be traceable to their origin.
 *     A deployment that cannot be traced to a simulation, plan, and
 *     approval is an ungoverned deployment.
 *
 *   - Replay: Simulations must be replayable for comparison, review,
 *     and what-if analysis. Without traceability, replay is
 *     impossible because the original context is lost.
 *
 *   - Accountability: Every enterprise artifact must have an author
 *     (via the identity system defined in the CLI), a timestamp,
 *     and a decision context. Traceability provides all three.
 *
 *   - Coherence: Integration proposals and ERP mappings that exist
 *     without a simulation parent are orphaned artifacts. They
 *     cannot be validated because there is no context against
 *     which to validate them.
 *
 * ============================================================================
 * DOMAIN 2: MEMORY & LINEAGE (RUVECTOR)
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Memory & Lineage domain defines Ruvector's conceptual role
 * within the Agentics platform. Ruvector is the system of record
 * for all enterprise memory — the authoritative persistence layer
 * through which simulations, decisions, artifacts, and lineage
 * relationships are stored, queried, and replayed.
 *
 * RUVECTOR'S CONCEPTUAL ROLE:
 *
 *   System of Record:
 *
 *     Ruvector is the single authoritative store for all enterprise
 *     simulation artifacts. When a simulation produces a plan, risk
 *     assessment, cost projection, or integration mapping, that
 *     artifact is persisted into Ruvector. No other storage system
 *     (local files, environment variables, in-memory caches, external
 *     databases) is authoritative.
 *
 *     This does not mean Ruvector is the only storage. Transient
 *     caches, local identity stores, and session state may exist
 *     for performance or convenience. But when there is a conflict
 *     between a cached value and Ruvector's record, Ruvector wins.
 *
 *   Lineage Store:
 *
 *     Ruvector maintains the parent-child relationships between
 *     artifacts. Every plan traces to a simulation. Every integration
 *     proposal traces to a plan. Every ERP mapping traces to a
 *     simulation. These relationships are first-class data in
 *     Ruvector, not inferred from timestamps or naming conventions.
 *
 *     Lineage enables:
 *       - Forward tracing: "What artifacts did this simulation produce?"
 *       - Backward tracing: "What simulation created this proposal?"
 *       - Impact analysis: "What would change if this simulation
 *         were re-run with different parameters?"
 *
 *   Replay and Audit Substrate:
 *
 *     Ruvector stores sufficient context to replay any simulation.
 *     Replay means re-executing the simulation's synthesis phase
 *     with the same inputs and comparing the outputs. This enables:
 *
 *       - Drift detection: "Has the synthesis engine's behavior
 *         changed since this simulation was created?"
 *       - Comparison: "How do two simulations of the same scenario
 *         differ?"
 *       - Audit: "Reconstruct the decision trail that led to this
 *         deployment."
 *
 *     Replay does not mean re-execution of state-mutating actions.
 *     Replay is always a read-only operation against Ruvector's
 *     stored context.
 *
 * WHAT MUST BE PERSISTED:
 *
 *   The following categories of data must always be persisted into
 *   Ruvector as part of the simulation lifecycle:
 *
 *   - Simulation metadata: identifier, creator (user_id, org_id),
 *     timestamp, input parameters, synthesis classification
 *
 *   - Simulation artifacts: all plans, risk assessments, cost
 *     projections, integration mappings, and ERP proposals generated
 *     by the simulation
 *
 *   - Lineage relationships: parent simulation for every artifact,
 *     derivation chain for compound artifacts
 *
 *   - Decision context: the natural language input that seeded
 *     synthesis, the governance rules that were applied, the
 *     identity of the requester
 *
 *   - Lifecycle transitions: when a plan was approved, when a
 *     deployment was initiated, when a rollback occurred —
 *     each transition is an immutable event
 *
 * WHAT MUST NOT BE PERSISTED IN RUVECTOR:
 *
 *   - API keys, credentials, or authentication tokens
 *   - Live enterprise system state (Ruvector stores proposals,
 *     not the current state of SAP, Salesforce, or other systems)
 *   - Transient UI state or session preferences
 *   - Raw LLM inference responses (only structured artifacts
 *     derived from synthesis are persisted)
 *   - Debugging logs or developer-specific traces
 *
 * ============================================================================
 * DOMAIN 3: INTEGRATION DOMAIN
 * ============================================================================
 *
 * DEFINITION:
 *
 * The Integration domain defines the conceptual role of the
 * Integrations repository (approximately 75 enterprise systems)
 * within the Agentics platform. Integrations represent enterprise
 * capabilities — they describe what an enterprise system can do,
 * what data it manages, and how it participates in enterprise
 * workflows.
 *
 * INTEGRATIONS ARE CAPABILITIES, NOT SCRIPTS:
 *
 *   Each integration in the repository represents a named enterprise
 *   system (e.g., SAP, Salesforce, Workday, ServiceNow, Jira,
 *   NetSuite) and defines:
 *
 *   - What the system is responsible for in an enterprise context
 *   - What data entities the system owns or participates in
 *   - What integration points exist (APIs, events, data feeds)
 *   - What constraints the system imposes (rate limits, data
 *     formats, authentication requirements)
 *
 *   An integration is NOT:
 *
 *   - A connector or adapter that makes live API calls
 *   - A script that automates data movement
 *   - A runtime dependency that must be available for the CLI
 *     to function
 *   - A configuration file that is deployed to an enterprise system
 *
 *   Integrations are declarative descriptions of enterprise
 *   capabilities. They inform simulations about what is possible
 *   and what constraints apply. They do not perform actions.
 *
 * HOW INTEGRATIONS PARTICIPATE IN SIMULATIONS:
 *
 *   During a simulation, the synthesis engine consults integration
 *   definitions to understand:
 *
 *   - Which enterprise systems are relevant to the simulated scenario
 *   - What data flows would be affected by the proposed change
 *   - What constraints would apply to a proposed implementation
 *   - What integration points would need to be modified
 *
 *   The integration definitions provide the enterprise context that
 *   makes simulations realistic and actionable. Without them,
 *   simulations would produce generic recommendations disconnected
 *   from the organization's actual technology landscape.
 *
 *   Critically, integrations participate in simulations WITHOUT
 *   being executed. The synthesis engine reads integration definitions
 *   as reference material. It does not invoke integration APIs,
 *   query integration data sources, or trigger integration workflows.
 *   Integrations are consulted, not activated, during simulation.
 *
 * INTEGRATION PROPOSALS:
 *
 *   When a simulation determines that an enterprise system would be
 *   affected by a proposed change, it generates an integration
 *   proposal. An integration proposal describes:
 *
 *   - Which integration is affected
 *   - What changes would be required
 *   - What risks the change introduces
 *   - What dependencies exist between this change and others
 *
 *   Integration proposals are simulation artifacts. They are persisted
 *   into Ruvector with full lineage tracing back to the parent
 *   simulation. They are never created outside of the simulation
 *   lifecycle.
 *
 * ============================================================================
 * DOMAIN 4: ERP SURFACE DOMAIN
 * ============================================================================
 *
 * DEFINITION:
 *
 * The ERP Surface domain defines the conceptual role of the ERP
 * Surface repository within the Agentics platform. ERP Surface is
 * an abstraction layer that models enterprise-wide processes, data
 * structures, and workflows at a level above individual enterprise
 * systems.
 *
 * ERP SURFACE IS AN ABSTRACTION, NOT AN ERP REPLACEMENT:
 *
 *   ERP Surface does not replicate, replace, or proxy any real ERP
 *   system. It is a modeling abstraction that provides:
 *
 *   - A unified vocabulary for enterprise processes that span
 *     multiple systems (e.g., "order-to-cash" spans CRM, ERP,
 *     billing, and logistics systems)
 *
 *   - A structural model of how enterprise entities relate to
 *     each other across system boundaries
 *
 *   - A surface onto which simulation-derived proposals can be
 *     mapped, visualized, and reviewed
 *
 *   ERP Surface is the enterprise's conceptual map. It does not
 *   contain live data, does not maintain connections to real
 *   systems, and does not execute business logic.
 *
 * HOW ERP SURFACE RECEIVES PROPOSED IMPLEMENTATIONS:
 *
 *   ERP Surface is a downstream consumer of simulation artifacts.
 *   The flow is:
 *
 *   1. A simulation produces enterprise-level decisions
 *   2. Those decisions reference integration capabilities
 *   3. Integration proposals describe system-level changes
 *   4. ERP Surface receives structured proposed implementations
 *      that map those changes onto the enterprise-wide model
 *
 *   ERP Surface never initiates a simulation. It never requests
 *   changes. It never drives the decision process. It receives
 *   proposals and presents them in the context of the enterprise
 *   model.
 *
 * WHY ERP SURFACE IS DOWNSTREAM, NOT A DRIVER:
 *
 *   If ERP Surface drove simulations, it would become the de facto
 *   requirements system — the place where enterprise intent
 *   originates. This would create several problems:
 *
 *   - The CLI's role as the governed entry point (ADR-003, Domain 1)
 *     would be undermined. Enterprise intent must enter through the
 *     CLI's 5-gate pipeline, not through ERP Surface.
 *
 *   - Governance rules would need to be duplicated into ERP Surface.
 *     Every synthesis boundary, argument contract, and phase
 *     transition would need a parallel implementation in the ERP
 *     layer. This violates ADR-003, Invariant 6 (governance
 *     centralization).
 *
 *   - Traceability would break. If proposals originate from ERP
 *     Surface rather than from simulations, there is no simulation
 *     parent to trace back to. The artifact lineage chain is severed.
 *
 *   ERP Surface is a projection surface. It reflects the outcomes
 *   of governed simulations onto the enterprise model. It does not
 *   generate those outcomes.
 *
 * ERP SURFACE REFLECTS PROPOSED STATE, NOT LIVE MUTATION:
 *
 *   ERP Surface never contains live enterprise state. It contains:
 *
 *   - The enterprise model (structural abstraction of processes
 *     and data entities)
 *
 *   - Proposed implementations mapped onto that model (derived
 *     from simulations, persisted in Ruvector)
 *
 *   - Impact assessments showing how proposals would affect the
 *     enterprise model
 *
 *   When a proposal is approved and executed (transitioning through
 *   ADR-003's Phase 2: Execution), the real-world changes happen
 *   outside of ERP Surface. ERP Surface is updated to reflect the
 *   new proposed state only when a new simulation produces new
 *   proposals.
 *
 * ============================================================================
 * DOMAIN 5: CLI AS ORCHESTRATOR (CONCEPTUAL ROLE)
 * ============================================================================
 *
 * DEFINITION:
 *
 * The CLI as Orchestrator domain defines the conceptual relationship
 * between the CLI control plane (ADR-003, Domain 1) and the
 * enterprise integration domains defined in this ADR. It clarifies
 * what the CLI is and what it is not in the context of enterprise
 * integration.
 *
 * CLI AS INITIATOR AND COORDINATOR:
 *
 *   The CLI is the sole entry point for all enterprise simulation
 *   and integration workflows. Every simulation begins with a CLI
 *   command. Every artifact is created because a CLI command was
 *   executed. Every lifecycle transition (plan → approve → deploy →
 *   rollback) is initiated through the CLI.
 *
 *   The CLI coordinates the flow between domains:
 *
 *   - It accepts user intent and routes it to the simulation domain
 *   - It ensures simulation artifacts are persisted into Ruvector
 *   - It ensures integration proposals are derived from simulations
 *   - It ensures ERP Surface updates originate from simulation artifacts
 *
 *   Coordination means sequencing and routing. The CLI ensures that
 *   the right domain receives the right data at the right time.
 *
 * CLI AS NOT THE OWNER OF BUSINESS LOGIC:
 *
 *   The CLI does not contain enterprise business logic. It does not
 *   know what a "good" migration plan looks like, how to assess
 *   integration risk, or how ERP processes relate to each other.
 *
 *   Business logic resides in:
 *
 *   - The synthesis engine (which generates artifacts from natural
 *     language input using LLM-powered reasoning)
 *
 *   - The integration definitions (which describe enterprise system
 *     capabilities and constraints)
 *
 *   - The ERP Surface model (which defines enterprise-wide process
 *     structures and entity relationships)
 *
 *   The CLI's role is to ensure that business logic is invoked in a
 *   governed, traceable, and auditable manner — not to implement or
 *   second-guess that logic.
 *
 * CLI AS BOUNDARY ENFORCER:
 *
 *   The CLI enforces the boundaries between domains. Specifically:
 *
 *   - It prevents integration proposals from being created outside
 *     of the simulation lifecycle (by requiring simulation IDs as
 *     inputs to integration-related commands)
 *
 *   - It prevents ERP Surface mutations that do not originate from
 *     simulations (by requiring simulation-derived artifacts as
 *     inputs to ERP-related commands)
 *
 *   - It prevents Ruvector from being used as a general-purpose
 *     database (by restricting what can be persisted to defined
 *     artifact categories)
 *
 *   - It prevents simulations from being created without governance
 *     (by enforcing the 5-gate pipeline before any synthesis occurs)
 *
 *   Boundary enforcement is the CLI's primary value in the
 *   enterprise integration architecture. Without it, the domains
 *   would collapse into an unstructured flow of data between
 *   subsystems.
 *
 * ============================================================================
 * INVARIANTS (NON-NEGOTIABLE)
 * ============================================================================
 *
 * The following are system-level truths that all implementations
 * must preserve. These invariants extend — and do not replace —
 * the invariants defined in ADR-003.
 *
 * INVARIANT 1: Every enterprise simulation has a memory footprint.
 *
 *   When a simulation is created through the CLI, it must be
 *   persisted into Ruvector before any artifacts are generated.
 *   A simulation that exists only in memory, in a local file, or
 *   in a transient cache is not a simulation — it is an untracked
 *   computation. Untracked computations have no lineage, no audit
 *   trail, and no replay capability.
 *
 * INVARIANT 2: Every proposed integration or ERP mapping is derived
 *   from a simulation.
 *
 *   Integration proposals and ERP mappings do not appear
 *   spontaneously. They are artifacts of a simulation that was
 *   initiated through the governed CLI. If a proposal exists, it
 *   must have a simulation parent. If a mapping exists, it must
 *   trace to a simulation that produced it.
 *
 * INVARIANT 3: No integration proposal exists without traceability.
 *
 *   Every integration proposal must be traceable to:
 *
 *   - A simulation: the process that generated it
 *   - A plan: the structured decision that includes it
 *   - A decision context: the natural language input, governance
 *     rules, and identity that authorized its creation
 *
 *   An integration proposal without this traceability chain is an
 *   orphaned artifact. Orphaned artifacts must not exist in the
 *   platform because they cannot be audited, reviewed, or
 *   attributed.
 *
 * INVARIANT 4: Ruvector is the only authoritative memory layer.
 *
 *   No other storage system — local files, environment variables,
 *   in-memory caches, external databases, or third-party services —
 *   is authoritative for enterprise simulation data. Transient
 *   caches may exist for performance. Local stores may exist for
 *   identity (as defined in the credential and identity stores).
 *   But when the question is "What did this simulation produce?",
 *   the answer comes from Ruvector and nowhere else.
 *
 * INVARIANT 5: Integrations are described and proposed, not executed,
 *   during simulation.
 *
 *   During the simulation phase (ADR-003, Phase 1: Planning),
 *   integrations are reference material. The synthesis engine reads
 *   integration definitions to understand enterprise capabilities.
 *   It does not call integration APIs, query integration data
 *   sources, or trigger integration workflows. Simulation is a
 *   read-only process with respect to enterprise systems.
 *
 * INVARIANT 6: ERP Surface reflects proposed state, not live mutation.
 *
 *   ERP Surface never contains the current state of real enterprise
 *   systems. It contains a structural model of the enterprise and
 *   the proposed changes derived from simulations. When users
 *   inspect ERP Surface, they see what WOULD change, not what HAS
 *   changed. Live mutation happens outside of ERP Surface, in the
 *   execution phase (ADR-003, Phase 2: Execution), which is
 *   governed by COMMITMENT_GRADE commands requiring explicit
 *   confirmation.
 *
 * INVARIANT 7: The CLI is the only path through which simulation
 *   artifacts enter the platform.
 *
 *   No backend service, no cron job, no external webhook, and no
 *   direct Ruvector insertion may create simulation artifacts
 *   outside of the CLI's governed pipeline. This ensures that every
 *   artifact passes through the 5-gate pipeline (ADR-002), is
 *   subject to governance rules (ADR-001), and carries identity
 *   attribution (user_id, org_id).
 *
 * ============================================================================
 * CONCEPTUAL INTERACTION MODEL
 * ============================================================================
 *
 * The following describes, in prose, how the five domains interact
 * during the lifecycle of an enterprise simulation. This is a
 * conceptual description, not an implementation specification.
 *
 * PHASE 1: SIMULATION INITIATION
 *
 *   An enterprise simulation begins when a user issues a CLI command
 *   that is classified as SYNTHESIS_REQUIRED (e.g., simulate create,
 *   plan create). The CLI's 5-gate pipeline validates the command,
 *   verifies the user's identity, and confirms that the argument is
 *   natural language (not an ID). The validated command is dispatched
 *   to the simulation domain.
 *
 *   The simulation domain creates a simulation record in Ruvector.
 *   This record includes the simulation identifier, the creator's
 *   identity (user_id, org_id), the natural language input, and the
 *   governance context (which gate pipeline version was applied,
 *   which synthesis classification was used). From this moment, the
 *   simulation has a memory footprint — Invariant 1 is satisfied.
 *
 * PHASE 2: ENTERPRISE DECISION GENERATION
 *
 *   The synthesis engine processes the simulation's input in the
 *   context of the organization's integration landscape. It consults
 *   integration definitions from the Integrations repository to
 *   understand which enterprise systems are relevant, what
 *   capabilities they provide, and what constraints they impose.
 *
 *   The synthesis engine produces structured artifacts: plans, risk
 *   assessments, cost projections, and integration mappings. Each
 *   artifact is associated with the parent simulation and is
 *   persisted into Ruvector with full lineage metadata. Integration
 *   proposals are derived from the simulation's analysis of which
 *   systems would be affected — Invariant 2 is satisfied.
 *
 *   At no point during this phase does the synthesis engine call
 *   real enterprise system APIs or modify real enterprise data.
 *   Integrations are consulted as reference material, not invoked
 *   as services — Invariant 5 is satisfied.
 *
 * PHASE 3: PERSISTENCE AND LINEAGE
 *
 *   All artifacts generated by the simulation are persisted into
 *   Ruvector with explicit lineage relationships. Each integration
 *   proposal records its parent simulation, the integration it
 *   references, and the plan it belongs to. Each ERP mapping records
 *   the simulation that derived it and the integration proposals
 *   it depends on.
 *
 *   Ruvector now contains sufficient context to answer any lineage
 *   question: "What simulation created this proposal?", "What
 *   integrations are affected by this plan?", "What would change
 *   if we re-ran this simulation?" — Invariant 3 and Invariant 4
 *   are satisfied.
 *
 * PHASE 4: ERP SURFACE PROJECTION
 *
 *   Simulation-derived proposals are projected onto the ERP Surface
 *   model. The ERP Surface receives structured proposed
 *   implementations that describe how enterprise-wide processes
 *   would be affected by the simulated change.
 *
 *   The ERP Surface does not initiate this projection. It receives
 *   it from the simulation lifecycle, mediated by the CLI. The
 *   proposed implementations are mapped onto the enterprise model,
 *   making them reviewable in the context of the organization's
 *   full process landscape — Invariant 6 is satisfied.
 *
 * PHASE 5: AUDIT AND REPLAY
 *
 *   At any point, the platform can reconstruct the complete
 *   decision trail for any artifact. Starting from a deployed
 *   integration change, a reviewer can trace backward through
 *   the deployment, the approved plan, the simulation that generated
 *   it, and the natural language input that seeded the synthesis.
 *
 *   Replay is possible because Ruvector stores the simulation's
 *   original context. Re-running the synthesis with the same inputs
 *   produces comparable outputs, enabling drift detection and
 *   comparison analysis.
 *
 *   All of this is possible because every artifact entered through
 *   the CLI's governed pipeline — Invariant 7 is satisfied.
 *
 * ============================================================================
 * RELATIONSHIP TO EXISTING ADRS
 * ============================================================================
 *
 * ADR-004 extends the governance hierarchy established by ADR-003:
 *
 *   ADR-003 → defines the CLI control plane conceptual model
 *     ↓
 *   ADR-004 → defines the enterprise integration conceptual model
 *     ↓
 *   ADR-001 → instantiates both models (command registry + types)
 *     ↓
 *   ADR-002 → enforces both models (gates + CI + regression tests)
 *
 * ADR-004 does NOT modify, replace, or conflict with any existing
 * ADR. It extends the conceptual architecture into the enterprise
 * integration space, which was not covered by ADR-003.
 *
 * Specifically:
 *
 * - ADR-003's five CLI domains (Control Plane, Command Semantics,
 *   Synthesis Governance, Execution & State Mutation, Governance
 *   Source of Truth) remain unchanged. ADR-004's five enterprise
 *   domains are complementary and downstream.
 *
 * - ADR-003's execution phases (Planning → Execution → Commitment →
 *   Rollback) govern the lifecycle of ADR-004's simulation
 *   artifacts. ADR-004 does not introduce new lifecycle phases.
 *
 * - ADR-001's command registry defines the CLI commands that
 *   initiate simulations, produce integration proposals, and
 *   interact with ERP Surface. ADR-004 does not introduce new
 *   commands; it defines the conceptual domains those commands
 *   operate within.
 *
 * - ADR-002's gate pipeline ensures that all simulation-initiating
 *   commands pass governance validation. ADR-004 relies on this
 *   enforcement and does not duplicate it.
 *
 * - ADR-003's invariants (1-7) remain in force. ADR-004's
 *   invariants (1-7) extend the system's invariant set into the
 *   enterprise integration space. There is no conflict because
 *   ADR-003 governs CLI behavior while ADR-004 governs enterprise
 *   integration behavior.
 *
 * No existing ADR needs to be edited as a result of ADR-004.
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * POSITIVE:
 *
 *   - Integration contributors understand where proposals belong.
 *     Every integration proposal must trace to a simulation. The
 *     Integrations repository defines capabilities; it does not
 *     generate proposals independently.
 *
 *   - ERP Surface evolution remains simulation-driven. ERP Surface
 *     receives proposed implementations from simulations; it does
 *     not originate or approve changes independently.
 *
 *   - Ruvector is clearly positioned as the memory authority. All
 *     enterprise simulation data flows through Ruvector. Other
 *     storage systems are explicitly non-authoritative.
 *
 *   - The distinction between "proposed" and "live" is
 *     architecturally enforced. Simulation artifacts are proposals.
 *     Real-world changes require COMMITMENT_GRADE commands with
 *     explicit confirmation, governed by ADR-003's phase model.
 *
 *   - New contributors can read this ADR and understand the
 *     enterprise integration architecture without reading
 *     implementation code.
 *
 *   - The document reads as enterprise architecture — appropriate
 *     for stakeholder review, compliance documentation, and
 *     onboarding material.
 *
 * NEGATIVE:
 *
 *   - This document adds a second conceptual layer (in addition to
 *     ADR-003) that must be maintained. If the enterprise integration
 *     model changes, ADR-004 must be updated before implementation
 *     ADRs.
 *
 *   - Contributors must understand four ADRs (003, 004, 001, 002)
 *     to fully comprehend the platform's governance model. However,
 *     ADR-003 and ADR-004 are complementary conceptual documents
 *     that frame different aspects of the architecture, reducing
 *     the cognitive burden compared to a single monolithic document.
 *
 *   - The strict invariants (particularly Invariant 7, requiring
 *     CLI-initiated artifact creation) may constrain future
 *     integration patterns such as event-driven or webhook-based
 *     artifact creation. This is intentional — governance requires
 *     a controlled entry point.
 *
 * ============================================================================
 * EXPLICIT NON-GOALS
 * ============================================================================
 *
 *   1. This ADR does NOT introduce new CLI commands or modify
 *      existing command semantics. Command definitions belong in
 *      ADR-001.
 *
 *   2. This ADR does NOT define schemas, data models, or field
 *      definitions for Ruvector, Integrations, or ERP Surface.
 *      Those belong in implementation-level ADRs.
 *
 *   3. This ADR does NOT specify Ruvector tables, queries, indices,
 *      or storage formats. Ruvector's internal architecture is an
 *      implementation concern.
 *
 *   4. This ADR does NOT contain pseudocode, code, or
 *      implementation flows. It describes what IS, not how it WORKS.
 *
 *   5. This ADR does NOT define middleware interfaces, API
 *      endpoints, or wire protocols. Those belong in implementation
 *      ADRs.
 *
 *   6. This ADR does NOT redefine CLI semantics, governance rules,
 *      or enforcement mechanisms covered in ADRs 001-003.
 *
 *   7. This ADR does NOT describe the internal architecture of any
 *      individual integration. Integration internals are the
 *      concern of the Integrations repository.
 *
 *   8. This ADR does NOT describe ERP Surface's internal data model
 *      or rendering logic. ERP Surface internals are the concern
 *      of the ERP Surface repository.
 *
 * ============================================================================
 * CONCEPTUAL ARCHITECTURE (TEXT DIAGRAM)
 * ============================================================================
 *
 * The following describes the directional relationships between
 * domains. Arrows indicate "produces," "persists into," or
 * "projects onto."
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │          CLI CONTROL PLANE (ADR-003, Domain 1)              │
 *   │                                                             │
 *   │   The governed entry point. All enterprise simulation       │
 *   │   workflows begin here. 5-gate pipeline enforces            │
 *   │   governance before any synthesis or persistence occurs.    │
 *   │                                                             │
 *   │   Identity attribution (user_id, org_id) is attached        │
 *   │   to every command invocation.                              │
 *   └────────────────────────┬────────────────────────────────────┘
 *                            │ initiates
 *                            ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │        ENTERPRISE SIMULATION DOMAIN (ADR-004, Domain 1)     │
 *   │                                                             │
 *   │   Transforms natural language intent into structured         │
 *   │   enterprise decisions: plans, risks, costs, mappings.      │
 *   │                                                             │
 *   │   Consults integration definitions as reference material.   │
 *   │   Produces artifacts that are proposals, not actions.        │
 *   └───────┬────────────────────┬────────────────────┬──────────┘
 *           │ persists           │ references          │ produces
 *           ▼                    ▼                     ▼
 *   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
 *   │ MEMORY & LINEAGE │ │ INTEGRATION      │ │ ERP SURFACE      │
 *   │ (Ruvector)       │ │ DOMAIN           │ │ DOMAIN           │
 *   │ ADR-004 Domain 2 │ │ ADR-004 Domain 3 │ │ ADR-004 Domain 4 │
 *   │                  │ │                  │ │                  │
 *   │ System of record │ │ ~75 enterprise   │ │ Enterprise-wide  │
 *   │ Lineage store    │ │ capabilities     │ │ process model    │
 *   │ Replay substrate │ │ (declarative)    │ │ (abstraction)    │
 *   │ Audit authority  │ │                  │ │                  │
 *   │                  │ │ Consulted during │ │ Receives         │
 *   │ ALL artifacts    │ │ simulation, NOT  │ │ proposed state   │
 *   │ persisted here   │ │ executed         │ │ from simulations │
 *   └──────────────────┘ └──────────────────┘ └──────────────────┘
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │          CLI AS ORCHESTRATOR (ADR-004, Domain 5)            │
 *   │                                                             │
 *   │   Initiates simulations    │ Does NOT own business logic    │
 *   │   Coordinates domain flow  │ Does NOT contain enterprise    │
 *   │   Enforces boundaries      │   knowledge or rules           │
 *   │   Ensures traceability     │ Does NOT bypass governance     │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * DIRECTIONAL RESPONSIBILITIES:
 *
 *   CLI Control Plane → Enterprise Simulation:
 *     The CLI initiates simulations via governed commands.
 *
 *   Enterprise Simulation → Ruvector:
 *     Simulations persist all artifacts and lineage into Ruvector.
 *
 *   Enterprise Simulation → Integration Domain:
 *     Simulations consult integration definitions as read-only
 *     reference material during artifact generation.
 *
 *   Enterprise Simulation → ERP Surface:
 *     Simulations produce proposed implementations that are
 *     projected onto the ERP Surface model.
 *
 *   Ruvector → (all domains):
 *     Ruvector is the authoritative source for artifact retrieval,
 *     lineage queries, and replay operations.
 *
 *   Integration Domain → Enterprise Simulation:
 *     Integration definitions inform simulation context. The
 *     relationship is informational, not transactional.
 *
 *   ERP Surface → (none):
 *     ERP Surface is a terminal consumer. It receives proposed
 *     implementations and presents them. It does not produce
 *     artifacts or initiate workflows.
 *
 * ============================================================================
 * ANTI-PATTERNS (WHAT FUTURE CONTRIBUTORS MUST NOT DO)
 * ============================================================================
 *
 * ANTI-PATTERN 1: AD-HOC INTEGRATION CREATION
 *
 *   What it looks like:
 *     A contributor adds a new integration that generates proposals
 *     directly, without going through the simulation lifecycle.
 *     The integration has its own "create proposal" function that
 *     writes to Ruvector independently of any simulation.
 *
 *   Why it's wrong:
 *     Integration proposals without a simulation parent are orphaned
 *     artifacts. They cannot be audited because there is no decision
 *     context. They cannot be replayed because there is no original
 *     input. They cannot be attributed because no governed CLI
 *     command initiated them. This violates Invariants 2, 3, and 7.
 *
 *   What to do instead:
 *     Integrations define capabilities. Simulations generate
 *     proposals. The simulation lifecycle is the only path through
 *     which integration proposals enter the platform.
 *
 * ANTI-PATTERN 2: DIRECT RUVECTOR INSERTION
 *
 *   What it looks like:
 *     A backend service, a cron job, or a migration script writes
 *     simulation artifacts directly into Ruvector, bypassing the
 *     CLI's governed pipeline.
 *
 *   Why it's wrong:
 *     Artifacts inserted without governance have no gate validation,
 *     no identity attribution, no synthesis classification, and no
 *     lineage chain. They are indistinguishable from corrupted data.
 *     This violates Invariants 4 and 7.
 *
 *   What to do instead:
 *     All artifact creation flows through the CLI. If a bulk
 *     operation is needed, it is implemented as a CLI command that
 *     iterates through the governed pipeline for each artifact.
 *
 * ANTI-PATTERN 3: ERP SURFACE AS REQUIREMENTS SOURCE
 *
 *   What it looks like:
 *     A contributor adds a feature where ERP Surface generates
 *     simulation requests — "the ERP model detected a gap, so it
 *     triggers a simulation to fill it."
 *
 *   Why it's wrong:
 *     ERP Surface is a downstream projection surface, not an
 *     upstream requirements system. If ERP Surface initiates
 *     simulations, it becomes an ungoverned entry point — a
 *     backdoor that bypasses the CLI's 5-gate pipeline. This
 *     violates ADR-003's Invariant 3 (no state mutation without
 *     governance) and ADR-004's Invariant 7 (CLI is the only path).
 *
 *   What to do instead:
 *     ERP Surface presents the current proposed state. If a gap
 *     exists, a user reviews it and initiates a simulation through
 *     the CLI. The human decision to simulate is the governance
 *     checkpoint.
 *
 * ANTI-PATTERN 4: INTEGRATION EXECUTION DURING SIMULATION
 *
 *   What it looks like:
 *     A simulation "validates" its proposals by making live API
 *     calls to enterprise systems — "let's check if the SAP endpoint
 *     is actually available before we propose changes to it."
 *
 *   Why it's wrong:
 *     Simulation is a planning phase (ADR-003, Phase 1). During
 *     planning, no real-world state changes should occur, and no
 *     live system dependencies should exist. Making API calls during
 *     simulation means: (a) simulations fail when systems are
 *     unavailable, (b) simulations may trigger unintended side
 *     effects in enterprise systems, (c) simulation results are
 *     non-deterministic because they depend on live system state.
 *     This violates Invariant 5.
 *
 *   What to do instead:
 *     Integration definitions describe enterprise capabilities
 *     declaratively. Simulations consult these definitions, not live
 *     systems. If validation against live systems is needed, it is
 *     a separate COMMITMENT_GRADE command (e.g., deploy preview)
 *     that occurs after simulation, not during it.
 *
 * ANTI-PATTERN 5: MEMORY FRAGMENTATION
 *
 *   What it looks like:
 *     Different commands persist artifacts into different stores.
 *     Plan artifacts go to Ruvector, but simulation artifacts go to
 *     a local SQLite database. Cost projections are stored in a JSON
 *     file. Integration mappings are cached in Redis.
 *
 *   Why it's wrong:
 *     When memory is fragmented across stores, lineage queries
 *     become impossible. "What simulation produced this plan?" requires
 *     querying multiple systems with no guaranteed consistency.
 *     Replay requires assembling context from disparate sources.
 *     Audit requires checking every store for every artifact type.
 *     This violates Invariant 4.
 *
 *   What to do instead:
 *     Ruvector is the single system of record. All enterprise
 *     simulation artifacts are persisted into Ruvector. Transient
 *     caches may exist for performance, but they are never
 *     authoritative and are always derivable from Ruvector's records.
 *
 * ANTI-PATTERN 6: INTEGRATION DRIFT
 *
 *   What it looks like:
 *     The Integrations repository evolves independently of the
 *     simulation lifecycle. New integration definitions are added
 *     without considering how they participate in simulations.
 *     Integration capabilities are described in formats that the
 *     synthesis engine cannot consume. Integration definitions
 *     contain implementation details (API endpoints, credentials)
 *     rather than capability descriptions.
 *
 *   Why it's wrong:
 *     Integrations exist to inform simulations. If integration
 *     definitions are not consumable by the synthesis engine, they
 *     do not participate in simulations, and simulation results
 *     are incomplete. If integration definitions contain
 *     implementation details, they blur the boundary between
 *     "what can this system do?" and "how do we connect to it?"
 *     — a boundary that must remain clear.
 *
 *   What to do instead:
 *     Integration definitions describe capabilities: what the
 *     system does, what data it manages, what constraints it
 *     imposes. They do not describe how to connect, authenticate,
 *     or invoke the system. Connection details belong in deployment
 *     and execution configurations, not in capability descriptions.
 *
 * ANTI-PATTERN 7: ORPHANED ERP MAPPINGS
 *
 *   What it looks like:
 *     An ERP mapping exists in the platform without a traceable
 *     path to a simulation. The mapping was created manually, or
 *     imported from an external tool, or generated by a script
 *     that did not use the CLI's governed pipeline.
 *
 *   Why it's wrong:
 *     Orphaned ERP mappings cannot be audited, replayed, or
 *     attributed. They represent assertions about enterprise state
 *     that have no decision context. A reviewer cannot determine
 *     why the mapping exists, who authorized it, or what simulation
 *     justified it. This violates Invariants 2 and 3.
 *
 *   What to do instead:
 *     All ERP mappings are derived from simulations. If a mapping
 *     needs to be created, a user runs a simulation through the CLI.
 *     The simulation produces the mapping as an artifact with full
 *     lineage. There is no "import" path that bypasses simulation.
 *
 * ============================================================================
 * SUCCESS CRITERIA
 * ============================================================================
 *
 * This ADR is successful if:
 *
 *   1. Integration contributors understand where proposals belong.
 *      A new contributor reading this document knows that integration
 *      proposals are simulation artifacts, not standalone creations.
 *
 *   2. ERP Surface evolution remains simulation-driven. No future
 *      implementation allows ERP Surface to initiate simulations or
 *      generate proposals independently.
 *
 *   3. Ruvector is clearly positioned as the memory authority. No
 *      future implementation introduces a competing authoritative
 *      store for enterprise simulation data.
 *
 *   4. No existing ADR needs modification. ADR-004 complements
 *      ADRs 001-003 without contradicting or duplicating them.
 *
 *   5. The document reads like enterprise architecture, not tooling
 *      notes. It is appropriate for stakeholder review, compliance
 *      documentation, and onboarding material.
 *
 *   6. The anti-patterns section prevents the most common integration
 *      drift scenarios, keeping the platform coherent as it scales
 *      to 75+ integrations.
 *
 *   7. The invariants are referenced by future implementation ADRs.
 *      When a contributor builds a new integration feature, they
 *      cite "ADR-004, Invariant N" to justify their architectural
 *      choices.
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Embed integration architecture into ADR-003:
 *    Rejected — ADR-003 defines the CLI control plane domains.
 *    Enterprise integration is downstream of the control plane.
 *    Combining them would produce a monolithic document that
 *    conflates governance boundaries.
 *
 * B. Define separate ADRs for Ruvector, Integrations, and ERP Surface:
 *    Rejected — the three subsystems are conceptually coupled. They
 *    share invariants (traceability, simulation-derivation) and
 *    interact through the simulation lifecycle. Splitting them would
 *    require cross-references between three documents for concepts
 *    that only make sense together.
 *
 * C. Skip the conceptual ADR and define implementation directly:
 *    Rejected — implementation without conceptual framing produces
 *    the exact anti-patterns this ADR documents: ad-hoc integrations,
 *    memory fragmentation, orphaned mappings. The conceptual layer
 *    prevents drift by establishing clear boundaries before code
 *    is written.
 *
 * D. Use a separate enterprise architecture framework (TOGAF, Zachman):
 *    Rejected — the ADR format is established in this codebase.
 *    Introducing a second documentation framework would create
 *    the duplication this ADR warns against. The ADR format is
 *    sufficient to express the required concepts.
 *
 * E. Define Ruvector's schema and integration data models here:
 *    Rejected — schema definitions are implementation concerns.
 *    This ADR defines what Ruvector IS (system of record, lineage
 *    store, replay substrate) and what it must preserve (invariants).
 *    How it stores data is a future implementation ADR's concern.
 */

// ============================================================================
// ADR-004 Metadata
// ============================================================================
// This ADR is purely conceptual. It exports only its own metadata
// for identification and cross-referencing by other ADRs.
// It contains no schemas, no middleware, no tables, no queries,
// no runtime code.
// ============================================================================

export const ADR_004_ID = 'ADR-004' as const;
export const ADR_004_TITLE = 'Enterprise Integration & Memory Architecture' as const;
export const ADR_004_STATUS = 'Accepted' as const;
export const ADR_004_DATE = '2026-01-28' as const;
