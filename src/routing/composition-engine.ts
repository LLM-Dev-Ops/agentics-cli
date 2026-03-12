/**
 * Composition Engine (ADR-031 Phase 3)
 *
 * Evaluates composition rules that encode expert knowledge about
 * capability interactions. When certain capability combinations are
 * detected, the engine automatically adds required companion capabilities.
 *
 * Example: erp_integration + security_validation → add data_security
 *
 * Rules are defined in the ecosystem graph's `compositions` array.
 * The engine iterates until no new capabilities are added, with a
 * maximum of 3 iterations to prevent runaway rule chains.
 */

// ============================================================================
// Types
// ============================================================================

export type CompositionOperator = 'all' | 'any';
export type CompositionPriority = 'required' | 'recommended' | 'optional';

export interface CompositionRule {
  readonly id: string;
  readonly when: readonly string[];
  readonly operator: CompositionOperator;
  readonly add: readonly string[];
  readonly reason: string;
  readonly priority: CompositionPriority;
}

export interface CompositionResult {
  /** Final set of capabilities after composition rules are applied. */
  readonly capabilities: readonly string[];
  /** Capabilities that were added by composition rules. */
  readonly added: readonly string[];
  /** Rules that fired and their details. */
  readonly firedRules: readonly FiredRule[];
  /** Number of iterations performed. */
  readonly iterations: number;
}

export interface FiredRule {
  readonly ruleId: string;
  readonly reason: string;
  readonly addedCapabilities: readonly string[];
  readonly priority: CompositionPriority;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_ITERATIONS = 3;

// ============================================================================
// Engine
// ============================================================================

/**
 * Apply composition rules to expand the capability set.
 *
 * Iterates until no new capabilities are added or MAX_ITERATIONS is reached.
 * Only 'required' rules always fire. 'recommended' rules fire if under
 * the agent budget threshold. 'optional' rules are never auto-applied.
 *
 * @param capabilities - Initial set of classified capabilities
 * @param rules - Composition rules from the graph
 * @param validCapabilities - Set of all valid capability names in the graph
 * @param options - Budget and control options
 */
export function applyCompositions(
  capabilities: readonly string[],
  rules: readonly CompositionRule[],
  validCapabilities: ReadonlySet<string>,
  options?: CompositionOptions,
): CompositionResult {
  if (rules.length === 0 || capabilities.length === 0) {
    return {
      capabilities,
      added: [],
      firedRules: [],
      iterations: 0,
    };
  }

  const currentAgentCount = options?.currentAgentCount ?? 0;
  const agentBudget = options?.agentBudget ?? 15;
  const result = new Set<string>(capabilities);
  const added: string[] = [];
  const firedRules: FiredRule[] = [];
  let iterations = 0;

  let changed = true;
  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    for (const rule of rules) {
      // Check if the rule's trigger condition is met
      if (!evaluateCondition(rule, result)) continue;

      // Determine which capabilities to add
      for (const capToAdd of rule.add) {
        if (result.has(capToAdd)) continue;
        if (!validCapabilities.has(capToAdd)) continue;

        if (rule.priority === 'required') {
          result.add(capToAdd);
          added.push(capToAdd);
          changed = true;
        } else if (
          rule.priority === 'recommended' &&
          currentAgentCount < agentBudget * 0.8
        ) {
          result.add(capToAdd);
          added.push(capToAdd);
          changed = true;
        }
        // 'optional' rules are not auto-applied
      }

      // Record the fired rule if it added anything
      const ruleAdded = rule.add.filter(c => added.includes(c));
      if (ruleAdded.length > 0 && !firedRules.some(f => f.ruleId === rule.id)) {
        firedRules.push({
          ruleId: rule.id,
          reason: rule.reason,
          addedCapabilities: ruleAdded,
          priority: rule.priority,
        });
      }
    }
  }

  return {
    capabilities: Array.from(result),
    added,
    firedRules,
    iterations,
  };
}

export interface CompositionOptions {
  /** Current agent count before composition. */
  readonly currentAgentCount?: number;
  /** Total agent budget ceiling. */
  readonly agentBudget?: number;
}

// ============================================================================
// Rule Evaluation
// ============================================================================

/**
 * Evaluate whether a composition rule's trigger condition is met.
 */
