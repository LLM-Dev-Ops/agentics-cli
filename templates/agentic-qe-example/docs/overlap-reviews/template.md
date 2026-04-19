# Overlap Review — `<upstream-tool-name>`

**Reviewer:** <github-handle>
**Date:** YYYY-MM-DD
**Upstream version checked:** <version or commit SHA>
**ADR reference:** ADR-PIPELINE-082 §5

---

## Context

The weekly rebase automation detected a new upstream AQE tool named
`<upstream-tool-name>` in version `<version>`. Per ADR-PIPELINE-082 §5, any new
upstream tool requires an overlap review before we decide to expose or exclude
it.

## 1. Declared capability

<paste the upstream's declared capability for this tool — from its tool-list
entry, docs, or source>

## 2. Existing Agentics domains that may cover this capability

Consult `docs/AGENT_CAPABILITY_REGISTRY.md` and `docs/ecosystem.graph.json`.

| Candidate domain | Overlap? (yes/partial/no) | Rationale |
|------------------|---------------------------|-----------|
| `safety` (Shield) | | |
| `performance_profiling` (Latency-Lens) | | |
| `connector_hub` | | |
| `data_security` (Data-Vault) | | |
| `memory_context` (Memory-Graph) | | |
| `test_bench` | | |
| `quality_engineering` (this domain) | | |

## 3. Decision

Choose one:

- [ ] **Expose** — no overlap with existing domains. Add to
  `bundle.json.exposed_agents[]`, add handler to `src/handlers/<agent-id>.ts`,
  add system prompt to `src/system-prompts/`, register agent in the agentics-cli
  `ecosystem.graph.json` QE infrastructure entry (ADR-PIPELINE-080), and update
  `docs/AGENT_CAPABILITY_REGISTRY.md`.

- [ ] **Exclude (overlap)** — overlaps with `<domain-name>`. Add to
  `bundle.json.excluded_upstream_agents[]` and `src/excluded-agents.ts`
  `EXCLUDED_UPSTREAM_AGENTS`. If the tool name pattern-matches an existing
  exclusion regex, the build-time validator already flags it — confirm.

- [ ] **Exclude (boundary)** — violates ADR-074 (ERP-Surface only) or another
  hard boundary. Add to exclusion list. Document the boundary violated.

- [ ] **Defer** — capability is novel enough that the right owner is unclear.
  Leave unexposed for now; file a follow-up issue to discuss cross-domain
  ownership. Do not add to exposed OR excluded lists.

## 4. Follow-up actions

- [ ] Edit `bundle.json` (exposed_agents OR excluded_upstream_agents)
- [ ] Edit `src/excluded-agents.ts` (if excluding)
- [ ] Edit `src/handlers/` (if exposing — create handler file)
- [ ] Edit `src/system-prompts/` (if exposing — create prompt file)
- [ ] Update `agentics-cli/docs/ecosystem.graph.json` QE agents list (if exposing)
- [ ] Update `agentics-cli/src/agents/system-prompts.ts` (if exposing)
- [ ] Add entry to `agentics-cli/CHANGELOG.md` under "Domain Promotions"
- [ ] Close upstream rebase PR with this review linked

## 5. Reviewer sign-off

- [ ] I confirm the ownership map in `docs/AGENT_CAPABILITY_REGISTRY.md` and
  `src/routing/domain-boundary.ts` is consistent with this decision.
- [ ] I confirm the conformance suite passes (`agentics-cli` reusable workflow).
- [ ] I confirm build-time exclusion check fires correctly on the planted
  forbidden tool (if exclusion chosen).
