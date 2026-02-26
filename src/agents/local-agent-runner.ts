/**
 * Local Agent Runner
 *
 * Executes agent prompts locally through the Claude Code CLI binary.
 * Uses the user's Claude Max subscription — no API keys needed.
 *
 * When AGENTICS_LOCAL_AGENTS is enabled, agent invocations bypass
 * Cloud Functions and run through `claude --print` instead.
 */

import { execFile } from 'node:child_process';
import { createClaudeCodeRunner } from '../runtime/claude-code-runner.js';
import { getLocalPrompt, hasLocalPrompt } from './system-prompts.js';
import type { AgentsInvokeResult } from '../commands/agents.js';

// ============================================================================
// Local Mode Detection
// ============================================================================

/**
 * Check if local agent execution mode is enabled.
 *
 * Priority:
 * 1. AGENTICS_LOCAL_AGENTS=true/false (explicit override)
 * 2. Auto-detect: enabled if `claude` binary is available
 */
export function isLocalAgentMode(): boolean {
  const envVal = process.env['AGENTICS_LOCAL_AGENTS'];
  if (envVal === 'true' || envVal === '1') return true;
  if (envVal === 'false' || envVal === '0') return false;

  // Auto-detect: check if claude binary is available
  try {
    const runner = createClaudeCodeRunner();
    runner.resolve();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific agent can be executed locally.
 */
export function canExecuteLocally(domain: string, agent: string): boolean {
  return isLocalAgentMode() && hasLocalPrompt(domain, agent);
}

// ============================================================================
// Local Execution
// ============================================================================

/**
 * Execute an agent locally through the Claude Code CLI binary.
 *
 * Builds a prompt combining the agent's system prompt with the user's query,
 * invokes `claude --print --output-format json`, and wraps the result in
 * the standard AgentsInvokeResult envelope.
 */
export function executeAgentLocally(
  domain: string,
  agent: string,
  userQuery: string,
  correlationId: string,
): AgentsInvokeResult {
  const start = Date.now();

  const systemPrompt = getLocalPrompt(domain, agent);
  if (!systemPrompt) {
    return {
      domain,
      agent,
      status: 404,
      response: { error: `No local prompt registered for ${domain}/${agent}` },
      timing: Date.now() - start,
    };
  }

  // Build the full prompt for Claude
  const fullPrompt = [
    `You are acting as the ${domain}/${agent} agent in the Agentics platform.`,
    '',
    `SYSTEM ROLE: ${systemPrompt}`,
    '',
    `USER QUERY: ${userQuery}`,
    '',
    'IMPORTANT: Respond with ONLY valid JSON. No markdown, no explanation, no code fences.',
    'The JSON must be a single object matching the output schema described in your system role.',
  ].join('\n');

  try {
    const runner = createClaudeCodeRunner();
    const result = runner.invoke<Record<string, unknown>>(fullPrompt, {
      runId: correlationId,
      schemaKey: undefined, // No contract validation for agent outputs
      timeoutMs: 120_000,
      verbose: process.env['AGENTICS_DEV'] === '1' || process.env['AGENTICS_DEV'] === 'true',
      correlationId,
    });

    // Wrap in standard envelope matching Cloud Function response format
    const envelope = {
      data: {
        result: result.data,
        execution_metadata: {
          trace_id: correlationId,
          agent: `${domain}/${agent}`,
          domain,
          timestamp: new Date().toISOString(),
          model: result.model,
          duration_ms: result.durationMs,
          mode: 'local',
        },
      },
      execution_metadata: {
        trace_id: correlationId,
        timestamp: new Date().toISOString(),
        service: `${domain}-agents-local`,
        execution_id: correlationId,
        mode: 'local',
      },
      layers_executed: [
        { layer: 'AGENT_ROUTING', status: 'completed' },
        { layer: `LOCAL_${domain.toUpperCase().replace(/-/g, '_')}_${agent.toUpperCase().replace(/-/g, '_')}`, status: 'completed', duration_ms: result.durationMs },
      ],
    };

    return {
      domain,
      agent,
      status: 200,
      response: envelope,
      timing: Date.now() - start,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      domain,
      agent,
      status: 502,
      response: {
        error: `Local agent execution failed: ${errMsg}`,
        execution_metadata: {
          trace_id: correlationId,
          mode: 'local',
          domain,
          agent,
        },
      },
      timing: Date.now() - start,
    };
  }
}

/**
 * Async version of executeAgentLocally that doesn't block the event loop.
 * Uses execFile (callback-based) wrapped in a Promise so parallel agent
 * dispatch via Promise.allSettled works correctly.
 */
export async function executeAgentLocallyAsync(
  domain: string,
  agent: string,
  userQuery: string,
  correlationId: string,
): Promise<AgentsInvokeResult> {
  const start = Date.now();

  const systemPrompt = getLocalPrompt(domain, agent);
  if (!systemPrompt) {
    return {
      domain,
      agent,
      status: 404,
      response: { error: `No local prompt registered for ${domain}/${agent}` },
      timing: Date.now() - start,
    };
  }

  const fullPrompt = [
    `You are acting as the ${domain}/${agent} agent in the Agentics platform.`,
    '',
    `SYSTEM ROLE: ${systemPrompt}`,
    '',
    `USER QUERY: ${userQuery}`,
    '',
    'IMPORTANT: Respond with ONLY valid JSON. No markdown, no explanation, no code fences.',
    'The JSON must be a single object matching the output schema described in your system role.',
  ].join('\n');

  try {
    const runner = createClaudeCodeRunner();
    const binary = runner.resolve();

    const childEnv: Record<string, string | undefined> = { ...process.env, CI: '1' };
    delete childEnv['CLAUDECODE'];
    delete childEnv['AGENTICS_DEV'];

    const raw = await new Promise<string>((resolve, reject) => {
      execFile(binary, [
        '--print', '--output-format', 'json', '--model', 'claude-sonnet-4-20250514', fullPrompt,
      ], {
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: childEnv as NodeJS.ProcessEnv,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    // Unwrap claude --output-format json envelope
    let resultText = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'result' && typeof parsed.result === 'string') {
        resultText = parsed.result;
      }
    } catch { /* use raw */ }

    // Try to parse as JSON
    let resultData: unknown;
    try { resultData = JSON.parse(resultText); } catch { resultData = { raw_response: resultText }; }

    return {
      domain,
      agent,
      status: 200,
      response: {
        data: resultData,
        execution_metadata: {
          trace_id: correlationId,
          timestamp: new Date().toISOString(),
          service: `${domain}-agents-local`,
          execution_id: correlationId,
          mode: 'local',
        },
        layers_executed: [
          { layer: 'AGENT_ROUTING', status: 'completed' },
          { layer: `LOCAL_${domain.toUpperCase().replace(/-/g, '_')}_${agent.toUpperCase().replace(/-/g, '_')}`, status: 'completed', duration_ms: Date.now() - start },
        ],
      },
      timing: Date.now() - start,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      domain,
      agent,
      status: 502,
      response: {
        error: `Local agent execution failed: ${errMsg}`,
        execution_metadata: { trace_id: correlationId, mode: 'local', domain, agent },
      },
      timing: Date.now() - start,
    };
  }
}

/**
 * Extract the user's query text from a payload object.
 * Handles various payload shapes used across agent domains.
 */
export function extractQueryFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');

  const p = payload as Record<string, unknown>;

  // Try common field names in priority order
  if (typeof p['text'] === 'string') return p['text'];
  if (typeof p['objective'] === 'string') return p['objective'];
  if (typeof p['input'] === 'string') return p['input'];
  if (typeof p['query'] === 'string') return p['query'];
  if (typeof p['description'] === 'string') return p['description'];

  // Nested shapes
  if (p['parameters'] && typeof p['parameters'] === 'object') {
    const params = p['parameters'] as Record<string, unknown>;
    if (typeof params['description'] === 'string') return params['description'];
  }

  // Fall back to JSON stringifying the payload
  return JSON.stringify(payload);
}
