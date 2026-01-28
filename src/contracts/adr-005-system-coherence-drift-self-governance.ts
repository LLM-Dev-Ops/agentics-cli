/**
 * ADR-005: System Coherence, Drift Detection, and Self-Governance
 *
 * STATUS: Accepted
 * DATE: 2026-01-28
 * AUTHORS: Platform Engineering
 * SUPERSEDES: None
 * DEPENDS ON: ADR-003 (governance architecture), ADR-004 (enterprise integration & memory)
 * REFERENCED BY: Future implementation ADRs for drift detection, coherence monitoring
 *
 * ============================================================================
 * POSITIONING STATEMENT
 * ============================================================================
 *
 * Agentics does not self-correct decisions — it preserves coherence so
 * humans can govern change safely.
 *
 * As simulations accumulate, integrations evolve, ERP proposals multiply,
 * and memory grows, the Agentics platform must remain structurally
 * coherent. Coherence is not a feature to be built — it is an
 * architectural property that emerges from governed processes and is
 * eroded by ungoverned ones.
 *
 * This ADR defines the conceptual architecture for how the platform:
 *
 *   - Detects incoherence and drift across simulations, integrations,
 *     ERP Surface, and memory
 *
 *   - Preserves long-term structural consistency without relying on
 *     autonomous correction
 *
 *   - Supports governed self-management — the ability of the system
 *     to observe its own state and surface findings to humans who
 *     make the decisions
 *
 * This ADR introduces no new commands, schemas, middleware, tables,
 * APIs, algorithms, or implementation details. It is a conceptual
 * framing document that establishes the domains, invariants, and
 * responsibility boundaries for coherence and drift within the
 * Agentics platform.
 *
 * ============================================================================
 * CONTEXT
 * ============================================================================
 *
 * The Agentics platform now has:
 *
 *   - Governed CLI semantics and synthesis rules (ADR-001) that define
 *     what every command accepts and when LLM synthesis may occur.
 *
 *   - Executable governance via schema, middleware, and CI (ADR-002)
 *     that mechanically enforces ADR-001's rules at runtime.
 *
 *   - A DDD framing for the CLI control plane (ADR-003) that defines
 *     five bounded contexts, seven invariants, and the governance
 *     hierarchy that all implementations must respect.
 *
 *   - A defined enterprise integration and memory architecture
 *     (ADR-004) centered on Ruvector, Integrations, and ERP Surface,
 *     with seven additional invariants governing traceability,
 *     simulation derivation, and memory authority.
 *
 * What is still missing is an explicit architectural model explaining:
 *
 *   - How the system detects drift over time. As simulations are
 *     re-run, as integration definitions evolve, and as ERP Surface
 *     accumulates proposals, the platform must be able to observe
 *     whether its state remains internally consistent.
 *
 *   - How coherence is preserved as the platform grows. A platform
 *     with 10 simulations and 5 integrations is easy to reason about.
 *     A platform with 10,000 simulations, 75 integrations, and
 *     thousands of ERP proposals is not. Coherence must be
 *     architectural, not accidental.
 *
 *   - How the platform "manages itself" structurally. Self-management
 *     does not mean autonomous correction. It means the platform can
 *     observe, compare, and surface — but never unilaterally act.
 *
 * Without this model:
 *
 *   - Drift accumulates silently. Integration definitions change but
 *     existing simulations that referenced earlier versions are not
 *     flagged. ERP proposals derived from outdated simulations remain
 *     without any indication of staleness.
 *
 *   - Contributors build autonomous correction. Without a clear
 *     statement that the platform does not self-correct, future
 *     contributors will build "auto-fix" and "auto-heal" features
 *     that violate the governance model.
 *
 *   - Long-term consistency becomes a manual burden. Without
 *     architectural support for coherence observation, operators
 *     must manually audit every artifact to determine if the
 *     platform's state is internally consistent.
 *
 *   - The distinction between observation and action blurs. Without
 *     an explicit boundary, detecting a problem and fixing it
 *     collapse into a single automated step — removing human
 *     judgment from enterprise decisions.
 *
 * This ADR fills that gap.
 *
 * ============================================================================
 * DECISION
 * ============================================================================
 *
 * The system coherence and self-governance architecture is organized
 * into five conceptual domains. Each domain has clear responsibilities,
 * boundaries, and invariants. Together, they describe how the platform
 * maintains structural integrity over time without autonomous action.
 *
 * The five domains are:
 *
 *   1. System Coherence
 *   2. Drift Detection
 *   3. Governed Self-Management
 *   4. Memory-Anchored Reality
 *   5. Human Oversight Boundary
 *
 * ============================================================================
 * DOMAIN 1: SYSTEM COHERENCE
 * ============================================================================
 *
 * DEFINITION:
 *
 * System coherence is the property that all artifacts, relationships,
 * and derivation chains within the Agentics platform are internally
 * consistent with respect to the governance rules and invariants
 * defined in ADRs 001-004.
 *
 * Coherence is not the same as correctness. A simulation may produce
 * a plan that is factually wrong about enterprise costs. That plan is
 * still coherent if it was created through the governed pipeline, is
 * traceable to a simulation, and is persisted in Ruvector with full
 * lineage. Coherence is a structural property. Correctness is a
 * judgment that only humans can make.
 *
 * WHAT COHERENCE MEANS IN AGENTICS:
 *
 *   Coherence means:
 *
 *   - Every artifact traces to its origin. A plan traces to a
 *     simulation. An integration proposal traces to a plan and a
 *     simulation. An ERP mapping traces to a simulation that produced
 *     it. If any artifact exists without a traceable origin, the
 *     platform is incoherent.
 *
 *   - Every derivation chain is intact. If Simulation A produced
 *     Plan B, and Plan B was approved to produce Deployment C, then
 *     the chain A → B → C must be reconstructable from Ruvector.
 *     If any link is missing, the platform is incoherent.
 *
 *   - Every artifact was created through governance. If an artifact
 *     exists in Ruvector without having passed through the 5-gate
 *     pipeline (ADR-002), the platform is incoherent — regardless
 *     of whether the artifact's content is "correct."
 *
 *   - Every reference resolves. If a plan references Simulation X,
 *     Simulation X must exist in Ruvector. If an integration proposal
 *     references Integration Y, Integration Y must exist in the
 *     Integrations repository. Dangling references are incoherence.
 *
 * WHY COHERENCE IS ARCHITECTURAL, NOT BEHAVIORAL:
 *
 *   Coherence is not a behavior that the system performs. It is a
 *   property that the system either has or lacks. The system does not
 *   "do coherence" — it is coherent (or not) based on whether its
 *   artifacts satisfy the invariants.
 *
 *   This distinction matters because:
 *
 *   - Behavioral coherence ("the system behaves consistently") is
 *     impossible to guarantee in a system that involves LLM synthesis.
 *     The same natural language input may produce different plans on
 *     different runs. This is not incoherence — it is the nature of
 *     synthesis.
 *
 *   - Structural coherence ("the system's artifacts satisfy their
 *     invariants") is verifiable. Every artifact either traces to a
 *     simulation or it does not. Every derivation chain is either
 *     intact or it is not. These are binary properties that can be
 *     checked mechanically.
 *
 *   The platform guarantees structural coherence. It does not and
 *   cannot guarantee that synthesis outputs are consistent across
 *   time. The distinction between "same inputs, same structure" and
 *   "same inputs, same outputs" is fundamental to how Agentics works.
 *
 * DIFFERENCE BETWEEN LOCAL CORRECTNESS AND SYSTEM COHERENCE:
 *
 *   Local correctness means a single artifact is valid in isolation.
 *   A plan has all required fields. A simulation has a valid identifier.
 *   An integration proposal has a non-empty description. These checks
 *   are handled by ADR-002's schema validation and contract enforcement.
 *
 *   System coherence means the entire platform's state is internally
 *   consistent. All derivation chains are intact. All references
 *   resolve. All artifacts trace to governed origins. No orphaned or
 *   dangling artifacts exist.
 *
 *   A platform can have locally correct artifacts and still be
 *   incoherent. If a plan is valid but its parent simulation was
 *   deleted, the plan is locally correct but the system is incoherent.
 *   If an integration proposal references an integration that no
 *   longer exists, the proposal is locally correct but the system
 *   is incoherent.
 *
 *   Local correctness is necessary but not sufficient for coherence.
 *
 * ============================================================================
 * DOMAIN 2: DRIFT DETECTION
 * ============================================================================
 *
 * DEFINITION:
 *
 * Drift is the gradual divergence of the platform's state from its
 * intended coherent state. Drift is not a failure — it is an
 * inevitable consequence of a living system where integrations evolve,
 * simulations accumulate, and the enterprise landscape changes.
 *
 * CATEGORIES OF DRIFT:
 *
 *   Semantic Drift:
 *
 *     The meaning of terms, categories, or classifications changes
 *     over time without explicit acknowledgment. A simulation created
 *     when "cloud migration" meant "lift-and-shift to AWS" may still
 *     exist when the organization has redefined "cloud migration" to
 *     mean "multi-cloud Kubernetes." The simulation is structurally
 *     coherent but semantically stale.
 *
 *     Semantic drift is the hardest to detect because it requires
 *     understanding context, not just structure. The platform cannot
 *     detect semantic drift autonomously — it can only surface
 *     temporal and contextual information that enables humans to
 *     recognize it.
 *
 *   Structural Drift:
 *
 *     The structure of artifacts, schemas, or integration definitions
 *     changes in ways that invalidate existing artifacts. A new
 *     required field is added to integration definitions, but existing
 *     simulations that referenced the old structure are not updated.
 *     The derivation chain is intact, but the referenced integration
 *     now has a different shape than what the simulation consumed.
 *
 *     Structural drift is detectable by comparing the structure of
 *     referenced artifacts against the structure that existed when
 *     the reference was created.
 *
 *   Lineage Drift:
 *
 *     The derivation chain between artifacts becomes incomplete or
 *     inconsistent. A simulation is deleted but its child plans and
 *     proposals remain. An integration is removed from the repository
 *     but proposals referencing it persist in Ruvector. A plan's
 *     parent simulation is re-run with different parameters, but the
 *     plan still references the original simulation version.
 *
 *     Lineage drift is detectable by traversing derivation chains
 *     and verifying that every link resolves to a valid artifact.
 *
 *   Integration Drift:
 *
 *     The Integrations repository evolves independently of existing
 *     simulations. New integrations are added. Existing integrations
 *     are modified. Integration capabilities change. But simulations
 *     that were created against an earlier version of the integration
 *     landscape are not flagged as potentially stale.
 *
 *     Integration drift is detectable by comparing the integration
 *     landscape at simulation creation time against the current
 *     landscape and identifying differences that affect the
 *     simulation's assumptions.
 *
 * WHY DRIFT IS INEVITABLE IN LARGE SYSTEMS:
 *
 *   Drift is inevitable because the platform is a living system.
 *   Integrations evolve as enterprise systems are upgraded. ERP
 *   processes change as the business transforms. Simulations
 *   accumulate and their assumptions become outdated. The enterprise
 *   context that justified a decision six months ago may no longer
 *   apply.
 *
 *   The platform cannot prevent drift because it cannot prevent the
 *   world from changing. What it can do is make drift observable —
 *   and that is a fundamentally different design goal than preventing
 *   it.
 *
 * WHY DETECTION MATTERS MORE THAN PREVENTION:
 *
 *   Prevention assumes that the system can identify and block all
 *   sources of drift at the point of occurrence. This is impossible
 *   in a system where external factors (enterprise system upgrades,
 *   organizational changes, regulatory updates) are the primary
 *   sources of drift. The platform does not control these factors.
 *
 *   Detection accepts that drift will occur and focuses on making
 *   it visible. A platform that detects drift enables humans to
 *   decide: Is this drift acceptable? Does it invalidate prior
 *   decisions? Should affected simulations be re-run?
 *
 *   Detection preserves human agency. Prevention removes it by
 *   implying that the system knows which changes are acceptable and
 *   which are not.
 *
 * ============================================================================
 * DOMAIN 3: GOVERNED SELF-MANAGEMENT
 * ============================================================================
 *
 * DEFINITION:
 *
 * Governed self-management is the platform's ability to observe,
 * compare, and surface information about its own state — without
 * autonomously acting on that information. The platform manages
 * itself structurally by maintaining the preconditions for human
 * governance. It does not govern itself.
 *
 * WHAT "SELF-MANAGEMENT" MEANS:
 *
 *   Self-management means the platform can:
 *
 *   - Observe its own coherence state. The platform can determine
 *     whether its artifacts satisfy the invariants defined in
 *     ADRs 003-005. It can identify orphaned artifacts, broken
 *     lineage chains, dangling references, and stale derivations.
 *
 *   - Compare artifacts across time. Because Ruvector stores
 *     simulation context, the platform can compare the inputs and
 *     outputs of simulations run at different times. It can identify
 *     cases where the same scenario produces materially different
 *     results, indicating that underlying assumptions have changed.
 *
 *   - Surface findings to operators. The platform can present its
 *     observations in structured, actionable reports that describe
 *     what drift exists, where it exists, and what artifacts are
 *     affected. These reports are informational. They do not
 *     prescribe corrective action.
 *
 * WHAT "SELF-MANAGEMENT" DOES NOT MEAN:
 *
 *   Self-management does NOT mean:
 *
 *   - Self-correction. The platform does not fix drift. It does not
 *     re-run simulations, update proposals, reconcile integration
 *     definitions, or modify ERP mappings based on detected drift.
 *     Correction requires human judgment about whether the drift
 *     matters and what the correct response is.
 *
 *   - Autonomous decision-making. The platform does not decide which
 *     simulations are "stale" and should be archived, which proposals
 *     are "outdated" and should be revoked, or which integrations
 *     are "drifted" and should be re-evaluated. These are enterprise
 *     decisions that humans must make.
 *
 *   - Proactive remediation. The platform does not take preventive
 *     action to avoid future drift. It does not re-run simulations
 *     on a schedule, automatically refresh integration definitions,
 *     or periodically validate ERP mappings. These would be
 *     autonomous behaviors that bypass the governed CLI pipeline.
 *
 * CLEAR DISTINCTION: SELF-GOVERNANCE vs AUTOMATION vs AUTONOMY:
 *
 *   Self-governance (what Agentics does):
 *     The platform maintains structural properties that enable
 *     human governance. It preserves lineage, ensures traceability,
 *     detects drift, and surfaces findings. Every action the platform
 *     takes to "manage itself" is observable, auditable, and does not
 *     modify enterprise decisions.
 *
 *   Automation (what Agentics may support, under governance):
 *     Automation executes predefined, deterministic workflows that
 *     humans have explicitly configured. A scheduled coherence report
 *     is automation. A notification when lineage breaks is automation.
 *     Automation operates within governance — it does what humans
 *     told it to do, when they told it to do it.
 *
 *   Autonomy (what Agentics must NEVER do):
 *     Autonomy means making enterprise decisions without human
 *     authorization. Re-running a simulation because drift was
 *     detected is autonomous. Archiving a "stale" proposal without
 *     human approval is autonomous. Modifying an ERP mapping based
 *     on detected integration changes is autonomous. Autonomy
 *     removes human judgment from the decision loop. The Agentics
 *     platform is explicitly non-autonomous.
 *
 * WHY AGENTICS MUST REMAIN EXPLAINABLE AND AUDITABLE:
 *
 *   The platform exists in an enterprise context where every decision
 *   must be attributable to a human (or to a governed process that
 *   a human authorized). This is not a design preference — it is a
 *   requirement imposed by:
 *
 *   - Compliance frameworks (SOC2, HIPAA, GDPR, ISO 27001) that
 *     require traceable decision chains with accountable actors.
 *
 *   - Enterprise governance policies that prohibit autonomous system
 *     changes without human approval.
 *
 *   - Risk management requirements that demand a clear separation
 *     between observation ("we detected drift") and action ("a human
 *     decided to re-simulate").
 *
 *   If the platform autonomously corrects drift, the audit trail
 *   breaks. The question "Who decided to update this proposal?" has
 *   the answer "The system decided." In an enterprise context, that
 *   answer is unacceptable.
 *
 * ============================================================================
 * DOMAIN 4: MEMORY-ANCHORED REALITY (RUVECTOR)
 * ============================================================================
 *
 * DEFINITION:
 *
 * Memory-anchored reality is the principle that the platform's
 * understanding of its own state is grounded in persisted memory
 * (Ruvector), not in transient computation, inferred relationships,
 * or assumed consistency. What is in Ruvector is real. What is not
 * in Ruvector does not exist.
 *
 * CONCEPTUAL ROLE OF MEMORY IN DETECTING DRIFT:
 *
 *   Drift detection requires comparison. To know that something has
 *   changed, the platform must know what it looked like before. This
 *   is the fundamental role of memory in drift detection:
 *
 *   - When a simulation is created, the integration landscape is
 *     recorded as part of the simulation's context in Ruvector.
 *     Later, the platform can compare the recorded landscape against
 *     the current landscape and identify differences.
 *
 *   - When a plan is derived from a simulation, the derivation
 *     relationship is recorded in Ruvector. Later, the platform can
 *     traverse derivation chains and verify that every link still
 *     resolves.
 *
 *   - When an ERP proposal is projected onto the enterprise model,
 *     the proposal's basis (the simulation that produced it, the
 *     integration definitions it referenced) is recorded. Later,
 *     the platform can check whether that basis remains valid.
 *
 *   Without memory, drift is undetectable. If the platform does not
 *   remember what integration definitions looked like when a simulation
 *   was created, it cannot know whether those definitions have changed.
 *   Memory is not a convenience — it is the substrate for coherence
 *   observation.
 *
 * WHY LINEAGE ENABLES COMPARISON OVER TIME:
 *
 *   Lineage is the explicit record of how artifacts relate to each
 *   other and how they were produced. Lineage enables time-based
 *   comparison because it answers the question: "What was the world
 *   like when this artifact was created?"
 *
 *   A simulation created on January 15 referenced Integration V2.3 of
 *   SAP. The current integration version is V3.1. Lineage tells the
 *   platform that the simulation's context assumed V2.3. The platform
 *   can then surface: "This simulation was created against SAP V2.3.
 *   The current version is V3.1. Changes may affect this simulation's
 *   conclusions."
 *
 *   Without lineage, this comparison is impossible. The platform would
 *   know only the current state of integrations, with no way to
 *   determine what state existed when any given simulation was created.
 *
 * WHY REPLAY AND DIFFING ARE ARCHITECTURAL PRIMITIVES:
 *
 *   Replay — the ability to re-execute a simulation's synthesis
 *   phase with recorded inputs — is not a feature. It is an
 *   architectural primitive that makes drift observable.
 *
 *   When the platform replays a simulation and the output differs
 *   from the original, the difference is a signal. That signal may
 *   indicate that the synthesis engine has changed, that integration
 *   definitions have evolved, or that enterprise context has shifted.
 *   The platform does not interpret the signal — it presents it to
 *   humans.
 *
 *   Diffing — the ability to compare two versions of an artifact,
 *   two simulation outputs, or two states of the integration
 *   landscape — is the mechanism by which replay signals become
 *   actionable. A diff that says "the cost projection changed by
 *   40%" is more useful than a signal that says "something changed."
 *
 *   Replay and diffing are architectural primitives because they are
 *   the fundamental operations through which coherence becomes
 *   observable. They are not features to be added later — they are
 *   capabilities that the memory architecture must support from the
 *   beginning.
 *
 * ============================================================================
 * DOMAIN 5: HUMAN OVERSIGHT BOUNDARY
 * ============================================================================
 *
 * DEFINITION:
 *
 * The human oversight boundary defines where human judgment is
 * mandatory in the Agentics platform. It establishes an explicit
 * line between what the platform may do autonomously (observe,
 * compare, surface) and what requires human authorization (correct,
 * approve, execute, archive).
 *
 * WHERE HUMANS REMAIN MANDATORY:
 *
 *   Enterprise decisions:
 *     Every decision that affects the enterprise — approving a plan,
 *     executing a deployment, enabling a policy, rolling back a change
 *     — requires explicit human authorization through a
 *     COMMITMENT_GRADE command with --force confirmation. The platform
 *     presents information. Humans decide.
 *
 *   Drift response:
 *     When the platform detects drift, the response is always a human
 *     decision. The platform surfaces: "These simulations may be
 *     affected by changes to Integration X." The human decides: re-run
 *     the simulations, accept the drift, or investigate further. The
 *     platform never decides autonomously which response is appropriate.
 *
 *   Coherence remediation:
 *     When the platform identifies incoherence (orphaned artifacts,
 *     broken lineage, dangling references), remediation is a human
 *     action. The platform surfaces: "Plan Y references Simulation Z,
 *     which no longer exists." The human decides: delete the plan,
 *     re-create the simulation, or accept the orphaned state. The
 *     platform never cleans up autonomously.
 *
 *   Archival and retention:
 *     Decisions about which simulations to archive, which proposals
 *     to retire, and which artifacts to retain are enterprise
 *     governance decisions. The platform may surface recommendations
 *     ("This simulation is 18 months old and has not been referenced").
 *     The human decides whether to archive it.
 *
 *   Interpretation:
 *     The platform produces observations, not judgments. "Simulation A
 *     and Simulation B produce different cost projections for the same
 *     scenario" is an observation. "Simulation A is outdated" is a
 *     judgment. The platform makes observations. Humans make judgments.
 *
 * WHY EXECUTIVE AND OPERATOR JUDGMENT IS PRESERVED:
 *
 *   Enterprise decisions have consequences that extend beyond the
 *   platform's scope. A deployment affects real systems, real budgets,
 *   real compliance obligations, and real people. The platform cannot
 *   understand these consequences because they exist outside its
 *   memory and governance model.
 *
 *   A simulation may show that a migration saves $2M annually. An
 *   executive may reject it because a regulatory change makes the
 *   target architecture non-compliant next quarter. The platform
 *   does not know about the regulatory change. If it autonomously
 *   acted on the simulation's recommendation, it would make the
 *   wrong decision.
 *
 *   Human judgment is not a limitation of the platform. It is a
 *   feature. It ensures that enterprise decisions account for context
 *   that the platform cannot observe.
 *
 * HOW THE SYSTEM SUPPORTS HUMANS WITHOUT REPLACING THEM:
 *
 *   The platform supports human decision-making by:
 *
 *   - Preserving context. Every simulation, plan, proposal, and
 *     decision is recorded with full context in Ruvector. Humans
 *     never need to reconstruct "why did we decide this?" — the
 *     platform remembers.
 *
 *   - Surfacing drift. The platform identifies when underlying
 *     assumptions have changed. Humans do not need to manually
 *     compare integration versions or check simulation freshness —
 *     the platform observes and reports.
 *
 *   - Enabling comparison. When humans need to evaluate alternatives,
 *     the platform can replay simulations, diff outputs, and present
 *     structured comparisons. Humans make the judgment; the platform
 *     provides the evidence.
 *
 *   - Maintaining traceability. When a decision is questioned — by
 *     auditors, executives, or future contributors — the platform
 *     provides the complete decision trail. Every artifact traces
 *     to a simulation, a plan, a human authorization, and a
 *     governance checkpoint.
 *
 *   The platform is an enterprise decision system that amplifies
 *   human judgment. It is not an AI tool that replaces it.
 *
 * ============================================================================
 * SYSTEM-LEVEL INVARIANTS (NON-NEGOTIABLE)
 * ============================================================================
 *
 * The following are system-level truths that all implementations
 * must preserve. These invariants extend — and do not replace — the
 * invariants defined in ADR-003 (Invariants 1-7) and ADR-004
 * (Invariants 1-7).
 *
 * INVARIANT 1: Every enterprise decision must remain traceable
 *   over time.
 *
 *   Traceability is not a point-in-time property. A decision must
 *   be traceable not only at creation but indefinitely afterward.
 *   The deletion or modification of upstream artifacts (simulations,
 *   plans, integration definitions) must not destroy the traceability
 *   of downstream decisions. If traceability degrades, the platform
 *   must detect and surface this as a coherence violation.
 *
 * INVARIANT 2: No integration or ERP proposal exists without
 *   historical context.
 *
 *   Every proposal must record the context in which it was created:
 *   which integration definitions were current, what simulation
 *   parameters were used, what governance version was applied, and
 *   who authorized the simulation. This historical context is the
 *   basis for future drift detection. A proposal without historical
 *   context is undiffable and therefore unmonitorable.
 *
 * INVARIANT 3: Drift may be detected but never silently corrected.
 *
 *   When the platform detects drift — stale simulations, changed
 *   integration definitions, broken lineage — it must surface the
 *   finding and wait for human response. The platform must not
 *   silently update, reconcile, archive, or discard artifacts
 *   based on detected drift. Silent correction is indistinguishable
 *   from data corruption from an audit perspective.
 *
 * INVARIANT 4: Memory is authoritative; projections are derived.
 *
 *   Ruvector's stored artifacts are the authoritative record of
 *   what the platform has produced. Any view, dashboard, report,
 *   or comparison that the platform presents is a projection derived
 *   from Ruvector's records. If a projection contradicts Ruvector,
 *   Ruvector is correct and the projection is wrong. Projections
 *   must never modify memory; they are read-only derivations.
 *
 * INVARIANT 5: Self-management never bypasses governance.
 *
 *   Any action the platform takes to manage its own state — producing
 *   coherence reports, detecting drift, comparing simulations,
 *   traversing lineage — must be a read-only operation against
 *   Ruvector. Self-management never writes to Ruvector, never
 *   modifies artifacts, never creates new artifacts, and never
 *   triggers the governed CLI pipeline without explicit human
 *   initiation.
 *
 * ============================================================================
 * CONCEPTUAL LIFECYCLE (DESCRIPTIVE ONLY)
 * ============================================================================
 *
 * The following describes, in prose, how the platform accumulates
 * state over time and how coherence becomes observable. This is a
 * conceptual description. It is not a specification, a workflow
 * definition, or an implementation guide.
 *
 * ACCUMULATION:
 *
 *   Over months and years of operation, the Agentics platform
 *   accumulates simulations, plans, proposals, and decisions. Each
 *   simulation captures a snapshot of the enterprise context at the
 *   time it was created: which integrations existed, what their
 *   capabilities were, what constraints applied, and what the user
 *   asked the system to reason about.
 *
 *   As new simulations are created, the integration landscape
 *   evolves. New enterprise systems are added. Existing systems are
 *   upgraded. Capabilities change. Constraints shift. Each new
 *   simulation captures the current landscape, but earlier
 *   simulations retain the landscape as it was.
 *
 * COMPARISON:
 *
 *   Because Ruvector stores the context of every simulation, the
 *   platform can compare any two points in time. A simulation from
 *   January can be compared against a simulation from July — not
 *   just in terms of their outputs, but in terms of the enterprise
 *   context that informed them.
 *
 *   Comparison reveals divergence. If two simulations of the same
 *   scenario produce different cost projections, the platform can
 *   present the differences alongside the contextual changes that
 *   may explain them. "The January simulation assumed 50 EC2
 *   instances at $X/month. The July simulation assumed 120 Kubernetes
 *   pods at $Y/month. The integration landscape changed between
 *   these runs: AWS integration was updated from V2 to V3."
 *
 * DRIFT BECOMES OBSERVABLE:
 *
 *   Drift becomes observable when the platform compares the context
 *   of an existing artifact against the current state of the system.
 *   The observation takes one of several forms:
 *
 *   - An integration definition that a simulation referenced has
 *     been modified. The simulation's assumptions may no longer hold.
 *
 *   - A derivation chain has a broken link. An artifact's parent
 *     no longer exists, making the artifact an orphan.
 *
 *   - A replay of a simulation produces materially different output.
 *     Something in the synthesis context has changed.
 *
 *   - Multiple proposals for the same enterprise process are based
 *     on different simulation contexts. The proposals may be
 *     contradictory.
 *
 *   Each of these is an observation, not a judgment. The platform
 *   records the observation and makes it available to operators.
 *
 * HUMANS ARE ALERTED OR INFORMED:
 *
 *   When drift is detected, the platform surfaces the finding through
 *   governed channels. The specific mechanism — a report, a
 *   notification, a dashboard entry, a CLI command output — is an
 *   implementation concern. The conceptual requirement is that drift
 *   findings reach a human who can evaluate them.
 *
 *   The finding includes:
 *
 *   - What was detected (the type of drift)
 *   - Where it was detected (which artifacts are affected)
 *   - What changed (the specific difference between the recorded
 *     context and the current state)
 *   - When the drift originated (the timestamp of the change)
 *
 *   The finding does NOT include:
 *
 *   - A recommendation for corrective action
 *   - A severity judgment
 *   - An automatic remediation option
 *   - A comparison to similar drift events
 *
 *   The platform presents facts. Humans interpret them.
 *
 * CORRECTIONS OCCUR THROUGH GOVERNED WORKFLOWS:
 *
 *   When a human decides that drift requires a response, the
 *   response flows through the governed CLI pipeline. If a
 *   simulation needs to be re-run, the human issues a simulate
 *   command. If a plan needs to be revised, the human issues a
 *   plan command. If a deployment needs to be rolled back, the
 *   human issues a deploy rollback command with --force confirmation.
 *
 *   There is no "fix drift" command. There is no "reconcile" button.
 *   There is no "auto-heal" workflow. Corrections are composed from
 *   the existing governed command vocabulary. The governed pipeline
 *   ensures that every correction is subject to the same governance
 *   as the original action: identity attribution, synthesis
 *   classification, gate validation, and Ruvector persistence.
 *
 *   This means that corrective actions are indistinguishable from
 *   original actions in the audit trail. A simulation re-run due
 *   to drift is just another simulation. A plan revision is just
 *   another plan. The platform does not distinguish between "first
 *   time" and "correction" — all actions are governed equally.
 *
 * ============================================================================
 * RELATIONSHIP TO EXISTING ADRS
 * ============================================================================
 *
 * ADR-005 is additive to the governance hierarchy established by
 * ADRs 001-004. It does not rewrite, replace, or contradict any
 * prior ADR.
 *
 *   ADR-003 → defines the CLI control plane conceptual model
 *     ↓
 *   ADR-004 → defines the enterprise integration conceptual model
 *     ↓
 *   ADR-005 → defines how coherence and drift are governed over time
 *     ↓
 *   ADR-001 → instantiates the models (command registry + types)
 *     ↓
 *   ADR-002 → enforces the models (gates + CI + regression tests)
 *
 * Specifically:
 *
 * - ADR-003's five CLI domains (Control Plane, Command Semantics,
 *   Synthesis Governance, Execution & State Mutation, Governance
 *   Source of Truth) remain unchanged. ADR-005's five coherence
 *   domains are complementary. They describe how ADR-003's domains
 *   maintain integrity over time.
 *
 * - ADR-003's execution phases (Planning → Execution → Commitment →
 *   Rollback) are the mechanisms through which drift corrections
 *   occur. ADR-005 does not introduce new lifecycle phases.
 *
 * - ADR-004's enterprise domains (Simulation, Memory, Integration,
 *   ERP Surface, CLI as Orchestrator) are the subjects of ADR-005's
 *   drift detection. ADR-005 describes how those domains' artifacts
 *   are monitored for coherence.
 *
 * - ADR-004's invariants (particularly Invariant 4: Ruvector as
 *   memory authority) are the foundation for ADR-005's
 *   memory-anchored reality principle.
 *
 * - ADR-001's command vocabulary is the mechanism through which
 *   humans respond to detected drift. ADR-005 does not introduce
 *   new commands.
 *
 * - ADR-002's gate pipeline ensures that drift corrections (like
 *   all actions) pass governance validation. ADR-005 relies on this
 *   enforcement and does not duplicate it.
 *
 * No existing ADR needs to be edited as a result of ADR-005.
 *
 * ============================================================================
 * CONSEQUENCES
 * ============================================================================
 *
 * POSITIVE:
 *
 *   - The platform's long-term integrity is explainable. A stakeholder
 *     can read this ADR and understand how the platform maintains
 *     coherence without requiring autonomous behavior.
 *
 *   - Future contributors understand how drift is handled. The clear
 *     separation between detection (platform) and correction (human)
 *     prevents the introduction of autonomous remediation features.
 *
 *   - No prior ADR needs revision. ADR-005 is purely additive,
 *     filling a conceptual gap without contradicting existing
 *     decisions.
 *
 *   - The platform reads as an enterprise decision system, not an AI
 *     tool. The emphasis on human oversight, auditability, and
 *     governed workflows positions the platform as infrastructure
 *     for decision-making rather than a replacement for it.
 *
 *   - Self-management is structural, not magical. There is no
 *     "auto-heal" mystique. The platform observes, compares, and
 *     surfaces. Humans govern.
 *
 *   - The distinction between observation and action is explicit.
 *     Future contributors cannot accidentally build autonomous
 *     correction by confusing "detect" with "fix."
 *
 * NEGATIVE:
 *
 *   - Drift correction requires human effort. The platform does not
 *     automate responses to drift, which means operators must monitor
 *     drift reports and take manual action. This is intentional —
 *     the alternative (autonomous correction) violates the governance
 *     model.
 *
 *   - The conceptual ADR chain (003, 004, 005) is now three documents.
 *     Contributors must understand the coherence model in addition to
 *     the CLI control plane and enterprise integration models.
 *     However, ADR-005 addresses a distinct concern (long-term
 *     integrity) that is not covered by the other conceptual ADRs.
 *
 *   - The invariant that drift is "never silently corrected" may
 *     frustrate contributors who want to build intelligent
 *     auto-remediation. This frustration is the point — the invariant
 *     exists to prevent well-intentioned autonomy from undermining
 *     governance.
 *
 * ============================================================================
 * EXPLICIT NON-GOALS
 * ============================================================================
 *
 *   1. This ADR does NOT introduce new CLI commands.
 *      Drift detection and coherence reporting will be exposed
 *      through existing or future commands defined in ADR-001.
 *      This ADR defines the conceptual domains, not the commands.
 *
 *   2. This ADR does NOT define schemas, tables, or APIs.
 *      How drift observations are stored, queried, or surfaced is
 *      an implementation concern for future ADRs.
 *
 *   3. This ADR does NOT describe middleware, jobs, or code.
 *      There are no background processes, cron jobs, or event
 *      handlers specified here. Implementation mechanisms belong
 *      in future implementation ADRs.
 *
 *   4. This ADR does NOT specify algorithms or heuristics.
 *      How drift is detected — what thresholds trigger observations,
 *      what comparison methods are used, how staleness is calculated
 *      — is an implementation concern. This ADR defines what drift
 *      IS and what the platform's responsibilities are, not how
 *      drift is computed.
 *
 *   5. This ADR does NOT propose automation or autonomous correction.
 *      The platform observes and surfaces. It does not fix, reconcile,
 *      archive, or remediate. Any future automation must be explicitly
 *      human-configured and must not violate Invariant 3.
 *
 *   6. This ADR does NOT re-state or modify prior ADR decisions.
 *      It extends the conceptual architecture into the coherence
 *      and drift space, which was not covered by ADRs 001-004.
 *
 * ============================================================================
 * ANTI-PATTERNS (WHAT FUTURE CONTRIBUTORS MUST NOT DO)
 * ============================================================================
 *
 * ANTI-PATTERN 1: SILENT AUTO-CORRECTION
 *
 *   What it looks like:
 *     A background job detects that a simulation's integration
 *     references are outdated. It automatically re-runs the
 *     simulation with updated integration definitions and replaces
 *     the original results in Ruvector.
 *
 *   Why it's wrong:
 *     Silent correction destroys the audit trail. The original
 *     simulation's results — which may have been reviewed, approved,
 *     and used to justify enterprise decisions — are overwritten.
 *     An auditor asking "What did the original simulation conclude?"
 *     gets the corrected answer, not the original. This violates
 *     Invariant 3 and is indistinguishable from data tampering.
 *
 *   What to do instead:
 *     Surface the drift. Present: "Simulation X referenced
 *     Integration V2.3. The current version is V3.1." Let the
 *     human decide whether to re-run the simulation. If they do,
 *     it creates a NEW simulation with its own lineage — the
 *     original is preserved.
 *
 * ANTI-PATTERN 2: AUTONOMOUS ARCHIVAL
 *
 *   What it looks like:
 *     A system policy automatically archives simulations older than
 *     90 days. A "staleness" algorithm marks proposals as "outdated"
 *     and removes them from active views.
 *
 *   Why it's wrong:
 *     Retention is an enterprise governance decision, not a system
 *     behavior. A simulation from two years ago may still be the
 *     basis for an active deployment. An "old" proposal may be
 *     under regulatory review. Autonomous archival removes artifacts
 *     that humans may need, based on the system's assumption about
 *     what is "stale." This violates Invariant 5.
 *
 *   What to do instead:
 *     Surface retention observations: "These 47 simulations are
 *     older than 12 months and have no downstream references."
 *     Let the operator decide whether to archive them. Archival
 *     is a governed action, not an automatic one.
 *
 * ANTI-PATTERN 3: DRIFT SEVERITY SCORING
 *
 *   What it looks like:
 *     The platform assigns "severity scores" to detected drift.
 *     "Critical: Integration SAP changed from V2 to V3. 12
 *     simulations affected." "Low: Integration Slack updated
 *     description text. 2 simulations reference it."
 *
 *   Why it's wrong:
 *     Severity is a judgment, not a measurement. A "minor" text
 *     change in a Slack integration might be irrelevant to most
 *     simulations but critical to one that depends on specific
 *     notification behavior. A "major" version change in SAP might
 *     be backward-compatible and affect nothing. The platform does
 *     not understand enterprise context deeply enough to assign
 *     severity accurately. False severity scores create false
 *     confidence or false urgency.
 *
 *   What to do instead:
 *     Present the facts without judgment: "Integration SAP changed
 *     from V2.3 to V3.1. 12 simulations referenced V2.3." The
 *     human determines whether this matters.
 *
 * ANTI-PATTERN 4: PREDICTIVE DRIFT PREVENTION
 *
 *   What it looks like:
 *     The platform analyzes integration change patterns and
 *     "pre-emptively" re-runs simulations that are "likely" to be
 *     affected by upcoming changes.
 *
 *   Why it's wrong:
 *     Prediction requires modeling the future behavior of enterprise
 *     systems, organizational decisions, and market conditions. The
 *     platform does not have access to these signals. Predictive
 *     prevention creates false confidence ("the system already
 *     accounted for this change") and wastes resources on
 *     simulations that may never be needed. Worse, it conflates
 *     prediction with governance — the platform is making decisions
 *     about what to simulate without human authorization.
 *
 *   What to do instead:
 *     When changes occur, surface them. Let humans decide which
 *     simulations to re-run based on their understanding of the
 *     enterprise context.
 *
 * ANTI-PATTERN 5: OVER-AUTOMATION OF COHERENCE CHECKS
 *
 *   What it looks like:
 *     Every artifact write triggers a full coherence check across
 *     the entire platform. Every integration change triggers
 *     notifications to all simulation owners. The system produces
 *     so many coherence observations that operators learn to
 *     ignore them.
 *
 *   Why it's wrong:
 *     Over-automation creates noise. When every change generates
 *     observations, the signal-to-noise ratio collapses. Operators
 *     stop reading coherence reports. Critical drift observations
 *     are lost in a flood of irrelevant notifications. The system
 *     that was designed to make drift visible inadvertently makes
 *     it invisible through volume.
 *
 *   What to do instead:
 *     Coherence checks should be invoked through governed workflows
 *     — not triggered automatically on every state change. Humans
 *     decide when to check coherence and at what scope.
 *
 * ============================================================================
 * SUCCESS CRITERIA
 * ============================================================================
 *
 * This ADR is successful if:
 *
 *   1. The system's long-term integrity is explainable. A new
 *      contributor, a stakeholder, or an auditor can read this
 *      document and understand how the platform maintains
 *      coherence over time — without reading implementation code.
 *
 *   2. Future contributors understand how drift is handled.
 *      The detect-surface-wait pattern is clear. No contributor
 *      builds autonomous correction without explicitly violating
 *      a stated invariant.
 *
 *   3. No prior ADR needs revision. ADR-005 is additive. ADRs
 *      001, 002, 003, and 004 remain unchanged and uncontradicted.
 *
 *   4. The platform reads as an enterprise decision system, not an
 *      AI tool. The emphasis on human oversight, governed workflows,
 *      and non-autonomous behavior positions the platform as
 *      infrastructure for enterprise governance.
 *
 *   5. Self-management is structural, not magical. The document
 *      makes clear that "self-managing" means observing and surfacing,
 *      not deciding and acting. There is no mystique about what the
 *      platform does on its own.
 *
 * ============================================================================
 * ALTERNATIVES CONSIDERED
 * ============================================================================
 *
 * A. Embed coherence concepts into ADR-004:
 *    Rejected — ADR-004 defines the enterprise integration and
 *    memory domains. Coherence and drift are cross-cutting concerns
 *    that apply to all domains (CLI, integration, ERP Surface, memory).
 *    Embedding them in ADR-004 would make coherence appear to be
 *    an integration concern rather than a system-wide property.
 *
 * B. Define specific drift detection algorithms:
 *    Rejected — algorithms are implementation concerns. This ADR
 *    defines what drift IS, what the platform's responsibilities
 *    are, and what boundaries apply. How drift is computed belongs
 *    in a future implementation ADR.
 *
 * C. Allow limited autonomous correction for "safe" cases:
 *    Rejected — "safe" autonomous correction is a category error.
 *    Safety is a judgment that requires enterprise context. A
 *    correction that is "safe" from a structural perspective may be
 *    unsafe from a regulatory, financial, or organizational
 *    perspective. The platform cannot evaluate these dimensions.
 *    Therefore, no correction is autonomous.
 *
 * D. Combine coherence and governance into a single domain:
 *    Rejected — governance (ADR-003) defines how decisions are
 *    made and enforced. Coherence (ADR-005) defines how decisions
 *    remain structurally consistent over time. These are related
 *    but distinct concerns. Combining them would blur the boundary
 *    between "how we decide" and "how we verify that our decisions
 *    remain valid."
 *
 * E. Introduce a "drift" command category:
 *    Rejected — this ADR does not introduce commands. If drift
 *    detection commands are needed, they will be defined in ADR-001
 *    (command registry) and governed by ADR-002 (enforcement), per
 *    the established ADR hierarchy.
 */

