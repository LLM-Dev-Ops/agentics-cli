/**
 * MCP subprocess bridge (ADR-PIPELINE-081 §4).
 *
 * Manages the upstream MCP server as a subprocess:
 *  - spawns on first use (lazy) or on adapter init (eager, for Cloud Function warm-up)
 *  - performs MCP handshake + tools/list
 *  - dispatches tools/call with correlation_id
 *  - restarts on unexpected subprocess exit (target: <2s recovery)
 *  - graceful shutdown via SIGTERM (5s grace) then SIGKILL
 *
 * This is a TEMPLATE — adopters customize UPSTREAM_COMMAND and any
 * upstream-specific handshake quirks. For simple upstreams the defaults
 * here should work unchanged.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isExcluded, ExcludedAgentError } from './excluded-agents.js';
import { withTierTimeout, type Tier } from './timeout.js';

/** Set from bundle.json.upstream.mcp_command at adapter init. Override per handler if needed. */
export let UPSTREAM_COMMAND: string[] = [];

export function configureUpstreamCommand(cmd: string[]): void {
  UPSTREAM_COMMAND = cmd;
}

// ============================================================================
// Subprocess state
// ============================================================================

interface McpProcess {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  stdoutBuffer: string;
  pendingById: Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  availableTools: Set<string>;
}

let current: McpProcess | null = null;

// ============================================================================
// Lifecycle
// ============================================================================

async function spawnUpstream(): Promise<McpProcess> {
  if (UPSTREAM_COMMAND.length === 0) {
    throw new Error('UPSTREAM_COMMAND not configured — call configureUpstreamCommand() at adapter init');
  }

  const [cmd, ...args] = UPSTREAM_COMMAND;
  if (!cmd) {
    throw new Error('UPSTREAM_COMMAND is empty');
  }

  const child = spawn(cmd, args, { stdio: 'pipe' });
  const state: McpProcess = {
    child,
    ready: Promise.resolve(),
    stdoutBuffer: '',
    pendingById: new Map(),
    nextId: 1,
    availableTools: new Set(),
  };

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => onStdout(state, chunk));
  child.on('exit', (code) => {
    for (const pending of state.pendingById.values()) {
      pending.reject(new Error(`MCP subprocess exited unexpectedly (code=${code})`));
    }
    state.pendingById.clear();
    if (current === state) current = null;
  });

  state.ready = handshake(state);
  return state;
}

function onStdout(state: McpProcess, chunk: string): void {
  state.stdoutBuffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = state.stdoutBuffer.indexOf('\n')) >= 0) {
    const line = state.stdoutBuffer.slice(0, newlineIdx).trim();
    state.stdoutBuffer = state.stdoutBuffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { id?: string | number; result?: unknown; error?: { message: string; code?: number } };
      if (msg.id !== undefined) {
        const pending = state.pendingById.get(msg.id);
        if (pending) {
          state.pendingById.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        }
      }
    } catch {
      // Non-JSON line — upstream diagnostics. Swallow.
    }
  }
}

async function handshake(state: McpProcess): Promise<void> {
  // MCP initialize method
  await sendRequest(state, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agentics-adapter', version: '0.1.0' },
  });

  // Discover tools
  const toolList = await sendRequest<{ tools?: Array<{ name: string }> }>(state, 'tools/list', {});
  for (const tool of toolList.tools ?? []) {
    state.availableTools.add(tool.name);
  }
}

function sendRequest<T = unknown>(state: McpProcess, method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = state.nextId++;
    state.pendingById.set(id, { resolve: (v) => resolve(v as T), reject });
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    state.child.stdin.write(payload + '\n');
  });
}

async function getOrSpawn(): Promise<McpProcess> {
  if (!current) {
    current = await spawnUpstream();
    await current.ready;
  } else {
    await current.ready;
  }
  return current;
}

// ============================================================================
// Public API
// ============================================================================

export interface ToolsCallOptions {
  tier: Tier;
  correlationId: string;
}

export interface ToolsCallResult {
  content: unknown;
  upstreamCode?: string;
}

/**
 * Dispatch a tools/call against the upstream MCP server with tier-specific
 * timeout. Runtime exclusion check happens first (defense-in-depth with
 * build-time validator).
 */
export async function toolsCall(
  upstreamTool: string,
  args: Record<string, unknown>,
  options: ToolsCallOptions,
): Promise<ToolsCallResult> {
  if (isExcluded(upstreamTool)) {
    throw new ExcludedAgentError(upstreamTool);
  }

  return withTierTimeout(options.tier, async (signal) => {
    const state = await getOrSpawn();

    if (!state.availableTools.has(upstreamTool)) {
      throw new Error(`Upstream tool "${upstreamTool}" not advertised by MCP server`);
    }

    const onAbort = () => {
      // Let the subprocess keep running; we just stop waiting.
      // The caller (withTierTimeout) will throw TIMEOUT_CAP_EXCEEDED.
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await sendRequest<{ content?: unknown }>(state, 'tools/call', {
        name: upstreamTool,
        arguments: { ...args, correlation_id: options.correlationId },
      });
      return { content: result.content };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  });
}

export async function shutdown(): Promise<void> {
  if (!current) return;
  const state = current;
  current = null;
  state.child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      state.child.kill('SIGKILL');
      resolve();
    }, 5000);
    state.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
