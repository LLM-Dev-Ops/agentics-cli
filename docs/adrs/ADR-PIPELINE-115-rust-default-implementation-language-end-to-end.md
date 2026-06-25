# ADR-PIPELINE-115: Rust-Default Implementation Language End-to-End, TypeScript Fallback

**Status:** Proposed
**Date:** 2026-06-25
**Authors:** Nick Ruest
**Priority:** HIGH — The reference run recorded `phase5b_skipped: { reason: "language-mismatch", detected: "unknown", template: "typescript" }`. This skipped an entire prototype-generation phase, producing no runnable code. Root cause: `language-resolver.ts` already defaults to Rust (a `rust-default-preference` signal; Rust wins ties), but the live prototype path is driven by `detectProjectLanguage` and `decideScaffoldEmission` (`src/pipeline/auto-chain.ts:5334` / `:5317`), which understand only TypeScript and Python. When the detected language is "unknown" (no `package.json`, `requirements.txt`, or `.py` files found), `decideScaffoldEmission` records a `language-mismatch` and skips both scaffold paths rather than defaulting to the language the resolver already selected. This ADR makes `language-resolver.ts` the single source of truth, routes "unknown" to Rust (the resolver's default), and directs `decideScaffoldEmission` to emit a Cargo project rather than skipping.
**Builds on:** ADR-PIPELINE-112 (model backend policy — real Rust output depends on a working LLM engine), ADR-PIPELINE-113 (ruflo resolution — ruflo generates Rust from SPARC/ADR/DDD artifacts when properly resolved), ADR-057 (Rust compute layer generation — established Rust as a target language for compute-intensive surfaces; this ADR elevates it to the default), ADR-043 (Rust and multi-language support — established the principle; this ADR enforces it at the scaffold emission gate).

---

## Context

### The language-resolver / scaffold-emission mismatch

Two independent systems determine the implementation language, and they disagree:

**System A — `src/pipeline/phase3/phases/language-resolver.ts`** (authoritative intent):

- Evaluates language signals from the dossier: keywords in the user's prompt, detected tech stack, domain conventions.
- Applies a `rust-default-preference` policy: when signals are weak or absent, Rust wins ties.
- Records `recommendedLanguage: "rust"` in the phase 3 output.

**System B — `detectProjectLanguage` + `decideScaffoldEmission`** (`src/pipeline/auto-chain.ts:5317` / `:5334`) (actual gate):

- Scans the workspace for language-specific files: `package.json` → typescript; `requirements.txt` / `*.py` → python.
- Falls back to `"unknown"` when neither set of markers is found.
- `decideScaffoldEmission` has two branches: `typescript` (emits a Node.js/Hono server scaffold) and `python` (emits a FastAPI scaffold). The `unknown` / `rust` branch records `language-mismatch` and calls `return { skip: true, reason: 'language-mismatch' }`.

In the reference run the user's project had no `package.json` or `.py` files. System A produced `recommendedLanguage: "rust"`. System B found `"unknown"` and skipped. The skip was not surfaced as a loud failure — `phase5b_skipped.reason: "language-mismatch"` was written to the manifest but the exit code was still 0.

### The prototype generators are TypeScript-only

A codebase audit of phase4/phase5 generators reveals:

| Generator | File | Language | Notes |
|-----------|------|----------|-------|
| HTTP server scaffold | `auto-chain.ts:~5400` | TypeScript (Hono) | Hardcoded; approximately 30 embedded TS scaffolds |
| ERP client scaffold | `src/pipeline/phases/erp-client-generator.ts` | TypeScript | `import 'hono'`, `tsconfig.json` emitted |
| Domain codegen | `src/pipeline/phases/domain-codegen.ts` | TypeScript | Generates TypeScript classes and interfaces |
| Rust optimizer | `src/pipeline/phases/rust-optimizer-generator.ts` | Rust (partial) | Generates a single `optimizer.rs` stub; no `Cargo.toml`, no workspace, not a complete project |

The `rust-optimizer-generator.ts` is the only Rust-emitting generator, and it is incomplete: it does not emit a `Cargo.toml`, does not define the package metadata, and does not integrate with the broader scaffold. A user attempting to build its output receives compilation errors before any business logic is compiled.

### The dependency on working engines

Generating real Rust code from SPARC/ADR/DDD artifacts requires LLM synthesis — ruflo running against a Claude Code session, or the `claude --print` transport. The reference run had no working engine (ADR-PIPELINE-112/113/114). Therefore:

- This ADR's decisions are **conditional**: real Rust output is only possible after ADR-112/113/114 fixes land and a working engine is available.
- In the absence of a working engine, this ADR's loud-failure protocol (delegated to ADR-PIPELINE-116) applies: phase 5b emits a failure artifact rather than a TypeScript scaffold masquerading as the user's requested Rust output.
- This ordering is intentional: fixing the engines (ADR-112–114) must precede enforcing Rust as the default (ADR-115). An engineer implementing this ADR in isolation — without the engine fixes — will see only a changed failure mode (Rust-labelled failure instead of language-mismatch skip), which is an improvement in honesty, not a regression.

---

## Decision

### D1. `language-resolver.ts` is the single source of truth for the implementation language

`detectProjectLanguage` in `auto-chain.ts:5317` is removed. Its workspace-file scan is subsumed into the phase 3 language resolver's signal set:

- File presence signals (`package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pyproject.toml`) are added as inputs to `language-resolver.ts`, weighted alongside the existing dossier-keyword signals.
- The resolver's output — `ResolvedLanguage { primary: string; fallbacks: string[]; confidence: number; rationale: string }` — is stored in the phase 3 output and read directly by `decideScaffoldEmission`.
- `decideScaffoldEmission` removes its own language-detection logic. It reads `resolvedLanguage.primary` and dispatches accordingly.

### D2. The Rust default: "unknown" maps to Rust

When `language-resolver.ts` finds no language-specific file markers and the dossier contains no strong language signal, `resolvedLanguage.primary` is `"rust"` with `confidence: 0.4` (below the high-confidence threshold of 0.7, indicating the decision is a default rather than a detection). This `confidence` value is surfaced in the manifest and in the loud-failure artifact (if needed) so the user understands the language was defaulted, not detected.

The `rust-default-preference` signal in `language-resolver.ts` is formalised as a documented policy constant:

```typescript
export const LANGUAGE_PREFERENCE_DEFAULT = 'rust';
// Rationale: Rust provides memory safety, deterministic performance, and
// small binary size — appropriate defaults for a compute-intensive backend
// when the user has not specified a language. This preference can be
// overridden by workspace signals (Cargo.toml → Rust confirmed; package.json →
// TypeScript; requirements.txt → Python) or by explicit --language flag.
```

### D3. `decideScaffoldEmission` emits a Cargo project for Rust

`decideScaffoldEmission` is extended with a `rust` branch:

| `resolvedLanguage.primary` | Scaffold emitted |
|---------------------------|-----------------|
| `typescript` | Node.js/Hono server (existing path) |
| `python` | FastAPI service (existing path) |
| `rust` | Cargo workspace scaffold (new path — D4) |
| any other language | Loud failure artifact (ADR-116): `LANG-FAIL-001.md` with `reason: "unsupported-language"` + `resolvedLanguage` dump |

The `language-mismatch` / `skip: true` return is removed. There is no skip path — every resolved language either has a scaffold path or produces a loud failure.

### D4. Rust scaffold: Cargo workspace with engine-generated domain crates

The Rust scaffold emitted by `decideScaffoldEmission` for `primary: "rust"` is a Cargo workspace generated from the SPARC/ADR/DDD artifacts produced in phases 3 and 4. The scaffold structure follows the architecture documented in the ADRs:

```
<runDir>/prototype/
  Cargo.toml                   # workspace manifest; members = domain crates
  crates/
    domain/
      Cargo.toml               # [lib] crate; generated from DDD aggregates
      src/lib.rs               # aggregate types, domain events, value objects
    api/
      Cargo.toml               # [[bin]] crate; HTTP server (axum or actix-web)
      src/main.rs
    erp-client/
      Cargo.toml               # [lib] crate; ERP surface client (if ERP detected)
      src/lib.rs
  .cargo/
    config.toml                # workspace-level cargo config (target, profile)
  README.md                    # build instructions: `cargo build`, `cargo test`
```

The domain crate's `src/lib.rs` is generated from the DDD aggregate definitions (phase 4 output). When a working LLM engine is available, ruflo generates the Rust source; when unavailable, ADR-116's failure protocol applies (see D5). The `rust-optimizer-generator.ts` partial implementation is extended to cover the full workspace.

Enumerated surfaces where TypeScript remains the scaffold language despite the Rust default:

| Surface | Why TypeScript is retained | Governed by |
|---------|---------------------------|-------------|
| Power BI connector | Power BI custom visual SDK requires TypeScript; no Rust binding | ADR-032 (ERP surface from detection) |
| npm/Node.js ecosystem shims | When `package.json` is present and `language-resolver` detects TypeScript with confidence ≥ 0.7 | D2 confidence threshold |
| Browser-side JavaScript SDK | WASM compilation is possible but not in scope for phase 5b scaffold | Deferred to a future ADR |

These surfaces are enumerated explicitly so the "TypeScript as fallback" clause cannot expand by drift.

### D5. Real Rust output depends on a working engine; without one, loud failure

When `resolvedLanguage.primary === 'rust'` and the backend resolver (ADR-112) returns `tier: 'none'` (no engine available):

- `decideScaffoldEmission` emits a loud-failure artifact `LANG-FAIL-001.md` in `<runDir>/phase5b/` with `Status: Failed`, `reason: "no-engine-available"`, and a clear message stating that Rust scaffold generation requires a working LLM engine (ruflo or `claude --print`), none of which was available.
- The run manifest records `phase5b: { status: "failed", reason: "no-engine-available", resolvedLanguage: "rust" }`.
- Exit code is non-zero.
- No TypeScript scaffold is emitted as a substitute. A TypeScript scaffold would satisfy the pipeline's file-emission criterion while completely misrepresenting the intended output language. This is the same substitution error that produced the reference run's hollow deliverables.

### D6. Retire hardcoded TypeScript scaffolds in `auto-chain.ts`

The approximately 30 embedded TypeScript scaffold strings in `auto-chain.ts:~5400` are removed. Scaffold generation is delegated to the engine (ruflo / `claude --print`) reading the SPARC/ADR/DDD artifacts, or to a small family of template files under `src/pipeline/scaffolds/` (one per enumerated language×domain family: `rust-domain.rs.tmpl`, `rust-api.rs.tmpl`, `ts-hono-server.ts.tmpl`, `python-fastapi.py.tmpl`). The templates carry `{{placeholder}}` markers that the engine fills; the engine does not generate scaffold structure from scratch.

This change reduces `auto-chain.ts` line count materially and eliminates the direct coupling between prototype output and the TypeScript ecosystem in the auto-chain.

---

## Alternatives Considered

### Alternative 1: Keep TypeScript as the default; Rust is opt-in via `--language rust` flag

Maintain the current TypeScript-default behaviour and require users to pass an explicit language flag for Rust output.

**Rejected because:**
- `language-resolver.ts` already establishes Rust as the default via `rust-default-preference`. This ADR enforces what the resolver already decided; rejecting this alternative means the resolver's decision is ignored by the gate — which is exactly the bug being fixed.
- The reference run's user did not pass a `--language` flag and received no Rust output. An opt-in flag would have produced the same empty result.
- Domain analysis shows the primary output of the pipeline (low-level service backends, ERP integration layers, simulation engines) is better served by Rust defaults than TypeScript defaults for users who have not expressed a preference.

### Alternative 2: Auto-detect the language from the `agentics ask` prompt text (regex / NLP)

Extract language keywords from the user's prompt string and use that as the primary signal.

**Rejected because:**
- This is already what `language-resolver.ts` does with dossier keywords — the prompt is part of the dossier. Adding a separate regex-based extractor in `auto-chain.ts` creates a third detection system (in addition to the two already conflicting).
- Prompt-text detection is less reliable than resolver signal aggregation; a user who writes "build a trading platform" without mentioning a language should get the same default as one who writes nothing.

### Alternative 3: Emit a TypeScript scaffold as a "compatibility bridge" when Rust is the target but the engine is unavailable

Generate a TypeScript prototype and label it as a bridge that will be replaced by Rust once the engine is available.

**Rejected because:**
- This is precisely the pattern that produced the reference run's hollow deliverables: something was emitted, it looked like a deliverable, but it was not the requested output. A TypeScript bridge that is never converted to Rust is indistinguishable, to the user, from a TypeScript output that was the intended result.
- ADR-PIPELINE-116 establishes that templates and surrogates must never be presented as real deliverables. A "compatibility bridge" is a surrogate.
- A loud failure artifact (D5) is honest; a surrogate TypeScript scaffold is not.

### Alternative 4: Complete the partial `rust-optimizer-generator.ts` rather than building a new workspace generator

Extend the existing single-file Rust generator to emit a full Cargo workspace.

**Accepted as the implementation vehicle:** D4 describes the workspace structure; `rust-optimizer-generator.ts` is the starting point for the implementation. The phrase "the `rust-optimizer-generator.ts` partial implementation is extended" in D4 reflects this. The alternative and the decision are aligned; what is rejected is the idea of stopping at the single-file scope of the existing generator.

---

## Consequences

### Benefits

1. **`phase5b_skipped: language-mismatch` is eliminated.** Every resolved language produces either a scaffold or a loud failure — no silent skips.
2. **Resolver authority is established.** One system decides the language; all downstream components read from it. The split-brain between `language-resolver.ts` and `detectProjectLanguage` is closed.
3. **Rust-first output aligns with the domain.** The pipeline targets compute-intensive backend services, ERP integrations, and simulation engines — workloads where Rust's performance and safety properties are appropriate.
4. **TypeScript fallback surfaces are enumerated.** The list of TypeScript-retained surfaces (D4 table) prevents silent drift back to TypeScript-everywhere; any new surface that claims TypeScript must be added to the enumeration explicitly.
5. **`auto-chain.ts` line count reduced** by removing ~30 hardcoded scaffold strings.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Rust scaffold generation requires a working engine; if engine fixes (ADR-112–114) are delayed, phase 5b always fails loudly | High (during transition) | Medium | Loud failure is the correct outcome (D5); users see an honest failure rather than a TypeScript surrogate. Engine fixes must precede Rust output in practice. |
| `Cargo.toml` workspace generation fails to compile cleanly when domain crate structure is engine-generated | Medium | Medium | The scaffold includes a `cargo check` validation step; compilation failures produce a `SCAFFOLD-WARN-001.md` alongside the output rather than silently emitting non-compiling code |
| Enumerated TypeScript surfaces (D4 table) are incomplete; a legitimate TypeScript surface is blocked | Low | Medium | The `language-resolver.ts` confidence threshold (≥ 0.7 for workspace-file signals) covers the major cases; the explicit `--language typescript` CLI flag overrides the resolver for any surface not in the table |
| Users with TypeScript projects see their existing `package.json` overridden by Rust default | Very low | High | `package.json` presence is a workspace-file signal with weight 0.9 → `primary: "typescript"` with confidence ≥ 0.85; the Rust default (confidence 0.4) cannot override it |
| Phase 5b loud failure (D5) is mistaken for an engine failure rather than a language-resolution success | Low | Low | `LANG-FAIL-001.md` clearly distinguishes `reason: "no-engine-available"` from `reason: "unsupported-language"`; the manifest records `resolvedLanguage.primary` so the language decision is visible separately from the engine failure |

### Performance Targets

| Metric | Target |
|--------|--------|
| `detectProjectLanguage` call sites in `src/pipeline/auto-chain.ts` | 0 (removed) |
| Language resolution paths reading from `resolvedLanguage.primary` | All phase 5b scaffold paths |
| `phase5b_skipped.reason: "language-mismatch"` occurrences in manifests | 0 |
| TypeScript scaffold emission for Rust-resolved runs | 0 |
| Cargo workspace compilation pass rate (engine-generated output, regression suite) | ≥ 80% `cargo check` clean |

---

## Related Decisions

- **ADR-PIPELINE-057** — Rust compute layer generation. Established Rust as a target language for compute-intensive surfaces; this ADR elevates it to the pipeline-wide default.
- **ADR-043** — Rust and multi-language support. The multi-language principle established there is enforced here by the resolver-driven dispatch with an explicit TypeScript-surface enumeration.
- **ADR-PIPELINE-112** — Model backend policy. Real Rust scaffold generation requires a working engine; this ADR's D5 defers to ADR-116 when no engine is available.
- **ADR-PIPELINE-113** — Ruflo resolution. Ruflo is the primary engine for generating Rust from SPARC/ADR/DDD artifacts.
- **ADR-PIPELINE-116** — Loud failure across all phases. D5 of this ADR delegates to ADR-116's failure protocol when phase 5b cannot produce real output.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-06-25 | Nick Ruest | Initial proposal — make language-resolver.ts authoritative, Rust default for unknown, extend decideScaffoldEmission with Rust branch, enumerate TypeScript-retained surfaces, retire hardcoded TS scaffolds |
