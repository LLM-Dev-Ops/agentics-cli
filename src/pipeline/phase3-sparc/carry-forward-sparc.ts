/**
 * Shared Phase 2 → Phase 3 SPARC carry-forward (ADR-PIPELINE-093/094 boundary fix).
 *
 * When Phase 3 cannot refine Ruflo `engineering/sparc-specification.md` (because
 * Ruflo produced no engineering SPARC in this environment), the pipeline carries
 * the Phase 2 SPARC output forward. Phase 2 writes title-cased markdown files
 * (`Specification.md`, `Architecture.md`, …), but every downstream consumer — the
 * phase4/phase5a dependency gate (`phase3/sparc/specification.md`), the prompt
 * generator, and the SPARC structural checks — expects the lower-cased canonical
 * names the healthy phase3-sparc coordinator emits (`specification.md`, …).
 *
 * On a case-sensitive filesystem a verbatim copy therefore produces
 * `phase3/sparc/Specification.md`, which the gate cannot see, so Phase 4 is
 * skipped and Phases 5–6 cascade-fail. Two call sites previously copied
 * verbatim (`auto-chain.ts` recovery block and `phase3-sparc-coordinator.ts`
 * `carryForwardPhase2SPARC`). This module is the single normalising copy both use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Copy Phase 2 SPARC (and, when present, TDD) artifacts into the Phase 3
 * directory, normalising markdown filenames to the lower-cased canonical form
 * the downstream gates and generators require, and mirroring the specification
 * to `engineering/sparc-specification.md` (the gate's accepted alternative path).
 *
 * Idempotent and best-effort: individual copy failures are skipped rather than
 * thrown, so a partial Phase 2 never aborts the carry-forward. Returns the list
 * of runDir-relative paths written (for manifest/telemetry logging).
 *
 * @param phase2Dir absolute path to `<runDir>/phase2`
 * @param phase3Dir absolute path to `<runDir>/phase3`
 */
export function carryForwardPhase2Sparc(phase2Dir: string, phase3Dir: string): string[] {
  const runDir = path.dirname(phase3Dir);
  const written: string[] = [];

  const phase2SparcDir = path.join(phase2Dir, 'sparc');
  const phase3SparcDir = path.join(phase3Dir, 'sparc');
  if (fs.existsSync(phase2SparcDir)) {
    fs.mkdirSync(phase3SparcDir, { recursive: true });
    for (const file of fs.readdirSync(phase2SparcDir)) {
      const src = path.join(phase2SparcDir, file);
      let isFile = false;
      try {
        isFile = fs.statSync(src).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;

      // Canonical (lower-cased) destination — what every downstream consumer
      // reads. `sparc-combined.json`, `specification.json`, etc. are already
      // lower-case so this is a no-op for them.
      const canonical = file.toLowerCase();
      try {
        fs.copyFileSync(src, path.join(phase3SparcDir, canonical));
        written.push(`phase3/sparc/${canonical}`);
      } catch {
        // best-effort — skip this file
      }
      // Preserve the original-cased name too when it differs, so any consumer
      // still keyed on the title-cased Phase 2 name keeps working.
      if (canonical !== file) {
        try {
          fs.copyFileSync(src, path.join(phase3SparcDir, file));
        } catch {
          // best-effort
        }
      }
    }
  }

  // Mirror the specification into engineering/ — the gate accepts either
  // `phase3/sparc/specification.md` OR `engineering/sparc-specification.md`.
  const specSrc = firstExisting([
    path.join(phase3SparcDir, 'specification.md'),
    path.join(phase2SparcDir, 'Specification.md'),
    path.join(phase2SparcDir, 'specification.md'),
    path.join(phase2SparcDir, 'sparc-combined.md'),
  ]);
  if (specSrc) {
    try {
      const engDir = path.join(runDir, 'engineering');
      fs.mkdirSync(engDir, { recursive: true });
      fs.copyFileSync(specSrc, path.join(engDir, 'sparc-specification.md'));
      written.push('engineering/sparc-specification.md');
    } catch {
      // best-effort
    }
  }

  // Carry TDD artifacts forward verbatim (their names are already canonical
  // and downstream reads are case-consistent with Phase 2's output).
  const phase2TddDir = path.join(phase2Dir, 'tdd');
  if (fs.existsSync(phase2TddDir)) {
    const phase3TddDir = path.join(phase3Dir, 'tdd');
    fs.mkdirSync(phase3TddDir, { recursive: true });
    for (const file of fs.readdirSync(phase2TddDir)) {
      const src = path.join(phase2TddDir, file);
      try {
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(phase3TddDir, file));
          written.push(`phase3/tdd/${file}`);
        }
      } catch {
        // best-effort
      }
    }
  }

  return written;
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
