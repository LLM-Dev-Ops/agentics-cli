/**
 * Phase 3 Pipeline — Public API
 *
 * Transforms Phase 2 engineering packages into deterministic, runnable
 * domain-core implementations:
 *   - Language Resolution (Rust vs TypeScript)
 *   - Project Scaffold Generation
 *   - Domain Code Generation (aggregates, VOs, events, commands, queries, seams)
 *   - London School TDD Test Generation
 *   - Ruflo Stub Filling
 *
 * Usage:
 *   import { executePhase3Pipeline } from './pipeline/phase3/index.js';
 *   const result = await executePhase3Pipeline(context);
 */

export { executePhase3Pipeline } from './phase3-coordinator.js';

export type {
  Phase2Artifacts,
  ImplementationLanguage,
  LanguageSignal,
  LanguageResolution,
  ScaffoldFile,
  ScaffoldMetadata,
  CodegenFile,
  CodegenOutput,
  TestFile,
  TestGenOutput,
  RufloResult,
  Phase3Stage,
  Phase3StageOutput,
  Phase3Context,
  Phase3Manifest,
  Phase3ManifestArtifact,
  Phase3PipelineResult,
} from './types.js';
