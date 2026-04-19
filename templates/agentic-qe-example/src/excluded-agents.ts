/**
 * Runtime exclusion list for the agentic-qe adapter (ADR-PIPELINE-082 §3).
 *
 * Blocks upstream AQE tools that overlap with existing Agentics domains:
 *   - Security (SAST/DAST/compliance)         → Shield (safety domain)
 *   - Performance profiling                    → Latency-Lens (performance_profiling)
 *   - Enterprise integration (SAP/SOAP/etc.)   → connector-hub + ERP-Surface (ADR-074)
 *   - Data privacy / anonymization             → Data-Vault (data_security) + Shield
 *   - Cross-session learning                   → Memory-Graph (memory_context)
 *
 * The build-time validator (agentics-cli/scripts/validate-adapter-bundle.ts)
 * also reads bundle.json.excluded_upstream_agents for the same list — keep
 * the two in sync.
 */

export const EXCLUDED_UPSTREAM_AGENTS: ReadonlyArray<string> = [
  // Security — owned by Shield (safety)
  'Security-SAST',
  'Security-DAST',
  'Security-Compliance',
  'Security-Vulnerability-Scanner',

  // Performance profiling — owned by Latency-Lens
  'Performance-Profiler',
  'Latency-Analyzer',
  'Cold-Start-Monitor',

  // Enterprise integration — owned by connector-hub + ERP-Surface (ADR-074)
  'SAP-Integration-Tester',
  'SOAP-Validator',
  'Middleware-Tester',
  'OData-Validator',

  // Data privacy — owned by Data-Vault + Shield
  'Data-Anonymizer',
  'PII-Redactor',
  'Privacy-Auditor',

  // Cross-session learning — owned by Memory-Graph
  'AQE-Learning-Orchestrator',
  'Pattern-Memory-Agent',
] as const;

/**
 * Regex patterns catching newly-added upstream tools that match an excluded
 * category. The weekly upstream rebase surfaces these via the overlap-review
 * process (ADR-082 §5).
 */
export const EXCLUDED_PATTERNS: ReadonlyArray<RegExp> = [
  /^Security-/,
  /^SAP-/,
  /^SOAP-/,
  /^Privacy-/,
  /^Middleware-/,
];

export function isExcluded(upstreamTool: string): boolean {
  if (EXCLUDED_UPSTREAM_AGENTS.includes(upstreamTool)) return true;
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(upstreamTool));
}

export class ExcludedAgentError extends Error {
  readonly code = 'EXCLUDED_AGENT' as const;
  readonly upstream_tool: string;

  constructor(upstreamTool: string) {
    super(`Upstream tool "${upstreamTool}" is excluded by ADR-PIPELINE-082 — see agentic-qe exclusion list`);
    this.upstream_tool = upstreamTool;
    this.name = 'ExcludedAgentError';
  }
}
