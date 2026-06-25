# ADR-PIPELINE-114: Harden the claude --print Synthesis Transport (Secondary Engine)

**Status:** Proposed
**Date:** 2026-06-25
**Authors:** Nick Ruest
**Priority:** CRITICAL — The `claude --print` transport used by the ADR generator (`runStreamedClaudePrint`, `src/pipeline/phase2/phases/adr-generator.ts:367`) passes the full synthesis prompt as a command-line argument, triggering ARG_MAX / E2BIG truncation on large inputs (100 KB+ prompts containing the full SPARC context, 67 dossier items, and the ADR exemplar). It then parses output using a per-run UUID delimiter that the model frequently drops, causing `parseMarkdownADRs` to return zero ADRs even when the response body is valid — the `ADR-FAIL-001` failure recorded in the reference run manifest. Concurrently, approximately four independent `claude` binary resolver implementations exist across the codebase, none of which is the hardened resolver already implemented in `src/runtime/claude-code-runner.ts`. This ADR routes all `claude --print` synthesis through one hardened runner.
**Builds on:** ADR-PIPELINE-100 (established `runStreamedClaudePrint` and the streaming subprocess pattern; this ADR hardens what ADR-100 introduced), ADR-PIPELINE-112 (model backend policy — `claude --print` is the tier-2 backend; this ADR specifies the hardened implementation), ADR-006 (claude-code synthesis runner — `src/runtime/claude-code-runner.ts` is the existing hardened runner this ADR designates as the canonical transport).

---

## Context

### How the current transport fails

`runStreamedClaudePrint` at `src/pipeline/phase2/phases/adr-generator.ts:367` invokes:

```typescript
const child = spawn(claudeBin, [
  '--print',
  '--output-format', 'text',
  '--no-stream',
  fullPrompt,          // ← the entire prompt string as a positional argument
], { env: { ...process.env, CLAUDECODE: '1', MCP_SERVER_MODE: '1' } });
```

**Problem 1: ARG_MAX / E2BIG risk from prompt-as-argument.**

On Linux, `ARG_MAX` is typically 2 097 152 bytes (2 MB). A single combined argument string is subject to this limit as part of the total `execve` argument vector. The full ADR synthesis prompt — SPARC specification (~20 KB), 67 dossier items (~40 KB), the ADR exemplar verbatim (~30 KB, per ADR-100 D1), and the instruction preamble (~5 KB) — totals approximately 95–120 KB. With additional env var bytes counted against `ARG_MAX`, the vector approaches the limit. On some environments (macOS with older kernel, Docker containers with stricter limits, or CI systems with `ARG_MAX` reduced to 512 KB) the `execve` call fails with `E2BIG`, which `spawn` surfaces as an `error` event on the child process rather than a structured error — it is indistinguishable from a binary-not-found failure without careful error code inspection.

**Problem 2: UUID delimiter drop causes zero-ADR parse.**

`runStreamedClaudePrint` sends the model a prompt containing:

```
Separate each ADR with exactly this string on its own line:
---DOC-BREAK-${uuid}---
```

The UUID is regenerated per run. The model frequently omits the delimiter (treating it as formatting noise), uses a slightly different string (`---DOC-BREAK---` without the UUID), or places it inline rather than on its own line. `parseMarkdownADRs` splits on the exact UUID-bearing delimiter; anything else produces a single unparsed string, which passes a minimum-length check but fails the ADR-structure test, returning zero ADRs. This is exactly `ADR-FAIL-001` in the reference run.

**Problem 3: `CLAUDECODE=1` and `MCP_SERVER_MODE=1` in the child environment.**

Empirical testing confirms that `claude --print` returns valid JSON with `--output-format json` even under `CLAUDECODE=1`. However, `MCP_SERVER_MODE=1` causes `claude` to enter MCP protocol mode and emit line-delimited JSON-RPC framing instead of the synthesis response, breaking the output parser. The current code sets both variables.

**Problem 4: Four independent binary resolvers.**

A codebase grep finds `claude` binary resolution in at least four locations:

