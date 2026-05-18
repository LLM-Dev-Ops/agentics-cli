/**
 * Repo Agent Runner — Executes Cloud Function agent code locally
 *
 * Downloads and caches each Cloud Function's source code, replaces its
 * `callClaude()` with a local shim that uses `claude --print`, then
 * calls the repo's actual handler function.
 *
 * This means:
 * - The repo's real system prompts, validation, and logic run
 * - Claude Code (Claude Max) provides the AI backbone
 * - No Anthropic API key needed anywhere
 * - No Cloud Function calls needed
 */

import { execSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeRunner } from '../runtime/claude-code-runner.js';
import { executeAgentLocallyAsync } from './local-agent-runner.js';
import { getPlatformApiKey } from '../utils/credentials.js';
import type { AgentsInvokeResult } from '../commands/agents.js';

// ============================================================================
// Configuration
// ============================================================================

const CACHE_DIR = join(process.env['HOME'] ?? '/tmp', '.agentics', 'repo-cache');

/** Shared cache root for all platform repos (agents + git repos). */
export const REPO_CACHE_ROOT = CACHE_DIR;
const GCS_BUCKET = 'gcf-v2-sources-1062287243982-us-central1';

// Map of domain → repo directory name in ~/.agentics/repo-cache/
export const FUNCTION_NAMES: Record<string, string> = {
  // Layer 1: Agent Domains (1-26)
  'test-bench': 'test-bench',
  'observatory': 'observatory',
  'shield': 'shield',
  'sentinel': 'sentinel',
  'memory-graph': 'memory-graph',
  'latency-lens': 'latency-lens',
  'forge': 'forge',
  'edge': 'edge-agent',
  'auto-optimizer': 'auto-optimizer',
  'incident-manager': 'incident-manager',
  'orchestrator': 'orchestrator',
  'costops': 'cost-ops',
  'governance-dashboard': 'governance-dashboard',
  'policy-engine': 'policy-engine',
  'registry': 'registry',
  'marketplace': 'marketplace',
  'analytics-hub': 'analytics-hub',
  'config-manager': 'config-manager',
  'schema-registry': 'schema-registry',
  'connector-hub': 'connector-hub',
  'copilot': 'copilot-agent',
  'simulator': 'simulator',
  'benchmark-exchange': 'benchmark-exchange',
  'inference-gateway': 'inference-gateway',
  'data-vault': 'data-vault',
  'research-lab': 'research-lab',
  'platform': 'platform-agents',
  // Layer 3: Core Integration Bundles (27-34)
  'intelligence-core': 'intelligence-core',
  'security-core': 'security-core',
  'automation-core': 'automation-core',
  'governance-core': 'governance-core',
  'data-core': 'data-core',
  'ecosystem-core': 'ecosystem-core',
  'research-core': 'research-core',
  'interface-core': 'interface-core',
  // Layer 4: Platform Services
  'ruvector-service': 'ruvector-service',
  'enterprise-roi-engine': 'enterprise-roi-engine',
};

// Map of org repo name → npm bundled agent directory name.
// The bundle script renames repos to *-agents suffix for the npm package.
export const BUNDLE_NAMES: Record<string, string> = {
  'test-bench': 'test-bench-agents',
  'observatory': 'observatory-agents',
  'shield': 'shield-agents',
  'sentinel': 'sentinel-agents',
  'memory-graph': 'memory-graph-agents',
  'latency-lens': 'latency-lens-agents',
  'forge': 'forge-agents',
  'edge-agent': 'edge-agents',
  'auto-optimizer': 'auto-optimizer-agents',
  'incident-manager': 'incident-manager-agents',
  'orchestrator': 'orchestrator-agents',
  'cost-ops': 'costops-agents',
  'governance-dashboard': 'governance-dashboard-agents',
  'policy-engine': 'policy-engine-agents',
  'registry': 'registry-agents',
  'marketplace': 'marketplace-agents',
  'analytics-hub': 'analytics-hub-agents',
  'config-manager': 'config-manager-agents',
  'schema-registry': 'schema-registry-agents',
  'connector-hub': 'connector-hub-agents',
  'copilot-agent': 'copilot-agents',
  'simulator': 'simulator-agents',
  'benchmark-exchange': 'benchmark-exchange-agents',
  'inference-gateway': 'inference-gateway-agents',
  'data-vault': 'data-vault-agents',
  'research-lab': 'research-lab-agents',
  'platform-agents': 'platform-agents',
};

// ============================================================================
// Check if local repo mode is available
// ============================================================================

export function isRepoAgentMode(): boolean {
  const envVal = process.env['AGENTICS_LOCAL_AGENTS'];
  if (envVal === 'true' || envVal === '1') return true;
  if (envVal === 'false' || envVal === '0') return false;

  // Auto-detect: enabled if `claude` binary is available
  try {
    const runner = createClaudeCodeRunner();
    runner.resolve();
    return true;
  } catch {
    return false;
  }
}

export function hasRepoAgent(domain: string): boolean {
  return domain in FUNCTION_NAMES;
}

// ============================================================================
// Source Cache Management
// ============================================================================

function getCacheDir(functionName: string): string {
  return join(CACHE_DIR, functionName);
}

function isSourceCached(functionName: string): boolean {
  const dir = getCacheDir(functionName);
  // Check for any of the common entry points or handler directories.
  // Must include functions/ and agents/ because some repos (copilot-agent,
  // observatory, shield) use those as their primary directory structure
  // and don't have index.js/dist/lib/src at the root level.
  return (
    existsSync(join(dir, 'index.js')) ||
    existsSync(join(dir, 'dist')) ||
    existsSync(join(dir, 'lib')) ||
    existsSync(join(dir, 'src')) ||
    existsSync(join(dir, 'functions')) ||
    existsSync(join(dir, 'agents')) ||
    existsSync(join(dir, 'api'))
  );
}

// ============================================================================
// Bundled Agents — shipped inside the npm package at dist/bundled-agents/
// ============================================================================

const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bundled-agents');
const BUNDLE_VERSION_FILE = '.bundled-version';

function getBundledAgentDir(functionName: string): string {
  // Check bundle name mapping first (org name → npm bundled name)
  const bundleName = BUNDLE_NAMES[functionName] ?? functionName;
  const bundledDir = join(BUNDLED_AGENTS_DIR, bundleName);
  if (existsSync(bundledDir)) return bundledDir;
  // Fallback: try the raw functionName directly
  return join(BUNDLED_AGENTS_DIR, functionName);
}

function isBundled(functionName: string): boolean {
  const dir = getBundledAgentDir(functionName);
  return existsSync(dir) && (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'index.js')));
}

