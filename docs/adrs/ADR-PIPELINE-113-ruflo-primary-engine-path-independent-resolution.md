# ADR-PIPELINE-113: Ruflo as Primary Generation Engine with Robust, PATH-Independent Resolution

**Status:** Proposed
**Date:** 2026-06-25
**Authors:** Nick Ruest
**Priority:** CRITICAL — In the reference run `runtime.ruflo.available: false, reason: "binary-not-found"` caused ruflo — the designated primary engineering executor (ADR-PIPELINE-091) — to be skipped entirely, dropping `tier_counts["ruflo-local"]` to zero and allowing all three engineering phases to fall through to embedded templates. The root cause was a single `execSync('ruflo --version')` call at `src/pipeline/auto-chain.ts:2760` that tested the ambient PATH, which does not reflect the PATH available when `agentics` is spawned from inside Claude Code. The robust resolution logic already written in `src/pipeline/ruflo-phase-executor.ts:242` was not reused at the availability gate, producing a split-brain condition: the gate said ruflo was unavailable; the executor would have found it.
**Builds on:** ADR-PIPELINE-091 (Ruflo as primary — this ADR fixes the gate that systematically bypassed ADR-091's policy), ADR-PIPELINE-112 (model backend policy — ruflo is the tier-1 backend in the resolution chain defined there; this ADR specifies how tier-1 is resolved), ADR-PIPELINE-116 (loud failure — ruflo unavailability after robust resolution is a loud failure, not a silent template fall-through).

---

## Context

### The split-brain availability check

`src/pipeline/auto-chain.ts:2760` gates the entire ruflo execution path with:

```typescript
const rufloAvailable = (() => {
  try {
    execSync('ruflo --version', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
})();
```

This is a naive ambient-PATH probe. Three failure modes are known:

| Failure mode | Observed in reference run? | Mechanism |
|-------------|---------------------------|-----------|
| `ruflo` not on PATH when `agentics` is launched from Claude Code | Yes (`binary-not-found`) | Claude Code spawns `agentics` with a stripped PATH that omits `~/.nvm/current/bin`, Homebrew shims, and similar runtime-manager bins. `ruflo` v3.14.1 was installed and functional but not on the inherited PATH. |
| `ruflo` installed globally via npm but the local `.bin/ruflo` takes precedence | Latent | `npm install` in a project with ruflo as a devDependency puts `./node_modules/.bin/ruflo` ahead of the global; the global is what works; the local is a shell script that fails in environments without bash resolution. |
| `execSync` timeout race on slow I/O (network drives, Docker volume mounts) | Latent | 3 000 ms timeout is generous for a version print but inadequate on some CI filesystems. |

Simultaneously, `src/pipeline/ruflo-phase-executor.ts:242` implements `resolveRufloBinary()` — a robust multi-step resolver that tries (in order): local `node_modules/.bin/ruflo`, walks parent directories for a hoisted `node_modules/.bin`, runs `which ruflo`, and falls back to a hardcoded `npx ruflo`. This resolver is correct. It is used only when the gate at `auto-chain.ts:2760` has already returned `true` — so it never runs in the reference environment because the gate fires first and returns `false`.

The result is two independent detection paths that can and did disagree.

### PATH propagation in Claude Code child processes

When Claude Code invokes `agentics` (via Bash tool or a spawned subprocess), it inherits a shell environment initialised from the user's profile. However:

- Profile-sourced PATH modifications from `~/.nvm/nvm.sh`, `~/.rvm/scripts/rvm`, or similar runtime managers are not re-executed when Claude Code spawns a child process directly via `execve`. The PATH is whatever Claude Code's process inherited from its own parent, which is often a system launcher (launchd, systemd, GNOME Session) with a minimal PATH.
- `npx` resolves ruflo through the npm registry at runtime, so it works even with a stripped PATH — but `execSync('ruflo --version')` does not use npx.

The empirical verification confirms: running `claude --print` works fine in a clean environment (`CLAUDECODE=1` has no effect on its output); `ruflo` v3.14.1 was on PATH in a standalone shell but not in the Claude Code child-process PATH.

### The executor's resolver is already correct

`ruflo-phase-executor.ts:242` (`resolveRufloBinary`) performs:

1. Check `./node_modules/.bin/ruflo` relative to the process cwd.
2. Walk up the directory tree looking for `node_modules/.bin/ruflo` in each ancestor.
3. Run `which ruflo` (uses the current PATH but is not hard-blocked by the gate failure).
4. Fall back to `npx ruflo` with `--yes` to allow on-demand install.

This is exactly the right search order for a Node.js tool installed via npm. The fix is to promote this resolver to the gate, not to write a new one.

---

## Decision

### D1. Replace the naive `execSync('ruflo --version')` gate with the existing robust resolver

`src/pipeline/auto-chain.ts:2760` is updated to call the shared resolver (D3) instead of executing `ruflo --version` in the ambient PATH. The gate's return value changes from a boolean to the resolver's `RufloResolution` struct (D3), which carries the resolved binary path. All downstream callers that previously checked `rufloAvailable === true` now check `rufloResolution.available === true` and use `rufloResolution.binaryPath` directly — eliminating any further PATH lookup at execution time.

### D2. Extend the resolver with `npx ruflo` and absolute nvm-path fallbacks

The existing `resolveRufloBinary` at `ruflo-phase-executor.ts:242` is extended with two additional fallback steps inserted after step 3 (`which ruflo`) and before step 4 (`npx`):

| Step | Resolution attempt | Rationale |
|------|-------------------|-----------|
| 1 | `./node_modules/.bin/ruflo` (cwd) | Local devDependency — fastest |
| 2 | Walk parent dirs for `node_modules/.bin/ruflo` | Monorepo hoisted install |
| 3 | `which ruflo` | Global install on current PATH |
| 4 (new) | `$(nvm which current)/bin/ruflo` — evaluated via `nvm which current` if nvm is available | Covers the Claude Code PATH-stripping case for nvm users |
| 5 (new) | `~/.nvm/versions/node/$(ls ~/.nvm/versions/node | sort -V | tail -1)/bin/ruflo` — absolute path enumeration | Covers cases where `nvm` itself is not on PATH |
| 6 | `npx ruflo --version` (existence probe, not invocation) | Last resort; works with zero PATH setup; adds ~1s latency |

Steps 4 and 5 specifically address the Claude Code PATH-stripping scenario confirmed in the reference run. Steps 1–3 are unchanged from the existing implementation.

### D3. One shared resolution module used by both the gate and the executor

The resolver logic is extracted from `ruflo-phase-executor.ts` into a standalone module `src/pipeline/ruflo-resolver.ts` and exported as:

```typescript
export interface RufloResolution {
  available: boolean;
  binaryPath: string | null;     // resolved path, or null if unavailable
  resolvedBy: 'local-bin' | 'hoisted-bin' | 'which' | 'nvm-current' |
              'nvm-absolute' | 'npx' | 'none';
  version: string | null;        // from `<binaryPath> --version`, or null
  reason: string;                // logged in manifest on failure
}

export async function resolveRuflo(): Promise<RufloResolution>;
```

`resolveRuflo()` is called once during pipeline initialisation (alongside `resolveBackend()` from ADR-112). Its result is stored in `runtime.ruflo` in the run manifest and cached for the run lifetime. Neither the gate in `auto-chain.ts` nor the executor in `ruflo-phase-executor.ts` performs its own resolution — both read from the cached result.

The `ruflo-phase-executor.ts:242` (`resolveRufloBinary`) private implementation is replaced with a call to `resolveRuflo()` from the shared module.

### D4. Fix PATH propagation for ruflo in Claude Code child processes

When `agentics` is spawned by Claude Code (detected via `CLAUDECODE=1` or `TERM_PROGRAM=vscode` in the environment), the pipeline prepends known runtime-manager bin directories to the child-process PATH before invoking the resolver:

```typescript
const augmentedPath = [
  path.join(os.homedir(), '.nvm', 'current', 'bin'),
  path.join(os.homedir(), '.rvm', 'gems', 'default', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  process.env.PATH ?? '',
].join(path.delimiter);
```

This augmentation applies only to the resolver subprocess invocations (`which`, `npx`), not to the entire process environment. It is a targeted fix for the known PATH-stripping behaviour, not a broad environment mutation.

### D5. Cache the resolution result; bind ruflo's backend to Claude Code / Codex

Per ADR-PIPELINE-112 D2: ruflo is the tier-1 backend in the resolution chain. When ruflo is resolved and invoked, it MUST run with `--local-only` (or the equivalent flag in the resolved ruflo version) to prevent it from opening an independent raw API connection. If the resolved ruflo version does not support `--local-only`, ruflo is treated as unavailable for this run and the chain advances to tier 2 (`claude --print`).

The ruflo resolution result is persisted in `runtime.ruflo` in the run manifest:

```json
{
  "runtime": {
    "ruflo": {
      "available": true,
      "binaryPath": "/home/user/.nvm/versions/node/v20.11.0/bin/ruflo",
      "resolvedBy": "nvm-absolute",
      "version": "3.14.1",
      "reason": "resolved via nvm absolute path fallback"
    }
  }
}
```

### D6. Ruflo unavailability after robust resolution is a loud failure (per ADR-116)

If `resolveRuflo()` returns `available: false` after exhausting all six resolution steps, the pipeline MUST NOT silently fall through to embedded templates. Instead, it emits a per-phase loud-failure artifact (ADR-PIPELINE-116 pattern, extended from the ADR-FAIL model to SPARC/DDD/TDD/prompts/prototype). The run manifest records `engineering_tier: "failed"` (not `"template"`); the CLI exits with a non-zero status.

The only exception is an explicit `AGENTICS_DISABLE_RUFLO=true` flag, which causes the pipeline to skip tier 1 and advance directly to tier 2 (`claude --print`) without a loud failure — this flag is documented as a diagnostic/CI-bypass tool, not a production configuration.

---

## Alternatives Considered

### Alternative 1: Fix the ambient PATH before calling `execSync`

Prepend runtime-manager paths to `process.env.PATH` at `auto-chain.ts` startup, then keep the existing `execSync('ruflo --version')` gate.

**Rejected because:**
- PATH mutation at startup is a broad side-effect that affects all child-process invocations in the pipeline, not just ruflo detection.
- The augmented PATH may still miss ruflo if it was installed to a path not covered by the prepended list (e.g. a user-specific `~/.local/bin` or a custom npm prefix).
- It does not address the split-brain condition: the gate and the executor still use independent detection logic.
- The robust resolver already handles the enumeration problem correctly; the fix is to reuse it, not to patch the PATH.

### Alternative 2: Hardcode the ruflo binary path in a config file

Allow users to set `AGENTICS_RUFLO_PATH=/absolute/path/to/ruflo` and skip resolution entirely when the env var is set.

**Considered as a user escape hatch, retained but not the primary mechanism:**
- This is a valid operational convenience and is preserved: `AGENTICS_RUFLO_PATH` is checked as step 0 before the six-step resolver runs.
- It is not the primary mechanism because requiring users to set it defeats the "zero-config" intent of the CLI and does not fix the underlying resolution problem for users who have not set it.

### Alternative 3: Ship ruflo as a bundled binary inside the `agentics-cli` npm package

Bundle a platform-specific ruflo binary in `node_modules/@llm-dev-ops/agentics-cli/bin/ruflo-<platform>` and resolve it deterministically at runtime.

**Rejected because:**
- Bundling architecture-specific binaries in an npm package adds 10–50 MB to the install payload per platform and requires a native module release process.
- ruflo is an independent package with its own release lifecycle; coupling the two release cadences introduces version-skew risk.
- The robust resolver (D2, steps 1 and 2) already finds a locally installed ruflo when it is a `devDependency` of the project — the same effect without bundling.

### Alternative 4: Use `npx ruflo` as the primary invocation, not the last resort

Invoke ruflo via `npx` always, accepting the 1-2 second startup overhead.

**Rejected because:**
- `npx` performs a network check for the latest package version on each invocation unless the package is already installed. In air-gapped or low-bandwidth environments this fails.
- The overhead compounds: ruflo is invoked once per engineering phase, so 3 phases × 1-2s = 3-6 seconds of added latency per run just for resolution.
- Steps 1 and 2 (local `node_modules/.bin`) already handle the common case without network access. `npx` is the right last resort, not the primary path.

---

## Consequences

### Benefits

1. **ruflo is found in all standard installation configurations.** The six-step resolver covers local devDependency, monorepo hoisting, global install, nvm-current, nvm-absolute, and npx — the entire realistic surface.
2. **Split-brain condition eliminated.** One resolver module, one result, shared by gate and executor. If the gate says ruflo is available, the executor uses the same binary path.
3. **PATH stripping in Claude Code is handled automatically.** Steps 4 and 5 of the resolver specifically address the reference run's failure mode without requiring user configuration.
4. **Resolver result is auditable.** `runtime.ruflo.resolvedBy` in the manifest tells support and users exactly how ruflo was found (or why it was not).
5. **Template fall-through on ruflo failure is removed** (per D6 + ADR-116). A ruflo failure is visible immediately rather than silently producing boilerplate.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| nvm-absolute step enumerates the wrong node version (e.g. selects an old version's ruflo) | Low | Medium | Step 4 prefers `nvm which current` (exact current version); step 5 is a fallback using the latest installed version by semver sort |
| npx (step 6) installs the wrong ruflo version in a version-pinned monorepo | Low | Medium | `npx` resolves the version from the project's `package.json` engines field if present; add `ruflo` to `peerDependencies` with a version range |
| PATH augmentation (D4) produces security-sensitive PATH pollution | Low | Low | Augmentation is scoped to the resolver subprocess environment, not the global `process.env`; the prepended paths are well-known system directories |
| Resolution adds startup latency in environments where all steps fail before reaching the last | Low | Low | Steps 1–3 are synchronous filesystem checks taking < 5ms; only steps 5–6 involve subprocess invocations |
| `AGENTICS_RUFLO_PATH` env var is set to a stale path by users who upgraded ruflo | Low | Low | Resolver validates the binary by running `<path> --version`; a stale path that fails validation falls through to the six-step search |

### Performance Targets

| Metric | Target |
|--------|--------|
| Resolver latency when ruflo is on PATH (steps 1–3 sufficient) | < 20ms |
| Resolver latency when nvm fallback required (steps 4–5) | < 100ms |
| Resolver latency when npx required (step 6) | < 3 000ms |
| `runtime.ruflo.resolvedBy` in manifest | Required field |
| Occurrence of `execSync('ruflo --version')` outside `src/pipeline/ruflo-resolver.ts` | 0 (enforced by lint rule) |

---

## Related Decisions

- **ADR-PIPELINE-091** — Ruflo as primary engineering executor. This ADR provides the reliable detection mechanism without which ADR-091's policy cannot be enacted.
- **ADR-PIPELINE-112** — Model backend policy. Ruflo is the tier-1 backend in the ADR-112 resolution chain; this ADR specifies how tier-1 is resolved.
- **ADR-PIPELINE-114** — Harden `claude --print` transport. Tier-2 activation depends on ruflo being genuinely unavailable after the robust resolution defined here.
- **ADR-PIPELINE-116** — Loud failure across all phases. Ruflo unavailability after robust resolution triggers ADR-116's failure protocol.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-06-25 | Nick Ruest | Initial proposal — promote `ruflo-phase-executor.ts` resolver to the gate, extend with nvm fallbacks, introduce shared `ruflo-resolver.ts` module, fix PATH propagation for Claude Code spawn |
