/**
 * Synthesis module exports
 */
export {
  routeSynthesis,
  isDecisionGrade,
  getSynthesisClass,
  buildSynthesisPrompt,
} from './router.js';
export { createArtifactWriter, ArtifactWriter } from './artifact-writer.js';
export { PROMPT_TEMPLATES } from './prompts/index.js';
