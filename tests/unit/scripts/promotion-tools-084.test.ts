/**
 * ADR-PIPELINE-084 acceptance tests — promotion-guard diff detection + sampler.
 *
 * Exercises the pure logic of scripts/check-promotion-guard.ts (diff detection)
 * and tools/promotion-sampler.ts (window/blocking filters, sampling, CSV).
 */

import { describe, it, expect } from '@jest/globals';
import {
  findMandatoryPromotions,
  findAdvisoryAdds,
} from '../../../src/promotion/graph-diff.js';
import {
  parseFindings,
  filterInWindow,
  filterBlocking,
  drawSample,
  toCsv,
  type Finding,
} from '../../../src/promotion/sampler-lib.js';

// ============================================================================
// Promotion guard — diff detection
// ============================================================================

describe('ADR-084: check-promotion-guard diff detection', () => {
  const baseGraph = {
    capabilities: [
      {
        name: 'validation',
        phase: 8,
        mandatory_agents: ['Quality Scoring Agent', 'Output Consistency Agent'],
        optional_agents: ['Regression Detection Agent'],
      },
      {
        name: 'build',
        phase: 7,
        mandatory_agents: ['SDK Generator Agent'],
        optional_agents: ['CLI Command Generator Agent'],
      },
    ],
  };

  it('detects a new mandatory agent (gating promotion)', () => {
    const headGraph = {
      capabilities: [
        {
          name: 'validation',
          phase: 8,
          mandatory_agents: ['Quality Scoring Agent', 'Output Consistency Agent', 'Defect Prediction Agent'],
          optional_agents: ['Regression Detection Agent'],
        },
        baseGraph.capabilities[1]!,
      ],
    };
    const promotions = findMandatoryPromotions(baseGraph, headGraph);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.capability).toBe('validation');
    expect(promotions[0]!.phase).toBe(8);
    expect(promotions[0]!.addedAgents).toEqual(['Defect Prediction Agent']);
  });

  it('detects multiple new mandatory agents across multiple capabilities', () => {
    const headGraph = {
      capabilities: [
        {
          name: 'validation',
          phase: 8,
          mandatory_agents: ['Quality Scoring Agent', 'Output Consistency Agent', 'A', 'B'],
          optional_agents: [],
        },
        {
          name: 'build',
          phase: 7,
          mandatory_agents: ['SDK Generator Agent', 'C'],
          optional_agents: [],
        },
      ],
    };
    const promotions = findMandatoryPromotions(baseGraph, headGraph);
    expect(promotions).toHaveLength(2);
    const byName = new Map(promotions.map(p => [p.capability, p] as const));
    expect(byName.get('validation')?.addedAgents).toEqual(['A', 'B']);
    expect(byName.get('build')?.addedAgents).toEqual(['C']);
  });

  it('returns no promotions when mandatory arrays are unchanged', () => {
    const promotions = findMandatoryPromotions(baseGraph, baseGraph);
    expect(promotions).toHaveLength(0);
  });

  it('detects new optional agents as advisory adds', () => {
    const headGraph = {
      capabilities: [
        {
          name: 'validation',
          phase: 8,
          mandatory_agents: ['Quality Scoring Agent', 'Output Consistency Agent'],
          optional_agents: ['Regression Detection Agent', 'Test Design Agent'],
        },
        baseGraph.capabilities[1]!,
      ],
    };
    const advisoryAdds = findAdvisoryAdds(baseGraph, headGraph);
    expect(advisoryAdds).toHaveLength(1);
    expect(advisoryAdds[0]!.addedAgents).toEqual(['Test Design Agent']);
  });

  it('does not count mandatory→optional move as advisory add (it is a regression)', () => {
    const headGraph = {
      capabilities: [
        {
          name: 'validation',
          phase: 8,
          mandatory_agents: ['Quality Scoring Agent'], // Output Consistency Agent removed
          optional_agents: ['Regression Detection Agent', 'Output Consistency Agent'],
        },
        baseGraph.capabilities[1]!,
      ],
    };
    const advisoryAdds = findAdvisoryAdds(baseGraph, headGraph);
    // "Output Consistency Agent" was previously mandatory, so its appearance in
    // optional_agents is a regression, not a new advisory add.
    const addedAgents = advisoryAdds.flatMap(a => a.addedAgents);
    expect(addedAgents).not.toContain('Output Consistency Agent');
  });

  it('handles newly-created capability (not in base) with mandatory agents as promotion', () => {
    const headGraph = {
      capabilities: [
        ...baseGraph.capabilities,
        {
          name: 'new_phase',
          phase: 12,
          mandatory_agents: ['New Agent'],
          optional_agents: [],
        },
      ],
    };
    const promotions = findMandatoryPromotions(baseGraph, headGraph);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]!.capability).toBe('new_phase');
    expect(promotions[0]!.addedAgents).toEqual(['New Agent']);
  });

  it('handles empty base gracefully', () => {
    const empty = { capabilities: [] };
    const promotions = findMandatoryPromotions(empty, baseGraph);
    expect(promotions.length).toBeGreaterThanOrEqual(2); // both caps have mandatory agents
  });
});

