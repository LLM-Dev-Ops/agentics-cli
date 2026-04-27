/**
 * ADR-PIPELINE-100 §D2: thin extractor that walks `phase4/adrs/*.md` and
 * derives a flat `adr-index.json` for downstream consumers.
 *
 * The markdown files are the canonical source of truth (per §D1). This index
 * is intentionally narrow — it captures only the fields downstream consumers
 * navigate by (id, title, status, date, phaseTags, filePath, buildsOn,
 * relatedDecisions). We do NOT try to faithfully serialise the full ADR back
 * into JSON; that's the pattern that produced the 5-field schema this ADR is
 * replacing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Build phase tag — drives phase-aware ADR injection in implementation prompts (§D4). */
export type AdrPhaseTag =
  | 'foundation'
  | 'domain'
  | 'integration'
  | 'api'
  | 'deployment'
  | 'operations'
  | 'cross-cutting'
  | string; // tolerant of unknown tags emitted by future LLM versions

/**
 * Flat metadata head for one ADR markdown document.
 * `filePath` is relative to the directory the index was written to.
 */
export interface AdrIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly status: 'proposed' | 'accepted' | 'deprecated' | 'failed' | string;
  readonly date: string;
  readonly priority?: string;
  readonly buildsOn: string[];
  readonly relatedDecisions: string[];
  readonly phaseTags: AdrPhaseTag[];
  readonly filePath: string;
  readonly byteSize: number;
}

/**
 * Public entry point: walk `adrDir` for `*.md` files, extract metadata,
 * write `adr-index.json` alongside them, and return the list of entries.
 *
 * Tolerant of:
 *   - missing/unreadable files (skipped with a stderr warning)
 *   - malformed headers (best-effort fallback values)
 *   - mixed casing in `**Status:**`/`**Date:**` lines
 *   - alternative ID formats (ADR-NNN, ADR-P2-NNN, ADR-PIPELINE-NNN, ADR-FAIL-NNN)
 */
export function extractAdrIndex(adrDir: string): AdrIndexEntry[] {
  if (!fs.existsSync(adrDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(adrDir)
      .filter(f => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch {
    return [];
  }

  const entries: AdrIndexEntry[] = [];

  for (const file of files) {
    const abs = path.join(adrDir, file);
    let content: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      content = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      process.stderr.write(`[adr-index-extractor] skipping unreadable ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }

    const meta = parseAdrMetadata(content);
    entries.push({
      id: meta.id || stripExt(file),
      title: meta.title || stripExt(file),
      status: meta.status || 'unknown',
      date: meta.date || '',
      priority: meta.priority,
      buildsOn: meta.buildsOn,
      relatedDecisions: meta.relatedDecisions,
      phaseTags: meta.phaseTags,
      filePath: file,
      byteSize: stat.size,
    });
  }

  return entries;
}

/**
 * Convenience: extract the index AND write it to `adrDir/adr-index.json`.
 * Returns the entries it wrote.
 */
export function writeAdrIndex(adrDir: string): AdrIndexEntry[] {
  const entries = extractAdrIndex(adrDir);
  if (entries.length === 0) return entries;

  const indexPath = path.join(adrDir, 'adr-index.json');
  try {
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o644,
    });
  } catch (err) {
    process.stderr.write(`[adr-index-extractor] failed to write ${indexPath}: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  return entries;
}

// ============================================================================
// Internal: tolerant markdown parsing
// ============================================================================

interface AdrMetadata {
  id: string;
  title: string;
  status: string;
  date: string;
  priority?: string;
  buildsOn: string[];
  relatedDecisions: string[];
  phaseTags: AdrPhaseTag[];
}

/**
 * Parse a single ADR markdown document into flat metadata.
 *
 * Heading conventions (matched case-insensitively, tolerant of whitespace):
 *   `# ADR-XXX-NNN: <title>`            → id, title
 *   `**Status:** <value>`                → status (lower-cased)
 *   `**Date:** <value>`                  → date
 *   `**Priority:** <value>`              → priority (optional)
 *   `**Builds on:** ADR-X, ADR-Y, ...`   → buildsOn (extract ADR IDs)
 *   `**Implementation Phase:** <tag>`    → phaseTags (split on `,` `/` `|`)
 *   `## Related Decisions` + bulleted    → relatedDecisions (extract ADR IDs)
 */
export function parseAdrMetadata(content: string): AdrMetadata {
  const meta: AdrMetadata = {
    id: '',
    title: '',
    status: '',
    date: '',
    buildsOn: [],
    relatedDecisions: [],
    phaseTags: [],
  };

  // H1: `# ADR-...: <title>` or just `# <title>` if the LLM forgot the ID
  // prefix. Case-insensitive on the ADR prefix so lowercase IDs (rare but
  // possible in user-pasted ADRs) still parse.
  const h1Re = /^#\s+(ADR[-\w]*\d+)[:\s]+(.+?)\s*$/im;
  const h1 = content.match(h1Re);
  if (h1) {
    meta.id = h1[1]!.trim();
    meta.title = h1[2]!.trim();
  } else {
    const anyH1 = content.match(/^#\s+(.+?)\s*$/m);
    if (anyH1) {
      const text = anyH1[1]!.trim();
      const idMatch = text.match(/^(ADR[-\w]*\d+)[:\s]+(.+)$/i);
      if (idMatch) {
        meta.id = idMatch[1]!.trim();
        meta.title = idMatch[2]!.trim();
      } else {
        meta.title = text;
      }
    }
  }

  meta.status = pickFieldLine(content, 'Status').toLowerCase();
  meta.date = pickFieldLine(content, 'Date');
  const priority = pickFieldLine(content, 'Priority');
  if (priority) meta.priority = priority;

  const buildsOnLine = pickFieldLine(content, 'Builds on');
  if (buildsOnLine) {
    meta.buildsOn = extractAdrIdsFromText(buildsOnLine);
  }

  const phaseLine = pickFieldLine(content, 'Implementation Phase');
  if (phaseLine) {
    meta.phaseTags = phaseLine
      .split(/[,/|]+/)
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0);
  }

  // Related Decisions section
  const relatedSection = pickSection(content, /^##\s+related\s+decisions\b/im);
  if (relatedSection) {
    meta.relatedDecisions = extractAdrIdsFromText(relatedSection);
  }

  return meta;
}

/**
 * Match a `**FieldName:** value` line and return the trimmed value.
 * Case-insensitive on the field name; preserves the value's case.
 */
function pickFieldLine(content: string, fieldName: string): string {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, 'im');
  const m = content.match(re);
  return m ? m[1]!.trim() : '';
}

/**
 * Extract the body text under a heading (matched by `headingRe`) up to the
 * next H1/H2, or end of document. Returns the trimmed body or empty string
 * when the heading is absent.
 */
function pickSection(content: string, headingRe: RegExp): string {
  const m = headingRe.exec(content);
  if (!m) return '';
  const start = m.index + m[0].length;
  const after = content.slice(start);
  const nextHeading = /^(?:#{1,2})\s+/m.exec(after);
  return (nextHeading ? after.slice(0, nextHeading.index) : after).trim();
}

/**
 * Extract ADR IDs (e.g. ADR-PIPELINE-100, ADR-027, ADR-P2-005, ADR-FAIL-001)
 * from a free-text blob. De-duplicates while preserving first-seen order.
 */
export function extractAdrIdsFromText(text: string): string[] {
  const re = /\bADR[-\w]*\d+\b/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[0];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function stripExt(filename: string): string {
  return filename.replace(/\.md$/i, '');
}
