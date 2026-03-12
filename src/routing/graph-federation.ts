/**
 * Graph Federation (ADR-031 Phase 4)
 *
 * Supports splitting the monolithic ecosystem.graph.json into per-capability
 * fragment files under docs/ecosystem.fragments/. The loader detects the
 * graph format and uses either monolithic or federated loading.
 *
 * Fragment format: Each file declares a single capability with an owner field.
 * Root graph in v2.0 format contains metadata, stages, compositions, and
 * a fragments_dir pointer instead of inline capabilities.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StageName } from './graph-loader.js';
import type { AgentInput } from './weighted-resolver.js';
import type { CompositionRule } from './composition-engine.js';

// ============================================================================
// Types
// ============================================================================

export interface CapabilityFragment {
  readonly capability: string;
  readonly description?: string;
  readonly owner?: string;
  readonly repos: readonly string[];
  readonly agents: readonly AgentInput[];
  readonly stage?: StageName;
  readonly depends_on?: readonly string[];
  readonly tags?: readonly string[];
}

export interface FederatedRootGraph {
  readonly version: string;
  readonly description?: string;
  readonly stages?: readonly StageName[];
  readonly fragments_dir: string;
  readonly compositions?: readonly CompositionRule[];
  readonly overrides?: Readonly<Record<string, FragmentOverride>>;
}

export interface FragmentOverride {
  readonly max_agents?: number;
  readonly stage?: StageName;
}

export interface FederationResult {
  readonly fragments: readonly CapabilityFragment[];
  readonly root: FederatedRootGraph;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect whether a parsed graph root uses federated mode (v2.0+).
 * Federated graphs have a `fragments_dir` field instead of `capabilities`.
 */
export function isFederatedGraph(data: Record<string, unknown>): boolean {
  return typeof data['fragments_dir'] === 'string';
}

// ============================================================================
// Fragment Loading
// ============================================================================

/**
 * Load all capability fragments from the fragments directory.
 * Returns the merged result with fragments, warnings, and errors.
 */
export function loadFragments(
  rootGraphPath: string,
  fragmentsDir: string,
): FederationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Read root graph
  let rootData: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(rootGraphPath, 'utf-8');
    rootData = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    errors.push(`Failed to read root graph: ${(err as Error).message}`);
    return {
      fragments: [],
      root: { version: '2.0', fragments_dir: fragmentsDir },
      errors,
      warnings,
    };
  }

  const root: FederatedRootGraph = {
    version: (rootData['version'] as string) ?? '2.0',
    description: rootData['description'] as string | undefined,
    stages: rootData['stages'] as StageName[] | undefined,
    fragments_dir: fragmentsDir,
    compositions: rootData['compositions'] as CompositionRule[] | undefined,
    overrides: rootData['overrides'] as Record<string, FragmentOverride> | undefined,
  };

  // Resolve fragments directory relative to root graph
  const rootDir = path.dirname(rootGraphPath);
  const absFragDir = path.resolve(rootDir, fragmentsDir);

  if (!fs.existsSync(absFragDir)) {
    errors.push(`Fragments directory not found: ${absFragDir}`);
    return { fragments: [], root, errors, warnings };
  }

  // Read all .graph.json files
  const files = fs.readdirSync(absFragDir)
    .filter(f => f.endsWith('.graph.json'))
    .sort();

  const fragments: CapabilityFragment[] = [];
  const capNames = new Set<string>();

  for (const file of files) {
    const filePath = path.join(absFragDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      const fragment = parseFragment(data, file);
      if (!fragment) {
        errors.push(`${file}: invalid fragment format — missing "capability" field`);
        continue;
      }

      // Check for duplicate capability names
      if (capNames.has(fragment.capability)) {
        errors.push(`${file}: duplicate capability name "${fragment.capability}"`);
        continue;
      }
      capNames.add(fragment.capability);

      // Check owner field
      if (!fragment.owner) {
        warnings.push(`${file}: missing "owner" field`);
      }

      // Apply root overrides
      const override = root.overrides?.[fragment.capability];
      const finalFragment = override ? applyOverride(fragment, override) : fragment;

      fragments.push(finalFragment);
    } catch (err) {
      errors.push(`${file}: failed to parse — ${(err as Error).message}`);
    }
  }

  return { fragments, root, errors, warnings };
}

