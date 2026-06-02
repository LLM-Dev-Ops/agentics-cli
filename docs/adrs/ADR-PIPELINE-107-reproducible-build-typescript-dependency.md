# ADR-PIPELINE-107: Reproducible Build — TypeScript as an Installed Dependency

**Status:** Implemented (2026-06-02)
**Implementation summary:** D1 — `build`=`tsc -p tsconfig.json`, `typecheck`=`tsc --noEmit -p tsconfig.json`, `dev`=`tsc --watch -p tsconfig.json` (no `npx`); the surviving `npx tsc` in `scripts/validate_claude_flow_style.sh` was replaced with `npm run build`. D2 — `typescript` pinned to exact `5.9.3` in devDependencies and `package-lock.json`; CI uses `npm ci`. D3 — `postbuild` asserts `dist/cli/index.js` exists (exit 1 with a clear message if missing) before a Windows-tolerant `chmod +x`; verified by a negative test (empty build now exits 1). D4 — new `.github/workflows/build.yml` runs `npm ci → verify local tsc → typecheck → build → assert dist + smoke (`node dist/cli/index.js version`, exit 0)`. Optimization (beyond ADR scope, per implementation request): `incremental: true` + `tsBuildInfoFile` cut no-change rebuilds from ~8.1s to ~1.9s (~4.3×); `.tsbuildinfo` is gitignored, removed by `clean`, and excluded from the published package (publish/CI always build cold via `prepublishOnly`'s `clean`, so reproducibility is preserved). Caveat: a stale `.tsbuildinfo` on a developer machine can yield stale local `dist` after large branch switches — run `npm run clean` (CI/publish unaffected). Validated end-to-end locally + independent two-agent review (PASS / LOW risk). Known follow-up (out of scope): `.github/workflows/adapter-repo-contract.yml` still runs `npx tsc --noEmit` against an *external* adapter repo's tree.
**Date:** 2026-06-02
**Priority:** CRITICAL (blocks everything) — A clean checkout cannot be built. `npm run build` exits 0 while producing no `dist/`, so the CLI silently fails to compile and every downstream test/run is impossible until the developer discovers the trap manually. This was hit live on 2026-06-02 while attempting an end-to-end pipeline test.
**Scope:** Build tooling only. No runtime/pipeline behaviour changes.

---

## Context

`package.json` declares:

```json
"scripts": { "build": "npx tsc" },
"devDependencies": { "typescript": "^5.9.3" }
```

TypeScript is a declared devDependency but is **not present in `node_modules`** on a fresh `npm install` in this environment (e.g. `--omit=dev`, or a partially-populated `node_modules`). When `tsc` is absent locally, `npx tsc` does **not** error — it resolves `tsc` from the npm registry, finds an unrelated, deprecated package literally named `tsc@2.0.4`, installs it, and runs it. That package prints:

```
This is not the tsc command you are looking for
```

…and exits **0**. Observed live:

- `npm run build` → exit 0, no compiler errors, **no `dist/` produced**.
- `node dist/cli/index.js` → `Error: Cannot find module '.../dist/cli/index.js'`.

The failure is silent (exit 0) and misleading (a "successful" build that built nothing). The workaround that actually compiled cleanly was `npm install typescript@^5.9.3 && ./node_modules/.bin/tsc`.

Two independent defects compound here:
1. **`npx` as a build-tool resolver** silently reaches outside the project for a same-named package when the local bin is missing.
2. **`typescript` is not reliably installed**, so the local bin is missing in the first place.

## Decision

### D1. The build MUST invoke the project-local TypeScript, never `npx`

`package.json` `build` script changes from `npx tsc` to a project-local invocation that fails loudly if TypeScript is absent:

```json
"build": "tsc -p tsconfig.json",
"typecheck": "tsc --noEmit -p tsconfig.json"
```

When run via `npm run`, `npm` puts `node_modules/.bin` on `PATH`, so `tsc` resolves to the installed compiler and **errors** (non-zero) if it is missing — the opposite of `npx`'s reach-out-to-registry behaviour. No script in this repo may use `npx` to run a tool that is (or should be) a declared dependency.

### D2. TypeScript MUST be an installed, version-pinned dependency

Keep `typescript` in `devDependencies` but ensure it is actually installed in every build context:
- CI / release builds run `npm ci` (not `npm install --omit=dev`) so devDependencies are present.
- `prepublishOnly` (which already runs `clean && build && bundle-agents`) is the release guard; it must run in an environment where `npm ci` installed devDeps.

### D3. The build MUST verify its own output

Add a `postbuild` assertion so a no-op compile can never again masquerade as success:

```json
"postbuild": "test -f dist/cli/index.js && chmod +x dist/cli/index.js || (echo 'BUILD FAILED: dist/cli/index.js missing' && exit 1)"
```

(The existing `postbuild` already `chmod +x`'s the entrypoint; this ADR adds the existence assertion in front of it.)

### D4. CI gate

A CI job runs `npm ci && npm run build` on a clean tree and fails if `dist/cli/index.js` is absent — turning "clean checkout cannot build" into a red build instead of a silent runtime mystery.

## Consequences

### Positive
- A clean checkout builds, or fails loudly with a real compiler error — never the exit-0/empty-dist trap.
- Removes a class of "works on my machine" failures rooted in `npx` registry reach-out.

### Negative / Risks
- Contributors who relied on `--omit=dev` installs must now install devDeps to build (correct, but a workflow change).

### Neutral
- No runtime code changes; purely build hygiene.

## Alternatives Considered

1. **Pin `npx tsc` to a version (`npx -p typescript@5.9.3 tsc`).** Rejected: still reaches the registry on every build (slow, network-dependent) and still bypasses the project's installed compiler.
2. **Vendor a build wrapper script.** Rejected as overkill; `tsc -p` + a `postbuild` assertion is sufficient and idiomatic.

## Implementation (not yet built — Proposed)

- `package.json` — `build`/`typecheck`/`postbuild` scripts (D1, D3); confirm `typescript` pinned in devDependencies (D2).
- CI config — clean-build job (D4).
