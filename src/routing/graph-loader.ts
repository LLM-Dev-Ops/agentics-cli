/**
 * Ecosystem Capability Graph Loader (ADR-030)
 *
 * Reads, validates, and caches the ecosystem capability graph from
 * docs/ecosystem.graph.json. Provides typed lookup methods for
 * the capability classifier and graph router.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentInput } from './weighted-resolver.js';
import type { CompositionRule } from './composition-engine.js';

// ============================================================================
// Graph Schema Types
// ============================================================================

export type StageName =
  | 'prompt_structuring'
  | 'simulation'
  | 'research'
  | 'sparc_generation'
  | 'sparc_handoff'
  | 'adr_ddd_architecture'
  | 'implementation_planning'
  | 'build'
  | 'validation'
  | 'integration_mapping'
  | 'governance_finops'
  | 'decision_packaging'
  // v1.x backward compatibility
  | 'specification'
  | 'architecture'
  | 'deployment'
  | 'governance';

export interface CapabilityEntry {
  readonly name: string;
  readonly description?: string;
  readonly repos: readonly string[];
  /** Agents can be plain strings or weighted objects (ADR-031 Phase 1). */
  readonly agents: readonly AgentInput[];
  readonly stage?: StageName;
  readonly depends_on?: readonly string[];
  readonly tags?: readonly string[];
}

export interface EcosystemGraph {
  readonly version: string;
  readonly description: string;
  readonly stages: readonly StageName[];
  readonly capabilities: readonly CapabilityEntry[];
  /** Composition rules for capability interaction (ADR-031 Phase 3). */
  readonly compositions?: readonly CompositionRule[];
  /** Fragments directory for federated mode (ADR-031 Phase 4). */
  readonly fragments_dir?: string;
}

// ============================================================================
// Validation
// ============================================================================

const VALID_STAGES: ReadonlySet<string> = new Set<string>([
  // v2.0 12-phase pipeline
  'prompt_structuring',
  'simulation',
  'research',
  'sparc_generation',
  'sparc_handoff',
  'adr_ddd_architecture',
  'implementation_planning',
  'build',
  'validation',
  'integration_mapping',
  'governance_finops',
  'decision_packaging',
  // v1.x backward compatibility
  'specification',
  'architecture',
  'deployment',
  'governance',
]);

export interface GraphValidationError {
  readonly path: string;
  readonly message: string;
}

