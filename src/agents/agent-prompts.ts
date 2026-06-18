/**
 * Per-Agent Sub-Prompt Loader + Run Context (agents/<domain>/<agent>/<agent>.md)
 *
 * Every one of the 109 dispatchable platform agents has a devoted folder under
 * the repo-root `agents/` tree and a hand-authored `<agent>.md` sub-prompt that
 * names the EXACT repo code / Cloud Run service that agent must execute, and
 * instructs it to (1) run that repo's real handler, (2) review the use case for
 * the current `agentics ask` run, and (3) review any outputs already produced by
 * earlier agents in the same run before acting.
 *
 * This module:
 *   - resolves and caches each `<agent>.md` (dev CWD + installed-package walk-up,
 *     mirroring src/pipeline/exemplars.ts),
 *   - keeps a process-scoped accumulator of prior agent outputs for the current
 *     run so later agents can review what earlier ones produced, and
 *   - composes the guidance block that the dispatcher prepends to the agent's
 *     payload text so the sub-prompt actually reaches the repo handler's
 *     `callClaude` prompt (ADR-PIPELINE-109 repo tier) and the cloud fallback.
 *
 * The `agents/` tree ships with the published package (see `files` in
 * package.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Domain → repo / Cloud Run service map (authoritative, mirrors
// src/agents/repo-agent-runner.ts FUNCTION_NAMES + src/config/endpoints.ts).
// Used to stamp the runtime guidance header so the agent is told — at execution
// time, not just in the .md — which code and service to run.
// ============================================================================

interface DomainExecutionTarget {
  /** Repo directory under ~/.agentics/repo-cache/ (and bundled-agents/). */
  readonly repoDir: string;
  /** Endpoint registry key in src/config/endpoints.ts. */
  readonly serviceName: string;
  /** Production Cloud Run base URL (default; overridable via env). */
  readonly cloudRunUrl: string;
}

export const DOMAIN_EXECUTION_TARGETS: Record<string, DomainExecutionTarget> = {
  'test-bench': { repoDir: 'test-bench', serviceName: 'test-bench-agents', cloudRunUrl: 'https://test-bench-agents-xx7kwyd5ra-uc.a.run.app' },
  'observatory': { repoDir: 'observatory', serviceName: 'observatory-agents', cloudRunUrl: 'https://observatory-agents-xx7kwyd5ra-uc.a.run.app' },
  'shield': { repoDir: 'shield', serviceName: 'shield-agents', cloudRunUrl: 'https://shield-agents-xx7kwyd5ra-uc.a.run.app' },
  'sentinel': { repoDir: 'sentinel', serviceName: 'sentinel-agents', cloudRunUrl: 'https://sentinel-agents-xx7kwyd5ra-uc.a.run.app' },
  'memory-graph': { repoDir: 'memory-graph', serviceName: 'memory-graph-agents', cloudRunUrl: 'https://memory-graph-agents-xx7kwyd5ra-uc.a.run.app' },
  'latency-lens': { repoDir: 'latency-lens', serviceName: 'latency-lens-agents', cloudRunUrl: 'https://latency-lens-agents-xx7kwyd5ra-uc.a.run.app' },
  'forge': { repoDir: 'forge', serviceName: 'forge-agents', cloudRunUrl: 'https://forge-agents-xx7kwyd5ra-uc.a.run.app' },
  'edge': { repoDir: 'edge-agent', serviceName: 'edge-agents', cloudRunUrl: 'https://edge-agents-xx7kwyd5ra-uc.a.run.app' },
  'auto-optimizer': { repoDir: 'auto-optimizer', serviceName: 'auto-optimizer-agents', cloudRunUrl: 'https://auto-optimizer-agents-xx7kwyd5ra-uc.a.run.app' },
  'incident-manager': { repoDir: 'incident-manager', serviceName: 'incident-manager-agents', cloudRunUrl: 'https://incident-manager-agents-xx7kwyd5ra-uc.a.run.app' },
  'orchestrator': { repoDir: 'orchestrator', serviceName: 'orchestrator-agents', cloudRunUrl: 'https://orchestrator-agents-xx7kwyd5ra-uc.a.run.app' },
  'costops': { repoDir: 'cost-ops', serviceName: 'costops-agents', cloudRunUrl: 'https://costops-agents-xx7kwyd5ra-uc.a.run.app' },
  'governance-dashboard': { repoDir: 'governance-dashboard', serviceName: 'governance-dashboard-agents', cloudRunUrl: 'https://governance-dashboard-agents-xx7kwyd5ra-uc.a.run.app' },
  'policy-engine': { repoDir: 'policy-engine', serviceName: 'policy-engine-agents', cloudRunUrl: 'https://policy-engine-agents-xx7kwyd5ra-uc.a.run.app' },
  'registry': { repoDir: 'registry', serviceName: 'registry-agents', cloudRunUrl: 'https://registry-agents-xx7kwyd5ra-uc.a.run.app' },
  'marketplace': { repoDir: 'marketplace', serviceName: 'marketplace-agents', cloudRunUrl: 'https://marketplace-agents-xx7kwyd5ra-uc.a.run.app' },
  'analytics-hub': { repoDir: 'analytics-hub', serviceName: 'analytics-hub-agents', cloudRunUrl: 'https://analytics-hub-agents-xx7kwyd5ra-uc.a.run.app' },
  'config-manager': { repoDir: 'config-manager', serviceName: 'config-manager-agents', cloudRunUrl: 'https://config-manager-agents-xx7kwyd5ra-uc.a.run.app' },
  'schema-registry': { repoDir: 'schema-registry', serviceName: 'schema-registry-agents', cloudRunUrl: 'https://schema-registry-agents-xx7kwyd5ra-uc.a.run.app' },
  'connector-hub': { repoDir: 'connector-hub', serviceName: 'connector-hub-agents', cloudRunUrl: 'https://us-central1-agentics-dev.cloudfunctions.net/connector-hub-agents' },
  'copilot': { repoDir: 'copilot-agent', serviceName: 'copilot-agents', cloudRunUrl: 'https://copilot-agents-xx7kwyd5ra-uc.a.run.app' },
  'simulator': { repoDir: 'simulator', serviceName: 'simulator-agents', cloudRunUrl: 'https://simulator-agents-xx7kwyd5ra-uc.a.run.app' },
  'benchmark-exchange': { repoDir: 'benchmark-exchange', serviceName: 'benchmark-exchange-agents', cloudRunUrl: 'https://benchmark-exchange-agents-xx7kwyd5ra-uc.a.run.app' },
  'inference-gateway': { repoDir: 'inference-gateway', serviceName: 'inference-gateway-agents', cloudRunUrl: 'https://inference-gateway-agents-xx7kwyd5ra-uc.a.run.app' },
  'data-vault': { repoDir: 'data-vault', serviceName: 'data-vault-agents', cloudRunUrl: 'https://data-vault-agents-xx7kwyd5ra-uc.a.run.app' },
  'research-lab': { repoDir: 'research-lab', serviceName: 'research-lab-agents', cloudRunUrl: 'https://research-lab-agents-xx7kwyd5ra-uc.a.run.app' },
  'platform': { repoDir: 'platform-agents', serviceName: 'platform-agents', cloudRunUrl: 'https://platform-agents-xx7kwyd5ra-uc.a.run.app' },
};

