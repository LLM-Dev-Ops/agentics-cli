# Scheduled Review — ADR-085 (test_bench and quality_engineering Coexistence)

**Review due:** 2026-10-15 (180 days after ADR-085 adoption on 2026-04-18)
**Review owner:** Platform architecture team
**Reviewing ADR:** ADR-PIPELINE-085
**Placeholder follow-up ADR:** `ADR-PIPELINE-085a-coexistence-180d-review.md` (to be created)

---

## Purpose

ADR-PIPELINE-085 §6 requires a 180-day review of whether `test_bench` and
`quality_engineering` should remain separate infrastructure domains or
consolidate. This document tracks the review until it fires.

## Review inputs to collect

Between 2026-04-18 and 2026-10-15, the platform team gathers:

- [ ] **Usage patterns by domain.** Observatory telemetry:
  `agent_invocations_total{domain=test_bench}` vs. `{domain=quality_engineering}`.
  Which domains are users actually invoking?

- [ ] **Routing overlap rate.** How often does a single user query trigger
  *both* domains simultaneously? Extract from `agentics ask` classification
  logs. A high overlap rate (>30%) suggests the boundary is artificial; a low
  rate (<5%) suggests the domains are cleanly separable.

- [ ] **Misrouting incidents.** Track cases where users reported "wrong
  domain picked up my query" or filed tickets about the boundary. Low count
  (<5 / 180d) means the disambiguation rules work; high count means the
  rules need refinement OR the domains should consolidate.

- [ ] **Adapter maintenance burden.** Hours spent on `test-bench` adapter vs.
  `agentic-qe` adapter over the window. If one adapter is substantially
  idle (<2 hrs maintenance/month), consolidation is worth considering.

- [ ] **User-facing clarity.** Survey or interview 5+ users who've invoked
  either domain: "Do you know which domain to ask for X?" Low clarity is a
  consolidation signal.

## Review decision tree

At 2026-10-15, the review concludes with one of:

1. **Keep both domains.** Boundary working as intended. File follow-up ADR
   `ADR-PIPELINE-085a` documenting the decision and metrics that justified it.
   Schedule next review at 2027-04-15 (+180 days).

2. **Refine boundary.** Add/modify disambiguation rules in
   `src/routing/domain-boundary.ts`; adjust capability ownership map in
   `docs/AGENT_CAPABILITY_REGISTRY.md`. ADR-085a documents the refinement.

3. **Consolidate.** Merge one domain into the other. This is a substantial
   operation: adapter migration, ecosystem graph changes, classifier rule
   removal, user migration docs. Requires a dedicated consolidation ADR,
   not just an 085a follow-up.

4. **Further review.** Data inconclusive. Extend review to 2027-01-15
   (+90 days). ADR-085a notes what additional data is needed.

Whatever is chosen, the decision MUST be documented in `ADR-PIPELINE-085a`.

## Tracking

When this review fires (on or after 2026-10-15):

1. Assign reviewer from platform architecture team.
2. Run the data-gathering queries from §"Review inputs to collect".
3. Draft `ADR-PIPELINE-085a` per the decision tree.
4. If consolidation is chosen, file a separate ADR for the migration plan
   (likely numbered in the 100+ range by then).
5. Delete this scheduled-review document once the follow-up ADR is merged.

## Anti-patterns to avoid

- **Confirmation bias:** Don't review only through a "we should consolidate"
  lens or a "we should keep both" lens. Let the metrics decide.
- **Silent deferral:** If 2026-10-15 passes without this review, the platform
  team's on-call lead is expected to flag it. No "we'll get to it next
  sprint" extensions without an updated review date documented here.
- **Invisible consolidation:** Never merge domains silently. All
  consolidation requires an ADR + CHANGELOG + migration notice.

## Related

- ADR-PIPELINE-085 (source)
- ADR-PIPELINE-080 (QE domain registration)
- ADR-PIPELINE-082 (Agent scope boundary — already established disambiguation)
- `src/routing/domain-boundary.ts` — implementation of disambiguation rules
- `docs/AGENT_CAPABILITY_REGISTRY.md` — capability ownership map