function validateGraph(data: unknown): GraphValidationError[] {
  const errors: GraphValidationError[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push({ path: '$', message: 'Root must be a non-null object' });
    return errors;
  }

  const obj = data as Record<string, unknown>;

  // version
  if (typeof obj['version'] !== 'string' || obj['version'].length === 0) {
    errors.push({ path: '$.version', message: 'version must be a non-empty string' });
  }

  // stages (optional in v1.0, required in v1.1+)
  if ('stages' in obj) {
    if (!Array.isArray(obj['stages'])) {
      errors.push({ path: '$.stages', message: 'stages must be an array' });
    } else {
      for (let i = 0; i < obj['stages'].length; i++) {
        const s = obj['stages'][i] as unknown;
        if (typeof s !== 'string' || !VALID_STAGES.has(s)) {
          errors.push({ path: `$.stages[${i}]`, message: `Invalid stage: ${String(s)}` });
        }
      }
    }
  }

  // capabilities
  if (!Array.isArray(obj['capabilities'])) {
    errors.push({ path: '$.capabilities', message: 'capabilities must be an array' });
    return errors;
  }

  const capNames = new Set<string>();
  const capabilities = obj['capabilities'] as unknown[];

  for (let i = 0; i < capabilities.length; i++) {
    const cap = capabilities[i];
    const prefix = `$.capabilities[${i}]`;

    if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
      errors.push({ path: prefix, message: 'Capability entry must be an object' });
      continue;
    }

    const c = cap as Record<string, unknown>;

    // name (required)
    if (typeof c['name'] !== 'string' || c['name'].length === 0) {
      errors.push({ path: `${prefix}.name`, message: 'name must be a non-empty string' });
    } else if (capNames.has(c['name'])) {
      errors.push({ path: `${prefix}.name`, message: `Duplicate capability name: ${c['name']}` });
    } else {
      capNames.add(c['name']);
    }

    // repos (required, non-empty array of strings)
    if (!Array.isArray(c['repos']) || c['repos'].length === 0) {
      errors.push({ path: `${prefix}.repos`, message: 'repos must be a non-empty array of strings' });
    } else {
      for (let j = 0; j < c['repos'].length; j++) {
        if (typeof (c['repos'] as unknown[])[j] !== 'string') {
          errors.push({ path: `${prefix}.repos[${j}]`, message: 'repo entry must be a string' });
        }
      }
    }

    // agents: accept v1 format (agents[]) or v2 format (mandatory_agents[] + optional_agents[])
    const hasV1Agents = Array.isArray(c['agents']) && (c['agents'] as unknown[]).length > 0;
    const hasV2Agents = Array.isArray(c['mandatory_agents']) && (c['mandatory_agents'] as unknown[]).length > 0;
    if (!hasV1Agents && !hasV2Agents) {
      errors.push({ path: `${prefix}.agents`, message: 'must have agents (v1) or mandatory_agents (v2) as a non-empty array' });
    }
    // Validate whichever agent arrays are present
    for (const agentKey of ['agents', 'mandatory_agents', 'optional_agents'] as const) {
      if (Array.isArray(c[agentKey])) {
        for (let j = 0; j < (c[agentKey] as unknown[]).length; j++) {
          const agent = (c[agentKey] as unknown[])[j];
          if (typeof agent === 'string') {
            if (agent.length === 0) {
              errors.push({ path: `${prefix}.${agentKey}[${j}]`, message: 'agent name must be non-empty' });
            }
          } else if (typeof agent === 'object' && agent !== null && !Array.isArray(agent)) {
            const agentObj = agent as Record<string, unknown>;
            if (typeof agentObj['name'] !== 'string' || agentObj['name'].length === 0) {
              errors.push({ path: `${prefix}.${agentKey}[${j}].name`, message: 'agent name must be a non-empty string' });
            }
          } else {
            errors.push({ path: `${prefix}.${agentKey}[${j}]`, message: 'agent must be a string or object' });
          }
        }
      }
    }

    // stage (optional, must be valid if present)
    if ('stage' in c && c['stage'] !== undefined) {
      if (typeof c['stage'] !== 'string' || !VALID_STAGES.has(c['stage'])) {
        errors.push({ path: `${prefix}.stage`, message: `Invalid stage: ${String(c['stage'])}` });
      }
    }

    // depends_on (optional, array of strings)
    if ('depends_on' in c && c['depends_on'] !== undefined) {
      if (!Array.isArray(c['depends_on'])) {
        errors.push({ path: `${prefix}.depends_on`, message: 'depends_on must be an array of strings' });
      } else {
        for (let j = 0; j < c['depends_on'].length; j++) {
          if (typeof (c['depends_on'] as unknown[])[j] !== 'string') {
            errors.push({ path: `${prefix}.depends_on[${j}]`, message: 'depends_on entry must be a string' });
          }
        }
      }
    }

    // tags (optional, array of strings)
    if ('tags' in c && c['tags'] !== undefined) {
      if (!Array.isArray(c['tags'])) {
        errors.push({ path: `${prefix}.tags`, message: 'tags must be an array of strings' });
      } else {
        for (let j = 0; j < c['tags'].length; j++) {
          if (typeof (c['tags'] as unknown[])[j] !== 'string') {
            errors.push({ path: `${prefix}.tags[${j}]`, message: 'tag entry must be a string' });
          }
        }
      }
    }
  }

  // Cross-reference: depends_on must reference existing capability names
  for (let i = 0; i < capabilities.length; i++) {
    const c = capabilities[i] as Record<string, unknown>;
    if (Array.isArray(c['depends_on'])) {
      for (let j = 0; j < c['depends_on'].length; j++) {
        const dep = (c['depends_on'] as string[])[j];
        if (typeof dep === 'string' && !capNames.has(dep)) {
          errors.push({
            path: `$.capabilities[${i}].depends_on[${j}]`,
            message: `depends_on references unknown capability: ${dep}`,
          });
        }
      }
    }
  }

  // Cycle detection in depends_on (Kahn's algorithm)
  if (errors.length === 0) {
    const cycleErrors = detectDependencyCycles(capabilities as Record<string, unknown>[]);
    errors.push(...cycleErrors);
  }

  return errors;
}