// ============================================================================
// Promotion sampler — pure logic
// ============================================================================

describe('ADR-084: promotion-sampler pure logic', () => {
  const now = new Date('2026-05-15T12:00:00Z');

  const mkFinding = (overrides: Partial<Finding>): Finding => ({
    id: 'f-1',
    timestamp: '2026-05-10T00:00:00Z',
    domain: 'quality_engineering',
    agent: 'defect-prediction',
    severity: 'medium',
    blocking: true,
    summary: 'example finding',
    ...overrides,
  });

  describe('parseFindings', () => {
    it('parses JSON array format', () => {
      const raw = JSON.stringify([mkFinding({ id: 'a' }), mkFinding({ id: 'b' })]);
      const parsed = parseFindings(raw);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.id).toBe('a');
    });

    it('parses JSONL format', () => {
      const raw = [
        JSON.stringify(mkFinding({ id: 'a' })),
        JSON.stringify(mkFinding({ id: 'b' })),
        JSON.stringify(mkFinding({ id: 'c' })),
      ].join('\n');
      const parsed = parseFindings(raw);
      expect(parsed).toHaveLength(3);
    });

    it('handles empty input', () => {
      expect(parseFindings('')).toEqual([]);
      expect(parseFindings('   \n  ')).toEqual([]);
    });

    it('ignores blank JSONL lines', () => {
      const raw = `${JSON.stringify(mkFinding({ id: 'a' }))}\n\n${JSON.stringify(mkFinding({ id: 'b' }))}\n`;
      expect(parseFindings(raw)).toHaveLength(2);
    });
  });

  describe('filterInWindow', () => {
    it('includes findings within the window', () => {
      const findings = [
        mkFinding({ id: '1', timestamp: '2026-05-10T00:00:00Z' }), // 5 days ago
        mkFinding({ id: '2', timestamp: '2026-05-14T00:00:00Z' }), // 1 day ago
      ];
      const filtered = filterInWindow(findings, 'quality_engineering', 7, now);
      expect(filtered).toHaveLength(2);
    });

    it('excludes findings outside the window', () => {
      const findings = [
        mkFinding({ id: 'old', timestamp: '2026-05-01T00:00:00Z' }), // 14 days ago
        mkFinding({ id: 'recent', timestamp: '2026-05-12T00:00:00Z' }),
      ];
      const filtered = filterInWindow(findings, 'quality_engineering', 7, now);
      expect(filtered.map(f => f.id)).toEqual(['recent']);
    });

    it('excludes findings from a different domain', () => {
      const findings = [
        mkFinding({ id: 'qe', timestamp: '2026-05-10T00:00:00Z', domain: 'quality_engineering' }),
        mkFinding({ id: 'other', timestamp: '2026-05-10T00:00:00Z', domain: 'safety' }),
      ];
      const filtered = filterInWindow(findings, 'quality_engineering', 7, now);
      expect(filtered.map(f => f.id)).toEqual(['qe']);
    });
  });

  describe('filterBlocking', () => {
    it('keeps only findings with blocking=true', () => {
      const findings = [
        mkFinding({ id: 'blocking', blocking: true }),
        mkFinding({ id: 'info', blocking: false }),
      ];
      expect(filterBlocking(findings)).toHaveLength(1);
      expect(filterBlocking(findings)[0]!.id).toBe('blocking');
    });
  });

  describe('drawSample', () => {
    it('returns everything when N ≤ 30', () => {
      const findings = Array.from({ length: 25 }, (_, i) => mkFinding({ id: `f${i}` }));
      const sample = drawSample(findings, { seed: 42 });
      expect(sample).toHaveLength(25);
    });

    it('returns floor of 30 when 30 < N < 300', () => {
      const findings = Array.from({ length: 100 }, (_, i) => mkFinding({ id: `f${i}` }));
      const sample = drawSample(findings, { seed: 42 });
      // 10% of 100 = 10, floor 30 kicks in
      expect(sample).toHaveLength(30);
    });

    it('returns 10% when N is large enough that 10% > 30', () => {
      const findings = Array.from({ length: 500 }, (_, i) => mkFinding({ id: `f${i}` }));
      const sample = drawSample(findings, { seed: 42 });
      // 10% of 500 = 50
      expect(sample).toHaveLength(50);
    });

    it('caps at 200 when 10% > 200', () => {
      const findings = Array.from({ length: 5000 }, (_, i) => mkFinding({ id: `f${i}` }));
      const sample = drawSample(findings, { seed: 42 });
      expect(sample).toHaveLength(200);
    });

    it('is deterministic with a seed', () => {
      const findings = Array.from({ length: 100 }, (_, i) => mkFinding({ id: `f${i}` }));
      const s1 = drawSample(findings, { seed: 1234 });
      const s2 = drawSample(findings, { seed: 1234 });
      expect(s1.map(f => f.id)).toEqual(s2.map(f => f.id));
    });

    it('different seeds produce different samples', () => {
      const findings = Array.from({ length: 100 }, (_, i) => mkFinding({ id: `f${i}` }));
      const s1 = drawSample(findings, { seed: 1 });
      const s2 = drawSample(findings, { seed: 9999 });
      expect(s1.map(f => f.id)).not.toEqual(s2.map(f => f.id));
    });

    it('handles empty input', () => {
      expect(drawSample([])).toEqual([]);
    });
  });

  describe('toCsv', () => {
    it('emits a header row', () => {
      const csv = toCsv([]);
      expect(csv).toBe('id,timestamp,domain,agent,severity,blocking,summary,fp_label\n');
    });

    it('emits one row per finding with blank fp_label', () => {
      const findings = [mkFinding({ id: 'a', summary: 'finding a' })];
      const csv = toCsv(findings);
      const lines = csv.split('\n');
      expect(lines[0]).toContain('fp_label');
      expect(lines[1]).toBe('a,2026-05-10T00:00:00Z,quality_engineering,defect-prediction,medium,true,finding a,');
    });

    it('escapes commas and quotes in summary', () => {
      const findings = [mkFinding({ id: 'a', summary: 'has, comma and "quote"' })];
      const csv = toCsv(findings);
      expect(csv).toContain('"has, comma and ""quote"""');
    });

    it('handles newlines in summary via quoting', () => {
      const findings = [mkFinding({ id: 'a', summary: 'line1\nline2' })];
      const csv = toCsv(findings);
      expect(csv).toContain('"line1\nline2"');
    });
  });

  // ========================================================================
  // End-to-end pipeline
  // ========================================================================
  describe('end-to-end: parse → filter → sample → CSV', () => {
    it('produces a valid sample CSV from synthetic JSONL input', () => {
      const findings: Finding[] = [];
      for (let i = 0; i < 200; i++) {
        findings.push(mkFinding({
          id: `f${i}`,
          timestamp: '2026-05-12T00:00:00Z',
          blocking: i % 2 === 0,
        }));
      }
      const raw = findings.map(f => JSON.stringify(f)).join('\n');

      const parsed = parseFindings(raw);
      const windowed = filterInWindow(parsed, 'quality_engineering', 7, now);
      const blocking = filterBlocking(windowed);
      const sample = drawSample(blocking, { seed: 42 });
      const csv = toCsv(sample);

      expect(parsed).toHaveLength(200);
      expect(windowed).toHaveLength(200);
      expect(blocking).toHaveLength(100);
      // 10% of 100 = 10, floor 30 applies
      expect(sample).toHaveLength(30);

      const lines = csv.trim().split('\n');
      expect(lines).toHaveLength(31); // 1 header + 30 rows
    });
  });
});
