#!/usr/bin/env tsx
/**
 * check-graph-resolver-coverage.ts
 *
 * Parses every agent display name referenced in `docs/ecosystem.graph.json`
 * and diffs the set against the keys of `AGENT_NAME_TO_DOMAIN` in
 * `src/routing/graph-router.ts`. Exits non-zero with a line-numbered report on
 * any gap — graph references that the resolver cannot map silently drop at
 * dispatch time.
 *
 * Usage:
 *   npx tsx scripts/check-graph-resolver-coverage.ts
 *
 * Exit codes:
 *   0 — every graph-referenced agent display name has a resolver entry
 *   1 — one or more names in the graph are missing from the resolver map
 *   2 — usage/parse error
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

const GRAPH_PATH = 'docs/ecosystem.graph.json';
const ROUTER_PATH = 'src/routing/graph-router.ts';

interface GraphName {
  name: string;
  /** Line numbers in the graph file where this name appears. */
  lines: number[];
  /** Context fields the name appears in — `agents`, `mandatory_agents`, etc. */
  contexts: string[];
}

function main(): void {
  const verbose = argv.includes('--verbose') || argv.includes('-v');

  let graphRaw: string;
  let routerRaw: string;
  try {
    graphRaw = readFileSync(GRAPH_PATH, 'utf8');
    routerRaw = readFileSync(ROUTER_PATH, 'utf8');
  } catch (err) {
    stderr.write(`Could not read source files: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(2);
  }

  const graphNames = collectGraphNames(graphRaw);
  const resolverKeys = collectResolverKeys(routerRaw);

  const missing: GraphName[] = [];
  for (const entry of graphNames.values()) {
    if (!resolverKeys.has(entry.name)) {
      missing.push(entry);
    }
  }

  if (missing.length === 0) {
    stdout.write(`✓ ADR-PIPELINE-087 §8 resolver coverage: ${graphNames.size} graph-referenced agent names all resolve.\n`);
    if (verbose) {
      stdout.write(`  graph names examined: ${graphNames.size}\n`);
      stdout.write(`  resolver keys loaded: ${resolverKeys.size}\n`);
    }
    exit(0);
  }

  stderr.write('\nADR-PIPELINE-087 §8 — Resolver coverage FAILED\n');
  stderr.write(`${missing.length} agent name${missing.length === 1 ? '' : 's'} referenced in ${GRAPH_PATH} have no entry in AGENT_NAME_TO_DOMAIN at ${ROUTER_PATH}:\n\n`);

  const sorted = [...missing].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const lines = entry.lines.length > 0 ? entry.lines.join(', ') : '?';
    const contexts = entry.contexts.length > 0 ? ` [${entry.contexts.join(', ')}]` : '';
    stderr.write(`  - "${entry.name}" (${GRAPH_PATH}:${lines})${contexts}\n`);
  }

  stderr.write('\nFix: add each name to the AGENT_NAME_TO_DOMAIN map in src/routing/graph-router.ts\n');
  stderr.write('     with the appropriate { domain, agent } pair. If the name is a graph alias of\n');
  stderr.write('     an existing agent, map it to the same pair. If it is a new agent, you likely\n');
  stderr.write('     also need an entry in AGENT_DOMAINS (src/commands/agents.ts).\n');
  stderr.write('\nBackground: ADR-PIPELINE-087 documents why this guard exists.\n');
  exit(1);
}

/**
 * Extract every agent display name referenced by the ecosystem graph across
 * all contexts: `domains[].agents[]`, `capabilities[].mandatory_agents[]`,
 * `capabilities[].optional_agents[]`, and any other array of display names.
 *
 * The parse is done by walking the JSON tree rather than regexing the raw
 * text so we get correct handling of escapes, multi-line arrays, and future
 * fields. Line numbers are re-derived from the raw text for the error report.
 */
function collectGraphNames(raw: string): Map<string, GraphName> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    stderr.write(`Could not parse ${GRAPH_PATH} as JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(2);
  }

  const results = new Map<string, GraphName>();
  const lineIndex = buildNameLineIndex(raw);

  function record(name: string, context: string): void {
    const existing = results.get(name);
    if (existing) {
      if (!existing.contexts.includes(context)) existing.contexts.push(context);
      return;
    }
    results.set(name, {
      name,
      lines: lineIndex.get(name) ?? [],
      contexts: [context],
    });
  }

  function walk(node: unknown, parentKey: string | null): void {
    if (Array.isArray(node)) {
      // Arrays of display names (e.g. agents, mandatory_agents, optional_agents)
      if (parentKey && isAgentArrayKey(parentKey)) {
        for (const item of node) {
          if (typeof item === 'string' && isLikelyAgentName(item)) {
            record(item, parentKey);
          }
        }
      }
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        // Also catch `{ name: "...", ... }` inside weighted-agent objects
        if (key === 'name' && typeof value === 'string' && isLikelyAgentName(value) && parentKey && isAgentArrayKey(parentKey)) {
          record(value, parentKey);
        }
        walk(value, key);
      }
    }
  }

  walk(parsed, null);
  return results;
}

function isAgentArrayKey(key: string): boolean {
  return key === 'agents' || key === 'mandatory_agents' || key === 'optional_agents';
}

function isLikelyAgentName(value: string): boolean {
  // Matches "Something Agent" — the display-name convention used throughout
  // the graph (and the only values that end up in AGENT_NAME_TO_DOMAIN).
  return /\bAgent$/.test(value);
}

/**
 * Build a map of agent-name → [line numbers] by scanning the raw JSON text.
 * Display names in the graph are always wrapped in double quotes, so a line
 * scan is reliable enough for an error-report aid (not authoritative — JSON
 * parsing above is).
 */
function buildNameLineIndex(raw: string): Map<string, number[]> {
  const idx = new Map<string, number[]>();
  const lines = raw.split('\n');
  const quoteRe = /"([^"]+?\bAgent)"/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let m: RegExpExecArray | null;
    while ((m = quoteRe.exec(line)) !== null) {
      const name = m[1];
      if (!name) continue;
      const list = idx.get(name) ?? [];
      list.push(i + 1);
      idx.set(name, list);
    }
  }
  return idx;
}

/**
 * Extract the keys of AGENT_NAME_TO_DOMAIN from graph-router.ts source.
 *
 * The map is declared as `new Map([ ['Name', { ... }], ... ])`, so we scan for
 * `['<string>',` rows inside the map's block. We do not evaluate the TS, to
 * avoid a compilation dependency for this guard (the CI job calls this via
 * tsx without a build step).
 */
function collectResolverKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const mapBlock = source.match(/AGENT_NAME_TO_DOMAIN[\s\S]*?= new Map\(\[([\s\S]*?)\n\]\)/);
  if (!mapBlock) {
    stderr.write(`Could not locate AGENT_NAME_TO_DOMAIN in ${ROUTER_PATH}\n`);
    exit(2);
  }
  const body = mapBlock[1];
  if (!body) return keys;
  const rowRe = /^\s*\['([^']+)',/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(body)) !== null) {
    const key = m[1];
    if (key) keys.add(key);
  }
  return keys;
}

main();
