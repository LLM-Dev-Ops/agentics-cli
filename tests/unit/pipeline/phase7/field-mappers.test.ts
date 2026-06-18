/**
 * ADR-PIPELINE-111 (Phase 7) — Template-Family Field Mapper tests.
 *
 * Enforces that the templateId families:
 *   1. are all unique AND cover every templateId the registry actually uses
 *      (no registry row falls back to the generic spec).
 *   2. fall back to GENERIC_FAMILY_SPEC for unknown ids.
 *   3. each carry a usable, non-trivial spec (label, focus, emphasizeAgents).
 *
 * The registry templateId set is read live from deliverables-registry.ts so a
 * future registry addition without a matching family spec is a hard failure.
 *
 * NOTE on the "33 families" figure: ADR-PIPELINE-111 / the field-mappers
 * header describe "33 families", but the SPECS array currently registers 35
 * (the registry uses 33 distinct templateIds; the specs additionally carry
 * `go-no-go` and `investment-thesis`, which no current registry row references
 * — those deliverables are folded into other families in the registry). The
 * count assertion below pins the live registered count and is documented so the
 * doc/code drift is explicit. The load-bearing guarantee — every registry
 * templateId has a non-generic spec — is enforced separately and is clean.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENERIC_FAMILY_SPEC,
  getFamilySpec,
  registeredFamilyIds,
} from '../../../../src/pipeline/phase7/field-mappers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  'src',
  'pipeline',
  'phase7',
  'deliverables-registry.ts',
);

/** Distinct templateIds actually referenced by the deliverables registry. */
function registryTemplateIds(): string[] {
  const src = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const ids = new Set<string>();
  const re = /templateId:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    ids.add(m[1]!);
  }
  return [...ids];
}

describe('ADR-111 — registeredFamilyIds()', () => {
  it('registers exactly one family per registry templateId (33)', () => {
    const ids = registeredFamilyIds();
    // All ids are unique (no duplicate family registrations).
    expect(new Set(ids).size).toBe(ids.length);
    // ADR-111: one family spec per distinct registry templateId — no orphans.
    const registryIds = new Set(registryTemplateIds());
    expect(ids).toHaveLength(registryIds.size);
    expect(new Set(ids)).toEqual(registryIds);
  });

  it('does not include the generic sentinel id', () => {
    expect(registeredFamilyIds()).not.toContain(GENERIC_FAMILY_SPEC.templateId);
  });

  it('covers EVERY templateId actually used by the registry (no generic fallback)', () => {
    const used = registryTemplateIds();
    // Sanity: the registry must reference a non-trivial number of templateIds.
    expect(used.length).toBeGreaterThan(20);

    const gaps: string[] = [];
    for (const id of used) {
      const spec = getFamilySpec(id);
      if (spec.templateId === GENERIC_FAMILY_SPEC.templateId) {
        gaps.push(id);
      }
    }
    expect(gaps).toEqual([]);

    // Every registry id is in the registered family set.
    const registered = new Set(registeredFamilyIds());
    for (const id of used) {
      expect(registered.has(id)).toBe(true);
    }
  });
});

describe('ADR-111 — getFamilySpec()', () => {
  it('returns the GENERIC_FAMILY_SPEC for an unknown templateId', () => {
    expect(getFamilySpec('totally-unknown')).toBe(GENERIC_FAMILY_SPEC);
  });

  it('returns a non-generic spec for each registered id', () => {
    for (const id of registeredFamilyIds()) {
      const spec = getFamilySpec(id);
      expect(spec.templateId).toBe(id);
      expect(spec.templateId).not.toBe(GENERIC_FAMILY_SPEC.templateId);
    }
  });
});

describe('ADR-111 — every registered spec is well-formed', () => {
  it('has a non-empty label, a focus >40 chars, and >=1 emphasizeAgents', () => {
    const offenders: Array<{ id: string; reason: string }> = [];
    for (const id of registeredFamilyIds()) {
      const spec = getFamilySpec(id);
      if (!spec.label || spec.label.trim().length === 0) {
        offenders.push({ id, reason: 'empty label' });
      }
      if (!spec.focus || spec.focus.trim().length <= 40) {
        offenders.push({ id, reason: `focus too short (${spec.focus?.length ?? 0})` });
      }
      if (!Array.isArray(spec.emphasizeAgents) || spec.emphasizeAgents.length < 1) {
        offenders.push({ id, reason: 'no emphasizeAgents' });
      }
    }
    expect(offenders).toEqual([]);
  });
});
