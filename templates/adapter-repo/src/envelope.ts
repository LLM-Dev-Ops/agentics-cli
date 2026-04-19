/**
 * JSON envelope for agentics agent-runner contract (ADR-PIPELINE-081 §3 + §8).
 *
 * All adapter handler responses use this shape. Local mode and Cloud Function
 * mode MUST produce byte-identical envelopes for the same input, excluding the
 * varying `timing` and timestamp fields.
 */

export interface AgentEnvelope {
  status: 200 | 502;
  data: Record<string, unknown>;
  execution_metadata: {
    correlation_id: string;
    adapter: string;
    upstream_mcp_tool: string;
    tier: 'observational' | 'advisory' | 'gating';
    started_at: string;
    completed_at: string;
    upstream_code?: string;
  };
  timing: number;
}

export interface EnvelopeBuildOptions {
  correlationId: string;
  adapter: string;
  upstreamTool: string;
  tier: 'observational' | 'advisory' | 'gating';
  startedAt: Date;
}

export function buildSuccessEnvelope(
  data: Record<string, unknown>,
  options: EnvelopeBuildOptions,
): AgentEnvelope {
  const completedAt = new Date();
  return {
    status: 200,
    data,
    execution_metadata: {
      correlation_id: options.correlationId,
      adapter: options.adapter,
      upstream_mcp_tool: options.upstreamTool,
      tier: options.tier,
      started_at: options.startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
    },
    timing: completedAt.getTime() - options.startedAt.getTime(),
  };
}

export function buildErrorEnvelope(
  error: string,
  details: Record<string, unknown>,
  options: EnvelopeBuildOptions,
  upstreamCode?: string,
): AgentEnvelope {
  const completedAt = new Date();
  return {
    status: 502,
    data: { error, ...details },
    execution_metadata: {
      correlation_id: options.correlationId,
      adapter: options.adapter,
      upstream_mcp_tool: options.upstreamTool,
      tier: options.tier,
      started_at: options.startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
    },
    timing: completedAt.getTime() - options.startedAt.getTime(),
  };
}

/**
 * Compare two envelopes for byte-identity excluding timing/timestamp fields.
 * Used by the conformance suite to verify local vs. cloud mode produce
 * identical envelopes for the same input.
 */
export function envelopesStructurallyEqual(a: AgentEnvelope, b: AgentEnvelope): boolean {
  if (a.status !== b.status) return false;
  if (JSON.stringify(a.data) !== JSON.stringify(b.data)) return false;
  const aMeta = { ...a.execution_metadata, started_at: '', completed_at: '' };
  const bMeta = { ...b.execution_metadata, started_at: '', completed_at: '' };
  return JSON.stringify(aMeta) === JSON.stringify(bMeta);
}