// ============================================================================
// Sub-prompt (.md) resolution + caching
// ============================================================================

/** Sanitize a domain/agent slug so it can only resolve inside the agents/ tree. */
function safeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9-]/gi, '');
}

/**
 * Candidate paths for an agent's `<agent>.md`, in priority order:
 *   1. <cwd>/agents/<domain>/<agent>/<agent>.md   (dev mode, repo root)
 *   2. walk up from this module's dir looking for agents/<domain>/<agent>/<agent>.md
 *      (installed mode — node_modules/@llm-dev-ops/agentics-cli/agents/...)
 */
function candidatePaths(domain: string, agent: string): string[] {
  const d = safeSlug(domain);
  const a = safeSlug(agent);
  const rel = path.join('agents', d, a, `${a}.md`);
  const out: string[] = [path.resolve(process.cwd(), rel)];

  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 10 && dir !== path.dirname(dir); i++) {
      out.push(path.join(dir, rel));
      dir = path.dirname(dir);
    }
  } catch {
    // import.meta.url unavailable in some test contexts; CWD candidate remains.
  }

  return out;
}

const _promptCache = new Map<string, string | null>();

/**
 * Load an agent's hand-authored sub-prompt body. Returns null (cached) when no
 * `.md` exists for the pair — callers degrade gracefully rather than throw,
 * since the sub-prompt augments execution but is not required for dispatch.
 */
export function loadAgentSubPrompt(domain: string, agent: string): string | null {
  const key = `${domain}/${agent}`;
  const cached = _promptCache.get(key);
  if (cached !== undefined) return cached;

  let body: string | null = null;
  for (const candidate of candidatePaths(domain, agent)) {
    try {
      if (fs.existsSync(candidate)) {
        body = fs.readFileSync(candidate, 'utf-8').trim();
        break;
      }
    } catch {
      // unreadable — try next candidate
    }
  }

  _promptCache.set(key, body);
  return body;
}

export function hasAgentSubPrompt(domain: string, agent: string): boolean {
  return loadAgentSubPrompt(domain, agent) !== null;
}

// ============================================================================
// Run-scoped prior-output accumulator
// ============================================================================

export interface PriorAgentOutput {
  readonly domain: string;
  readonly agent: string;
  readonly status: number;
  readonly tier?: string;
  /** Short, single-line digest of what the agent produced. */
  readonly summary: string;
}

const _priorOutputs: PriorAgentOutput[] = [];

