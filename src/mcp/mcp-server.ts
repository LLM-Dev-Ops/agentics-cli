#!/usr/bin/env node
/**
 * Agentics CLI — MCP Server (stdio transport)
 *
 * Exposes every CLI command + subcommand as an MCP tool so Claude Code
 * can call them directly, the same way claude-flow works.
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdin/stdout
 *
 * Tool inventory (51 tools across 13 domains):
 *
 *   Identity & Access   login, logout, whoami
 *   Simulation          simulate_create, simulate_run, simulate_list,
 *                       simulate_inspect, simulate_delete
 *   Planning            plan_create, plan_list, plan_inspect,
 *                       plan_approve, plan_delete
 *   Inspect             inspect_query, inspect_run, inspect_latest,
 *                       inspect_artifacts
 *   Usage & Billing     usage, usage_history, usage_limits, usage_reset
 *   ROI / Quantify      quantify_create, quantify_inspect, quantify_list,
 *                       quantify_compare
 *   Deployment          deploy_preview, deploy_run, deploy_status,
 *                       deploy_rollback
 *   Export              export_terraform, export_kubernetes, export_erp
 *   Policy              policy_list, policy_inspect, policy_create,
 *                       policy_edit, policy_delete, policy_enable,
 *                       policy_disable, policy_dry_run, policy_scope
 *   ERP Surface         erp_list, erp_inspect, erp_surface, erp_map,
 *                       erp_export
 *   Diligence           diligence
 *   Audit               audit
 *   Routing             ask, agents_invoke, agents_list
 *   Meta                version, help
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ADR-PIPELINE-102 §1: ESM-safe require shim. The package is "type": "module";
// bare require() throws ReferenceError at runtime.
const esmRequire = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
const VERSION = (() => {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string;
  } catch {
    return 'unknown';
  }
})();
const SESSION_ID = `agentics-mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;
const CLI_ENTRY = path.resolve(__dirname, '../cli/index.js');

// ---------------------------------------------------------------------------
// Logging (stderr only — stdout is reserved for JSON-RPC)
// ---------------------------------------------------------------------------

function log(level: string, msg: string): void {
  process.stderr.write(
    `[${new Date().toISOString()}] ${level} [agentics-mcp] (${SESSION_ID}) ${msg}\n`,
  );
}

log('INFO', 'Starting in stdio mode');
log('INFO', JSON.stringify({
  arch: process.arch,
  mode: 'mcp-stdio',
  nodeVersion: process.version,
  pid: process.pid,
  platform: process.platform,
  protocol: 'stdio',
  sessionId: SESSION_ID,
  version: VERSION,
}));

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const FORMAT_PROP = {
  format: { type: 'string' as const, enum: ['json', 'yaml'], description: 'Output format (default: json)' },
};
const VERBOSE_PROP = {
  verbose: { type: 'boolean' as const, description: 'Enable verbose output' },
};
const GLOBAL_OPTS = { ...FORMAT_PROP, ...VERBOSE_PROP };

function obj(
  properties: Record<string, unknown>,
  required?: string[],
): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required && required.length > 0) {
    schema['required'] = required;
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Tool definition type
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Pre-computed CLI args builder.  Receives tool arguments, returns string[]. */
  toArgs: (p: Record<string, unknown>) => string[];
}

// ---------------------------------------------------------------------------
// Helpers to build arg lists
// ---------------------------------------------------------------------------

function globalFlags(p: Record<string, unknown>): string[] {
  const a: string[] = [];
  if (p['format']) a.push('--format', String(p['format']));
  else a.push('--format', 'json');
  if (p['verbose']) a.push('--verbose');
  return a;
}

// ---------------------------------------------------------------------------
// === TOOL DEFINITIONS (48 tools) ==========================================
// ---------------------------------------------------------------------------