| File | Mechanism | Issues |
|------|-----------|--------|
| `adr-generator.ts:~310` | `process.env.CLAUDE_CODE_BIN \|\| 'claude'` | Falls back to ambient PATH; no version check |
| `ruflo-phase-executor.ts:~180` | `which claude` via `execSync` | Separate PATH probe; not shared |
| `runtime/claude-code-runner.ts:~45` | Full multi-step resolver: local bin → which → absolute paths | Correct; not used by ADR path |
| `auto-chain.ts:~1240` | `child_process.execFileSync(claudeBin, ...)` with hardcoded fallback | Hardcoded `/usr/local/bin/claude` last resort |

Each resolver can return a different binary in edge cases. If one resolver finds a version of `claude` that does not support `--output-format json`, the JSON envelope unwrap fails. If another finds the wrong architecture binary in a universal binary directory, the subprocess crashes silently.

### The hardened runner already exists and is not used by the ADR path

`src/runtime/claude-code-runner.ts` implements:

- **Prompt via stdin** (~line 569): builds the prompt as a string and writes it to the subprocess's stdin with a final `\x04` (EOT) flush — no argument-length limit.
- **`--output-format json` with envelope unwrap** (~line 253): reads the JSON envelope `{ "type": "result", "result": "..." }` and extracts the inner string — no delimiter dependency.
- **`MCP_SERVER_MODE` deleted from child env** (~line 312): explicitly removes the variable before spawning.
- **Consolidated binary resolver**: one path, reused across all usages of the runner.

The ADR generator does not use this runner. The Phase 7 enrichment path (ADR-098) uses it. The split means ADR generation is on the fragile path; Phase 7 enrichment is on the hardened path. This ADR closes the gap.

---

## Decision

### D1. Route all `claude --print` synthesis through `src/runtime/claude-code-runner.ts`

`runStreamedClaudePrint` in `adr-generator.ts` is refactored to delegate to `ClaudeCodeRunner` from `src/runtime/claude-code-runner.ts` rather than spawning `claude` directly. The same delegation applies to any other phase that currently spawns `claude --print` directly (SPARC generator, DDD generator, prompt enrichment). All direct `spawn(claudeBin, ['--print', ...])` call sites outside `claude-code-runner.ts` are replaced with `ClaudeCodeRunner.generate(prompt, options)` or equivalent.

`claude-code-runner.ts` becomes the **single** place where `claude` is invoked for synthesis. Its internal binary resolver is the canonical resolver for `claude` across the codebase, just as `ruflo-resolver.ts` (ADR-113) is the canonical resolver for `ruflo`.

### D2. Prompt delivery via stdin, not argv

The synthesis prompt is written to the child process's stdin stream:

```typescript
// D2 canonical form — inside claude-code-runner.ts (existing pattern, ~line 569):
const child = spawn(resolvedClaudeBin, [
  '--print',
  '--output-format', 'json',
  '--no-stream',
], {
  env: childEnv,   // CLAUDECODE preserved if needed; MCP_SERVER_MODE deleted (D3)
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.write(fullPrompt, 'utf8');
child.stdin.end();
```

No prompt content appears in the argv array. This eliminates the ARG_MAX / E2BIG risk regardless of prompt length. The practical upper bound on stdin-delivered prompts is the OS pipe buffer (typically 64 KB per write, drained continuously) and the model's context window — not the kernel argument vector limit.

### D3. `--output-format json` with envelope unwrap; delete `MCP_SERVER_MODE` from child env

The output format is `json`, not `text`. The `claude --print --output-format json` response wraps the synthesis result in a JSON envelope:

```json
{
  "type": "result",
  "subtype": "success",
  "result": "<full markdown output here>",
  "session_id": "...",
  "cost_usd": 0.0034
}
```

The runner unwraps the `result` field and returns it as a plain string. This is already implemented in `claude-code-runner.ts:~253`. Adoption by the ADR path requires no new code — only rerouting the call.

The child environment preparation (`buildChildEnv` in the runner, ~line 290) explicitly deletes `MCP_SERVER_MODE`:

```typescript
const childEnv = { ...process.env };
delete childEnv.MCP_SERVER_MODE;
// CLAUDECODE: leave as-is (empirically harmless with --output-format json)
```

Empirical verification: `claude --print --output-format json` returns a valid JSON envelope under `CLAUDECODE=1`. `MCP_SERVER_MODE=1` changes the output format to line-delimited JSON-RPC, breaking envelope unwrap. Deleting it is correct.

