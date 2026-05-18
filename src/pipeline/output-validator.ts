/**
 * Output Structural Validator (ADR-PIPELINE-101 §harness)
 *
 * Post-write structural checks for the three load-bearing artifact families:
 * SPARC specification files, ADR markdown files, and implementation-prompts
 * directories. The goal is visibility, not enforcement — failures are logged
 * loudly via stderr with a [STRUCTURE FAIL] prefix so the operator can act on
 * them, but the pipeline does not crash. A crash would break iteration; a
 * loud log forces the operator to see the failure without losing partial work.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface StructuralCheckResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly filePath: string;
  readonly artifactKind: 'sparc' | 'adr' | 'implementation-prompts';
}

/** Required H2 headers in every ADR markdown file. */
const ADR_REQUIRED_HEADERS = ['## Context', '## Decision', '## Consequences'] as const;

/** SPARC sections — section names matched case-insensitively as H1/H2/H3. */
const SPARC_SECTIONS = [
  { label: 'Specification', re: /^#{1,3}\s*(?:[1-5]\.\s*)?(?:S\b|Specification)/im },
  { label: 'Pseudocode',    re: /^#{1,3}\s*(?:[1-5]\.\s*)?(?:P\b|Pseudocode)/im },
  { label: 'Architecture',  re: /^#{1,3}\s*(?:[1-5]\.\s*)?(?:A\b|Architecture)/im },
  { label: 'Refinement',    re: /^#{1,3}\s*(?:[1-5]\.\s*)?(?:R\b|Refinement)/im },
  { label: 'Completion',    re: /^#{1,3}\s*(?:[1-5]\.\s*)?(?:C\b|Completion)/im },
] as const;

/**
 * Validate a SPARC specification file. Combined single-file form or split
 * files both accepted — caller passes whichever path exists.
 */
export function validateSparc(filePath: string): StructuralCheckResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: ['file-not-found'], filePath, artifactKind: 'sparc' };
  }
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      missing: [`unreadable: ${err instanceof Error ? err.message : String(err)}`],
      filePath,
      artifactKind: 'sparc',
    };
  }
  if (content.trim().length < 200) {
    return { ok: false, missing: ['file-too-short'], filePath, artifactKind: 'sparc' };
  }
  const missing = SPARC_SECTIONS.filter((s) => !s.re.test(content)).map((s) => s.label);
  return { ok: missing.length === 0, missing, filePath, artifactKind: 'sparc' };
}

/**
 * Validate every ADR markdown file in adrDir. Each must contain Context,
 * Decision, and Consequences H2 headers. Returns per-file results — caller
 * decides whether to log or escalate.
 */
export function validateAdrDir(adrDir: string): StructuralCheckResult[] {
  if (!fs.existsSync(adrDir)) {
    return [{ ok: false, missing: ['directory-not-found'], filePath: adrDir, artifactKind: 'adr' }];
  }
  let files: string[];
  try {
    files = fs
      .readdirSync(adrDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'adr-index.md');
  } catch (err) {
    return [{
      ok: false,
      missing: [`unreadable: ${err instanceof Error ? err.message : String(err)}`],
      filePath: adrDir,
      artifactKind: 'adr',
    }];
  }
  if (files.length === 0) {
    return [{ ok: false, missing: ['no-adr-files'], filePath: adrDir, artifactKind: 'adr' }];
  }
  return files.map((filename): StructuralCheckResult => {
    const fp = path.join(adrDir, filename);
    let content: string;
    try {
      content = fs.readFileSync(fp, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        missing: [`unreadable: ${err instanceof Error ? err.message : String(err)}`],
        filePath: fp,
        artifactKind: 'adr',
      };
    }
    const missing = ADR_REQUIRED_HEADERS.filter((h) => !content.includes(h));
    if (content.trim().length < 400) {
      return { ok: false, missing: ['file-too-short', ...missing], filePath: fp, artifactKind: 'adr' };
    }
    return { ok: missing.length === 0, missing, filePath: fp, artifactKind: 'adr' };
  });
}

/**
 * Verify the implementation-prompts directory has numbered prompts in the
 * impl-NNN-*.md form. Counts the prompts and reports zero or too-few cases.
 */
export function validateImplementationPrompts(
  promptsDir: string,
  minPrompts = 5,
): StructuralCheckResult {
  if (!fs.existsSync(promptsDir)) {
    return {
      ok: false,
      missing: ['directory-not-found'],
      filePath: promptsDir,
      artifactKind: 'implementation-prompts',
    };
  }
  let files: string[];
  try {
    files = fs.readdirSync(promptsDir).filter((f) => /^impl-\d+-.+\.md$/.test(f));
  } catch (err) {
    return {
      ok: false,
      missing: [`unreadable: ${err instanceof Error ? err.message : String(err)}`],
      filePath: promptsDir,
      artifactKind: 'implementation-prompts',
    };
  }
  if (files.length < minPrompts) {
    return {
      ok: false,
      missing: [`expected at least ${minPrompts} prompts, found ${files.length}`],
      filePath: promptsDir,
      artifactKind: 'implementation-prompts',
    };
  }
  return {
    ok: true,
    missing: [],
    filePath: promptsDir,
    artifactKind: 'implementation-prompts',
  };
}

/**
 * Emit a clearly-formatted block of structural failures to stderr. Returns
 * the count of failures so the caller can record it on the phase summary.
 */
export function logStructuralFailures(
  results: readonly StructuralCheckResult[],
  phaseLabel: string,
): number {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return 0;
  process.stderr.write(`\n  [STRUCTURE FAIL] ${phaseLabel}: ${failed.length} artifact(s) below quality bar\n`);
  for (const r of failed) {
    process.stderr.write(`  [STRUCTURE FAIL] ${r.artifactKind} :: ${r.filePath}\n`);
    process.stderr.write(`                   Missing: ${r.missing.join(', ')}\n`);
  }
  process.stderr.write(`  [STRUCTURE FAIL] Re-run the phase or inspect the artifacts — they do not match the harness contract.\n\n`);
  return failed.length;
}
