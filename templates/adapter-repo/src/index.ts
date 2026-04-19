/**
 * Adapter entry point (ADR-PIPELINE-081 §7).
 *
 * Supports both deployment modes:
 *  - Local mode: handlers imported as ESM, called in-process from
 *    agentics-cli/src/agents/local-agent-runner.ts.
 *  - Cloud Function mode: `adapterHandler` exported as the GCP Function entry;
 *    routes POST /agents/<agent-id> to the matching handler.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureUpstreamCommand, shutdown as shutdownBridge } from './mcp-bridge.js';
import type { AgentEnvelope } from './envelope.js';
import { buildErrorEnvelope } from './envelope.js';

// ============================================================================
// Initialize upstream command from bundle.json
// ============================================================================

function loadBundleManifest(): { upstream?: { mcp_command?: string }; agentics_domain?: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundlePath = join(here, '..', 'bundle.json');
  return JSON.parse(readFileSync(bundlePath, 'utf-8')) as { upstream?: { mcp_command?: string }; agentics_domain?: string };
}

const manifest = loadBundleManifest();
const adapterName = manifest.agentics_domain ?? 'adapter';

if (manifest.upstream?.mcp_command) {
  configureUpstreamCommand(manifest.upstream.mcp_command.split(/\s+/));
}

// ============================================================================
// Handler registry (populated by each handler file via registerHandler)
// ============================================================================

export type Handler = (body: HandlerRequest) => Promise<AgentEnvelope>;

export interface HandlerRequest {
  query: string;
  correlation_id: string;
  context?: Record<string, unknown>;
}

const handlers = new Map<string, Handler>();

export function registerHandler(agentId: string, handler: Handler): void {
  handlers.set(agentId, handler);
}

export function getHandler(agentId: string): Handler | undefined {
  return handlers.get(agentId);
}

// ============================================================================
// Auto-register handlers from ./handlers/*.ts
// ============================================================================

async function autoRegisterHandlers(): Promise<void> {
  const { readdirSync } = await import('node:fs');
  const here = dirname(fileURLToPath(import.meta.url));
  const handlersDir = join(here, 'handlers');
  const files = readdirSync(handlersDir)
    .filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_') && !f.endsWith('.test.ts') && !f.endsWith('.test.js'));
  for (const file of files) {
    await import(join(handlersDir, file));
  }
}

await autoRegisterHandlers();

// ============================================================================
// Cloud Function entry
// ============================================================================

interface CloudRequest {
  path?: string;
  body?: unknown;
}

interface CloudResponse {
  status: (code: number) => CloudResponse;
  json: (body: unknown) => void;
}

export async function adapterHandler(req: CloudRequest, res: CloudResponse): Promise<void> {
  const path = req.path ?? '';
  const match = /^\/agents\/([^/]+)\/?$/.exec(path);

  if (!match) {
    res.status(404).json({ error: 'not_found', path });
    return;
  }

  const agentId = match[1] ?? '';
  const handler = handlers.get(agentId);

  if (!handler) {
    res.status(404).json({ error: 'unknown_agent', agent: agentId });
    return;
  }

  const body = req.body as HandlerRequest | undefined;
  if (!body || typeof body.query !== 'string' || typeof body.correlation_id !== 'string') {
    res.status(400).json({ error: 'invalid_request_body' });
    return;
  }

  const started = new Date();
  try {
    const envelope = await handler(body);
    res.status(envelope.status).json(envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const envelope = buildErrorEnvelope(
      'UNHANDLED_HANDLER_ERROR',
      { details: msg },
      {
        correlationId: body.correlation_id,
        adapter: adapterName,
        upstreamTool: 'unknown',
        tier: 'advisory',
        startedAt: started,
      },
    );
    res.status(502).json(envelope);
  }
}

// ============================================================================
// Local mode cleanup
// ============================================================================

process.on('SIGTERM', () => { void shutdownBridge(); });
process.on('SIGINT', () => { void shutdownBridge(); });
