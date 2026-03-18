/**
 * Code Resolver — Agent-to-Source-Code Mapping (ADR-039)
 *
 * Maps agent identifiers to their source code provenance:
 *   - Package registry lookup (domain → npm package)
 *   - Git context (commit hash from working directory)
 *   - Entry point mapping (agent type → source file)
 *   - Dependency resolution (key runtime dependencies)
 *
 * For agents built into the CLI, provenance points to the CLI's own
 * package and specific source module.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentRef, CodeProvenance } from './types.js';

// ============================================================================
// Agent → Package Registry
// ============================================================================

/** Maps agent domains to their npm package names. */
const DOMAIN_PACKAGE_MAP: Readonly<Record<string, string>> = {
  'copilot': '@agentics/copilot',
  'simulator': '@agentics/simulator',
  'sentinel': '@agentics/sentinel',
  'test-bench': '@agentics/test-bench',
  'shield': '@agentics/shield',
  'policy-engine': '@agentics/policy-engine',
  'costops': '@agentics/costops',
  'governance-dashboard': '@agentics/governance-dashboard',
  'orchestrator': '@agentics/orchestrator',
  'forge': '@agentics/forge',
  'connector-hub': '@agentics/connector-hub',
  'observatory': '@agentics/observatory',
  'latency-lens': '@agentics/latency-lens',
  'incident-manager': '@agentics/incident-manager',
  'memory-graph': '@agentics/memory-graph',
  'auto-optimizer': '@agentics/auto-optimizer',
  'edge': '@agentics/edge',
  'registry': '@agentics/registry',
  'marketplace': '@agentics/marketplace',
  'analytics-hub': '@agentics/analytics-hub',
  'config-manager': '@agentics/config-manager',
  'schema-registry': '@agentics/schema-registry',
  'benchmark-exchange': '@agentics/benchmark-exchange',
  'inference-gateway': '@agentics/inference-gateway',
  'data-vault': '@agentics/data-vault',
  'research-lab': '@agentics/research-lab',
  'platform': '@agentics/platform',
  // Internal pipeline agents
  'pipeline': '@llm-dev-ops/agentics-cli',
};

/** Maps agent domains to their repository URLs. */
const DOMAIN_REPO_MAP: Readonly<Record<string, string>> = {
  'pipeline': 'https://github.com/ruvnet/agentics-cli',
};
const DEFAULT_REPO = 'https://github.com/ruvnet/agentics-cli';

// ============================================================================
// Git Context Cache
// ============================================================================

let cachedCommitHash: string | undefined;
let cachedCLIVersion: string | undefined;

/** Resolve the current git commit hash (cached, best effort). */
export function resolveGitCommit(): string {
  if (cachedCommitHash !== undefined) return cachedCommitHash;
  try {
    cachedCommitHash = execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    cachedCommitHash = 'unknown';
  }
  return cachedCommitHash;
}

/** Resolve the CLI package version (cached, best effort). */
export function resolveCLIVersion(): string {
  if (cachedCLIVersion !== undefined) return cachedCLIVersion;
  try {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      cachedCLIVersion = pkg.version ?? '0.0.0';
    } else {
      cachedCLIVersion = '0.0.0';
    }
  } catch {
    cachedCLIVersion = '0.0.0';
  }
  return cachedCLIVersion;
}

/** Clear the cached values (for testing). */
export function clearResolverCache(): void {
  cachedCommitHash = undefined;
  cachedCLIVersion = undefined;
}

// ============================================================================
// Code Resolver
// ============================================================================

/**
 * Resolve the code provenance for an agent.
 *
 * Uses the domain→package registry to determine the npm package,
 * then resolves the git commit, entry point, and dependencies.
 */
export function resolveCodeProvenance(agent: AgentRef): CodeProvenance {
  const pkg = DOMAIN_PACKAGE_MAP[agent.domain] ?? `@agentics/${agent.domain}`;
  const repo = DOMAIN_REPO_MAP[agent.domain] ?? DEFAULT_REPO;
  const commitHash = resolveGitCommit();
  const version = resolveCLIVersion();

  // Entry point: domain/agent.ts (convention)
  const entryPoint = agent.domain === 'pipeline'
    ? `src/pipeline/enterprise/${agent.agent}.ts`
    : `src/agents/${agent.domain}/${agent.agent}.ts`;

  // Key runtime dependencies (static — based on the CLI's known deps)
  const dependencies = resolveKeyDependencies(agent.domain);

  return {
    package: pkg,
    version,
    entryPoint,
    repository: repo,
    commitHash,
    dependencies,
  };
}