// ============================================================================
// ADR-005 Metadata
// ============================================================================
// This ADR is purely conceptual. It exports only its own metadata
// for identification and cross-referencing by other ADRs.
// It contains no schemas, no middleware, no algorithms, no runtime code.
// ============================================================================

export const ADR_005_ID = 'ADR-005' as const;
export const ADR_005_TITLE = 'System Coherence, Drift Detection, and Self-Governance' as const;
export const ADR_005_STATUS = 'Accepted' as const;
export const ADR_005_DATE = '2026-01-28' as const;

// ============================================================================
// ADR-005 Implementation: Types
// ============================================================================

/**
 * The five coherence domains from ADR-005.
 */
export type CoherenceDomain =
  | 'SYSTEM_COHERENCE'
  | 'DRIFT_DETECTION'
  | 'GOVERNED_SELF_MANAGEMENT'
  | 'MEMORY_ANCHORED_REALITY'
  | 'HUMAN_OVERSIGHT_BOUNDARY';

/**
 * The four drift categories from ADR-005 Domain 2.
 */
export type DriftCategory =
  | 'SEMANTIC_DRIFT'
  | 'STRUCTURAL_DRIFT'
  | 'LINEAGE_DRIFT'
  | 'INTEGRATION_DRIFT';

/**
 * Types of coherence violations (structural properties).
 */
