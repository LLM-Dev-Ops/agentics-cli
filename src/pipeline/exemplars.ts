/**
 * Exemplar Loader (ADR-PIPELINE-101 §harness)
 *
 * Single canonical loader for the gold-standard reference templates that
 * drive Phase 2/3/4 prompts. Replaces the prior 7-path fallback in
 * ruflo-phase-executor.ts that returned an empty string when files were
 * missing — silent-degrade behaviour produced canned LLM slop.
 *
 * Throws `ExemplarNotFoundError` with the searched-path list when an
 * exemplar can't be located, on the principle that the pipeline must NOT
 * pretend to work without the quality bar these documents establish.
 *
 * The exemplars live under `docs/templates/` and ship with the published
 * package (see `files` in package.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExemplarName =
  | 'sparc-specification'
  | 'adr'
  | 'implementation-prompts';

const FILENAMES: Record<ExemplarName, string> = {
  'sparc-specification': 'sparc-specification-good-example.md',
  'adr': 'ADR-Good-Example.md',
  'implementation-prompts': 'Implementation-Prompts-Good-Example.md',
};

export class ExemplarNotFoundError extends Error {
  readonly code = 'EXEMPLAR_NOT_FOUND' as const;
  readonly exemplar: ExemplarName;
  readonly searched: readonly string[];

  constructor(name: ExemplarName, searched: readonly string[]) {
    super(
      `[HARNESS] Exemplar "${name}" (${FILENAMES[name]}) not found.\n` +
        `Searched:\n${searched.map((p) => `  - ${p}`).join('\n')}\n` +
        `Exemplars must exist under docs/templates/ in either the consumer CWD ` +
        `or the published package root. Without them the Phase 2/3/4 prompts ` +
        `cannot enforce a quality bar and the pipeline produces canned slop. ` +
        `Aborting per ADR-PIPELINE-101 §harness.`,
    );
    this.name = 'ExemplarNotFoundError';
    this.exemplar = name;
    this.searched = searched;
  }
}

/**
 * Resolve every path we'll try for a given exemplar, in priority order:
 *   1. <cwd>/docs/templates/<file>          (dev mode, running from repo root)
 *   2. walk up from this module's directory looking for docs/templates/<file>
 *      (installed mode — finds it inside node_modules/@llm-dev-ops/agentics-cli/)
 */
function candidatePaths(name: ExemplarName): string[] {
  const filename = FILENAMES[name];
  const out: string[] = [];

  out.push(path.resolve(process.cwd(), 'docs/templates', filename));

  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 10 && dir !== path.dirname(dir); i++) {
      out.push(path.join(dir, 'docs', 'templates', filename));
      dir = path.dirname(dir);
    }
  } catch {
    // import.meta.url unavailable in some test contexts; CWD candidate remains
  }

  return out;
}

/**
 * Load an exemplar as a UTF-8 string. Throws ExemplarNotFoundError if the
 * file can't be located.
 */
export function loadExemplar(name: ExemplarName): string {
  const tried = candidatePaths(name);
  for (const candidate of tried) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    } catch {
      // unreadable — continue to next candidate
    }
  }
  throw new ExemplarNotFoundError(name, tried);
}

/**
 * Wrap an exemplar in a clearly-marked block ready to embed in an LLM prompt.
 * The wrapper sets the explicit instruction that the LLM must COPY THE
 * STRUCTURE of the exemplar without copying its subject matter.
 */
export function embedExemplar(name: ExemplarName): string {
  const body = loadExemplar(name);
  const label = LABELS[name];
  return `\n\n## Structural exemplar — ${label} (ADR-PIPELINE-101 §harness)\n\n` +
    `The following is a canonical "good" ${label} from an unrelated domain. ` +
    `**Match its structure, depth, specificity, and rigour for the user's domain above.** ` +
    `Copy the section headings, level of detail, tables, code samples, and rule patterns. ` +
    `Do NOT reuse its subject matter — the user's scenario above is your subject.\n\n` +
    `<EXEMPLAR name="${FILENAMES[name]}">\n${body}\n</EXEMPLAR>\n`;
}

const LABELS: Record<ExemplarName, string> = {
  'sparc-specification': 'SPARC Specification',
  'adr': 'Architecture Decision Record',
  'implementation-prompts': 'Implementation Prompts',
};