function getPackageVersion(): string | null {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function isCacheStale(cacheDir: string): boolean {
  const currentVersion = getPackageVersion();
  if (!currentVersion) return false;
  const versionFile = join(cacheDir, BUNDLE_VERSION_FILE);
  if (!existsSync(versionFile)) return false; // not provisioned from bundle, don't overwrite
  try {
    return readFileSync(versionFile, 'utf-8').trim() !== currentVersion;
  } catch {
    return true;
  }
}

function provisionFromBundle(functionName: string, cacheDir: string): void {
  const bundleSrc = getBundledAgentDir(functionName);
  mkdirSync(cacheDir, { recursive: true });
  cpSync(bundleSrc, cacheDir, { recursive: true, force: true });

  // Install npm dependencies if needed
  const pkgJson = join(cacheDir, 'package.json');
  const nodeModules = join(cacheDir, 'node_modules');
  if (existsSync(pkgJson) && !existsSync(nodeModules)) {
    const hasLockfile = existsSync(join(cacheDir, 'package-lock.json'));
    const installCmd = hasLockfile ? 'npm ci --production --silent' : 'npm install --production --silent';
    try {
      process.stderr.write(`[bundled-agents] Installing dependencies for ${functionName}...\n`);
      execSync(installCmd, { cwd: cacheDir, stdio: 'pipe', timeout: 120_000 });
    } catch {
      // Best-effort: some repos work without all deps
      process.stderr.write(`[bundled-agents] Warning: npm install incomplete for ${functionName}\n`);
    }
  }

  // Inject Claude shim
  injectClaudeShim(cacheDir);

  // Patch known handler issues (missing files, env fallbacks, etc.)
  patchKnownHandlerIssues(functionName, cacheDir);

  // Mark the version so we can detect stale caches on upgrade
  const version = getPackageVersion();
  if (version) {
    writeFileSync(join(cacheDir, BUNDLE_VERSION_FILE), version, 'utf-8');
  }
}

// ============================================================================
// Known Handler Issue Patches
// ============================================================================

/**
 * Fix known issues in agent handler repos that prevent local execution.
 * Called after provisioning (bundle or GCS download).
 */
function patchKnownHandlerIssues(functionName: string, repoDir: string): void {
  // simulator-agents: create missing schemas/validate.js
  if (functionName === 'simulator' || functionName === 'simulator-agents') {
    const schemasDir = join(repoDir, 'schemas');
    const validateFile = join(schemasDir, 'validate.js');
    if (!existsSync(validateFile)) {
      mkdirSync(schemasDir, { recursive: true });
      writeFileSync(validateFile, SIMULATOR_SCHEMAS_VALIDATE, 'utf-8');
    }
  }

  // policy-engine-agents: create tsconfig.json for @utils/* path aliases
  if (functionName === 'policy-engine' || functionName === 'policy-engine-agents') {
    const tsconfigFile = join(repoDir, 'tsconfig.json');
    if (!existsSync(tsconfigFile) && existsSync(join(repoDir, 'src'))) {
      writeFileSync(tsconfigFile, POLICY_ENGINE_TSCONFIG, 'utf-8');
    }

    // Make PolicyRepository.findActive() return synthetic policies on DB error
    // instead of throwing. The handler calls createAgentWithPolicies() which queries
    // PostgreSQL. Without a local DB, the throw propagates to buildExecutionResult
    // which emits EXECUTION_INVARIANT_ERROR. Returning realistic policies lets the
    // agent evaluate rules and produce meaningful enforcement decisions.
    const policyRepoFile = join(repoDir, 'dist', 'functions', 'db', 'models', 'policy-repository.js');
    if (existsSync(policyRepoFile)) {
      let prContent = readFileSync(policyRepoFile, 'utf-8');
      // Only patch if not already patched (marker comment prevents re-application)
      if (!prContent.includes('synthetic-policies-patched') && prContent.includes('throw new errors_1.DatabaseError("Failed to find active policies:')) {
        prContent = prContent.replace(
          /throw new errors_1\.DatabaseError\("Failed to find active policies:/g,
          `return [2 /*return*/, [
  {
    metadata: { id: 'policy-rate-limit', name: 'API Rate Limiting Policy', description: 'Enforces token and request rate limits per model tier', version: '1.0.0', namespace: 'org-simulation', tags: ['rate-limit', 'cost-control'], priority: 100 },
    rules: [
      { id: 'rule-max-tokens', name: 'Max Tokens Per Request', enabled: true, condition: { operator: 'gt', field: 'llm.maxTokens', value: 8192 }, action: { decision: 'deny', reason: 'Request exceeds maximum token limit of 8192' } },
      { id: 'rule-premium-model', name: 'Premium Model Access Control', enabled: true, condition: { operator: 'and', conditions: [{ operator: 'in', field: 'llm.model', value: ['claude-opus-4-20250514', 'gpt-4-turbo'] }, { operator: 'not_in', field: 'user.roles', value: ['admin', 'premium'] }] }, action: { decision: 'deny', reason: 'Premium model access requires admin or premium role' } }
    ],
    status: 'active'
  },
  {
    metadata: { id: 'policy-content-safety', name: 'Content Safety Policy', description: 'Monitors prompts for PII and sensitive content', version: '1.0.0', namespace: 'org-simulation', tags: ['safety', 'compliance'], priority: 90 },
    rules: [
      { id: 'rule-pii-warn', name: 'PII Detection Warning', enabled: true, condition: { operator: 'eq', field: 'llm.containsPII', value: true }, action: { decision: 'warn', reason: 'Prompt may contain personally identifiable information' } }
    ],
    status: 'active'
  },
  {
    metadata: { id: 'policy-budget-gate', name: 'Budget Gating Policy', description: 'Prevents requests when estimated cost exceeds threshold', version: '1.0.0', namespace: 'org-simulation', tags: ['budget', 'cost-control'], priority: 80 },
    rules: [
      { id: 'rule-cost-threshold', name: 'Cost Threshold Gate', enabled: true, condition: { operator: 'gt', field: 'llm.estimatedCost', value: 5.0 }, action: { decision: 'warn', reason: 'Estimated request cost exceeds $5.00 threshold', metadata: { threshold: 5.0, currency: 'USD' } } },
      { id: 'rule-production-audit', name: 'Production Environment Audit', enabled: true, condition: { operator: 'eq', field: 'project.environment', value: 'production' }, action: { decision: 'modify', reason: 'Production requests require audit logging', modifications: { audit_enabled: true, log_level: 'verbose' } } }
    ],
    status: 'active'
  }
]]; // synthetic-policies-patched`,
        );
        writeFileSync(policyRepoFile, prContent, 'utf-8');
      }
    }
  }

  // costops-agents: patch forecast/budget proxy handlers to return rule-based
  // fallback when CORE_API_URL is not configured (instead of 503 error)
  if (functionName === 'cost-ops' || functionName === 'costops-agents') {
    const distIndex = join(repoDir, 'dist', 'index.js');
    if (existsSync(distIndex)) {
      let content = readFileSync(distIndex, 'utf-8');
      // Replace the 503 error for forecast with a rule-based fallback
      content = content.replace(
        /if \(!CORE_API_URL\) \{\s*proxy\.status\(503\)\.json\(\{\s*success: false,\s*error: \{\s*code: "SERVICE_UNAVAILABLE",\s*message: "Cost forecasting backend not configured[^}]*\}\s*\}\);\s*return;\s*\}/g,
        `if (!CORE_API_URL) {
    const input = parseResult.data;
    const days = input.forecast_horizon_days || 30;
    const points = (input.historical_data || []).map(function(d, i) {
      return { date: d.timestamp, projected_cost: (d.total_cost || 0) * 1.05, confidence: 0.6 };
    });
    proxy.status(200).json({
      success: true,
      forecast: {
        horizon_days: days,
        method: "rule-based-fallback",
        projected_points: points.length ? points : [{ date: new Date().toISOString(), projected_cost: 0, confidence: 0 }],
        total_projected_cost: points.reduce(function(s, p) { return s + p.projected_cost; }, 0),
        trend: "stable",
        note: "Rule-based estimate (forecasting backend not configured)"
      }
    });
    return;
  }`
      );
      // Replace the 503 error for budget with a rule-based fallback
      content = content.replace(
        /if \(!CORE_API_URL\) \{\s*proxy\.status\(503\)\.json\(\{\s*success: false,\s*error: \{\s*code: "SERVICE_UNAVAILABLE",\s*message: "Budget enforcement backend not configured[^}]*\}\s*\}\);\s*return;\s*\}/g,
        `if (!CORE_API_URL) {
    proxy.status(200).json({
      success: true,
      budget: {
        status: "not_enforced",
        method: "rule-based-fallback",
        note: "Budget enforcement backend not configured (set CORE_API_URL)"
      }
    });
    return;
  }`
      );
      // Make ROI decision-event persistence non-blocking: wrap saveDecisionEvent
      // in a try-catch so ROI analysis results are returned even if ruvector is down
      content = content.replace(
        /if \(this\.config\.enableDecisionLogging\) \{\s*await this\.ruvectorClient\.saveDecisionEvent\(decisionEvent\);\s*\}/g,
        `if (this.config.enableDecisionLogging) {
        try { await this.ruvectorClient.saveDecisionEvent(decisionEvent); } catch (_e) { /* non-blocking */ }
      }`
      );
      writeFileSync(distIndex, content, 'utf-8');
    }
  }
}

/**
 * Minimal validation module for simulator-agents.
 * The Cloud Function repo expects schemas/validate.js with two validators.
 */
const SIMULATOR_SCHEMAS_VALIDATE = `'use strict';

function validateWhatIfRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }
  if (!body.input && !body.text && !body.query) {
    errors.push('Missing required field: input, text, or query');
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

function validateScenarioRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }
  if (!body.scenario_id && !body.input && !body.text && !body.query) {
    errors.push('Missing required field: scenario_id, input, text, or query');
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

module.exports = { validateWhatIfRequest, validateScenarioRequest };
`;

/**
 * Minimal tsconfig.json for policy-engine-agents.
 * Maps @utils/* path aliases so tsx can resolve them.
 */
const POLICY_ENGINE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    esModuleInterop: true,
    strict: true,
    outDir: './dist',
    rootDir: './src',
    baseUrl: './src',
    paths: {
      '@utils/*': ['./utils/*'],
      '@core/*': ['./core/*'],
      '@agents/*': ['./agents/*'],
      '@api/*': ['./api/*'],
      '@integrations/*': ['./integrations/*'],
      '@cache/*': ['./cache/*'],
    },
  },
  include: ['src/**/*'],
}, null, 2);

// ============================================================================
// GCS Source Download (fallback for development)
// ============================================================================

function downloadAndCacheSource(functionName: string): void {
  const cacheDir = getCacheDir(functionName);
  mkdirSync(cacheDir, { recursive: true });

  const zipPath = join(cacheDir, 'source.zip');

  // Try gsutil first
  try {
    execSync(
      `gsutil cp gs://${GCS_BUCKET}/${functionName}/function-source.zip ${zipPath}`,
      { stdio: 'pipe', timeout: 30_000 },
    );
  } catch {
    // Try with full path to gsutil
    try {
      const gsutil = '/home/codespace/google-cloud-sdk/bin/gsutil';
      execSync(
        `${gsutil} cp gs://${GCS_BUCKET}/${functionName}/function-source.zip ${zipPath}`,
        { stdio: 'pipe', timeout: 30_000 },
      );
    } catch {
      throw new Error(`Cannot download source for ${functionName}. Ensure gcloud auth is configured.`);
    }
  }

  // Unzip
  execSync(`unzip -oq ${zipPath} -d ${cacheDir}`, { stdio: 'pipe', timeout: 15_000 });

  // Inject the Claude shim — replace callClaude with local claude --print
  injectClaudeShim(cacheDir);

  // Patch known handler issues (missing files, env fallbacks, etc.)
  patchKnownHandlerIssues(functionName, cacheDir);
}

/**
 * Replace the repo's callClaude with our shim that uses `claude --print`.
 * Handles three locations:
 * 1. Separate claude.ts/claude.js files (platform-agents style)
 * 2. Inline callClaude in root index.js (simulator-agents style)
 * 3. lib/ or functions/dist/ variants
 */
function injectClaudeShim(repoDir: string): void {
  const shimContent = buildClaudeShimForRepo();

  // Write shim to all locations where claude.ts/claude.js might exist
  for (const subpath of [
    'src/claude.ts', 'src/claude.js', 'dist/claude.js',
    'lib/claude.js', 'functions/dist/claude.js',
  ]) {
    const target = join(repoDir, subpath);
    if (existsSync(target)) {
      writeFileSync(target, shimContent, 'utf-8');
    }
  }

  // Also create src/claude.ts if src/ exists but file doesn't
  const srcClaude = join(repoDir, 'src', 'claude.ts');
  if (!existsSync(srcClaude) && existsSync(join(repoDir, 'src'))) {
    writeFileSync(srcClaude, shimContent, 'utf-8');
  }

  // Patch inline callClaude in root index.js (simulator-agents pattern)
  const rootIndex = join(repoDir, 'index.js');
  if (existsSync(rootIndex)) {
    const content = readFileSync(rootIndex, 'utf-8');
    if (content.includes('function callClaude(') && content.includes('api.anthropic.com')) {
      // Replace the inline callClaude function body with our shim version
      const patched = content.replace(
        /function callClaude\(apiKey,\s*systemPrompt,\s*userPrompt\)\s*\{[\s\S]*?return new Promise[\s\S]*?\}\);[\s\n]*\}/,
        buildInlineCallClaudeShim(),
      );
      if (patched !== content) {
        writeFileSync(rootIndex, patched, 'utf-8');
      }
    }
  }

  // Install npm deps if missing
  const pkgJson = join(repoDir, 'package.json');
  if (existsSync(pkgJson) && !existsSync(join(repoDir, 'node_modules'))) {
    try {
      execSync('npm install --production --silent', {
        cwd: repoDir, stdio: 'pipe', timeout: 60_000,
      });
    } catch { /* deps install is best-effort */ }
  }
}

/**
 * Build an inline replacement for repos that define callClaude directly
 * in their index.js (returns a Promise like the original).
 */
function buildInlineCallClaudeShim(): string {
  return `function callClaude(apiKey, systemPrompt, userPrompt) {
  const { execFileSync } = require('child_process');
  function findBin() {
    for (const n of ['claude', 'claude-code']) {
      try { const r = execFileSync('which', [n], {encoding:'utf-8',timeout:5000}).trim(); if(r) return r; } catch {}
    }
    throw new Error('Claude Code binary not found');
  }
  return new Promise((resolve, reject) => {
    try {
      const binary = findBin();
      const prompt = systemPrompt + '\\n\\n' + userPrompt;
      const env = Object.assign({}, process.env, { CI: '1' });
      delete env.CLAUDECODE; delete env.AGENTICS_DEV;
      const tMs = process.env.AGENTICS_CHILD_PROCESS ? 8000 : 120000;
      const raw = execFileSync(binary, ['--print','--output-format','json','--model','claude-sonnet-4-20250514',prompt], {
        encoding:'utf-8', timeout:tMs, stdio:['pipe','pipe','pipe'], env, maxBuffer:10*1024*1024
      });
      try { const p = JSON.parse(raw); if(p.type==='result'&&typeof p.result==='string') return resolve(p.result); resolve(raw); } catch { resolve(raw); }
    } catch(e) { reject(e); }
  });
}`;
}

/**
 * Build a CommonJS-compatible claude shim that uses execFileSync
 * to call `claude --print` instead of the Anthropic HTTP API.
 */
function buildClaudeShimForRepo(): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callClaude = callClaude;
exports.extractJson = extractJson;

const { execFileSync } = require("child_process");

function findClaudeBinary() {
  for (const name of ["claude", "claude-code"]) {
    try {
      const result = execFileSync("which", [name], { encoding: "utf-8", timeout: 5000 }).trim();
      if (result) return result;
    } catch {}
  }
  throw new Error("Claude Code binary not found. Install: npm i -g @anthropic-ai/claude-code");
}

let _binary = null;
function getBinary() {
  if (!_binary) _binary = findClaudeBinary();
  return _binary;
}

async function callClaude(apiKey, systemPrompt, userMessage) {
  const binary = getBinary();
  const prompt = systemPrompt + "\\n\\n" + userMessage;
  const env = Object.assign({}, process.env, { CI: "1" });
  // Use short timeout when called from a child process (to avoid blocking the
  // child's event loop for 120s). The parent will kill us anyway at timeoutMs.
  const timeoutMs = process.env.AGENTICS_CHILD_PROCESS ? 8000 : 600000;
  delete env.CLAUDECODE;
  delete env.AGENTICS_DEV;

  const raw = execFileSync(binary, [
    "--print", "--output-format", "json", "--model", "claude-sonnet-4-20250514", prompt
  ], {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
    env: env,
    maxBuffer: 10 * 1024 * 1024,
  });

  // Unwrap claude --output-format json envelope
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type === "result" && typeof parsed.result === "string") {
      return parsed.result;
    }
    return raw;
  } catch {
    return raw;
  }
}

function extractJson(text) {
  const fenceMatch = text.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
  const startIdx = text.search(/[{[]/);
  if (startIdx >= 0) {
    const startChar = text[startIdx];
    const endChar = startChar === "{" ? "}" : "]";
    let depth = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === startChar) depth++;
      else if (text[i] === endChar) depth--;
      if (depth === 0) return JSON.parse(text.slice(startIdx, i + 1));
    }
  }
  return JSON.parse(text.trim());
}
`;
}

// ============================================================================
// Sub-directory Dependency Installation
// ============================================================================

/**
 * Some repos keep their Cloud Function handler in a subdirectory (e.g.
 * `functions/`, `agents/`, `api/`). That subdirectory has its own package.json
 * and needs its own node_modules. This function detects and installs deps for
 * the best handler entry point's containing directory.
 */
function ensureSubDirDeps(repoDir: string): void {
  // Map sub-directory entry points to their package.json directories.
  // Order matches the search priority in buildChildProcessScript.
  const subDirCandidates = [
    { handler: join('functions', 'dist', 'index.js'), pkgDir: 'functions' },
    { handler: join('functions', 'src', 'index.ts'), pkgDir: 'functions' },
    { handler: join('functions', 'index.ts'), pkgDir: 'functions' },
    { handler: join('agents', 'functions', 'index.ts'), pkgDir: join('agents') },
    { handler: join('agents', 'src', 'functions', 'index.ts'), pkgDir: 'agents' },
    { handler: join('api', 'src', 'functions', 'handler.ts'), pkgDir: 'api' },
  ];

  for (const { handler, pkgDir } of subDirCandidates) {
    const handlerPath = join(repoDir, handler);
    const pkgJsonPath = join(repoDir, pkgDir, 'package.json');
    const nodeModulesPath = join(repoDir, pkgDir, 'node_modules');

    if (existsSync(handlerPath) && existsSync(pkgJsonPath) && !existsSync(nodeModulesPath)) {
      const cwd = join(repoDir, pkgDir);
      const hasLockfile = existsSync(join(cwd, 'package-lock.json'));
      const cmd = hasLockfile ? 'npm ci --production --silent' : 'npm install --production --silent';
      try {
        process.stderr.write(`[repo-agent] Installing deps in ${pkgDir}/ for ${repoDir.split('/').pop()}...\n`);
        execSync(cmd, { cwd, stdio: 'pipe', timeout: 120_000 });
      } catch {
        process.stderr.write(`[repo-agent] Warning: npm install incomplete for ${pkgDir}/\n`);
      }
      // Inject Claude shim into the sub-directory too
      injectClaudeShim(cwd);
      return; // Only install for the first matching entry point
    }
  }
}

// ============================================================================
// Pure Rust Repo Detection
// ============================================================================

/**
 * Check if a repo is pure Rust (has Cargo.toml but no JS/TS handler entry point).
 * These repos cannot be executed via Node child process and should fall back to
 * the system-prompt-based local agent runner.
 */
function isRustOnlyRepo(repoDir: string): boolean {
  if (!existsSync(join(repoDir, 'Cargo.toml'))) return false;

  // Check all known JS/TS entry points. If any exist, it's a hybrid repo.
  const jsEntryPoints = [
    'index.js', join('lib', 'index.js'), join('dist', 'index.js'),
    join('dist', 'functions', 'handler.js'), join('dist', 'functions.js'),
    join('functions', 'index.js'), join('functions', 'index.ts'),
    join('functions', 'dist', 'index.js'), join('functions', 'src', 'index.ts'),
    join('src', 'index.ts'), join('src', 'functions', 'handler.ts'),
    join('agents', 'functions', 'index.ts'), join('agents', 'src', 'functions', 'index.ts'),
    join('api', 'src', 'functions', 'handler.ts'),
    join('dist', 'router.js'), join('src', 'router.js'),
  ];

  return !jsEntryPoints.some(p => existsSync(join(repoDir, p)));
}

// ============================================================================
// Repo Cache Warmup
// ============================================================================

/**
 * Pre-install dependencies for all provisioned repo caches.
 * Call this proactively to avoid npm install delays during agent execution.
 * Repos that already have node_modules are skipped.
 */
export async function warmRepoCache(): Promise<{ warmed: string[]; failed: string[]; skipped: string[] }> {
  const warmed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const [domain, functionName] of Object.entries(FUNCTION_NAMES)) {
    const cacheDir = getCacheDir(functionName);
    if (!existsSync(cacheDir)) { skipped.push(domain); continue; }

    // Skip if already has node_modules or is Rust-only
    const pkgJson = join(cacheDir, 'package.json');
    const nodeModules = join(cacheDir, 'node_modules');
    if (!existsSync(pkgJson)) { skipped.push(domain); continue; }
    if (existsSync(nodeModules) && existsSync(join(nodeModules, '.package-lock.json'))) {
      skipped.push(domain);
      continue;
    }

    // Provision from bundle if not cached yet
    if (!isSourceCached(functionName) && isBundled(functionName)) {
      try { provisionFromBundle(functionName, cacheDir); } catch { /* best-effort */ }
    }

    // Install root deps
    if (existsSync(pkgJson) && !existsSync(join(nodeModules, '.package-lock.json'))) {
      const hasLockfile = existsSync(join(cacheDir, 'package-lock.json'));
      const cmd = hasLockfile ? 'npm ci --production --silent' : 'npm install --production --silent';
      try {
        process.stderr.write(`[warmup] Installing deps for ${functionName}...\n`);
        execSync(cmd, { cwd: cacheDir, stdio: 'pipe', timeout: 180_000 });
        warmed.push(domain);
      } catch {
        failed.push(domain);
      }
    } else {
      skipped.push(domain);
    }

    // Install sub-directory deps
    ensureSubDirDeps(cacheDir);
  }

  return { warmed, failed, skipped };
}

// ============================================================================
// Agent Execution
// ============================================================================

/**
 * Execute an agent using its actual repo code with Claude Code as the AI backend.
 */
export async function executeRepoAgent(
  domain: string,
  agent: string,
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<AgentsInvokeResult> {
  const start = Date.now();
  const functionName = FUNCTION_NAMES[domain];

  if (!functionName) {
    return {
      domain,
      agent,
      status: 404,
      response: { error: `No repo mapping for domain '${domain}'` },
      timing: Date.now() - start,
    };
  }

  // ── AUTH GATE ──────────────────────────────────────────────────────────
  // Require a valid agentics_sk_* or agentics_internal_* API key before
  // executing any agent. Users get keys at https://agentics.dev
  const platformKey = await getPlatformApiKey();
  if (!platformKey || (!platformKey.startsWith('agentics_sk_') && !platformKey.startsWith('agentics_internal_'))) {
    return {
      domain,
      agent,
      status: 401,
      response: {
        error: 'Agent execution requires an Agentics API key. Get one at https://agentics.dev and run: agentics login',
        auth_required: true,
        signup_url: 'https://agentics.dev',
      },
      timing: Date.now() - start,
    };
  }

  // ── SOURCE PROVISIONING ────────────────────────────────────────────────
  // Priority: 1) existing cache  2) bundled in npm package  3) gsutil download
  const cacheDir = getCacheDir(functionName);
  const needsProvision = !isSourceCached(functionName) || (isBundled(functionName) && isCacheStale(cacheDir));

  if (needsProvision) {
    if (isBundled(functionName)) {
      try {
        provisionFromBundle(functionName, cacheDir);
      } catch (err) {
        return {
          domain,
          agent,
          status: 502,
          response: {
            error: `Failed to provision bundled agent ${functionName}: ${err instanceof Error ? err.message : String(err)}`,
          },
          timing: Date.now() - start,
        };
      }
    } else {
      // Fallback: gsutil download (for development / internal use)
      try {
        downloadAndCacheSource(functionName);
      } catch (err) {
        // Race condition guard: a concurrent agent invocation for the same
        // function may have populated the cache while we were downloading.
        // Check again before giving up.
        if (isSourceCached(functionName)) {
          patchKnownHandlerIssues(functionName, cacheDir);
          // Cache was populated by a concurrent call — proceed to handler execution
        } else {
          // Cache still empty — try system-prompt fallback (outside CLAUDECODE)
          if (!process.env['CLAUDECODE']) {
            const queryText = (payload['text'] ?? payload['objective'] ?? payload['input'] ?? JSON.stringify(payload)) as string;
            try {
              return await executeAgentLocallyAsync(domain, agent, queryText, correlationId);
            } catch { /* fall through to error */ }
          }
          return {
            domain,
            agent,
            status: 502,
            response: {
              error: `Failed to download ${functionName} source: ${err instanceof Error ? err.message : String(err)}`,
            },
            timing: Date.now() - start,
          };
        }
      }
    }
  } else {
    // Even for already-cached repos, ensure known issues are patched.
    // This is idempotent — patchKnownHandlerIssues only writes if files are missing.
    patchKnownHandlerIssues(functionName, cacheDir);
  }

  // ── PURE RUST REPOS ──────────────────────────────────────────────────
  // Repos like latency-lens and incident-manager core are Rust-only (no JS/TS
  // handler entry point). Skip directly to the system-prompt fallback.
  if (isRustOnlyRepo(cacheDir)) {
    if (!process.env['CLAUDECODE']) {
      const queryText = (payload['text'] ?? payload['objective'] ?? payload['input'] ?? JSON.stringify(payload)) as string;
      try {
        return await executeAgentLocallyAsync(domain, agent, queryText, correlationId);
      } catch { /* fall through to error */ }
    }
    return {
      domain,
      agent,
      status: 200,
      response: {
        data: {
          message: `${domain}/${agent} is a Rust-native agent (no local JS handler). Use cloud execution or system-prompt mode.`,
          mode: 'rust-native-fallback',
        },
        execution_metadata: {
          trace_id: correlationId,
          timestamp: new Date().toISOString(),
          service: `${functionName}-local`,
          execution_id: correlationId,
          mode: 'rust-native',
        },
      },
      timing: Date.now() - start,
    };
  }

  // ── ROOT-LEVEL DEPS ──────────────────────────────────────────────────
  // For git-cloned repos (not provisioned from bundle/GCS), ensure root deps
  // are installed. injectClaudeShim() handles this during provisioning, but
  // repos that were pre-cached via git clone skip that path.
  const rootPkgJson = join(cacheDir, 'package.json');
  const rootNodeModules = join(cacheDir, 'node_modules');
  if (existsSync(rootPkgJson) && !existsSync(rootNodeModules)) {
    try {
      const hasLockfile = existsSync(join(cacheDir, 'package-lock.json'));
      const cmd = hasLockfile ? 'npm ci --production --silent' : 'npm install --production --silent';
      process.stderr.write(`[repo-agent] Installing root deps for ${functionName}...\n`);
      execSync(cmd, { cwd: cacheDir, stdio: 'pipe', timeout: 120_000 });
    } catch { /* best-effort */ }
  }

  // ── SUB-DIRECTORY DEPS ──────────────────────────────────────────────
  // Handlers in subdirectories (functions/, agents/, api/) need their own
  // node_modules. Install once if missing.
  ensureSubDirDeps(cacheDir);

  // Detect if the repo's handler calls callClaude (needs longer timeout for claude --print).
  // Check actual entry point files for callClaude usage, not just whether claude.js exists
  // (we inject claude.js as a shim into every repo).
  const usesCallClaude = (() => {
    try {
      // Check all possible entry point files for callClaude imports/calls
      for (const entryPath of [
        join(cacheDir, 'index.js'),
        join(cacheDir, 'dist', 'router.js'),
        join(cacheDir, 'lib', 'index.js'),
        join(cacheDir, 'functions', 'index.js'),
        join(cacheDir, 'functions', 'dist', 'index.js'),
        join(cacheDir, 'functions', 'index.ts'),
        join(cacheDir, 'functions', 'src', 'index.ts'),
        join(cacheDir, 'agents', 'functions', 'index.ts'),
        join(cacheDir, 'agents', 'src', 'functions', 'index.ts'),
        join(cacheDir, 'api', 'src', 'functions', 'handler.ts'),
        join(cacheDir, 'dist', 'functions.js'),
        join(cacheDir, 'dist', 'functions', 'handler.js'),
      ]) {
        if (existsSync(entryPath)) {
          const src = readFileSync(entryPath, 'utf-8');
          if (src.includes('callClaude') || src.includes("from './claude") || src.includes("from '../claude") || src.includes("require('./claude") || src.includes("require('../claude")) {
            return true;
          }
        }
      }
    } catch { /* ignore */ }
    return false;
  })();

  // Run the handler in a child process with a hard OS-level timeout.
  // Child process uses import() which handles both CJS and ESM modules.
  // If the handler calls callClaude → claude --print, allow up to 120s.
  // This prevents event-loop-blocking require() or handler code from
  // causing the main process to hang indefinitely.
  try {
    const childTimeout = usesCallClaude ? 120_000 : 15_000;
    const result = await runHandlerInChildProcess(cacheDir, functionName, domain, agent, payload, correlationId, childTimeout);

    return {
      domain,
      agent,
      status: 200,
      response: {
        data: result,
        execution_metadata: {
          trace_id: correlationId,
          timestamp: new Date().toISOString(),
          service: `${functionName}-local`,
          execution_id: correlationId,
          mode: 'repo-local',
        },
        layers_executed: [
          { layer: 'AGENT_ROUTING', status: 'completed' },
          { layer: `REPO_${domain.toUpperCase().replace(/-/g, '_')}_${agent.toUpperCase().replace(/-/g, '_')}`, status: 'completed', duration_ms: Date.now() - start },
        ],
      },
      timing: Date.now() - start,
    };
  } catch (err) {
    // Fallback: if repo handler fails (missing deps, etc.), use system-prompt-based
    // execution through Claude Code. This still uses the agent's domain-specific
    // system prompt (from system-prompts.ts, derived from the repos).
    // Skip the claude --print fallback when running inside Claude Code session
    // (nested claude calls block indefinitely in that environment).
    if (!process.env['CLAUDECODE']) {
      const queryText = (payload['text'] ?? payload['objective'] ?? payload['input'] ?? JSON.stringify(payload)) as string;
      try {
        return await executeAgentLocallyAsync(domain, agent, queryText, correlationId);
      } catch { /* fall through to error response */ }
    }
    return {
      domain,
      agent,
      status: 502,
      response: {
        error: `Repo handler execution failed: ${err instanceof Error ? err.message : String(err)}`,
        execution_metadata: {
          trace_id: correlationId,
          mode: 'repo-local',
          domain,
          agent,
        },
      },
      timing: Date.now() - start,
    };
  }
}

/**
 * Execute a repo handler in a child Node process with a hard timeout.
 *
 * This prevents the main process event loop from being blocked by
 * require() calls or handler code that never yields. The OS enforces
 * the timeout by killing the child process.
 */
function runHandlerInChildProcess(
  repoDir: string,
  functionName: string,
  domain: string,
  agent: string,
  payload: Record<string, unknown>,
  traceId: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const innerTimeout = Math.max(timeoutMs - 3000, 5000);
    const script = buildChildProcessScript(repoDir, functionName, domain, agent, payload, traceId, innerTimeout);

    const env: Record<string, string | undefined> = { ...process.env, CI: '1', AGENTICS_CHILD_PROCESS: '1', LOG_LEVEL: 'silent' };
    delete env['CLAUDECODE'];

    // Constrain child process memory to prevent OOM kills (exit 140).
    // Default 384MB is enough for most handlers; heavy repos get 512MB.
    const heavyRepos = new Set(['test-bench', 'memory-graph', 'shield', 'schema-registry']);
    const memLimit = heavyRepos.has(functionName) ? 512 : 384;
    const existingNodeOpts = env['NODE_OPTIONS'] ?? '';
    if (!existingNodeOpts.includes('--max-old-space-size')) {
      env['NODE_OPTIONS'] = existingNodeOpts ? `${existingNodeOpts} --max-old-space-size=${memLimit}` : `--max-old-space-size=${memLimit}`;
    }

    // Inject service URLs so agent handlers don't fall back to localhost defaults.
    // The production ruvector-service URL is required by costops/roi, governance-dashboard/audit, etc.
    if (!env['RUVECTOR_SERVICE_URL']) {
      env['RUVECTOR_SERVICE_URL'] = 'https://ruvvector-service-1062287243982.us-central1.run.app';
    }
    if (!env['RUVECTOR_API_KEY']) {
      env['RUVECTOR_API_KEY'] = 'agent-local-execution';
    }

    // Check if repo needs tsx: use tsx when the best available handler entry
    // point is a .ts file. Some repos have both dist/index.js (library) and
    // functions/index.ts (Cloud Function handler) — we need tsx for the .ts file.
    const needsTsx = bestEntryPointIsTs(repoDir);

    // Add sub-directory node_modules to NODE_PATH so require() resolves deps
    // from subdirectories like functions/, agents/, api/ that have their own package.json.
    for (const subDir of ['functions', 'agents', 'api']) {
      const subNodeModules = join(repoDir, subDir, 'node_modules');
      if (existsSync(subNodeModules)) {
        const existing = env['NODE_PATH'] ?? '';
        env['NODE_PATH'] = existing ? `${subNodeModules}:${existing}` : subNodeModules;
      }
    }

    // Write script to temp file (needed for tsx; avoids --eval escaping issues).
    // Use .cjs extension so it's treated as CommonJS even in ESM repos.
    // For tsx runtime, use .mts (explicit ESM) to avoid ERR_REQUIRE_CYCLE_MODULE
    // on Node v24+ where .ts files trigger CJS↔ESM cycle detection.
    const ext = needsTsx ? '.mts' : '.cjs';
    const tmpScript = join(repoDir, `.agent-runner-tmp-${Date.now()}${ext}`);
    writeFileSync(tmpScript, script, 'utf-8');

    // For tsx: resolve the full path to tsx/esm so --import can find it.
    // NODE_PATH is set for require()/import resolution within the script.
    let args: string[];
    if (needsTsx) {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const cliNodeModules = join(thisDir, '..', '..', 'node_modules');
      const tsxPath = join(cliNodeModules, 'tsx', 'dist', 'esm', 'index.mjs');
      args = ['--import', tsxPath, tmpScript];
      const existing = env['NODE_PATH'] ?? '';
      env['NODE_PATH'] = existing ? `${cliNodeModules}:${existing}` : cliNodeModules;
    } else {
      args = [tmpScript];
    }
    execFile('node', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env,
      cwd: repoDir,
    }, (err, stdout, _stderr) => {
      // Clean up temp file
      try { require('fs').unlinkSync(tmpScript); } catch { /* ignore */ }

      if (err) {
        reject(new Error(`Handler child process failed for ${domain}/${agent}: ${err.message}`));
        return;
      }
      try {
        // Take the last non-empty line — handlers may log to stdout despite our redirect
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const jsonLine = lines[lines.length - 1] ?? '';
        const result = JSON.parse(jsonLine);
        resolve(result);
      } catch {
        reject(new Error(`Handler returned non-JSON for ${domain}/${agent}: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Check if the best available handler entry point is a TypeScript file.
 * Uses the same search order as the child script's searchPaths.
 * If a router.js exists (Pattern 1), we don't need tsx.
 * Otherwise, check the simulateHTTP search paths in order.
 */
function bestEntryPointIsTs(repoDir: string): boolean {
  // Pattern 1: router.js never needs tsx
  if (existsSync(join(repoDir, 'dist', 'router.js')) || existsSync(join(repoDir, 'src', 'router.js'))) {
    return false;
  }
  // Check in the same order as the child script's searchPaths.
  // Return true if the first existing entry is .ts.
  // IMPORTANT: Cloud Function entry points (functions/, agents/, api/) come BEFORE
  // root index.js because some repos have a root index.js that's a Rust binary
  // wrapper or library export, not a Cloud Function handler.
  for (const p of [
    join('dist', 'functions', 'handler.js'),
    join('dist', 'functions', 'functions', 'handler.js'), // policy-engine nested build
    join('dist', 'functions.js'),
    join('functions', 'index.js'),
    join('functions', 'dist', 'index.js'),               // registry
    join('functions', 'index.ts'),
    join('functions', 'src', 'index.ts'),                 // incident-manager
    join('agents', 'functions', 'index.ts'),              // shield agents subdir
    join('agents', 'src', 'functions', 'index.ts'),       // data-vault agents subdir
    join('api', 'src', 'functions', 'handler.ts'),        // analytics-hub api subdir
    join('src', 'functions', 'handler.ts'),
    'index.js',
    join('lib', 'index.js'),
    join('dist', 'index.js'),
    join('src', 'index.ts'),
  ]) {
    if (existsSync(join(repoDir, p))) {
      return p.endsWith('.ts');
    }
  }
  return false;
}

/**
 * Build a Node script that loads the handler and executes it,
 * printing JSON result to stdout.
 */
function buildChildProcessScript(
  repoDir: string,
  _functionName: string,
  domain: string,
  agent: string,
  payload: Record<string, unknown>,
  traceId: string,
  innerTimeoutMs = 12_000,
): string {
  const payloadJson = JSON.stringify(payload).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedRepoDir = repoDir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedDomain = domain.replace(/'/g, "\\'");
  const escapedAgent = agent.replace(/'/g, "\\'");
  const escapedTraceId = traceId.replace(/'/g, "\\'");

  // For .ts files (tsx runtime), use ESM imports; for .cjs files, use require
  const isTsx = bestEntryPointIsTs(repoDir);
  const header = isTsx
    ? `import { createRequire as __cr } from 'module';
import path from 'path';
import fs from 'fs';
const require = __cr(import.meta.url);`
    : `'use strict';
const path = require('path');
const fs = require('fs');`;

  return `
${header}

const repoDir = '${escapedRepoDir}';
const domain = '${escapedDomain}';
const agent = '${escapedAgent}';
const traceId = '${escapedTraceId}';
const payload = JSON.parse('${payloadJson}');

// Redirect console.log to stderr so handler logging doesn't corrupt stdout JSON.
// Only our explicit console.log(JSON.stringify(result)) should go to stdout.
const __origLog = console.log;
console.log = function(...args) { process.stderr.write(args.join(' ') + '\\n'); };
function __writeResult(obj) { __origLog(JSON.stringify(obj)); }

// Hard timeout — force exit if handler hangs
setTimeout(() => { process.stderr.write('CHILD_TIMEOUT\\n'); process.exit(1); }, ${innerTimeoutMs});

// Register TypeScript path aliases for repos that use @alias/* patterns
// (e.g., policy-engine: @utils/*, @core/*, @agents/*).
// Compiled JS still uses @alias/ imports; we resolve them to dist/.
{
  var tsconfig = path.join(repoDir, 'tsconfig.json');
  if (fs.existsSync(tsconfig)) {
    try {
      var tc = JSON.parse(fs.readFileSync(tsconfig, 'utf-8'));
      var tcPaths = (tc.compilerOptions || {}).paths;
      var rootDir = (tc.compilerOptions || {}).rootDir || '.';
      var outDir = (tc.compilerOptions || {}).outDir || '.';
      if (tcPaths) {
        var Module = require('module');
        var origResolve = Module._resolveFilename;
        Module._resolveFilename = function(request, parent, isMain, options) {
          for (var alias in tcPaths) {
            var prefix = alias.replace('*', '');
            if (request.startsWith(prefix)) {
              var target = tcPaths[alias][0].replace('*', '').replace(/^\\.\\//,'');
              // Map src/ paths to dist/ (rootDir→outDir): ./src/utils/* → dist/utils/*
              var rootDirNorm = rootDir.replace(/^\\.\\//,'').replace(/\\/$/, '');
              var outDirNorm = outDir.replace(/^\\.\\//,'').replace(/\\/$/, '');
              if (target.startsWith(rootDirNorm + '/')) {
                target = outDirNorm + target.slice(rootDirNorm.length);
              }
              var resolved = request.replace(prefix, path.join(repoDir, target));
              try { return origResolve.call(this, resolved, parent, isMain, options); } catch {}
            }
          }
          return origResolve.call(this, request, parent, isMain, options);
        };
      }
    } catch {}
  }
}

// Universal module loader: import() works for both CJS and ESM.
// For CJS .js files, try require() first (faster, avoids ESM namespace wrapping).
// For .ts files (tsx runtime), always use import().
async function load(filePath) {
  if (filePath.endsWith('.ts')) {
    const m = await import(filePath);
    return m.default && Object.keys(m).length === 1 ? m.default : m;
  }
  try { return require(filePath); } catch (e) {
    if (e.code === 'ERR_REQUIRE_ESM' || (e.message && e.message.includes('ES Module'))) {
      const m = await import(filePath);
      return m.default && Object.keys(m).length === 1 ? m.default : m;
    }
    throw e;
  }
}

async function run() {
  const distDir = path.join(repoDir, 'dist');
  const libDir = path.join(repoDir, 'lib');
  const srcDir = path.join(repoDir, 'src');

  // Always provide a truthy API key for header validation.
  // Handlers that call callClaude will use our shim (claude --print).
  // Inside Claude Code session, callClaude may timeout but the handler
  // should fall back to heuristic analysis on its own catch block.
  const apiKey = 'claude-max-local';

  // Pattern 1: router.js with resolveAgent
  for (const routerPath of [path.join(distDir, 'router.js'), path.join(srcDir, 'router.js')]) {
    if (fs.existsSync(routerPath)) {
      const router = await load(routerPath);
      if (typeof router.resolveAgent === 'function') {
        const agentRoute = router.resolveAgent(agent);
        if (agentRoute && agentRoute.handler) {
          const result = await agentRoute.handler(payload, traceId, apiKey);
          __writeResult(result);
          return;
        }
      }
    }
  }

  // Pattern 2: dist/agents/{agent}.js with handleXxx
  for (const base of [path.join(distDir, 'agents'), distDir]) {
    const agentFile = path.join(base, agent + '.js');
    if (fs.existsSync(agentFile)) {
      const mod = await load(agentFile);
      const handlerName = 'handle' + agent.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
      if (typeof mod[handlerName] === 'function' && mod[handlerName].length > 2) {
        const result = await mod[handlerName](payload, traceId, apiKey);
        __writeResult(result);
        return;
      }
      if (typeof mod.default === 'function') {
        const result = await mod.default(payload, traceId, apiKey);
        __writeResult(result);
        return;
      }
    }
  }

  // Pattern 3-5: Entry point files — simulate HTTP
  // Includes .ts paths for repos that need tsx runtime
  // Order matters: Cloud Function entry points first, then library exports.
  // functions/index.ts must come before dist/index.js because some repos
  // (test-bench) export a library from dist/ but the handler is in functions/.
  // IMPORTANT: Cloud Function entry points (functions/, agents/, api/) come BEFORE
  // root index.js because some repos have a root index.js that's a Rust binary
  // wrapper or library export, not a Cloud Function handler.
  const searchPaths = [
    path.join(distDir, 'functions', 'handler.js'),
    path.join(distDir, 'functions', 'functions', 'handler.js'), // policy-engine nested build
    path.join(distDir, 'functions.js'),
    path.join(repoDir, 'functions', 'index.js'),
    path.join(repoDir, 'functions', 'dist', 'index.js'),        // registry (functions/dist/)
    path.join(repoDir, 'functions', 'index.ts'),                 // shield, test-bench (tsx)
    path.join(repoDir, 'functions', 'src', 'index.ts'),          // incident-manager (functions/src/)
    path.join(repoDir, 'agents', 'functions', 'index.ts'),       // shield agents subdir
    path.join(repoDir, 'agents', 'src', 'functions', 'index.ts'),// data-vault (agents/src/functions/)
    path.join(repoDir, 'api', 'src', 'functions', 'handler.ts'), // analytics-hub (api/src/functions/)
    path.join(repoDir, 'src', 'functions', 'handler.ts'),        // policy-engine (tsx)
    path.join(repoDir, 'index.js'),
    path.join(libDir, 'index.js'),
    path.join(distDir, 'index.js'),
    path.join(repoDir, 'src', 'index.ts'),                       // some repos
  ];

  for (const indexPath of searchPaths) {
    if (!fs.existsSync(indexPath)) continue;

    const mod = await load(indexPath);
    const result = await simulateHTTP(mod, domain, agent, payload, traceId);
    if (result) {
      __writeResult(result);
      return;
    }
  }

  throw new Error('No handler found for ' + domain + '/' + agent);
}

// Sub-route actions for agents that use Express sub-routers
var AGENT_SUB_ROUTES = {
  'policy-engine': { 'enforce': '/evaluate', 'constraints': '/resolve', 'approval': '/evaluate' },
};

function simulateHTTP(mod, domain, agent, payload, traceId) {
  var subRoute = (AGENT_SUB_ROUTES[domain] || {})[agent] || '';
  var urlPath = '/v1/' + domain + '/' + agent + subRoute;
  return tryHTTP(mod, urlPath, domain, agent, payload, traceId);
}

function tryHTTP(mod, urlPath, domain, agent, payload, traceId) {
  return new Promise((resolve, reject) => {
    let responseBody = null;

    const fakeReq = {
      method: 'POST',
      url: urlPath,
      path: urlPath,
      originalUrl: urlPath,
      baseUrl: '',
      params: { agent },
      query: {},
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': traceId,
        'x-api-version': '2024-01-01',
        'authorization': 'Bearer claude-max-local',
        'x-anthropic-api-key': 'claude-max-local',
        'x-execution-id': traceId,
        'x-parent-span-id': traceId + '-span',
      },
      body: payload.payload ? payload : Object.assign({ context: {} }, payload, { payload }),
      get: function(n) { return this.headers[n.toLowerCase()]; },
      header: function(n) { return this.headers[n.toLowerCase()]; },
      is: function() { return 'application/json'; },
      // Stream stubs required by finalhandler / unpipe
      unpipe: function() {},
      on: function() { return this; },
      removeListener: function() { return this; },
      connection: { destroy: function() {} },
    };

    const fakeRes = {
      statusCode: 200,
      _headers: {},
      status: function(c) { this.statusCode = c; return this; },
      json: function(b) { responseBody = b; done(); return this; },
      send: function(b) {
        if (typeof b === 'string') { try { responseBody = JSON.parse(b); } catch { responseBody = { raw: b }; } }
        else { responseBody = b; }
        done();
        return this;
      },
      writeHead: function(c) { this.statusCode = c; return this; },
      end: function(b) {
        if (b) { try { responseBody = JSON.parse(b); } catch { responseBody = { raw: b }; } }
        done();
      },
      setHeader: function(n, v) { if (typeof n === 'string') this._headers[n.toLowerCase()] = v; return this; },
      getHeader: function(n) { return typeof n === 'string' ? this._headers[n.toLowerCase()] : undefined; },
      removeHeader: function() {},
      headersSent: false,
      set: function(n, v) { if (typeof n === 'object' && n !== null) { for (var k in n) { this._headers[k.toLowerCase()] = n[k]; } } else if (typeof n === 'string') { this._headers[n.toLowerCase()] = v; } return this; },
    };

    let settled = false;
    function done() {
      if (settled) return;
      settled = true;
      if (responseBody && typeof responseBody === 'object') resolve(responseBody);
      else reject(new Error('Handler did not produce JSON response'));
    }

    // Hard timeout for this simulation
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('HTTP simulation timeout')); } }, 10000);

    try {
      // Detect handler type
      if (typeof mod.handler === 'function') {
        Promise.resolve(mod.handler(fakeReq, fakeRes)).catch(reject);
      } else if (typeof mod.api === 'function') {
        callExpress(mod.api, fakeReq, fakeRes, done);
      } else if (typeof mod.default === 'function') {
        const fn = mod.default;
        if (fn.use || fn.handle) callExpress(fn, fakeReq, fakeRes, done);
        else Promise.resolve(fn(fakeReq, fakeRes)).catch(reject);
      } else {
        // Find Express app in exports
        const keys = Object.keys(mod);
        let found = false;
        for (const key of keys) {
          const fn = mod[key];
          if (typeof fn === 'function' && (fn.use || fn.handle)) {
            callExpress(fn, fakeReq, fakeRes, done);
            found = true;
            break;
          }
        }
        if (!found) reject(new Error('No handler export found'));
      }
    } catch (e) { reject(e); }
  });
}

function callExpress(app, req, res, done) {
  try {
    if (typeof app.handle === 'function') app.handle(req, res, () => {});
    else app(req, res, () => {});
  } catch (e) { /* ignore Express internal errors */ }
}

run().then(() => { process.exit(0); }).catch(e => { process.stderr.write('ERROR: ' + e.message + '\\n'); process.exit(1); });
`.trim();
}

