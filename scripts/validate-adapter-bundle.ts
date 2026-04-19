#!/usr/bin/env tsx
/**
 * validate-adapter-bundle.ts
 *
 * Build-time conformance validator for adapter repos per ADR-PIPELINE-081.
 *
 * Usage:
 *   npx tsx scripts/validate-adapter-bundle.ts <path-to-adapter-repo>
 *
 * Exit codes:
 *   0 — valid adapter bundle
 *   1 — invalid (one or more violations found)
 *   2 — usage error (missing path, bundle.json not found)
 *
 * What it checks (per adapter-repo.md §6.1 + §9):
 *   1. bundle.json exists and has type === "adapter"
 *   2. bundle.json has all required fields (name, agentics_domain, upstream.*,
 *      exposed_agents, excluded_upstream_agents, excluded_patterns)
 *   3. Every exposed_agents[] entry has a handler at src/handlers/<agent-id>.ts
 *   4. No handler imports/references an excluded upstream agent (string match)
 *   5. No handler's upstreamTool matches excluded_patterns (regex match)
 *   6. No orphan handlers (handlers not in exposed_agents[])
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { argv, exit } from 'node:process';

interface BundleManifest {
  type?: string;
  name?: string;
  agentics_domain?: string;
  upstream?: {
    product?: string;
    mcp_command?: string;
    version_pin?: string;
  };
  exposed_agents?: string[];
  excluded_upstream_agents?: string[];
  excluded_patterns?: string[];
}

interface Violation {
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  location?: string;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const adapterPath = argv[2];
  if (!adapterPath) {
    console.error('Usage: validate-adapter-bundle.ts <path-to-adapter-repo>');
    exit(2);
  }

  if (!existsSync(adapterPath) || !statSync(adapterPath).isDirectory()) {
    console.error(`ERROR: Adapter path does not exist or is not a directory: ${adapterPath}`);
    exit(2);
  }

  const bundleJsonPath = join(adapterPath, 'bundle.json');
  if (!existsSync(bundleJsonPath)) {
    console.error(`ERROR: bundle.json not found at ${bundleJsonPath}`);
    exit(2);
  }

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(readFileSync(bundleJsonPath, 'utf-8')) as BundleManifest;
  } catch (err) {
    console.error(`ERROR: bundle.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    exit(2);
  }

  if (manifest.type !== 'adapter') {
    // Not an adapter bundle — nothing to validate. Exit cleanly.
    console.error(`Skipping: bundle.json.type is "${manifest.type ?? '<missing>'}", not "adapter"`);
    exit(0);
  }

  const violations: Violation[] = [];

  violations.push(...checkRequiredFields(manifest));
  violations.push(...checkHandlerInventory(adapterPath, manifest));
  violations.push(...checkExclusionViolations(adapterPath, manifest));

  reportViolations(violations);

  const errorCount = violations.filter(v => v.severity === 'error').length;
  exit(errorCount > 0 ? 1 : 0);
}

// ============================================================================
// Rule 1 & 2: Required manifest fields
// ============================================================================

function checkRequiredFields(manifest: BundleManifest): Violation[] {
  const v: Violation[] = [];

  if (!manifest.name || !manifest.name.endsWith('-agents')) {
    v.push({
      severity: 'error',
      rule: 'bundle-name',
      message: `bundle.json.name must end with "-agents" (got: "${manifest.name ?? '<missing>'}")`,
    });
  }

  if (!manifest.agentics_domain || typeof manifest.agentics_domain !== 'string') {
    v.push({
      severity: 'error',
      rule: 'agentics-domain',
      message: 'bundle.json.agentics_domain is required (kebab-case domain key)',
    });
  }

  if (!manifest.upstream) {
    v.push({
      severity: 'error',
      rule: 'upstream-missing',
      message: 'bundle.json.upstream is required',
    });
  } else {
    if (!manifest.upstream.product) {
      v.push({ severity: 'error', rule: 'upstream-product', message: 'bundle.json.upstream.product is required' });
    }
    if (!manifest.upstream.mcp_command) {
      v.push({ severity: 'error', rule: 'upstream-mcp-command', message: 'bundle.json.upstream.mcp_command is required' });
    }
    if (!manifest.upstream.version_pin) {
      v.push({ severity: 'error', rule: 'upstream-version-pin', message: 'bundle.json.upstream.version_pin is required (exact version or SHA — "latest" is forbidden)' });
    } else if (manifest.upstream.version_pin === 'latest' || manifest.upstream.version_pin === '*') {
      v.push({ severity: 'error', rule: 'upstream-version-pin-float', message: `bundle.json.upstream.version_pin must be an exact version or SHA (got: "${manifest.upstream.version_pin}")` });
    }
  }

  if (!Array.isArray(manifest.exposed_agents)) {
    v.push({ severity: 'error', rule: 'exposed-agents', message: 'bundle.json.exposed_agents is required (array of kebab-case agent IDs)' });
  }

  if (!Array.isArray(manifest.excluded_upstream_agents)) {
    v.push({ severity: 'error', rule: 'excluded-upstream-agents', message: 'bundle.json.excluded_upstream_agents is required (array; can be empty)' });
  }

  if (!Array.isArray(manifest.excluded_patterns)) {
    v.push({ severity: 'error', rule: 'excluded-patterns', message: 'bundle.json.excluded_patterns is required (array of regex strings; can be empty)' });
  }

  return v;
}

// ============================================================================
// Rule 3 & 6: Handler inventory match
// ============================================================================

function checkHandlerInventory(adapterPath: string, manifest: BundleManifest): Violation[] {
  const v: Violation[] = [];
  const exposed = manifest.exposed_agents ?? [];
  if (!Array.isArray(exposed)) return v;

  const handlersDir = join(adapterPath, 'src', 'handlers');
  if (!existsSync(handlersDir)) {
    if (exposed.length > 0) {
      v.push({
        severity: 'error',
        rule: 'handlers-dir-missing',
        message: `src/handlers/ directory not found at ${handlersDir}`,
      });
    }
    return v;
  }

  const handlerFiles = readdirSync(handlersDir)
    .filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.startsWith('_') && !f.endsWith('.test.ts') && !f.endsWith('.test.js'));
  const handlerIds = new Set(handlerFiles.map(f => basename(f, extname(f))));

  // Rule 3: every exposed agent has a handler
  for (const agentId of exposed) {
    if (!handlerIds.has(agentId)) {
      v.push({
        severity: 'error',
        rule: 'missing-handler',
        message: `exposed_agents[] contains "${agentId}" but no handler exists at src/handlers/${agentId}.ts`,
      });
    }
  }

  // Rule 6: no orphan handlers
  const exposedSet = new Set(exposed);
  for (const handlerId of handlerIds) {
    if (!exposedSet.has(handlerId)) {
      v.push({
        severity: 'warning',
        rule: 'orphan-handler',
        message: `handler src/handlers/${handlerId} is not in bundle.json.exposed_agents[] — either expose it or prefix with "_" to mark as template/example`,
      });
    }
  }

  return v;
}

// ============================================================================
// Rule 4 & 5: Exclusion violations
// ============================================================================

function checkExclusionViolations(adapterPath: string, manifest: BundleManifest): Violation[] {
  const v: Violation[] = [];
  const excludedExact = manifest.excluded_upstream_agents ?? [];
  const excludedPatterns = (manifest.excluded_patterns ?? []).map(p => {
    try { return new RegExp(p); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);

  const handlersDir = join(adapterPath, 'src', 'handlers');
  if (!existsSync(handlersDir)) return v;

  const handlerFiles = readdirSync(handlersDir)
    .filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.test.ts') && !f.endsWith('.test.js'));

  for (const file of handlerFiles) {
    const filePath = join(handlersDir, file);
    const content = readFileSync(filePath, 'utf-8');

    // Extract upstreamTool constant or JSDoc tag — supports:
    //   export const UPSTREAM_TOOL = "..."
    //   export const upstreamTool = "..."
    //   /** @upstreamTool ... */
    const upstreamTool = extractUpstreamTool(content);

    // Rule 4: exact exclusion string match
    for (const excluded of excludedExact) {
      if (content.includes(`"${excluded}"`) || content.includes(`'${excluded}'`) || upstreamTool === excluded) {
        v.push({
          severity: 'error',
          rule: 'excluded-agent-reference',
          message: `handler references excluded upstream agent "${excluded}" (see bundle.json.excluded_upstream_agents)`,
          location: `src/handlers/${file}`,
        });
      }
    }

    // Rule 5: pattern match
    if (upstreamTool) {
      for (const pattern of excludedPatterns) {
        if (pattern.test(upstreamTool)) {
          v.push({
            severity: 'error',
            rule: 'excluded-pattern-match',
            message: `handler's upstreamTool "${upstreamTool}" matches excluded pattern /${pattern.source}/ — add to excluded_upstream_agents or refactor`,
            location: `src/handlers/${file}`,
          });
        }
      }
    }
  }

  return v;
}

function extractUpstreamTool(content: string): string | null {
  // export const UPSTREAM_TOOL = "foo" (with ' or " quotes)
  const constMatch = content.match(/export\s+const\s+UPSTREAM_TOOL\s*[:=]\s*['"]([^'"]+)['"]/);
  if (constMatch && constMatch[1]) return constMatch[1];

  // @upstreamTool in JSDoc
  const jsdocMatch = content.match(/@upstreamTool\s+([^\s*]+)/);
  if (jsdocMatch && jsdocMatch[1]) return jsdocMatch[1];

  return null;
}

// ============================================================================
// Reporting
// ============================================================================

function reportViolations(violations: Violation[]): void {
  if (violations.length === 0) {
    console.error('✓ Adapter bundle validation passed');
    return;
  }

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} error(s):`);
    for (const v of errors) {
      const loc = v.location ? ` (${v.location})` : '';
      console.error(`  [${v.rule}]${loc} ${v.message}`);
    }
  }

  if (warnings.length > 0) {
    console.error(`\n⚠ ${warnings.length} warning(s):`);
    for (const v of warnings) {
      const loc = v.location ? ` (${v.location})` : '';
      console.error(`  [${v.rule}]${loc} ${v.message}`);
    }
  }
}

main();