export type CoherenceViolationType =
  | 'MISSING_LINEAGE'
  | 'DANGLING_REFERENCE'
  | 'UNGOVERNED_ORIGIN'
  | 'BROKEN_DERIVATION_CHAIN'
  | 'ORPHANED_ARTIFACT';

/**
 * Self-management capabilities (ALLOWED — read-only observations).
 */
export type SelfManagementCapability =
  | 'OBSERVE_COHERENCE'
  | 'COMPARE_ARTIFACTS'
  | 'SURFACE_FINDINGS'
  | 'TRAVERSE_LINEAGE'
  | 'DETECT_DRIFT'
  | 'REPLAY_SIMULATION';

/**
 * Prohibited autonomous actions (FORBIDDEN — require human authorization).
 */
export type ProhibitedAutonomy =
  | 'AUTO_CORRECT_DRIFT'
  | 'AUTO_ARCHIVE'
  | 'AUTO_REMEDIATE'
  | 'AUTO_RERUN'
  | 'AUTO_RECONCILE'
  | 'AUTO_SEVERITY_SCORE';

/**
 * Action boundary classification.
 */
export type ActionBoundary =
  | 'OBSERVATION'
  | 'AUTONOMOUS_ACTION'
  | 'GOVERNED_ACTION';

// ============================================================================
// ADR-005 Implementation: Interfaces
// ============================================================================

