# ADR-PIPELINE-002: Eliminate NLP-Based DDD Command Extraction

## Status
Implemented

## Context
The Phase 2 DDD model builder in `src/pipeline/phase2/phases/sparc-specification.ts` uses naive NLP parsing to extract bounded contexts, commands, and queries from the user's natural language prompt. It splits sentences into fragments and converts them directly into domain names, producing absurd results like:

- Command: `WithinEltekOstpointWithoutDisruptingOurCurrentProjectManagementProcesses`
- Command: `EarlyIndicatorsThatAProjectMayBeTrendingTowardCostOverrunsOrScheduleDelays`
- Context: `manually-periodic-project`
- Context: `suggest-risk-emerging`
- Event: `PatternsThatSuggestRiskIsEmergingFCertainThresholdsAreDetectedSucceeded`

These sentence fragments become file names, class names, interface names, route paths, and SQL table names — propagating garbage through the entire pipeline.

The Ruflo swarms and 110 agentics.dev agents are perfectly capable of reading the user's prompt and producing proper domain models. The NLP extraction is doing work the swarms should be doing.

## Decision
Remove the naive NLP sentence-fragment extraction. Replace it with a minimal structural scaffold that produces clean placeholder context names from detected nouns/entities only, while deferring real domain modeling to the Ruflo swarm + agentics agents.

Specifically:
1. Extract **only proper nouns and known domain terms** (ERP names, database names, cloud providers, business entities like "invoice", "project", "budget", "contract")
2. Never use sentence fragments longer than 3 words as a context or command name
3. For commands, use standard CRUD verbs: `Create`, `Update`, `Query`, `List`, `Get`, `Delete`
4. For integration contexts, use the pattern `{system}-integration` (e.g., `azure-integration`, `costpoint-integration`)
5. Include the full user prompt text in the DDD artifact so the Ruflo swarm can do proper domain extraction

## Files to Change
- `src/pipeline/phase2/phases/sparc-specification.ts` — the DDD extraction logic (command/context naming)
- Any helper that converts descriptions into kebab-case identifiers

## Consequences
- No more 80-character file names like `within-eltek-ostpoint-without-disrupting-our-current-project-management-processes.ts`
- Clean, predictable domain names: `project`, `budget`, `contract`, `invoice`, `milestone`, `costpoint-integration`
- Ruflo swarms + agentics agents still receive the full prompt text and can produce richer domain models
- The codegen layer produces compilable, navigable code
