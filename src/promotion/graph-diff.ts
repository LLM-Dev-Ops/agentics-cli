/**
 * Graph diff detection for promotion guard (ADR-PIPELINE-084 §3 enforcement).
 *
 * Pure functions that detect when `ecosystem.graph.json` changes promote a
 * domain agent from `optional_agents[]` to `mandatory_agents[]`, or newly
 * add an agent to either array. Used by scripts/check-promotion-guard.ts to
 * fail PRs that promote to gating without accompanying ADR + CHANGELOG updates.
 */

export interface PhaseCapability {
  name: string;
  phase?: number;
  mandatory_agents?: string[];
  optional_agents?: string[];
}

export interface Graph {
  capabilities?: PhaseCapability[];
  infrastructure?: Array<{ name: string; agents?: string[] }>;
}

export interface PromotionRecord {
  capability: string;
  phase?: number;
  addedAgents: string[];
}

/**
 * Detect agents newly added to `mandatory_agents[]` across all capabilities.
 * Includes capabilities that are entirely new in head (their full mandatory
 * list counts as additions).
 */
export function findMandatoryPromotions(base: Graph, head: Graph): PromotionRecord[] {
  const results: PromotionRecord[] = [];
  const baseCapsByName = new Map<string, PhaseCapability>();
  for (const cap of base.capabilities ?? []) {
    baseCapsByName.set(cap.name, cap);
  }

  for (const headCap of head.capabilities ?? []) {
    const baseCap = baseCapsByName.get(headCap.name);
    const baseMandatory = new Set(baseCap?.mandatory_agents ?? []);
    const headMandatory = headCap.mandatory_agents ?? [];

    const added = headMandatory.filter(a => !baseMandatory.has(a));
    if (added.length > 0) {
      const record: PromotionRecord = { capability: headCap.name, addedAgents: added };
      if (headCap.phase !== undefined) record.phase = headCap.phase;
      results.push(record);
    }
  }

  return results;
}

/**
 * Detect agents newly added to `optional_agents[]` (observational→advisory
 * promotions). Excludes agents that were previously in `mandatory_agents[]`
 * — those indicate a regression, handled separately.
 */
export function findAdvisoryAdds(base: Graph, head: Graph): PromotionRecord[] {
  const results: PromotionRecord[] = [];
  const baseCapsByName = new Map<string, PhaseCapability>();
  for (const cap of base.capabilities ?? []) {
    baseCapsByName.set(cap.name, cap);
  }

  for (const headCap of head.capabilities ?? []) {
    const baseCap = baseCapsByName.get(headCap.name);
    const baseOptional = new Set(baseCap?.optional_agents ?? []);
    const baseMandatory = new Set(baseCap?.mandatory_agents ?? []);
    const headOptional = headCap.optional_agents ?? [];

    const added = headOptional.filter(a => !baseOptional.has(a) && !baseMandatory.has(a));
    if (added.length > 0) {
      const record: PromotionRecord = { capability: headCap.name, addedAgents: added };
      if (headCap.phase !== undefined) record.phase = headCap.phase;
      results.push(record);
    }
  }

  return results;
}