/**
 * A single coherence violation.
 * Descriptive only — no severity, no recommendation, no auto-fix.
 */
export interface CoherenceViolation {
  readonly id: string;
  readonly type: CoherenceViolationType;
  readonly domain: CoherenceDomain;
  readonly artifact_id: string;
  readonly artifact_type: string;
  readonly description: string;
  readonly related_artifacts: readonly string[];
  readonly detected_at: string;
}

/**
 * Coherence state of the system at a point in time.
 */
export interface CoherenceState {
  readonly checked_at: string;
  readonly domains_checked: readonly CoherenceDomain[];
  readonly violation_count: number;
  readonly violations: readonly CoherenceViolation[];
  readonly is_coherent: boolean;
  readonly metadata: {
    readonly artifacts_checked: number;
    readonly lineage_chains_traversed: number;
    readonly references_validated: number;
  };
}

/**
 * Context snapshot for drift comparison.
 */
export interface ContextSnapshot {
  readonly timestamp: string;
  readonly integration_versions: Readonly<Record<string, string>>;
  readonly gate_pipeline_version: string;
  readonly schema_versions: Readonly<Record<string, string>>;
}

/**
 * A specific field-level difference between two contexts.
 */
export interface ContextDifference {
  readonly field: string;
  readonly original_value: unknown;
  readonly current_value: unknown;
  readonly change_type: 'added' | 'removed' | 'modified';
}