function evaluateCondition(rule: CompositionRule, capabilities: ReadonlySet<string>): boolean {
  if (rule.operator === 'all') {
    return rule.when.every(c => capabilities.has(c));
  }
  if (rule.operator === 'any') {
    return rule.when.some(c => capabilities.has(c));
  }
  return false;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate composition rules for structural correctness.
 * Returns error messages or empty array.
 */
export function validateCompositionRules(
  rules: readonly CompositionRule[],
  validCapabilities: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const ruleIds = new Set<string>();

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const prefix = `compositions[${i}]`;

    // Unique ID
    if (!rule.id || rule.id.length === 0) {
      errors.push(`${prefix}.id: must be a non-empty string`);
    } else if (ruleIds.has(rule.id)) {
      errors.push(`${prefix}.id: duplicate rule id "${rule.id}"`);
    } else {
      ruleIds.add(rule.id);
    }

    // when array
    if (!Array.isArray(rule.when) || rule.when.length === 0) {
      errors.push(`${prefix}.when: must be a non-empty array`);
    } else {
      for (const capName of rule.when) {
        if (!validCapabilities.has(capName)) {
          errors.push(`${prefix}.when: references unknown capability "${capName}"`);
        }
      }
    }

    // operator
    if (rule.operator !== 'all' && rule.operator !== 'any') {
      errors.push(`${prefix}.operator: must be "all" or "any", got "${String(rule.operator)}"`);
    }

    // add array
    if (!Array.isArray(rule.add) || rule.add.length === 0) {
      errors.push(`${prefix}.add: must be a non-empty array`);
    } else {
      for (const capName of rule.add) {
        if (!validCapabilities.has(capName)) {
          errors.push(`${prefix}.add: references unknown capability "${capName}"`);
        }
      }
    }

    // reason
    if (!rule.reason || rule.reason.length === 0) {
      errors.push(`${prefix}.reason: must be a non-empty string`);
    }

    // priority
    if (!['required', 'recommended', 'optional'].includes(rule.priority)) {
      errors.push(`${prefix}.priority: must be "required", "recommended", or "optional"`);
    }

    // Self-reference check
    if (rule.when && rule.add) {
      const overlap = rule.add.filter(c => rule.when.includes(c));
      if (overlap.length > 0) {
        errors.push(`${prefix}: self-referencing — "when" and "add" share capabilities: ${overlap.join(', ')}`);
      }
    }
  }

  return errors;
}

/**
 * Detect cycles in composition rules.
 * A cycle occurs when rule A adds capability X, and rule B (triggered by X) adds
 * a capability that triggers rule A.
 */
export function detectCompositionCycles(
  rules: readonly CompositionRule[],
): { hasCycle: boolean; cycleNodes: string[] } {
  // Build adjacency: for each rule, "when" caps point to "add" caps
  const adj = new Map<string, Set<string>>();
  const allNodes = new Set<string>();

  for (const rule of rules) {
    for (const trigger of rule.when) {
      allNodes.add(trigger);
      if (!adj.has(trigger)) adj.set(trigger, new Set());
      for (const target of rule.add) {
        allNodes.add(target);
        adj.get(trigger)!.add(target);
      }
    }
    for (const target of rule.add) {
      allNodes.add(target);
      if (!adj.has(target)) adj.set(target, new Set());
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const node of allNodes) {
    inDegree.set(node, 0);
  }
  for (const [, neighbors] of adj) {
    for (const n of neighbors) {
      inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) queue.push(node);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (sorted.length < allNodes.size) {
    const cycleNodes = Array.from(allNodes).filter(n => !sorted.includes(n));
    return { hasCycle: true, cycleNodes };
  }

  return { hasCycle: false, cycleNodes: [] };
}

/**
 * Format composition result as a human-readable explanation.
 */
export function formatCompositionExplanation(result: CompositionResult): string {
  if (result.firedRules.length === 0) {
    return '';
  }

  const lines: string[] = [];
  for (const rule of result.firedRules) {
    lines.push(`  Composition rule "${rule.ruleId}" triggered:`);
    lines.push(`    added: [${rule.addedCapabilities.join(', ')}]`);
    lines.push(`    reason: ${rule.reason}`);
    lines.push(`    priority: ${rule.priority}`);
  }
  return lines.join('\n');
}
