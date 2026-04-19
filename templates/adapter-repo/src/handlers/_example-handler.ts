/**
 * Example handler — template for per-agent HTTP handlers.
 *
 * To use: copy this file to `<agent-id>.ts` and replace:
 *  - AGENT_ID (matches bundle.json.exposed_agents[] entry)
 *  - UPSTREAM_TOOL (the MCP tool name in the upstream server)
 *  - Validation schema for `body.query` if the agent expects structured input
 *
 * The file is prefixed with `_` so the auto-registrar skips it and the
 * bundle validator does not flag it as an orphan handler.
 */

import { registerHandler, type HandlerRequest } from '../index.js';
import { buildSuccessEnvelope, buildErrorEnvelope, type AgentEnvelope } from '../envelope.js';
import { toolsCall } from '../mcp-bridge.js';
import { tierOrDefault, isTimeoutError } from '../timeout.js';
import { ExcludedAgentError } from '../excluded-agents.js';

const AGENT_ID = 'example-agent';
export const UPSTREAM_TOOL = 'ExampleUpstreamTool';
const ADAPTER_NAME = 'adapter-template';

async function exampleHandler(body: HandlerRequest): Promise<AgentEnvelope> {
  const startedAt = new Date();
  const tier = tierOrDefault((body.context as { tier?: unknown } | undefined)?.tier);

  const envelopeOpts = {
    correlationId: body.correlation_id,
    adapter: ADAPTER_NAME,
    upstreamTool: UPSTREAM_TOOL,
    tier,
    startedAt,
  };

  try {
    const result = await toolsCall(UPSTREAM_TOOL, { query: body.query }, {
      tier,
      correlationId: body.correlation_id,
    });
    return buildSuccessEnvelope({ result: result.content }, envelopeOpts);
  } catch (err) {
    if (err instanceof ExcludedAgentError) {
      return buildErrorEnvelope('EXCLUDED_AGENT', { upstream_tool: err.upstream_tool }, envelopeOpts);
    }
    if (isTimeoutError(err)) {
      return buildErrorEnvelope('TIMEOUT_CAP_EXCEEDED', { tier: err.tier, cap_ms: err.cap_ms }, envelopeOpts);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return buildErrorEnvelope('UPSTREAM_ERROR', { details: msg }, envelopeOpts);
  }
}

registerHandler(AGENT_ID, exampleHandler);