/**
 * Resolve code provenance for multiple agents in batch.
 * Deduplicates package lookups for efficiency.
 */
export function resolveCodeProvenanceBatch(agents: readonly AgentRef[]): Map<string, CodeProvenance> {
  const result = new Map<string, CodeProvenance>();
  for (const agent of agents) {
    const key = `${agent.domain}/${agent.agent}`;
    if (!result.has(key)) {
      result.set(key, resolveCodeProvenance(agent));
    }
  }
  return result;
}

// ============================================================================
// Dependency Resolution
// ============================================================================

/** Key runtime dependencies per domain. */
function resolveKeyDependencies(domain: string): readonly string[] {
  // These are the key dependencies for each agent domain category
  const depMap: Record<string, readonly string[]> = {
    'copilot': ['anthropic-sdk', 'prompt-engine'],
    'simulator': ['scenario-engine', 'probability-models'],
    'sentinel': ['anomaly-detector', 'correlation-engine'],
    'test-bench': ['evaluation-framework', 'benchmark-suite'],
    'shield': ['security-scanner', 'pii-detector', 'content-filter'],
    'policy-engine': ['policy-evaluator', 'constraint-solver'],
    'costops': ['cost-calculator', 'roi-engine', 'forecast-models'],
    'governance-dashboard': ['audit-logger', 'compliance-checker'],
    'orchestrator': ['workflow-engine', 'task-scheduler'],
    'forge': ['code-generator', 'sdk-builder'],
    'connector-hub': ['api-adapter', 'erp-connector', 'auth-provider'],
    'observatory': ['telemetry-collector', 'metrics-aggregator'],
    'latency-lens': ['trace-analyzer', 'profiler'],
    'incident-manager': ['alert-router', 'escalation-engine'],
    'memory-graph': ['vector-store', 'hnsw-index', 'knowledge-graph'],
    'platform': ['decision-engine', 'executive-reporter'],
    'pipeline': ['@claude-flow/cli', 'ruflo'],
  };

  return depMap[domain] ?? [];
}

// ============================================================================
// Version Discrepancy Detection
// ============================================================================

/** Check for version discrepancies across agent code provenances. */
export function detectVersionDiscrepancies(
  provenances: ReadonlyMap<string, CodeProvenance>,
): readonly { agentKey: string; package: string; version: string; commitHash: string }[] {
  const byPackage = new Map<string, { versions: Set<string>; commits: Set<string>; agents: string[] }>();

  for (const [agentKey, prov] of provenances) {
    const existing = byPackage.get(prov.package);
    if (existing) {
      existing.versions.add(prov.version);
      existing.commits.add(prov.commitHash);
      existing.agents.push(agentKey);
    } else {
      byPackage.set(prov.package, {
        versions: new Set([prov.version]),
        commits: new Set([prov.commitHash]),
        agents: [agentKey],
      });
    }
  }

  const discrepancies: { agentKey: string; package: string; version: string; commitHash: string }[] = [];

  for (const [pkg, info] of byPackage) {
    if (info.versions.size > 1 || info.commits.size > 1) {
      for (const agentKey of info.agents) {
        const prov = provenances.get(agentKey)!;
        discrepancies.push({
          agentKey,
          package: pkg,
          version: prov.version,
          commitHash: prov.commitHash,
        });
      }
    }
  }

  return discrepancies;
}

// ============================================================================
// Package Registry Lookup
// ============================================================================

/** Get the npm package name for an agent domain. */
export function getPackageForDomain(domain: string): string {
  return DOMAIN_PACKAGE_MAP[domain] ?? `@agentics/${domain}`;
}

/** Get all registered domain→package mappings. */
export function getAllDomainPackages(): Readonly<Record<string, string>> {
  return DOMAIN_PACKAGE_MAP;
}
