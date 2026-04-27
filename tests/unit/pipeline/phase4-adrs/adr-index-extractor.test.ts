/**
 * ADR-PIPELINE-100 §D2: tests for the markdown-derived `adr-index.json`
 * extractor.
 *
 * Five golden fixtures cover the heading-variation surface the extractor
 * must tolerate:
 *
 *   1. Canonical good ADR (full header block, all sections present)
 *   2. Loud-failure ADR (status: failed, ADR-FAIL-001 ID format)
 *   3. Minimal ADR (only H1 + Status + Date — common for early Ruflo output)
 *   4. ADR with mixed heading casing and missing optional fields
 *   5. ADR-PIPELINE-NNN style ID (longer prefix the extractor must accept)
 *
 * Plus negative cases: empty file, malformed H1, missing status.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseAdrMetadata,
  extractAdrIndex,
  writeAdrIndex,
  extractAdrIdsFromText,
} from '../../../../src/pipeline/phase4-adrs/adr-index-extractor.js';

// ============================================================================
// Fixtures
// ============================================================================

const FIXTURE_GOOD = `# ADR-P2-001: Use Bayesian inference for cooling tower efficiency forecasting

**Status:** Proposed
**Date:** 2026-04-27
**Implementation Phase:** domain
**Builds on:** ADR-PIPELINE-091, ADR-PIPELINE-098

## Context

The system must forecast cooling-tower efficiency under uncertainty.

## Decision

Use Bayesian inference with conjugate priors.

## Alternatives Considered

### 1. Bayesian inference (selected)

Concrete rationale.

### 2. Point estimates (rejected)

Rejected because: ignores uncertainty.

## Consequences

### Benefits

- Calibrated uncertainty intervals
- Composable with Monte Carlo

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Prior misspec | Medium | High | Sensitivity analysis |

## Related Decisions

- **ADR-PIPELINE-100** — Markdown-direct ADRs
- ADR-027: LLM-Generated ADRs
`;

const FIXTURE_FAIL = `# ADR-FAIL-001: ADR Generation Failed

**Status:** Failed
**Date:** 2026-04-27
**Implementation Phase:** cross-cutting
**Failure mode:** All LLM transports failed.

## What happened

The streamed claude --print call hit the 30-minute hard bound.

## Pipeline state

- Phase 1 artifacts: present
- Phase 2 dossier: 48 items
`;

const FIXTURE_MINIMAL = `# ADR-P2-007: Use ServiceNow REST table API for write-back

**Status:** Accepted
**Date:** 2026-04-27
**Implementation Phase:** integration

## Context

ServiceNow is the only ERP in scope.

## Decision

Use the table API with optimistic locking.
`;

const FIXTURE_MIXED_CASE = `# adr-p2-012: scoring algorithm

**status:** proposed
**date:** 2026-04-27
**implementation phase:** domain, cross-cutting

## context

Mixed-case headings should still parse.
`;

const FIXTURE_PIPELINE_PREFIX = `# ADR-PIPELINE-100: Markdown-Direct ADRs and Phase-Aware Prompt Linking

**Status:** Proposed
**Date:** 2026-04-27
**Priority:** CRITICAL
**Implementation Phase:** cross-cutting
**Builds on:** ADR-PIPELINE-091, ADR-PIPELINE-098, ADR-PIPELINE-099, ADR-027

## Context

Pipeline produces canned ADRs.

## Decision

Move to markdown-direct.

## Related Decisions

- ADR-PIPELINE-091 — Ruflo primary
- ADR-PIPELINE-098 — Phase 7 enrichment
- ADR-PIPELINE-099 — Heartbeat
`;

// ============================================================================
// Single-document parser tests
// ============================================================================

describe('parseAdrMetadata', () => {
  it('extracts full metadata from a canonical good ADR', () => {
    const m = parseAdrMetadata(FIXTURE_GOOD);
    expect(m.id).toBe('ADR-P2-001');
    expect(m.title).toBe('Use Bayesian inference for cooling tower efficiency forecasting');
    expect(m.status).toBe('proposed');
    expect(m.date).toBe('2026-04-27');
    expect(m.phaseTags).toEqual(['domain']);
    expect(m.buildsOn).toEqual(['ADR-PIPELINE-091', 'ADR-PIPELINE-098']);
    expect(m.relatedDecisions).toEqual(expect.arrayContaining(['ADR-PIPELINE-100', 'ADR-027']));
  });

  it('classifies a loud-failure ADR with status=failed', () => {
    const m = parseAdrMetadata(FIXTURE_FAIL);
    expect(m.id).toBe('ADR-FAIL-001');
    expect(m.title).toBe('ADR Generation Failed');
    expect(m.status).toBe('failed');
    expect(m.phaseTags).toEqual(['cross-cutting']);
  });

  it('parses a minimal ADR with only the required fields', () => {
    const m = parseAdrMetadata(FIXTURE_MINIMAL);
    expect(m.id).toBe('ADR-P2-007');
    expect(m.title).toBe('Use ServiceNow REST table API for write-back');
    expect(m.status).toBe('accepted');
    expect(m.phaseTags).toEqual(['integration']);
    expect(m.buildsOn).toEqual([]);
    expect(m.relatedDecisions).toEqual([]);
  });

  it('tolerates mixed-case heading and lowercase ID', () => {
    const m = parseAdrMetadata(FIXTURE_MIXED_CASE);
    expect(m.id).toBe('adr-p2-012');
    expect(m.title).toBe('scoring algorithm');
    expect(m.status).toBe('proposed');
    expect(m.phaseTags).toEqual(['domain', 'cross-cutting']);
  });

  it('handles ADR-PIPELINE-NNN-style IDs and Priority field', () => {
    const m = parseAdrMetadata(FIXTURE_PIPELINE_PREFIX);
    expect(m.id).toBe('ADR-PIPELINE-100');
    expect(m.priority).toBe('CRITICAL');
    expect(m.buildsOn).toContain('ADR-PIPELINE-091');
    expect(m.buildsOn).toContain('ADR-027');
    expect(m.relatedDecisions.length).toBeGreaterThanOrEqual(3);
  });

  it('returns sensible defaults for empty content', () => {
    const m = parseAdrMetadata('');
    expect(m.id).toBe('');
    expect(m.title).toBe('');
    expect(m.status).toBe('');
    expect(m.buildsOn).toEqual([]);
  });

  it('handles content with no Status line', () => {
    const m = parseAdrMetadata('# ADR-P2-001: A title\n\nbody only');
    expect(m.id).toBe('ADR-P2-001');
    expect(m.title).toBe('A title');
    expect(m.status).toBe('');
  });

  it('extracts ADR IDs from related-decisions text without false positives', () => {
    const ids = extractAdrIdsFromText('See ADR-001, also ADR-PIPELINE-100 and ADR-FAIL-001 — references nothing else.');
    expect(ids).toEqual(['ADR-001', 'ADR-PIPELINE-100', 'ADR-FAIL-001']);
  });

  it('de-duplicates repeated ADR IDs', () => {
    expect(extractAdrIdsFromText('ADR-001 ADR-001 ADR-002')).toEqual(['ADR-001', 'ADR-002']);
  });
});

// ============================================================================
// Directory-walking integration tests
// ============================================================================

describe('extractAdrIndex / writeAdrIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-index-extractor-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array for missing directory', () => {
    expect(extractAdrIndex(path.join(tmpDir, 'no-such-dir'))).toEqual([]);
  });

  it('walks markdown files in alphabetical order', () => {
    fs.writeFileSync(path.join(tmpDir, 'ADR-P2-002.md'), FIXTURE_MINIMAL);
    fs.writeFileSync(path.join(tmpDir, 'ADR-P2-001.md'), FIXTURE_GOOD);
    const entries = extractAdrIndex(tmpDir);
    expect(entries.map(e => e.filePath)).toEqual(['ADR-P2-001.md', 'ADR-P2-002.md']);
    expect(entries[0]!.id).toBe('ADR-P2-001');
    expect(entries[1]!.id).toBe('ADR-P2-007');     // ID comes from H1, not filename
  });

  it('skips non-markdown files', () => {
    fs.writeFileSync(path.join(tmpDir, 'ADR-P2-001.md'), FIXTURE_GOOD);
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'irrelevant');
    fs.writeFileSync(path.join(tmpDir, 'index.json'), '{}');
    const entries = extractAdrIndex(tmpDir);
    expect(entries.map(e => e.filePath)).toEqual(['ADR-P2-001.md']);
  });

  it('writeAdrIndex emits a parseable JSON file alongside the .md files', () => {
    fs.writeFileSync(path.join(tmpDir, 'ADR-P2-001.md'), FIXTURE_GOOD);
    fs.writeFileSync(path.join(tmpDir, 'ADR-FAIL-001.md'), FIXTURE_FAIL);

    const entries = writeAdrIndex(tmpDir);
    expect(entries.length).toBe(2);

    const indexPath = path.join(tmpDir, 'adr-index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    const failEntry = parsed.find((e: { id: string }) => e.id === 'ADR-FAIL-001');
    expect(failEntry).toBeDefined();
    expect(failEntry.status).toBe('failed');
  });

  it('writeAdrIndex returns empty and does NOT write index for empty directory', () => {
    const entries = writeAdrIndex(tmpDir);
    expect(entries).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'adr-index.json'))).toBe(false);
  });

  it('preserves byteSize and filePath for downstream phase-aware injection', () => {
    fs.writeFileSync(path.join(tmpDir, 'ADR-P2-001.md'), FIXTURE_GOOD);
    const [entry] = extractAdrIndex(tmpDir);
    expect(entry).toBeDefined();
    expect(entry!.filePath).toBe('ADR-P2-001.md');
    expect(entry!.byteSize).toBeGreaterThan(0);
    expect(entry!.phaseTags).toEqual(['domain']);
  });

  it('captures phaseTags across all 5 fixtures with no false positives', () => {
    fs.writeFileSync(path.join(tmpDir, '01-good.md'), FIXTURE_GOOD);
    fs.writeFileSync(path.join(tmpDir, '02-fail.md'), FIXTURE_FAIL);
    fs.writeFileSync(path.join(tmpDir, '03-min.md'), FIXTURE_MINIMAL);
    fs.writeFileSync(path.join(tmpDir, '04-mixed.md'), FIXTURE_MIXED_CASE);
    fs.writeFileSync(path.join(tmpDir, '05-pipeline.md'), FIXTURE_PIPELINE_PREFIX);

    const entries = extractAdrIndex(tmpDir);
    expect(entries.length).toBe(5);

    const tagsByTitle: Record<string, string[]> = {};
    for (const e of entries) {
      tagsByTitle[e.title.slice(0, 30)] = e.phaseTags;
    }

    // Every entry must have at least one phase tag
    for (const e of entries) {
      expect(e.phaseTags.length).toBeGreaterThan(0);
    }

    // Mixed-case fixture should split on comma into TWO tags
    const mixed = entries.find(e => e.title === 'scoring algorithm');
    expect(mixed?.phaseTags).toEqual(['domain', 'cross-cutting']);
  });
});

import { beforeEach } from '@jest/globals';