/**
 * A drift observation.
 * Fact-based only — no severity, no recommendation, no staleness score.
 */
export interface DriftObservation {
  readonly id: string;
  readonly category: DriftCategory;
  readonly change_description: string;
  readonly affected_artifacts: readonly string[];
  readonly original_context: ContextSnapshot;
  readonly current_context: ContextSnapshot;
  readonly differences: readonly ContextDifference[];
  readonly observed_at: string;
}

/**
 * Drift report surfaced to humans.
 * Summary counts only — no recommendations, no auto-fix options.
 */
export interface DriftReport {
  readonly id: string;
  readonly generated_at: string;
  readonly observations: readonly DriftObservation[];
  readonly summary: {
    readonly total_observations: number;
    readonly by_category: Readonly<Record<DriftCategory, number>>;
    readonly artifacts_affected: number;
  };
}

/**
 * Classification of an action as observation vs autonomous.
 */
export interface ActionClassification {
  readonly action: string;
  readonly boundary: ActionBoundary;
  readonly is_observation: boolean;
  readonly is_autonomous: boolean;
  readonly justification: string;
  readonly violates_invariant?: 1 | 2 | 3 | 4 | 5;
}

/**
 * Result of checking one of the 5 coherence invariants.
 */
export interface InvariantCheckResult {
  readonly invariant_number: 1 | 2 | 3 | 4 | 5;
  readonly invariant_description: string;
  readonly satisfied: boolean;
  readonly violations: readonly CoherenceViolation[];
  readonly checked_at: string;
}