const TOOLS: ToolDef[] = [

  // ===================== ROUTING (PRIMARY ENTRY POINT) =====================

  {
    name: 'agentics-ask',
    description: 'Route any natural-language query to Agentics AI agents. Use this FIRST for tasks involving: security, testing, cost analysis, optimization, monitoring, deployment, policy, ERP, simulation, auditing, or observability. Returns Phase 1 agent results plus an AGENTICS_TRACE_ID. Per ADR-PIPELINE-088, Phases 2-6 (SPARC, ADR/DDD, TDD, ruflo build, ERP push) run in the background and typically complete in 30-60 minutes — poll `agentics-status` with the returned trace id to observe phase completion and retrieve artifact paths. After receiving the Phase 1 response, execute the FULL pipeline in this exact order: (1) RESEARCH — deep-dive into agent output, domain context, technology stack, regulatory requirements, and integration points, (2) ENTERPRISE SIMULATION — call agentics-simulate_create to model the scenario end-to-end with cost analysis, risk assessment, architecture, and implementation plan, (3) SPARC — execute all 5 phases: Specification (requirements + constraints), Pseudocode (modular algorithms with TDD anchors), Architecture (scalable system design), Refinement (iterate + optimize), Completion (integration + deployment readiness), (4) ADRs + DDD — create Architecture Decision Records for every significant technical choice, then model the domain using bounded contexts, aggregates, entities, value objects, and domain events with ubiquitous language, (5) HIGH-FIDELITY CODE — generate production-ready source code with full implementations (not stubs), TypeScript types, error handling, tests (TDD London School), configs, and deployment manifests, (6) PUSH TO ERP SURFACE — call agentics-erp_surface with the simulation ID to surface and register all ERP integration endpoints. Never stop at just showing agent JSON — always execute the full pipeline end to end.',
    inputSchema: obj({
      query: { type: 'string', description: 'Natural language query or task description to route to specialist agents' },
      ...GLOBAL_OPTS,
    }, ['query']),
    toArgs: (p) => ['ask', String(p['query']), ...globalFlags(p)],
  },
  {
    // ADR-PIPELINE-088 §4: companion tool to agentics-ask. Reports phase
    // completion of the background auto-chain subprocess started by the MCP
    // fast-return path. Takes the trace id emitted as AGENTICS_TRACE_ID.
    name: 'agentics-status',
    description: 'Check the status of a running or completed agentics-ask background pipeline (ADR-PIPELINE-088). Pass the AGENTICS_TRACE_ID returned by agentics-ask. Returns: current phase, liveness (running/done/crashed), artifact counts per type (adrs/ddd/sparc/tdd/prompts), log path, and error details if the pipeline failed.',
    inputSchema: obj({
      trace_id: { type: 'string', description: 'Trace id from agentics-ask (emitted as AGENTICS_TRACE_ID=...)' },
      ...GLOBAL_OPTS,
    }, ['trace_id']),
    toArgs: (p) => ['status', String(p['trace_id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-agents_invoke',
    description: 'Invoke a specific Agentics agent by domain and agent name. Use when you know exactly which agent to call. Domains: shield, test-bench, costops, observatory, sentinel, auto-optimizer, memory-graph, latency-lens, forge, edge, orchestrator, incident-manager, governance-dashboard, policy-engine, registry, marketplace, analytics-hub, connector-hub, copilot, simulator, data-vault, research-lab, platform.',
    inputSchema: obj({
      domain: { type: 'string', description: 'Agent domain (e.g. shield, test-bench, costops)' },
      agent: { type: 'string', description: 'Agent name within the domain (e.g. prompt-injection, benchmark, attribution)' },
      input: { type: 'string', description: 'JSON input for the agent (e.g. \'{"text":"analyze this"}\')' },
      ...GLOBAL_OPTS,
    }, ['domain', 'agent', 'input']),
    toArgs: (p) => ['agents', 'invoke', String(p['domain']), String(p['agent']), String(p['input']), ...globalFlags(p)],
  },
  {
    name: 'agentics-agents_list',
    description: 'List all available Agentics agents across all domains (27 domains, 109 agents).',
    inputSchema: obj({
      domain: { type: 'string', description: 'Filter by domain (optional)' },
      ...GLOBAL_OPTS,
    }),
    toArgs: (p) => {
      const a = ['agents', 'list'];
      if (p['domain']) a.push('--domain', String(p['domain']));
      return [...a, ...globalFlags(p)];
    },
  },

  // ===================== META =====================

  {
    name: 'agentics-version',
    description: 'Show the Agentics CLI version',
    inputSchema: obj({}),
    toArgs: () => ['version'],
  },
  {
    name: 'agentics-help',
    description: 'Show help for the Agentics CLI or a specific command',
    inputSchema: obj({
      command: { type: 'string', description: 'Command name to get help for' },
    }),
    toArgs: (p) => p['command'] ? ['help', String(p['command'])] : ['help'],
  },

  // ===================== IDENTITY & ACCESS =====================

  {
    name: 'agentics-login',
    description: 'Authenticate the CLI via browser-based auth or API key. No synthesis.',
    inputSchema: obj({
      api_key: { type: 'string', description: 'API key for non-interactive auth' },
    }),
    toArgs: (p) => {
      const a = ['login'];
      if (p['api_key']) a.push('--api-key', String(p['api_key']));
      return a;
    },
  },
  {
    name: 'agentics-logout',
    description: 'Clear local authentication state. No synthesis.',
    inputSchema: obj({}),
    toArgs: () => ['logout'],
  },
  {
    name: 'agentics-whoami',
    description: 'Show current identity, org, and role. No synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['whoami', ...globalFlags(p)],
  },

  // ===================== SIMULATION =====================

  {
    name: 'agentics-simulate_create',
    description: '[synth] Create a new simulation from a natural-language scenario description.',
    inputSchema: obj({
      description: { type: 'string', description: 'Natural language scenario description' },
      ...GLOBAL_OPTS,
    }, ['description']),
    toArgs: (p) => ['simulate', 'create', String(p['description']), ...globalFlags(p)],
  },
  {
    name: 'agentics-simulate_run',
    description: '[synth] Execute an existing simulation scenario. Incurs cost & risk analysis.',
    inputSchema: obj({
      scenario: { type: 'string', description: 'Scenario name or ID to run' },
      ...GLOBAL_OPTS,
    }, ['scenario']),
    toArgs: (p) => ['simulate', 'run', String(p['scenario']), ...globalFlags(p)],
  },
  {
    name: 'agentics-simulate_list',
    description: 'List all simulations. Read-only, no synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['simulate', 'list', ...globalFlags(p)],
  },
  {
    name: 'agentics-simulate_inspect',
    description: 'Inspect a simulation run by ID. Read-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Simulation run ID to inspect' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['simulate', 'inspect', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-simulate_delete',
    description: 'Delete a simulation scenario. Admin-only, no synthesis.',
    inputSchema: obj({
      scenario: { type: 'string', description: 'Scenario name or ID to delete' },
      ...GLOBAL_OPTS,
    }, ['scenario']),
    toArgs: (p) => ['simulate', 'delete', String(p['scenario']), ...globalFlags(p)],
  },

  // ===================== PLANNING =====================

  {
    name: 'agentics-plan_create',
    description: '[synth] Create a new deployment plan from a short natural-language description (max 256 characters).',
    inputSchema: obj({
      description: { type: 'string', description: 'Short plan description (max 256 characters). Be concise.' },
      ...GLOBAL_OPTS,
    }, ['description']),
    toArgs: (p) => ['plan', 'create', String(p['description']), ...globalFlags(p)],
  },
  {
    name: 'agentics-plan_list',
    description: 'List all plans. Read-only, no synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['plan', 'list', ...globalFlags(p)],
  },
  {
    name: 'agentics-plan_inspect',
    description: 'Inspect a plan by ID. Read-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to inspect' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['plan', 'inspect', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-plan_approve',
    description: '[synth] Approve a plan — explicit commitment. Critical decision-grade operation.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to approve' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['plan', 'approve', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-plan_delete',
    description: 'Delete a plan by ID. Admin-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to delete' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['plan', 'delete', String(p['id']), ...globalFlags(p)],
  },

  // ===================== INSPECTION & OBSERVABILITY =====================

  {
    name: 'agentics-inspect_query',
    description: 'Inspect a resource by natural-language query. Read-only, no synthesis.',
    inputSchema: obj({
      query: { type: 'string', description: 'Natural language query or resource reference' },
      ...GLOBAL_OPTS,
    }, ['query']),
    toArgs: (p) => ['inspect', String(p['query']), ...globalFlags(p)],
  },
  {
    name: 'agentics-inspect_run',
    description: 'Inspect a specific run by ID. Read-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Run ID to inspect' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['inspect', 'run', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-inspect_latest',
    description: 'Inspect the most recent run. Read-only, no synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['inspect', 'latest', ...globalFlags(p)],
  },
  {
    name: 'agentics-inspect_artifacts',
    description: 'List artifacts for a specific run. Read-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Run ID to list artifacts for' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['inspect', 'artifacts', String(p['id']), ...globalFlags(p)],
  },

  // ===================== USAGE & BILLING =====================

  {
    name: 'agentics-usage',
    description: 'Show current usage summary (tokens, costs, rate limits). No synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['usage', ...globalFlags(p)],
  },
  {
    name: 'agentics-usage_history',
    description: 'Show usage history over time. No synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['usage', 'history', ...globalFlags(p)],
  },
  {
    name: 'agentics-usage_limits',
    description: 'Show current usage limits and quotas. No synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['usage', 'limits', ...globalFlags(p)],
  },
  {
    name: 'agentics-usage_reset',
    description: 'Reset usage counters. No synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['usage', 'reset', ...globalFlags(p)],
  },

  // ===================== ROI & QUANTIFICATION =====================

  {
    name: 'agentics-quantify_create',
    description: '[synth] Create an ROI report from a natural-language scenario.',
    inputSchema: obj({
      description: { type: 'string', description: 'Natural language ROI scenario description' },
      ...GLOBAL_OPTS,
    }, ['description']),
    toArgs: (p) => ['quantify', 'create', String(p['description']), ...globalFlags(p)],
  },
  {
    name: 'agentics-quantify_inspect',
    description: 'Inspect an ROI report by ID. Read-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'ROI report ID to inspect' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['quantify', 'inspect', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-quantify_list',
    description: 'List all ROI reports. Read-only, no synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['quantify', 'list', ...globalFlags(p)],
  },
  {
    name: 'agentics-quantify_compare',
    description: '[synth] Compare two ROI reports — explicit tradeoff decision.',
    inputSchema: obj({
      id_a: { type: 'string', description: 'First ROI report ID' },
      id_b: { type: 'string', description: 'Second ROI report ID' },
      ...GLOBAL_OPTS,
    }, ['id_a', 'id_b']),
    toArgs: (p) => ['quantify', 'compare', String(p['id_a']), String(p['id_b']), ...globalFlags(p)],
  },

  // ===================== DEPLOYMENT =====================

  {
    name: 'agentics-deploy_preview',
    description: '[synth] Preview a deployment for a plan — risk analysis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to preview deployment for' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['deploy', 'preview', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-deploy_run',
    description: '[synth] Execute a deployment — irreversible commitment. Requires confirmation.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to deploy' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['deploy', 'run', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-deploy_status',
    description: 'Check deployment status by ID. Read-only, no synthesis.',
    inputSchema: obj({
      id: { type: 'string', description: 'Deployment ID to check status' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['deploy', 'status', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-deploy_rollback',
    description: '[synth] Rollback a deployment — incident-grade decision.',
    inputSchema: obj({
      id: { type: 'string', description: 'Deployment ID to rollback' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['deploy', 'rollback', String(p['id']), ...globalFlags(p)],
  },

  // ===================== EXPORT & INFRASTRUCTURE =====================

  {
    name: 'agentics-export_terraform',
    description: '[synth] Export deployment artifacts as Terraform IaC.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to export as Terraform' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['export', 'terraform', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-export_kubernetes',
    description: '[synth] Export deployment artifacts as Kubernetes manifests.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to export as Kubernetes' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['export', 'kubernetes', String(p['id']), ...globalFlags(p)],
  },
  {
    name: 'agentics-export_erp',
    description: '[synth] Export ERP integration artifacts for a plan.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to export ERP artifacts for' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['export', 'erp', String(p['id']), ...globalFlags(p)],
  },

  // ===================== GOVERNANCE & POLICY =====================

  {
    name: 'agentics-policy_list',
    description: 'List all governance policies. Read-only, no synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['policy', 'list', ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_inspect',
    description: 'Inspect a specific policy. Read-only, no synthesis.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to inspect' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'inspect', String(p['policy']), ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_create',
    description: '[synth] Create a new governance policy. Optionally provide a --name.',
    inputSchema: obj({
      description: { type: 'string', description: 'Natural language policy description' },
      name: { type: 'string', description: 'Policy name (e.g. "cost-cap-prod")' },
      ...GLOBAL_OPTS,
    }),
    toArgs: (p) => {
      const a = ['policy', 'create'];
      if (p['description']) a.push(String(p['description']));
      if (p['name']) a.push('--name', String(p['name']));
      return [...a, ...globalFlags(p)];
    },
  },
  {
    name: 'agentics-policy_edit',
    description: '[synth] Edit an existing governance policy.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to edit' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'edit', String(p['policy']), ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_delete',
    description: 'Delete a governance policy. Admin-only, no synthesis.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to delete' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'delete', String(p['policy']), ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_enable',
    description: '[synth] Enable a governance policy — critical operational decision.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to enable' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'enable', String(p['policy']), ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_disable',
    description: '[synth] Disable a governance policy.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to disable' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'disable', String(p['policy']), ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_dry_run',
    description: '[synth] Dry-run a policy to evaluate its impact without applying it.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to dry-run' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'dry-run', String(p['policy']), ...globalFlags(p)],
  },
  {
    name: 'agentics-policy_scope',
    description: 'Show the scope of a governance policy. Read-only, no synthesis.',
    inputSchema: obj({
      policy: { type: 'string', description: 'Policy name or ID to show scope for' },
      ...GLOBAL_OPTS,
    }, ['policy']),
    toArgs: (p) => ['policy', 'scope', String(p['policy']), ...globalFlags(p)],
  },

  // ===================== ERP SURFACE =====================

  {
    name: 'agentics-erp_list',
    description: 'List all connected ERP systems. Read-only, no synthesis.',
    inputSchema: obj({ ...GLOBAL_OPTS }),
    toArgs: (p) => ['erp', 'list', ...globalFlags(p)],
  },
  {
    name: 'agentics-erp_inspect',
    description: 'Inspect a specific ERP system. Read-only, no synthesis.',
    inputSchema: obj({
      system: { type: 'string', description: 'ERP system name or ID to inspect' },
      ...GLOBAL_OPTS,
    }, ['system']),
    toArgs: (p) => ['erp', 'inspect', String(p['system']), ...globalFlags(p)],
  },
  {
    name: 'agentics-erp_surface',
    description: '[synth] Surface ERP integration points for a plan. Requires a plan ID (positional) and optionally a simulation ID for lineage tracing.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID (UUID) — the plan to analyze for ERP integration' },
      simulation_id: { type: 'string', description: 'Simulation ID for lineage tracing (required by ADR-004)' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => {
      const a = ['erp', 'surface', String(p['id'])];
      if (p['simulation_id']) a.push('--simulation-id', String(p['simulation_id']));
      return [...a, ...globalFlags(p)];
    },
  },
  {
    name: 'agentics-erp_map',
    description: '[synth] Map a plan to ERP integration points — integration commitment. Requires simulation_id for lineage tracing (ADR-004).',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to map to ERP' },
      simulation_id: { type: 'string', description: 'Simulation ID for lineage tracing (required by ADR-004)' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => {
      const a = ['erp', 'map', String(p['id'])];
      if (p['simulation_id']) a.push('--simulation-id', String(p['simulation_id']));
      return [...a, ...globalFlags(p)];
    },
  },
  {
    name: 'agentics-erp_export',
    description: '[synth] Export ERP integration artifacts for a plan.',
    inputSchema: obj({
      id: { type: 'string', description: 'Plan ID to export ERP integration for' },
      ...GLOBAL_OPTS,
    }, ['id']),
    toArgs: (p) => ['erp', 'export', String(p['id']), ...globalFlags(p)],
  },

  // ===================== DILIGENCE =====================

  {
    name: 'agentics-diligence',
    description: '[synth] Run due diligence analysis on references.',
    inputSchema: obj({
      description: { type: 'string', description: 'Natural language description or references for due diligence' },
      ...GLOBAL_OPTS,
    }, ['description']),
    toArgs: (p) => ['diligence', String(p['description']), ...globalFlags(p)],
  },

  // ===================== AUDIT =====================

  {
    name: 'agentics-audit',
    description: '[synth] Run audit analysis on the current project or references.',
    inputSchema: obj({
      description: { type: 'string', description: 'Natural language description or references for audit' },
      ...GLOBAL_OPTS,
    }),
    toArgs: (p) => {
      const a = ['audit'];
      if (p['description']) a.push(String(p['description']));
      return [...a, ...globalFlags(p)];
    },
  },
];

// ---------------------------------------------------------------------------
// Tool lookup map
// ---------------------------------------------------------------------------

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

// ---------------------------------------------------------------------------
// CLI execution helper
// ---------------------------------------------------------------------------

/**
 * Send an MCP progress notification over stdout.
 * Claude Code displays these to the user while a tool call is running.
 */
function sendProgressNotification(progressToken: string | number, progress: number, total: number, message: string): void {
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      total,
      message,
    },
  };
  process.stdout.write(JSON.stringify(notification) + '\n');
}

// ADR-PIPELINE-090: stderr parsing + event rendering lives in
// src/mcp/agent-event-parser.ts so it's testable without importing this
// self-executing module. We import the shapes/functions here.
import { type AgentEvent, parseAgentEvent, formatAgentEventLive, formatAgentReport } from './agent-event-parser.js';

/**
 * Run a CLI command with streaming progress.
 * Uses spawn instead of execFile so output lines are sent as MCP progress
 * notifications in real-time rather than buffered until completion.
 *
 * ADR-PIPELINE-090: stderr lines are also parsed into AgentEvent[] which
 * gets returned alongside stdout/stderr so the tool handler can render a
 * structured "Agent Invocation Report" block in the final response.
 */
function runCLI(args: string[], progressToken?: string | number): Promise<{ stdout: string; stderr: string; code: number; events: AgentEvent[] }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_ENTRY, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', MCP_SERVER_MODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lineCount = 0;
    const events: AgentEvent[] = [];
    const parseState = { phase: 1 };  // Phase 1 is default until we see a header

    const processLine = (line: string) => {
      if (!line.trim()) return;
      lineCount++;

      const ev = parseAgentEvent(line, parseState);
      if (ev) {
        events.push(ev);
        if (progressToken != null) {
          sendProgressNotification(progressToken, lineCount, 0, formatAgentEventLive(ev));
        }
      }
    };

    let stdoutPartial = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      stdoutPartial += text;
      const lines = stdoutPartial.split('\n');
      stdoutPartial = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    let stderrPartial = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      stderrPartial += text;
      const lines = stderrPartial.split('\n');
      stderrPartial = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    // Timeout after 2 hours — pipeline with ruflo SPARC generation takes 1-2 hours
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + '\n[TIMEOUT] Process exceeded 2 hour limit', code: 1, events });
    }, 7_200_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      // Flush remaining partial lines
      if (stdoutPartial.trim()) processLine(stdoutPartial);
      if (stderrPartial.trim()) processLine(stderrPartial);
      resolve({ stdout, stderr, code: code ?? 0, events });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: 1, events });
    });
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// JSON-RPC message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  if (!msg.method) {
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: { code: -32600, message: 'Invalid Request: missing method' },
    };
  }

  const params = (msg.params ?? {}) as Record<string, unknown>;

  try {
    switch (msg.method) {
      // ---- Lifecycle ----
      case 'initialize': {
        // ADR-058: Capture client's project root from initialize params
        // Claude Code sends roots[] with the project directory
        const initParams = params as { roots?: Array<{ uri: string }> };
        if (initParams.roots && initParams.roots.length > 0) {
          const rootUri = initParams.roots[0]!.uri;
          // Convert file:// URI to path
          const rootPath = rootUri.startsWith('file://') ? decodeURIComponent(rootUri.slice(7)) : rootUri;
          if (rootPath && rootPath.startsWith('/')) {
            process.env['AGENTICS_PROJECT_ROOT'] = rootPath;
            log('INFO', `Client project root: ${rootPath}`);
          }
        }
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'agentics-cli', version: VERSION },
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
            },
          },
        };
      }

      case 'notifications/initialized':
        log('INFO', 'Client initialized');
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id: msg.id ?? null, result: {} };

      // ---- Prompts ----
      case 'prompts/list':
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            prompts: [
              {
                name: 'agentics-workflow',
                description: 'Full Agentics development workflow: research → SPARC → TDD → ADRs → DDD → production code',
                arguments: [
                  { name: 'task', description: 'The task or project to build', required: true },
                ],
              },
            ],
          },
        };

      case 'prompts/get': {
        const promptName = params['name'] as string;
        if (promptName === 'agentics-workflow') {
          const taskArg = ((params['arguments'] ?? {}) as Record<string, string>)['task'] ?? 'the requested system';
          return {
            jsonrpc: '2.0',
            id: msg.id ?? null,
            result: {
              description: 'Full Agentics development workflow',
              messages: [
                {
                  role: 'user',
                  content: {
                    type: 'text',
                    text: `Build: ${taskArg}\n\nFollow the full Agentics development pipeline in this exact order:\n\n1. RESEARCH — Use agentics-ask to route the query to specialist agents. Deep-dive into agent output for domain context, technology stack, regulatory requirements, and integration points.\n\n2. ENTERPRISE SIMULATION — Call agentics-simulate_create to model the full scenario end-to-end. This produces cost analysis, risk assessment, architecture recommendations, implementation timeline, and KPIs. Use the simulation ID for downstream steps.\n\n3. SPARC METHODOLOGY — Execute all 5 phases:\n   - Specification: Capture functional requirements, edge cases, constraints from research + simulation\n   - Pseudocode: Write modular pseudocode with TDD anchors\n   - Architecture: Design scalable, secure, modular architecture informed by simulation output\n   - Refinement: Iterate on design, optimize, address edge cases\n   - Completion: Final integration, documentation, deployment readiness\n\n4. ADRs + DDD —\n   - Architecture Decision Records: Create ADR documents for every significant technical decision. Format: Title, Status, Context, Decision, Consequences.\n   - Domain-Driven Design: Identify bounded contexts, aggregates, entities, value objects, and domain events. Define the ubiquitous language.\n\n5. HIGH-FIDELITY CODE — Generate production-ready code, not stubs or pseudocode:\n   - Full implementations with error handling\n   - TypeScript types/interfaces\n   - Tests written FIRST (TDD London School — failing test → minimal impl → refactor)\n   - Integration with specified platforms (SAP, GCP, etc.)\n   - Configuration and environment management\n   - Deployment manifests (Terraform/Kubernetes if applicable)\n\n6. PUSH TO ERP SURFACE — Call agentics-erp_surface with the simulation ID to surface and register all ERP integration endpoints.\n\nOutput structure:\n   - /docs/adrs/ — Architecture Decision Records\n   - /docs/ddd/ — Domain model documentation\n   - /src/ — Production source code\n   - /tests/ — Test suites\n   - /infrastructure/ — IaC and deployment configs`,
                  },
                },
              ],
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32601, message: `Prompt not found: ${promptName}` },
        };
      }

      // ---- Tools ----
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            tools: TOOLS.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case 'tools/call': {
        const toolName = params['name'] as string;
        const toolArgs = (params['arguments'] ?? {}) as Record<string, unknown>;

        const tool = TOOL_MAP.get(toolName);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id: msg.id ?? null,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          };
        }

        const cliArgs = tool.toArgs(toolArgs);
        log('INFO', `Calling CLI: agentics ${cliArgs.join(' ')}`);

        // Extract progressToken from MCP _meta if provided by client
        const meta = (params['_meta'] ?? {}) as Record<string, unknown>;
        const progressToken = meta['progressToken'] as string | number | undefined;

        // 2.5.3: immediate ack + heartbeat. The subprocess takes 5-15s of
        // cold-start before its first stderr line appears. Without an
        // immediate progress notification Claude Code's MCP client sees
        // pure silence and often decides the call is dead, reporting
        // "Tool result missing due to internal error." Ack now, then beat
        // every 5s while we're awaiting the subprocess so the client
        // keeps the connection alive.
        let heartbeat: NodeJS.Timeout | undefined;
        if (progressToken != null) {
          sendProgressNotification(progressToken, 0, 0, `Starting ${toolName}…`);
          let ticks = 0;
          heartbeat = setInterval(() => {
            ticks++;
            sendProgressNotification(progressToken, ticks, 0, `${toolName} still running (${ticks * 5}s elapsed)`);
          }, 5000);
          // Don't let the heartbeat block Node from exiting.
          heartbeat.unref?.();
        }

        let result;
        try {
          result = await runCLI(cliArgs, progressToken);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
        const output = result.stdout || result.stderr || '(no output)';

        const content: Array<{ type: string; text: string }> = [];

        if (toolName === 'agentics-ask') {
          // DO NOT put raw CLI output first — Claude Code reads the first block and stops.
          // The CLI output contains "Next step: drill into artifacts..." which Claude Code
          // treats as the deliverable. Instead, we put instructions FIRST and truncated
          // pipeline output SECOND.
          // Strip any "Next step" / "drill into" / "let me know" suggestions from CLI output
          // that would make Claude Code think it's done.
          const cleanedOutput = output
            .replace(/---[\s\S]*?Next step:[\s\S]*$/m, '') // Remove "Next step" section
            .replace(/If you'd like to[\s\S]*$/m, '')        // Remove "If you'd like" suggestions
            .replace(/let me know[\s\S]*$/im, '')            // Remove "let me know" endings
            .trim();
          // The auto-chain inside the CLI subprocess ran Phases 1-6 and
          // progressively copied planning artifacts to .agentics/plans/.
          // Tell Claude Code to READ those plans and generate code from them.
          // Do NOT tell it to re-run simulation, re-create plans, or re-do analysis.
          //
          // IMPORTANT: Only list artifacts that actually exist on disk.
          // The pipeline may have failed at certain phases.
          // Use client's project root (from MCP initialize) → git root → cwd (in that order)
          let repoRoot = process.env['AGENTICS_PROJECT_ROOT'] ?? '';
          if (!repoRoot) {
            try {
              repoRoot = esmRequire('node:child_process').execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', timeout: 3000 }).trim();
            } catch { /* fall through */ }
          }
          if (!repoRoot) repoRoot = process.cwd();
          const plansDir = path.join(repoRoot, '.agentics', 'plans');
          const artifactLines: string[] = [];
          const checkDir = (rel: string, desc: string) => {
            const full = path.join(plansDir, rel);
            try {
              const entries = existsSync(full) ? readdirSync(full) : [];
              if (entries.length > 0) artifactLines.push(`  .agentics/plans/${rel.padEnd(14)} — ${desc} (${entries.length} files)`);
            } catch { /* skip */ }
          };
          const checkFile = (rel: string, desc: string) => {
            if (existsSync(path.join(plansDir, rel))) artifactLines.push(`  .agentics/plans/${rel.padEnd(14)} — ${desc}`);
          };
          checkDir('sparc/', 'Architecture specification (read architecture.md first)');
          checkDir('adrs/', 'Architecture Decision Records');
          checkDir('ddd/', 'Domain model, context map, glossary');
          checkDir('tdd/', 'Test plan (London School TDD)');
          checkDir('prompts/', 'Implementation prompts and execution plan');
          checkFile('executive-summary.md', 'Executive summary');
          checkFile('decision-memo.md', 'Decision memo');
          checkFile('research-dossier.md', 'Research dossier');
          checkFile('research-dossier.json', 'Research dossier (JSON)');

          // Warn about missing critical artifacts
          const warnings: string[] = [];
          if (!existsSync(path.join(plansDir, 'adrs'))) {
            warnings.push('WARNING: ADRs were not generated — Phase 4 may have failed. Check pipeline output above.');
          }
          if (!existsSync(path.join(plansDir, 'ddd'))) {
            warnings.push('WARNING: DDD model was not generated — Phase 4 may have failed.');
          }

          // ADR-052: Implementation instructions MUST be the FIRST content block.
          // Claude Code reads the first block and acts on it. If planning output
          // comes first, it presents the plans as the deliverable and stops.
          content.unshift({
            type: 'text',
            text: [
              '╔══════════════════════════════════════════════════════════════════╗',
              '║  YOU MUST BUILD A WORKING PROTOTYPE — NOT JUST PRESENT PLANS   ║',
              '╚══════════════════════════════════════════════════════════════════╝',
              '',
              'The pipeline below generated planning artifacts. These are INPUTS.',
              'Your job is to BUILD a complete, working, tested prototype from them.',
              'Do NOT just read the plans and summarize them. WRITE CODE.',
              '',
              artifactLines.length > 0
                ? `Planning artifacts in .agentics/plans/:`
                : 'WARNING: No planning artifacts found.',
              ...artifactLines,
              ...warnings,
              '',
              'IMPLEMENTATION INSTRUCTIONS — follow these steps in order:',
              '',
              'STEP 1: Detect the implementation language.',
              '  Read .agentics/plans/sparc/architecture.md — it specifies the tech stack.',
              '  Check if the query mentions a specific language (Rust, Python, Go, Java, etc.).',
              '  If no language is specified, default to TypeScript.',
              '  Adapt ALL subsequent steps to the detected language.',
              '',
              'STEP 2: Read the implementation prompts (ordered build steps):',
              '  Read .agentics/plans/prompts/execution-plan.json for build order',
              '  Read each .agentics/plans/prompts/impl-*.md file in sequence',
              '  Each prompt specifies what to build, which ADRs govern it,',
              '  and mandatory cross-cutting requirements (logging, validation, error handling).',
              '',
              'STEP 3: Read architecture context:',
              '  .agentics/plans/adrs/ — Architecture Decision Records (design rationale)',
              '  .agentics/plans/sparc/architecture.md — System design',
              '  .agentics/plans/ddd/ — Domain model with bounded contexts',
              '',
              'STEP 4: Set up scaffold (adapt to detected language):',
              '  If TypeScript: copy .agentics/plans/scaffold/src/logger.ts, config.ts, errors.ts, middleware.ts',
              '  middleware.ts provides: correlationId middleware, requestLogger, metricsHandler, CircuitBreaker class',
              '  Wire into Express/Hono: app.use(correlationId); app.use(requestLogger); app.get("/metrics", metricsHandler);',
              '  If Python: create logger.py (structured JSON logging), config.py (env-based), errors.py (exception hierarchy)',
              '  If Rust: create src/logger.rs, src/config.rs, src/errors.rs with equivalent patterns',
              '  If Go: create internal/logger/logger.go, internal/config/config.go, internal/errors/errors.go',
              '  EVERY module must use the structured logger — never print/println/console.log.',
              '',
              'STEP 5: Create the project with language-appropriate tooling:',
              '  TypeScript: package.json + tsconfig.json + vitest/jest',
              '  Python: pyproject.toml + pytest + mypy',
              '  Rust: Cargo.toml + cargo test',
              '  Go: go.mod + go test',
              '  ADR-047 ARCHITECTURE RULES:',
              '  - Create a composition root (src/container.ts) that wires all services',
              '  - Every service receives deps via constructor — no module-level singletons',
              '  - Route handlers are THIN: validate → call service → respond (no business logic)',
              '',
              'STEP 6: Write domain types, service modules, ERP adapter, and demo script.',
              '  Follow the implementation prompts from Step 2.',
              '  ADR-046 CODE QUALITY RULES (9/10 target):',
              '  - Zod-parse ALL external data: request bodies, DB rows, ERP responses, config',
              '  - NEVER use `as SomeType` to cast external data — Zod-parse first',
              '  - ALL thresholds/weights/factors from config — ZERO hardcoded magic numbers',
              '  - Config validates with Zod at startup — refuse to start if invalid',
              '  - No Math.random() in production code — use crypto.randomUUID()',
              '  - Event bus handlers: wrap EACH in try/catch — one failure must not block others',
              '  ADR-050 ERP INTEGRATION:',
              '  - ERP adapter: retry (1s/2s/4s backoff), idempotency keys, circuit breaker',
              '  - Schema as code: src/erp/schema.ts mapping domain fields → ERP fields',
              '  - Check-before-write: query for existing record before creating',
              '  ADR-049 SIMULATION ALIGNMENT:',
              '  - Domain types (Decision, Recommendation, ERPTransaction) include simulationId/traceId fields',
              '  - Load simulationId from .agentics/plans/manifest.json at startup',
              '  - Demo output includes "Analysis Confidence" section explaining consensus level',
              '  ADR-052 EXECUTIVE OUTPUT:',
              '  - Demo MUST print "Business Case" section with: addressable value, annual savings,',
              '    implementation cost, ROI, payback — ALL derived from prototype seed data analysis',
              '  - Demo MUST print "Analysis Confidence" section (high/medium/low + explanation)',
              '  - Do NOT use generic per-employee heuristics — cite actual analysis results',
              '  - Every module uses structured logger and input validation',
              '',
              'STEP 7: Write tests first (TDD), then implementations. ALL tests must pass.',
              '',
              'STEP 8: Run the build + test + type-check pipeline for the detected language.',
              '',
              'CRITICAL — YOU MUST BUILD A WORKING PROTOTYPE:',
              '  The planning artifacts above are inputs, not the deliverable.',
              '  You MUST produce a complete, compilable project with:',
              '  - Structured logger module (JSON to stderr, correlation IDs)',
              '  - Configuration module (reads from environment variables)',
              '  - Typed error hierarchy',
              '  - Domain types',
              '  - Service modules with real business logic (scoring, comparison, recommendations)',
              '  - ERP adapter with approval workflow and SHA-256 hash-chained audit trail',
              '  - RBAC middleware (X-User-Role header) on approval endpoints',
              '  - Separation of duties: creator cannot approve own recommendation',
              '  - Audit chain verification endpoint (GET /api/audit/verify)',
              '  - Demo script showing the full end-to-end pipeline',
              '  - Tests — ALL passing',
              '  - Clean compilation / type check',
              '',
              '  If you only present the planning artifacts without building working code,',
              '  the evaluation scores Code Quality at 0/10. BUILD THE PROTOTYPE.',
              '',
              'CODE RULES (apply to ANY language):',
              '  - Do NOT use print/println/console.log — use the structured logger',
              '  - Do NOT put business logic in route/controller handlers — use a service layer',
              '  - Do NOT skip input validation — validate at every public boundary',
              '  - Do NOT re-run agentics-ask or launch background agents',
              '  - Write code directly and sequentially',
            ].join('\n'),
          });

          // ADR-PIPELINE-090: write the Agent Invocation Report as its own
          // content block so the user has a guaranteed record of which
          // agents were called and their outcome — even if the live
          // progress stream scrolled past or the UI didn't render every
          // notification. Parsed from the subprocess's stderr into
          // structured events by runCLI.
          const traceMatch = output.match(/AGENTICS_TRACE_ID=([^\s\n]+)/);
          const traceIdFromOutput = traceMatch ? traceMatch[1] : undefined;
          const agentReport = formatAgentReport(result.events, traceIdFromOutput);
          if (agentReport) {
            content.push({
              type: 'text',
              text: agentReport,
            });
          }

          // Add cleaned pipeline output AFTER instructions (for reference, not as primary directive)
          if (cleanedOutput.length > 50) {
            content.push({
              type: 'text',
              text: `--- Pipeline Summary (reference only — your task is to BUILD code from the plans above) ---\n${cleanedOutput.slice(0, 3000)}`,
            });
          }
        } else {
          // Non-ask tools: include full output
          content.push({ type: 'text', text: output.trim() });
        }

        // agentics-ask often exits non-zero due to agent fallbacks
        // but the pipeline itself succeeds — don't mark as error
        const isError = toolName === 'agentics-ask' ? false : result.code !== 0;

        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          result: {
            content,
            isError,
          },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
    }
  } catch (err) {
    log('ERROR', `${msg.method}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : 'Internal error',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;

  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message: JsonRpcMessage = JSON.parse(line);
      const response = await handleMessage(message);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch {
      log('ERROR', 'Failed to parse message');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  log('INFO', 'stdin closed, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('INFO', 'Received SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('INFO', 'Received SIGTERM');
  process.exit(0);
});