/** Record an agent's result so later agents in the same run can review it. */
export function recordAgentOutput(output: PriorAgentOutput): void {
  // Cap the accumulator so a long run can't unbounded-grow the prompt context.
  if (_priorOutputs.length >= 200) _priorOutputs.shift();
  _priorOutputs.push(output);
}

/** All outputs already produced in the current process/run, oldest first. */
export function getPriorAgentOutputs(): readonly PriorAgentOutput[] {
  return _priorOutputs;
}

/** Clear the accumulator (call at the start of a fresh `agentics ask` run). */
export function resetAgentRunContext(): void {
  _priorOutputs.length = 0;
}

/** Build a one-line summary digest from an arbitrary agent response object. */
export function summarizeAgentResponse(response: unknown, max = 240): string {
  if (response == null) return '(no response)';
  try {
    const obj = typeof response === 'object' ? (response as Record<string, unknown>) : null;
    const data = obj && 'data' in obj ? obj['data'] : obj;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  } catch {
    return '(unserializable response)';
  }
}

// ============================================================================
// Guidance composition + payload injection
// ============================================================================

const GUIDANCE_OPEN = '<AGENT_EXECUTION_GUIDANCE';

export interface ComposeOptions {
  readonly domain: string;
  readonly agent: string;
  /** The user's objective for this `agentics ask` run. */
  readonly useCase: string;
  /** Outputs already produced earlier in this run (defaults to accumulator). */
  readonly priorOutputs?: readonly PriorAgentOutput[];
}

/**
 * Compose the guidance block prepended to the agent's payload text. Returns
 * null when the pair has no sub-prompt (nothing to inject).
 */
export function composeAgentExecutionContext(opts: ComposeOptions): string | null {
  const subPrompt = loadAgentSubPrompt(opts.domain, opts.agent);
  if (!subPrompt) return null;

  const target = DOMAIN_EXECUTION_TARGETS[opts.domain];
  const priors = opts.priorOutputs ?? getPriorAgentOutputs();
  const otherPriors = priors.filter((p) => !(p.domain === opts.domain && p.agent === opts.agent));

  const priorBlock = otherPriors.length
    ? otherPriors
        .map((p) => `- [${p.domain}/${p.agent}] (status ${p.status}${p.tier ? `, ${p.tier} tier` : ''}): ${p.summary}`)
        .join('\n')
    : 'None yet — you are among the first agents to execute in this run. Produce output later agents can build on.';

  const targetLine = target
    ? `Repo: \`${target.repoDir}\` · Cloud Run service: \`${target.serviceName}\` (${target.cloudRunUrl})`
    : `Domain \`${opts.domain}\` — execute its repo handler.`;

  return [
    `${GUIDANCE_OPEN} domain="${opts.domain}" agent="${opts.agent}">`,
    targetLine,
    '',
    subPrompt,
    '',
    '## USE CASE — the objective for this `agentics ask` run',
    opts.useCase.trim() || '(no explicit use case text provided)',
    '',
    '## PRIOR PIPELINE OUTPUTS — already produced in this run; review before acting',
    priorBlock,
    '</AGENT_EXECUTION_GUIDANCE>',
    '',
    '---',
    '',
  ].join('\n');
}

/** Fields, in priority order, that repo handlers turn into the Claude userMessage. */
const TEXT_FIELDS = ['text', 'objective', 'input', 'query', 'prompt'] as const;

/**
 * Prepend the guidance block to the payload so it reaches the repo handler's
 * `callClaude` prompt. Idempotent: skips payloads already carrying guidance.
 * Returns a new payload object (never mutates the input).
 */
export function injectGuidanceIntoPayload(
  payload: Record<string, unknown>,
  guidance: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };

  for (const field of TEXT_FIELDS) {
    const value = next[field];
    if (typeof value === 'string') {
      if (value.includes(GUIDANCE_OPEN)) return next; // already injected
      next[field] = `${guidance}${value}`;
      next['agent_execution_guidance'] = true;
      return next;
    }
  }

  // No text-bearing field: expose guidance as a discrete field so handlers /
  // the cloud tier can still surface it.
  if (typeof next['agent_execution_guidance_text'] !== 'string') {
    next['agent_execution_guidance_text'] = guidance;
    next['agent_execution_guidance'] = true;
  }
  return next;
}

const GUIDANCE_CLOSE = '</AGENT_EXECUTION_GUIDANCE>';

/** Extract the user's use-case text from an arbitrary domain payload. */
export function extractUseCase(payload: Record<string, unknown>): string {
  for (const field of TEXT_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim()) {
      // Strip any already-injected guidance block so the use case stays clean:
      // everything after the closing tag, minus the leading `---` separator.
      const closeIdx = value.indexOf(GUIDANCE_CLOSE);
      if (value.includes(GUIDANCE_OPEN) && closeIdx >= 0) {
        return value.slice(closeIdx + GUIDANCE_CLOSE.length).replace(/^\s*-{3,}\s*/, '').trim();
      }
      return value.trim();
    }
  }
  return '';
}