// ============================================================================
// ADR-005 Implementation: Constants
// ============================================================================

/**
 * The five system-level invariants from ADR-005.
 */
export const COHERENCE_INVARIANTS = [
  {
    number: 1 as const,
    id: 'INV-005-01' as const,
    description: 'Every enterprise decision must remain traceable over time',
    domain: 'MEMORY_ANCHORED_REALITY' as CoherenceDomain,
  },
  {
    number: 2 as const,
    id: 'INV-005-02' as const,
    description: 'No integration or ERP proposal exists without historical context',
    domain: 'SYSTEM_COHERENCE' as CoherenceDomain,
  },
  {
    number: 3 as const,
    id: 'INV-005-03' as const,
    description: 'Drift may be detected but never silently corrected',
    domain: 'DRIFT_DETECTION' as CoherenceDomain,
  },
  {
    number: 4 as const,
    id: 'INV-005-04' as const,
    description: 'Memory is authoritative; projections are derived',
    domain: 'MEMORY_ANCHORED_REALITY' as CoherenceDomain,
  },
  {
    number: 5 as const,
    id: 'INV-005-05' as const,
    description: 'Self-management never bypasses governance',
    domain: 'GOVERNED_SELF_MANAGEMENT' as CoherenceDomain,
  },
] as const;

