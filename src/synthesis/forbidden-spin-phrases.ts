/**
 * ADR-PIPELINE-071: Forbidden spin phrases for contested runs.
 *
 * On contested-tier consensus runs, executive documents must NOT minimize
 * the analytical uncertainty with confidence-projecting phrases. The list
 * below feeds FCR-010 in the cross-document consistency validator.
 *
 * Add to it carefully — false positives create reviewer noise. Each phrase
 * must be a near-unambiguous indicator that the document is downplaying
 * dissent.
 */

export interface ForbiddenSpinPhrase {
  readonly id: string;
  readonly pattern: RegExp;
  readonly note: string;
}

export const FORBIDDEN_SPIN_PHRASES: readonly ForbiddenSpinPhrase[] = [
  {
    id: 'no-meaningful-dissent',
    pattern: /no\s+meaningful\s+dissent/i,
    note: 'Implies agents agreed when consensus is contested.',
  },
  {
    id: 'direction-not-disputed',
    pattern: /direction\s+(?:is\s+)?not\s+disputed/i,
    note: 'Hides the actual disagreement on direction.',
  },
  {
    id: 'broad-agreement',
    pattern: /\bbroad\s+agreement\b/i,
    note: 'Misleading on contested runs.',
  },
  {
    id: 'agents-aligned',
    pattern: /\bagents?\s+aligned\b/i,
    note: 'Contradicts the contested classification.',
  },
  {
    id: 'unanimous',
    pattern: /\bunanimous(?:ly)?\b/i,
    note: 'Cannot be true on a contested run.',
  },
  {
    id: 'high-confidence',
    pattern: /\bhigh\s+confidence\b/i,
    note: 'Inappropriate when precision <50%.',
  },
  {
    id: 'no-significant-uncertainty',
    pattern: /no\s+significant\s+uncertainty/i,
    note: 'Directly contradicts the contested classification.',
  },
];

/**
 * Scan a document body for forbidden spin phrases. Returns one match per
 * phrase found (multiple matches of the same phrase collapse to one
 * report). Strips comments and code fences before scanning so prose
 * inside fenced blocks isn't misclassified — but markdown HTML comments
 * (`<!-- -->`) ARE preserved because executive documents legitimately
 * use them for fcv tags, not for narrative text.
 */
export function findForbiddenSpinPhrases(
  body: string,
): Array<{ id: string; line: number; rawText: string; note: string }> {
  // Strip fenced code blocks but keep the surrounding lines so line
  // numbers stay roughly anchored to the original document.
  const cleaned = body.replace(/```[\s\S]*?```/g, m => '\n'.repeat(m.split('\n').length - 1));
  const lines = cleaned.split(/\r?\n/);
  const findings: Array<{ id: string; line: number; rawText: string; note: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const phrase of FORBIDDEN_SPIN_PHRASES) {
      const key = `${phrase.id}:${i}`;
      if (seen.has(key)) continue;
      const m = line.match(phrase.pattern);
      if (m) {
        findings.push({
          id: phrase.id,
          line: i + 1,
          rawText: m[0],
          note: phrase.note,
        });
        seen.add(key);
      }
    }
  }
  return findings;
}
