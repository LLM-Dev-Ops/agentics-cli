/**
 * Runtime exclusion enforcement (ADR-PIPELINE-081 §6.2, defense-in-depth with
 * build-time validator).
 *
 * Populate EXCLUDED_UPSTREAM_AGENTS with upstream tool names that must never
 * be surfaced via this adapter — typically because they overlap with an
 * existing Agentics domain (ADR-082) or violate the ERP boundary (ADR-074).
 *
 * The exclusion list must be kept in sync with bundle.json.excluded_upstream_agents.
 */

export const EXCLUDED_UPSTREAM_AGENTS: ReadonlyArray<string> = [
  // Example for AQE per ADR-082:
  // 'Security-SAST',
  // 'Security-DAST',
  // 'SAP-Integration-Tester',
  // 'Data-Anonymizer',
  // ...
];

/**
 * Regex patterns matching upstream tool names that must not be exposed.
 * Catches newly-added upstream tools in an excluded category without
 * requiring an exact-name update.
 */
export const EXCLUDED_PATTERNS: ReadonlyArray<RegExp> = [
  // Example for AQE:
  // /^(Security-|SAP-|SOAP-|Privacy-)/,
];

export function isExcluded(upstreamTool: string): boolean {
  if (EXCLUDED_UPSTREAM_AGENTS.includes(upstreamTool)) return true;
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(upstreamTool));
}

export class ExcludedAgentError extends Error {
  readonly code = 'EXCLUDED_AGENT' as const;
  readonly upstream_tool: string;

  constructor(upstreamTool: string) {
    super(`Upstream tool "${upstreamTool}" is excluded from this adapter`);
    this.upstream_tool = upstreamTool;
    this.name = 'ExcludedAgentError';
  }
}
