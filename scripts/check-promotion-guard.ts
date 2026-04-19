#!/usr/bin/env tsx
/**
 * check-promotion-guard.ts (ADR-PIPELINE-084 §3 enforcement CLI).
 *
 * Detects when a PR promotes domain agents to `mandatory_agents[]` in
 * docs/ecosystem.graph.json without an accompanying ADR update and CHANGELOG
 * entry. Pure diff logic lives in src/promotion/graph-diff.ts.
 *
 * Usage:
 *   npx tsx scripts/check-promotion-guard.ts <base-ref> [head-ref]
 *
 * Exit codes:
 *   0 — no promotion detected OR promotion detected with required docs
 *   1 — gating promotion detected but missing ADR or CHANGELOG
 *   2 — usage error
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import {
  findMandatoryPromotions,
  findAdvisoryAdds,
  type Graph,
} from '../src/promotion/graph-diff.js';

const GRAPH_PATH = 'docs/ecosystem.graph.json';
const ADR_DIR = 'docs/adrs/';
const CHANGELOG = 'CHANGELOG.md';

function main(): void {
  const baseRef = argv[2];
  const headRef = argv[3] ?? 'HEAD';

  if (!baseRef) {
    stderr.write('Usage: check-promotion-guard.ts <base-ref> [head-ref]\n');
    exit(2);
  }

  const baseGraph = loadGraphAtRef(baseRef);
  const headGraph = loadGraphAtHead(headRef);

  if (!baseGraph) {
    stdout.write(`No base graph found at ${baseRef} — nothing to compare, skipping.\n`);
    exit(0);
  }

  const promotions = findMandatoryPromotions(baseGraph, headGraph);
  const advisoryAdds = findAdvisoryAdds(baseGraph, headGraph);

  if (promotions.length === 0 && advisoryAdds.length === 0) {
    stdout.write('✓ No domain-binding promotions detected in this PR.\n');
    exit(0);
  }

  const changedFiles = gitChangedFiles(baseRef, headRef);
  const hasAdrUpdate = changedFiles.some(f => f.startsWith(ADR_DIR));
  const hasChangelog = changedFiles.some(f => f === CHANGELOG);

  stdout.write(`\nADR-084 Promotion Guard — change summary\n`);
  stdout.write(`  gating promotions (optional→mandatory):  ${promotions.length}\n`);
  stdout.write(`  advisory additions (new optional):       ${advisoryAdds.length}\n`);
  stdout.write(`  ADR update present:                      ${hasAdrUpdate ? 'yes' : 'NO'}\n`);
  stdout.write(`  CHANGELOG entry present:                 ${hasChangelog ? 'yes' : 'NO'}\n\n`);

  if (promotions.length > 0) {
    stdout.write('Gating promotions detected:\n');
    for (const p of promotions) {
      stdout.write(`  - phase ${p.phase ?? '?'} (${p.capability}): +[${p.addedAgents.join(', ')}]\n`);
    }
    stdout.write('\n');

    if (!hasAdrUpdate) stderr.write('❌ FAIL: gating promotion without accompanying ADR update under docs/adrs/\n');
    if (!hasChangelog) stderr.write('❌ FAIL: gating promotion without accompanying CHANGELOG.md entry\n');
    if (!hasAdrUpdate || !hasChangelog) {
      stderr.write('\nSee docs/processes/domain-promotion.md §3.2 for the full procedure.\n');
      stderr.write('Use docs/templates/promotion-changelog.md for the CHANGELOG entry.\n');
      exit(1);
    }
    stdout.write('✓ Gating promotion has required ADR + CHANGELOG documentation.\n');
  }

  if (advisoryAdds.length > 0) {
    stdout.write('Advisory additions detected (non-blocking):\n');
    for (const a of advisoryAdds) {
      stdout.write(`  - phase ${a.phase ?? '?'} (${a.capability}): +[${a.addedAgents.join(', ')}]\n`);
    }
    if (!hasAdrUpdate || !hasChangelog) {
      stdout.write('  ⚠ advisory adds SHOULD include ADR + CHANGELOG (ADR-084 §3.1). Not failing.\n');
    }
  }

  exit(0);
}

function loadGraphAtRef(ref: string): Graph | null {
  try {
    const content = execSync(`git show ${ref}:${GRAPH_PATH}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(content) as Graph;
  } catch {
    return null;
  }
}

function loadGraphAtHead(headRef: string): Graph {
  if (headRef === 'HEAD' && existsSync(GRAPH_PATH)) {
    return JSON.parse(readFileSync(GRAPH_PATH, 'utf-8')) as Graph;
  }
  try {
    const content = execSync(`git show ${headRef}:${GRAPH_PATH}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(content) as Graph;
  } catch {
    if (existsSync(GRAPH_PATH)) {
      return JSON.parse(readFileSync(GRAPH_PATH, 'utf-8')) as Graph;
    }
    throw new Error(`Could not load graph at ref ${headRef} or working tree`);
  }
}

function gitChangedFiles(baseRef: string, headRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${baseRef} ${headRef}`, { encoding: 'utf-8' });
    return out.split('\n').filter(l => l.trim().length > 0);
  } catch {
    return [];
  }
}

main();
