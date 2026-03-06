# ADR-PIPELINE-015: Implementation Prompts Emitted in Codegen Output Directory

## Status
Implemented

## Context
ADR-004 added `buildContextImplementationPrompt()` to `domain-codegen.ts` which generates per-context implementation prompt markdown files at `project/prompts/{context}-implementation.md`. ADR-004 also updated `buildPhase5Tasks()` in `ruflo-phase-executor.ts` to create one Ruflo task per bounded context, referencing these prompt files.

However, in the `081f90a2` run (which predates the ADR-004 code changes), no `prompts/` directory exists in the codegen output. Even after ADR-004 is deployed, there is a potential issue: the `writeCodegenFiles()` function writes files relative to `context.phase3Dir`, but the Ruflo swarm reads from a different directory (`config.outputDir`). The prompt files must be written where the swarm can find them.

Additionally, the `buildPhase5Tasks()` per-context task descriptions reference `project/prompts/{context}-implementation.md` but the actual path may differ depending on the phase directory structure.

## Decision
Ensure implementation prompt files are reliably available to the Ruflo swarm:

1. **Write prompts to both locations**: Write per-context prompts to the codegen output dir (`phase3Dir/project/prompts/`) AND copy them to the Ruflo cache dir (`runDir/.ruflo-cache/phase5/prompts/`)
2. **Embed prompt content in task description**: Instead of referencing a file path, embed the first N bytes of the implementation prompt directly in the Ruflo task description so the swarm has the content even without file access
3. **Verify prompt file existence**: In `buildPhase5Tasks()`, check if prompt files exist on disk and fall back to reading the DDD model directly if they don't
4. **Write to `runDir/prompts/`**: Persist prompts in the run directory for debugging and future re-runs

## Files to Change
- `src/pipeline/phase3/phases/domain-codegen.ts` — ensure `generateDomainCode()` writes prompt files to the run directory in addition to the codegen output
- `src/pipeline/ruflo-phase-executor.ts` — in `buildPhase5Tasks()`, read prompt file content and embed it in the task description; add fallback when prompt files don't exist

## Consequences
- Ruflo swarm tasks contain the full implementation prompt in their description
- Prompt files are persisted in the run directory for traceability
- Per-context tasks work even if the file path is different from what was expected
- No dependency on specific directory layout between codegen and Ruflo execution
