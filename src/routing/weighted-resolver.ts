/**
 * Weighted Agent Resolver (ADR-031 Phase 1)
 *
 * Weight-aware agent selection that replaces flat agent lists with
 * prioritized selection based on weight scores and role classification.
 *
 * Backward compatible: plain string agents are treated as
 * { name: string, weight: 1.0, role: "primary" }.
 */

// ============================================================================
// Types
// ============================================================================

export type AgentRole = 'primary' | 'secondary' | 'specialist';

export interface WeightedAgent {
  readonly name: string;
  readonly weight: number;
  readonly role: AgentRole;
}

/** Input can be either a plain string or a weighted agent object. */
export type AgentInput = string | WeightedAgent;

// ============================================================================
// Normalization
// ============================================================================

/**
 * Normalize an agent input (string or weighted object) into a WeightedAgent.
 * Plain strings get weight 1.0 and role "primary".
 */
export function normalizeAgent(input: AgentInput): WeightedAgent {
  if (typeof input === 'string') {
    return { name: input, weight: 1.0, role: 'primary' };
  }
  return {
    name: input.name,
    weight: clampWeight(input.weight),
    role: input.role ?? 'primary',
  };
}

/**
 * Normalize an array of agent inputs into weighted agents.
 */
export function normalizeAgents(inputs: readonly AgentInput[]): WeightedAgent[] {
  return inputs.map(normalizeAgent);
}

/**
 * Extract the agent name from any agent input form.
 */
export function getAgentName(input: AgentInput): string {
  return typeof input === 'string' ? input : input.name;
}

// ============================================================================
// Selection Algorithm
// ============================================================================

export interface WeightedSelectionOptions {
  /** Maximum number of agents to select. */
  readonly budget: number;
  /** Tags from the user prompt for specialist matching. */
  readonly promptTags?: readonly string[];
}

/**
 * Select agents from a capability using weight-aware prioritization.
 *
 * Algorithm:
 * 1. Select all primary agents (sorted by weight descending)
 * 2. Fill remaining budget with secondary agents (by weight)
 * 3. Add specialists only when prompt tags match capability tags
 * 4. Enforce budget ceiling
 */
export function selectWeightedAgents(
  agents: readonly AgentInput[],
  options: WeightedSelectionOptions,
): WeightedAgent[] {
  const normalized = normalizeAgents(agents);
  const { budget, promptTags } = options;

  if (budget <= 0) return [];
  if (normalized.length === 0) return [];

  // Sort all agents by weight descending
  const sorted = [...normalized].sort((a, b) => b.weight - a.weight);

  // Step 1: Select primary agents
  const primary = sorted.filter(a => a.role === 'primary');
  const selected: WeightedAgent[] = primary.slice(0, budget);

  // Step 2: Fill with secondary agents
  if (selected.length < budget) {
    const secondary = sorted.filter(a => a.role === 'secondary');
    const remaining = budget - selected.length;
    selected.push(...secondary.slice(0, remaining));
  }

  // Step 3: Add matching specialists (can exceed budget by specialist count)
  if (promptTags && promptTags.length > 0) {
    const tagSet = new Set(promptTags.map(t => t.toLowerCase()));
    const specialists = sorted.filter(a =>
      a.role === 'specialist' && !selected.some(s => s.name === a.name),
    );
    for (const spec of specialists) {
      // Specialist name tokens are matched against prompt tags
      const nameTokens = spec.name.toLowerCase().split(/[\s\-_]+/);
      const hasMatch = nameTokens.some(t => tagSet.has(t));
      if (hasMatch) {
        selected.push(spec);
      }
    }
  }

  // Step 4: Enforce hard budget (specialists can push over)
  return selected.slice(0, Math.max(budget, selected.length));
}

// ============================================================================
// Validation
// ============================================================================

const VALID_ROLES: ReadonlySet<string> = new Set(['primary', 'secondary', 'specialist']);

/**
 * Validate agent input format. Returns error messages or empty array.
 */
export function validateAgentInput(input: unknown, path: string): string[] {
  const errors: string[] = [];

  if (typeof input === 'string') {
    if (input.length === 0) {
      errors.push(`${path}: agent name must be non-empty`);
    }
    return errors;
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    errors.push(`${path}: agent must be a string or { name, weight, role } object`);
    return errors;
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].length === 0) {
    errors.push(`${path}.name: must be a non-empty string`);
  }

  if (typeof obj['weight'] !== 'number') {
    errors.push(`${path}.weight: must be a number`);
  } else if (obj['weight'] < 0 || obj['weight'] > 1) {
    errors.push(`${path}.weight: must be between 0.0 and 1.0, got ${obj['weight']}`);
  }

  if ('role' in obj && obj['role'] !== undefined) {
    if (typeof obj['role'] !== 'string' || !VALID_ROLES.has(obj['role'])) {
      errors.push(`${path}.role: must be "primary", "secondary", or "specialist", got "${String(obj['role'])}"`);
    }
  }

  return errors;
}

/**
 * Check if an agent input is in weighted object format.
 */
export function isWeightedAgent(input: unknown): input is WeightedAgent {
  if (typeof input !== 'object' || input === null) return false;
  const obj = input as Record<string, unknown>;
  return typeof obj['name'] === 'string' && typeof obj['weight'] === 'number';
}

// ============================================================================
// Utilities
// ============================================================================

function clampWeight(w: number): number {
  return Math.max(0, Math.min(1, w));
}