/**
 * Coherence domain definitions.
 */
export const COHERENCE_DOMAINS = {
  SYSTEM_COHERENCE: {
    name: 'System Coherence',
    description: 'Structural property: lineage intact, references resolve, governed origins',
    verifiable: true,
  },
  DRIFT_DETECTION: {
    name: 'Drift Detection',
    description: 'Temporal divergence observation across 4 categories',
    verifiable: true,
  },
  GOVERNED_SELF_MANAGEMENT: {
    name: 'Governed Self-Management',
    description: 'Observe/compare/surface — NEVER correct/decide/remediate',
    verifiable: true,
  },
  MEMORY_ANCHORED_REALITY: {
    name: 'Memory-Anchored Reality',
    description: 'Ruvector as authoritative substrate; replay and diffing as primitives',
    verifiable: true,
  },
  HUMAN_OVERSIGHT_BOUNDARY: {
    name: 'Human Oversight Boundary',
    description: 'Human mandatory for decisions, drift response, remediation, archival, interpretation',
    verifiable: false,
  },
} as const;

/**
 * Drift category definitions.
 */
export const DRIFT_CATEGORIES = {
  SEMANTIC_DRIFT: {
    name: 'Semantic Drift',
    description: 'Meaning changes without acknowledgment',
    detectable_automatically: false,
  },
  STRUCTURAL_DRIFT: {
    name: 'Structural Drift',
    description: 'Schema or definition shape changes',
    detectable_automatically: true,
  },
  LINEAGE_DRIFT: {
    name: 'Lineage Drift',
    description: 'Broken or incomplete derivation chains',
    detectable_automatically: true,
  },
  INTEGRATION_DRIFT: {
    name: 'Integration Drift',
    description: 'Integration landscape evolution',
    detectable_automatically: true,
  },
} as const;