function detectDependencyCycles(capabilities: Record<string, unknown>[]): GraphValidationError[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const cap of capabilities) {
    const name = cap['name'] as string;
    adj.set(name, []);
    inDegree.set(name, 0);
  }

  for (const cap of capabilities) {
    const name = cap['name'] as string;
    const deps = (cap['depends_on'] as string[] | undefined) ?? [];
    for (const dep of deps) {
      const neighbors = adj.get(dep);
      if (neighbors) {
        neighbors.push(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length < capabilities.length) {
    const cycleNodes = capabilities
      .map(c => c['name'] as string)
      .filter(n => !sorted.includes(n));
    return [{
      path: '$.capabilities',
      message: `Circular dependency detected among capabilities: ${cycleNodes.join(', ')}`,
    }];
  }

  return [];
}

// ============================================================================
// Graph Loader
// ============================================================================

const DEFAULT_STAGES: readonly StageName[] = [
  'prompt_structuring',
  'simulation',
  'research',
  'sparc_generation',
  'sparc_handoff',
  'adr_ddd_architecture',
  'implementation_planning',
  'build',
  'validation',
  'integration_mapping',
  'governance_finops',
  'decision_packaging',
] as const;

/** Cached graph instance — loaded once per process. */
let cachedGraph: EcosystemGraph | null = null;
let cachedGraphPath: string | null = null;

/**
 * Resolve the path to the ecosystem graph file.
 * Looks relative to the project root (the directory containing package.json).
 */
export function resolveGraphPath(projectRoot?: string): string {
  const root = projectRoot ?? findProjectRoot();
  return path.join(root, 'docs', 'ecosystem.graph.json');
}

function findProjectRoot(): string {
  // First check cwd for the graph file (running from agentics-cli repo itself)
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'docs', 'ecosystem.graph.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the agentics-cli package directory (installed globally or via npx)
  const pkgDir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  if (fs.existsSync(path.join(pkgDir, 'docs', 'ecosystem.graph.json'))) {
    return pkgDir;
  }
  return process.cwd();
}

/**
 * Load and validate the ecosystem capability graph.
 *
 * Returns a validated, immutable graph object. The result is cached for the
 * lifetime of the process. Pass `forceReload: true` to bypass the cache.
 *
 * @throws Error if the graph file cannot be read or fails validation.
 */
export function loadEcosystemGraph(options?: {
  graphPath?: string;
  forceReload?: boolean;
}): EcosystemGraph {
  const graphPath = options?.graphPath ?? resolveGraphPath();

  // Return cached if same path and not forcing reload
  if (cachedGraph && cachedGraphPath === graphPath && !options?.forceReload) {
    return cachedGraph;
  }

  // Read file
  let raw: string;
  try {
    raw = fs.readFileSync(graphPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Ecosystem graph not found at ${graphPath}. Expected docs/ecosystem.graph.json in the project root.`);
    }
    throw new Error(`Failed to read ecosystem graph at ${graphPath}: ${(err as Error).message}`);
  }

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Ecosystem graph at ${graphPath} contains invalid JSON: ${(err as Error).message}`);
  }

  // Validate
  const errors = validateGraph(data);
  if (errors.length > 0) {
    const details = errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
    throw new Error(`Ecosystem graph validation failed:\n${details}`);
  }

  // Build typed graph
  const obj = data as Record<string, unknown>;
  const rawCapabilities = obj['capabilities'] as Record<string, unknown>[];
  const stages = (Array.isArray(obj['stages']) ? obj['stages'] : DEFAULT_STAGES) as StageName[];

  const graph: EcosystemGraph = {
    version: obj['version'] as string,
    description: (obj['description'] as string | undefined) ?? '',
    stages,
    capabilities: rawCapabilities.map(c => ({
      name: c['name'] as string,
      description: c['description'] as string | undefined,
      repos: c['repos'] as string[],
      agents: (c['agents'] as AgentInput[] | undefined)
        ?? [...(c['mandatory_agents'] as AgentInput[] ?? []), ...(c['optional_agents'] as AgentInput[] ?? [])],
      stage: c['stage'] as StageName | undefined,
      depends_on: (c['depends_on'] as string[] | undefined) ?? [],
      tags: (c['tags'] as string[] | undefined) ?? [],
    })),
    compositions: Array.isArray(obj['compositions'])
      ? (obj['compositions'] as CompositionRule[])
      : undefined,
    fragments_dir: typeof obj['fragments_dir'] === 'string'
      ? (obj['fragments_dir'] as string)
      : undefined,
  };

  // Cache
  cachedGraph = graph;
  cachedGraphPath = graphPath;

  return graph;
}

/**
 * Clear the cached graph. Useful for testing.
 */
export function clearGraphCache(): void {
  cachedGraph = null;
  cachedGraphPath = null;
}

// ============================================================================
// Lookup Helpers
// ============================================================================

/**
 * Look up a capability by exact name.
 */
export function getCapabilityByName(graph: EcosystemGraph, name: string): CapabilityEntry | undefined {
  return graph.capabilities.find(c => c.name === name);
}

/**
 * Find all capabilities that have a matching tag.
 */
export function getCapabilitiesByTag(graph: EcosystemGraph, tag: string): readonly CapabilityEntry[] {
  const lower = tag.toLowerCase();
  return graph.capabilities.filter(c =>
    c.tags?.some(t => t.toLowerCase() === lower),
  );
}

/**
 * Find all capabilities assigned to a given stage.
 */
export function getCapabilitiesByStage(graph: EcosystemGraph, stage: StageName): readonly CapabilityEntry[] {
  return graph.capabilities.filter(c => c.stage === stage);
}

/**
 * Resolve the full dependency tree for a set of capability names.
 * Returns all capability names including transitive dependencies.
 * Uses iterative BFS to avoid stack overflow on deep graphs.
 */
export function resolveDependencies(
  graph: EcosystemGraph,
  capabilityNames: readonly string[],
): readonly string[] {
  const resolved = new Set<string>(capabilityNames);
  const queue = [...capabilityNames];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const cap = getCapabilityByName(graph, current);
    if (!cap?.depends_on) continue;

    for (const dep of cap.depends_on) {
      if (!resolved.has(dep)) {
        resolved.add(dep);
        queue.push(dep);
      }
    }
  }

  return Array.from(resolved);
}