// ============================================================================
// Fragment Parsing
// ============================================================================

function parseFragment(data: Record<string, unknown>, _fileName: string): CapabilityFragment | null {
  if (typeof data['capability'] !== 'string') return null;

  return {
    capability: data['capability'] as string,
    description: data['description'] as string | undefined,
    owner: data['owner'] as string | undefined,
    repos: (data['repos'] as string[]) ?? [],
    agents: (data['agents'] as AgentInput[]) ?? [],
    stage: data['stage'] as StageName | undefined,
    depends_on: data['depends_on'] as string[] | undefined,
    tags: data['tags'] as string[] | undefined,
  };
}

function applyOverride(fragment: CapabilityFragment, override: FragmentOverride): CapabilityFragment {
  return {
    ...fragment,
    stage: override.stage ?? fragment.stage,
    // max_agents is applied at selection time, not stored on fragment
  };
}

// ============================================================================
// Federation Script Support
// ============================================================================

/**
 * Split a monolithic graph into capability fragments.
 * Used by the `graph federate` CLI command.
 *
 * @param graphPath - Path to the monolithic ecosystem.graph.json
 * @param outputDir - Directory to write fragments to
 * @returns Summary of the federation operation
 */
export function federateGraph(
  graphPath: string,
  outputDir: string,
): { fragmentsCreated: number; rootUpdated: boolean; errors: string[] } {
  const errors: string[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(graphPath, 'utf-8');
  } catch (err) {
    return { fragmentsCreated: 0, rootUpdated: false, errors: [`Cannot read graph: ${(err as Error).message}`] };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return { fragmentsCreated: 0, rootUpdated: false, errors: [`Invalid JSON: ${(err as Error).message}`] };
  }

  const capabilities = data['capabilities'] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return { fragmentsCreated: 0, rootUpdated: false, errors: ['No capabilities found in graph'] };
  }

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  let fragmentsCreated = 0;

  for (const cap of capabilities) {
    const name = cap['name'] as string;
    if (!name) {
      errors.push('Skipping capability with no name');
      continue;
    }

    const fragment: Record<string, unknown> = {
      capability: name,
      description: cap['description'],
      owner: '',
      repos: cap['repos'],
      agents: cap['agents'],
      stage: cap['stage'],
      depends_on: cap['depends_on'],
      tags: cap['tags'],
    };

    const fileName = `${name}.graph.json`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(fragment, null, 2) + '\n', 'utf-8');
    fragmentsCreated++;
  }

  // Update root graph to v2.0 format
  const relativeDir = path.relative(path.dirname(graphPath), outputDir);
  const newRoot: Record<string, unknown> = {
    version: '2.0',
    description: data['description'] ?? '',
    stages: data['stages'],
    fragments_dir: relativeDir,
    compositions: data['compositions'] ?? [],
  };

  // Write updated root (backup original first)
  const backupPath = graphPath + '.bak';
  fs.copyFileSync(graphPath, backupPath);
  fs.writeFileSync(graphPath, JSON.stringify(newRoot, null, 2) + '\n', 'utf-8');

  return { fragmentsCreated, rootUpdated: true, errors };
}

/**
 * Convert a capability fragment back to the monolithic format.
 * Used internally by the graph loader to unify fragment and inline formats.
 */
export function fragmentToCapabilityEntry(fragment: CapabilityFragment): Record<string, unknown> {
  return {
    name: fragment.capability,
    description: fragment.description,
    repos: fragment.repos,
    agents: fragment.agents,
    stage: fragment.stage,
    depends_on: fragment.depends_on ?? [],
    tags: fragment.tags ?? [],
  };
}