### D4. Tolerant output parsing that does not depend on a per-run delimiter

`parseMarkdownADRs` is rewritten to be delimiter-independent. The new parser uses structural heuristics to segment the response into individual ADR documents:

1. **Primary split**: split on `\n# ADR-` (a top-level H1 heading starting with `ADR-`). Every ADR begins with this pattern per the template.
2. **Secondary validation**: each segment must contain `**Status:**` and `**Date:**` within its first 40 lines; segments that do not are joined with the previous segment (handles the case where a diagram or code block contains `# ADR-`-like text).
3. **Minimum length**: each segment must be ≥ 50 lines; shorter segments are accumulated rather than emitted as standalone ADRs.
4. **UUID delimiter as bonus**: if the per-run UUID delimiter is present, it is used as an additional split point. Its absence does not fail the parse.

This parser is robust to the model omitting, misquoting, or embedding the delimiter. The structural signal (`# ADR-` H1) is present in every well-formed ADR response and is not plausibly confused with diagram content (diagrams use backtick code blocks; H1 headings in code blocks are not treated as headings by the parser).

### D5. Consolidate `claude` binary resolvers — four paths become one

The four resolver implementations identified in Context are replaced by a single `resolveClaudeBinary()` function in `src/runtime/claude-code-runner.ts`:

```typescript
export interface ClaudeResolution {
  available: boolean;
  binaryPath: string | null;
  resolvedBy: 'env-override' | 'local-bin' | 'which' | 'absolute-path' | 'none';
  version: string | null;
  reason: string;
}

export async function resolveClaudeBinary(): Promise<ClaudeResolution>;
```

Resolution order:

| Step | Source | Notes |
|------|--------|-------|
| 0 | `CLAUDE_CODE_BIN` env var | Explicit user override |
| 1 | `./node_modules/.bin/claude` | Local install |
| 2 | Walk parent dirs for `node_modules/.bin/claude` | Monorepo hoisting |
| 3 | `which claude` with PATH augmentation (per ADR-113 D4 pattern) | Global install |
| 4 | `/usr/local/bin/claude`, `~/.claude/bin/claude`, `/opt/homebrew/bin/claude` | Absolute fallbacks |

The resolver validates the found binary by running `<path> --version` and checking that the output is semver-parseable. A binary that fails `--version` is skipped. The result is cached per run.

---

## Alternatives Considered

### Alternative 1: Increase the `execSync` argument buffer limit and keep the argv-based prompt

On Linux, the kernel argument limit can be increased (within bounds) via `ulimit -s unlimited`. On macOS it cannot be increased programmatically.

**Rejected because:**
- Not portable: the fix works on some Linux kernels and not at all on macOS or Docker containers with restricted namespaces.
- Addresses the symptom (argument length) not the mechanism: passing the prompt via stdin is strictly superior — it eliminates the limit entirely, is cross-platform, and matches the pattern already used in `claude-code-runner.ts`.
- Does not address the other three problems (delimiter, `MCP_SERVER_MODE`, resolver fragmentation).

### Alternative 2: Shorten the prompt to stay under ARG_MAX

Truncate the SPARC context, reduce the dossier to a summary, or omit the ADR exemplar from the argv-passed prompt.

**Rejected because:**
- The ADR exemplar is the structural bar (ADR-100 D1). Omitting it from the prompt degrades ADR quality, which is the root defect ADR-100 fixed.
- Truncating the dossier trades synthesis fidelity for transport convenience — the wrong trade.
- The correct fix (stdin delivery) has zero quality impact; this alternative sacrifices quality for no benefit.

### Alternative 3: Use a temporary file for prompt delivery

Write the prompt to a temp file and pass the file path as an argument (`claude --print < /tmp/prompt-<uuid>.txt` via shell).

**Rejected because:**
- Requires shell invocation (security surface: shell injection if the prompt contains backticks or `$`).
- Leaves temp files on disk if the process is killed mid-run.
- `claude --print` does not natively support reading from a file path argument — the `<` redirection requires a shell intermediary.
- Stdin delivery (D2) achieves the same goal without these problems.

### Alternative 4: Per-ADR LLM call (one subprocess per ADR) to avoid large combined prompts

Generate each ADR in a separate subprocess invocation, passing only the context relevant to that ADR.