/**
 * Self-management capabilities (all read-only, all allowed).
 */
export const SELF_MANAGEMENT_CAPABILITIES = {
  OBSERVE_COHERENCE: {
    name: 'Observe Coherence',
    boundary: 'OBSERVATION' as ActionBoundary,
    read_only: true,
    requires_human: false,
  },
  COMPARE_ARTIFACTS: {
    name: 'Compare Artifacts',
    boundary: 'OBSERVATION' as ActionBoundary,
    read_only: true,
    requires_human: false,
  },
  SURFACE_FINDINGS: {
    name: 'Surface Findings',
    boundary: 'OBSERVATION' as ActionBoundary,
    read_only: true,
    requires_human: false,
  },
  TRAVERSE_LINEAGE: {
    name: 'Traverse Lineage',
    boundary: 'OBSERVATION' as ActionBoundary,
    read_only: true,
    requires_human: false,
  },
  DETECT_DRIFT: {
    name: 'Detect Drift',
    boundary: 'OBSERVATION' as ActionBoundary,
    read_only: true,
    requires_human: false,
  },
  REPLAY_SIMULATION: {
    name: 'Replay Simulation',
    boundary: 'OBSERVATION' as ActionBoundary,
    read_only: true,
    requires_human: false,
  },
} as const;

/**
 * Prohibited autonomous actions (all forbidden, each references an invariant).
 */
export const PROHIBITED_AUTONOMY = {
  AUTO_CORRECT_DRIFT: {
    name: 'Auto-Correct Drift',
    boundary: 'AUTONOMOUS_ACTION' as ActionBoundary,
    violates_invariant: 3 as const,
    reason: 'Drift may be detected but never silently corrected',
  },
  AUTO_ARCHIVE: {
    name: 'Auto-Archive',
    boundary: 'AUTONOMOUS_ACTION' as ActionBoundary,
    violates_invariant: 5 as const,
    reason: 'Self-management never bypasses governance',
  },
  AUTO_REMEDIATE: {
    name: 'Auto-Remediate',
    boundary: 'AUTONOMOUS_ACTION' as ActionBoundary,
    violates_invariant: 3 as const,
    reason: 'Remediation requires human decision',
  },
  AUTO_RERUN: {
    name: 'Auto-Rerun',
    boundary: 'AUTONOMOUS_ACTION' as ActionBoundary,
    violates_invariant: 5 as const,
    reason: 'Simulation execution must be human-initiated',
  },
  AUTO_RECONCILE: {
    name: 'Auto-Reconcile',
    boundary: 'AUTONOMOUS_ACTION' as ActionBoundary,
    violates_invariant: 4 as const,
    reason: 'Memory is authoritative; cannot be auto-modified',
  },
  AUTO_SEVERITY_SCORE: {
    name: 'Auto-Severity Score',
    boundary: 'AUTONOMOUS_ACTION' as ActionBoundary,
    violates_invariant: 3 as const,
    reason: 'Severity is a judgment that requires enterprise context',
  },
} as const;

/**
 * Action verb patterns for boundary classification.
 */
export const ACTION_BOUNDARIES = {
  read_operations: ['query', 'list', 'inspect', 'compare', 'traverse', 'observe', 'detect', 'replay', 'surface', 'check'] as const,
  write_operations: ['correct', 'fix', 'remediate', 'archive', 'reconcile', 'update', 'delete', 'modify', 'overwrite'] as const,
  judgment_operations: ['score', 'prioritize', 'recommend', 'decide', 'classify-severity', 'rank'] as const,
} as const;

// ============================================================================
// ADR-005 Implementation: Validation Functions
// ============================================================================

/**
 * Classify an action as observation, autonomous, or governed.
 *
 * Uses verb pattern matching against ACTION_BOUNDARIES and known
 * capability/prohibition registries.
 */
export function classifyAction(action: string): ActionClassification {
  const normalized = action.toLowerCase().replace(/[_-]/g, ' ');

  // Check against prohibited autonomy first (most restrictive)
  for (const [, config] of Object.entries(PROHIBITED_AUTONOMY)) {
    const keyword = config.name.toLowerCase().replace('auto-', '');
    if (normalized.includes('auto') && normalized.includes(keyword)) {
      return {
        action,
        boundary: 'AUTONOMOUS_ACTION',
        is_observation: false,
        is_autonomous: true,
        justification: config.reason,
        violates_invariant: config.violates_invariant,
      };
    }
  }

  // Check against self-management capabilities
  for (const [, config] of Object.entries(SELF_MANAGEMENT_CAPABILITIES)) {
    const keyword = config.name.toLowerCase();
    if (normalized.includes(keyword)) {
      return {
        action,
        boundary: 'OBSERVATION',
        is_observation: true,
        is_autonomous: false,
        justification: `Allowed self-management capability: ${config.name}`,
      };
    }
  }

  // Classify by verb patterns
  const hasReadVerb = ACTION_BOUNDARIES.read_operations.some(v => normalized.includes(v));
  const hasWriteVerb = ACTION_BOUNDARIES.write_operations.some(v => normalized.includes(v));
  const hasJudgmentVerb = ACTION_BOUNDARIES.judgment_operations.some(v => normalized.includes(v));

  if (hasWriteVerb || hasJudgmentVerb) {
    return {
      action,
      boundary: 'AUTONOMOUS_ACTION',
      is_observation: false,
      is_autonomous: true,
      justification: 'Write or judgment operation requires human authorization',
      violates_invariant: 5,
    };
  }

  if (hasReadVerb) {
    return {
      action,
      boundary: 'OBSERVATION',
      is_observation: true,
      is_autonomous: false,
      justification: 'Read-only operation',
    };
  }

  // Default: unknown actions require governance
  return {
    action,
    boundary: 'GOVERNED_ACTION',
    is_observation: false,
    is_autonomous: false,
    justification: 'Unknown action — requires explicit governance',
  };
}

/**
 * Check if an action is a pure observation (read-only, allowed).
 */
export function isObservation(action: string): boolean {
  return classifyAction(action).is_observation;
}

/**
 * Check if an action is autonomous (forbidden without human approval).
 */
export function isAutonomous(action: string): boolean {
  return classifyAction(action).is_autonomous;
}

/**
 * Check if a ProhibitedAutonomy key is in the prohibited list.
 */
export function isProhibitedAction(action: ProhibitedAutonomy): boolean {
  return action in PROHIBITED_AUTONOMY;
}

/**
 * Validate that an action respects the human oversight boundary.
 * Returns null if valid, or an error message if violated.
 */
export function validateActionBoundary(
  action: string,
  hasHumanAuthorization: boolean,
): string | null {
  const classification = classifyAction(action);

  if (classification.is_observation) {
    return null;
  }

  if (classification.is_autonomous) {
    return (
      `Action "${action}" is prohibited. ${classification.justification}. ` +
      `Violates ADR-005 Invariant ${classification.violates_invariant}.`
    );
  }

  if (classification.boundary === 'GOVERNED_ACTION' && !hasHumanAuthorization) {
    return `Action "${action}" requires human authorization.`;
  }

  return null;
}