**Considered, not adopted as primary:** this approach is discussed in ADR-100 Alternative 4 and was deferred. It remains a valid escalation if the single-call approach proves insufficient. The hardened transport (D2–D4) makes the single-call approach reliable; per-ADR calls are a quality escalation, not a transport-reliability fix.

### Alternative 5: Keep four separate binary resolvers but synchronise them

Add a shared config file that all four resolvers read.

**Rejected because:**
- Four resolvers reading a shared config is four resolvers with one extra file to keep in sync.
- `claude-code-runner.ts:resolveClaudeBinary()` already does the right thing. Making the other three import from it (D5) is a net reduction of code, not an increase.

---

## Consequences

### Benefits

1. **ARG_MAX / E2BIG risk eliminated.** The full synthesis prompt — exemplar, dossier, SPARC, instruction preamble — is delivered via stdin regardless of size.
2. **`ADR-FAIL-001` cascade prevented at source.** The delimiter-independent parser (D4) produces valid ADR segments even when the model omits the delimiter entirely.
3. **`MCP_SERVER_MODE` protocol hijack eliminated.** The hardened child environment (D3) prevents `claude` from entering MCP mode.
4. **Single canonical runner.** All `claude --print` synthesis uses one code path; a fix to the runner propagates to every generation phase simultaneously.
5. **Four resolvers collapsed to one.** No more divergent binary detection that can find different `claude` binaries in different phases of the same run.
6. **Cost visibility.** The JSON envelope returned by `--output-format json` includes `cost_usd`; the runner logs this per call, enabling per-phase cost attribution.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Existing callers of `runStreamedClaudePrint` do not propagate the refactor | Medium | Medium | Grep for all direct `spawn(claudeBin` call sites in `src/pipeline/`; replace each in the same PR as this ADR's implementation |
| The JSON envelope format changes in a future `claude` version | Low | Medium | `resolveClaudeBinary()` version-checks the binary; pin a minimum version that guarantees the envelope format; add an integration test that checks envelope structure |
| Tolerant parser (D4) splits on `# ADR-` inside a code block | Low | Low | Parser only splits on `\n# ADR-` at the start of a line outside of code fence blocks (triple-backtick detection); the secondary validation rejects segments that lack `**Status:**` |
| stdin delivery hangs if `claude` does not read stdin and the pipe buffer fills | Very low | High | The runner sets a 30-minute hard timeout with a 60-second idle-output bound (per ADR-100 D3 pattern); also attaches a stream drain listener |
| Consolidating resolvers breaks existing `CLAUDE_CODE_BIN` env var behaviour | Low | Low | Step 0 of `resolveClaudeBinary()` preserves the env-var override — existing behaviour retained |

### Performance Targets

| Metric | Target |
|--------|--------|
| `spawn(claudeBin, [...prompt...])` occurrences outside `claude-code-runner.ts` | 0 |
| `parseMarkdownADRs` zero-ADR rate on valid model responses in regression suite | < 1% |
| `claude` binary resolver implementations in `src/` | 1 (in `claude-code-runner.ts`) |
| Phase 4 end-to-end latency change from this ADR | Neutral (no extra round-trips; stdin delivery is not slower than argv) |

---

## Related Decisions

- **ADR-PIPELINE-100** — Established `runStreamedClaudePrint` and the streaming subprocess pattern. This ADR hardens the transport that ADR-100 introduced.
- **ADR-006** — Claude Code synthesis runner (`src/runtime/claude-code-runner.ts`). This ADR designates the existing runner as the canonical `claude --print` transport for all synthesis phases.
- **ADR-PIPELINE-112** — Model backend policy. `claude --print` is the tier-2 backend; this ADR specifies the hardened implementation of that tier.
- **ADR-PIPELINE-113** — Robust ruflo resolution. The resolver pattern for `claude` (D5) mirrors the pattern defined for `ruflo` there.
- **ADR-PIPELINE-116** — Loud failure across all phases. When the hardened transport returns zero usable content after exhausting retries, ADR-116's failure protocol applies.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-06-25 | Nick Ruest | Initial proposal — stdin delivery, JSON envelope, delimiter-independent parser, MCP_SERVER_MODE deletion, consolidate four resolvers into claude-code-runner.ts |
