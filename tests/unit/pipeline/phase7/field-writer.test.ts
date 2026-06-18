/**
 * ADR-PIPELINE-111 (Phase 7) — LLM Field Writer pure-function tests.
 *
 * Covers the deterministic, offline-safe exports of field-writer.ts:
 *   - extractJsonObject: tolerant JSON extraction from LLM text.
 *   - sanitizeFields: placeholder allow-listing + D5 money guard.
 *   - buildFieldWriterPrompt: prompt shape / coherence instructions.
 *
 * `writeFieldsViaLLM` shells to the real `claude` binary and returns `{}`
 * offline, so it is intentionally NOT exercised here.
 */

import { describe, it, expect } from '@jest/globals';

import {
  buildFieldWriterPrompt,
  extractJsonObject,
  sanitizeFields,
  type FieldWriterInput,
} from '../../../../src/pipeline/phase7/field-writer.js';
import { getFamilySpec } from '../../../../src/pipeline/phase7/field-mappers.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeInput(overrides: Partial<FieldWriterInput> = {}): FieldWriterInput {
  return {
    slug: 'roi-model',
    templateId: 'financial-model',
    family: getFamilySpec('financial-model'),
    placeholders: ['cost_benefit', 'roi_narrative', 'unit_economics'],
    scenarioQuery: 'Should we migrate the data platform to a managed service?',
    agentEvidence: 'costops/roi found a 240% return with $8.5M/yr savings.',
    knownFields: { artifact_title: 'ROI Model', slug: 'roi-model' },
    canonicalFigures: 'ROI 240%, savings $8.5M/yr',
    traceId: 'trace-111',
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// extractJsonObject
// --------------------------------------------------------------------------

describe('ADR-111 — extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a":"b"}')).toEqual({ a: 'b' });
  });

  it('parses JSON inside ```json fences', () => {
    const text = 'Here is the result:\n```json\n{"a":"b","c":"d"}\n```\nDone.';
    expect(extractJsonObject(text)).toEqual({ a: 'b', c: 'd' });
  });

  it('parses JSON inside bare ``` fences (no json tag)', () => {
    const text = '```\n{"x":"1"}\n```';
    expect(extractJsonObject(text)).toEqual({ x: '1' });
  });

  it('parses JSON with leading and trailing prose', () => {
    const text = 'Sure! The JSON object is {"k":"v"} and that is all.';
    expect(extractJsonObject(text)).toEqual({ k: 'v' });
  });

  it('handles nested braces and a string value containing a brace', () => {
    const text = '{"a":{"b":1},"c":"}"}';
    expect(extractJsonObject(text)).toEqual({ a: { b: 1 }, c: '}' });
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here at all')).toBeNull();
  });

  it('returns null on a malformed object', () => {
    expect(extractJsonObject('{"a": }')).toBeNull();
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error — exercising the runtime guard.
    expect(extractJsonObject(null)).toBeNull();
  });

  it('returns null for a top-level JSON array (not an object)', () => {
    // The first `{` is inside the array element, so a balanced object is found,
    // but plain `[1,2,3]` has no `{` at all → null.
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// sanitizeFields
// --------------------------------------------------------------------------

describe('ADR-111 — sanitizeFields', () => {
  it('keeps only keys present in input.placeholders', () => {
    const input = makeInput({ placeholders: ['keep_me'], canonicalFigures: '' });
    const out = sanitizeFields(
      { keep_me: 'kept', drop_me: 'dropped', another: 'x' },
      input,
    );
    expect(out).toEqual({ keep_me: 'kept' });
  });

  it('drops non-string and empty-string values', () => {
    const input = makeInput({
      placeholders: ['a', 'b', 'c', 'd', 'e'],
      canonicalFigures: '',
    });
    const out = sanitizeFields(
      {
        a: 'good',
        b: '',
        c: '   ',
        // @ts-expect-error — deliberately wrong types from arbitrary LLM JSON.
        d: 42,
        // @ts-expect-error — deliberately wrong types from arbitrary LLM JSON.
        e: { nested: true },
      },
      input,
    );
    expect(out).toEqual({ a: 'good' });
  });

  it('trims surviving string values', () => {
    const input = makeInput({ placeholders: ['a'], canonicalFigures: '' });
    expect(sanitizeFields({ a: '  padded  ' }, input)).toEqual({ a: 'padded' });
  });

  describe('D5 money guard', () => {
    const input = makeInput({
      placeholders: ['narrative', 'fabricated', 'fabricated_comma', 'no_money'],
      canonicalFigures: 'ROI 240%, savings $8.5M/yr',
    });

    it('keeps a value that cites a canonical figure ($8.5M)', () => {
      const out = sanitizeFields(
        { narrative: 'We expect $8.5M/yr in savings at a 240% ROI.' },
        input,
      );
      expect(out).toEqual({
        narrative: 'We expect $8.5M/yr in savings at a 240% ROI.',
      });
    });

    it('drops a value that introduces a NEW figure ($99M)', () => {
      const out = sanitizeFields(
        { fabricated: 'This unlocks a $99M opportunity.' },
        input,
      );
      expect(out).toEqual({});
    });

    it('drops a value that introduces a NEW comma-formatted figure ($12,000)', () => {
      const out = sanitizeFields(
        { fabricated_comma: 'Setup costs $12,000 upfront.' },
        input,
      );
      expect(out).toEqual({});
    });

    it('keeps a value with no dollar figures at all', () => {
      const out = sanitizeFields(
        { no_money: 'Returns are strongly positive (240% ROI).' },
        input,
      );
      expect(out).toEqual({
        no_money: 'Returns are strongly positive (240% ROI).',
      });
    });

    it('keeps canonical but drops fabricated when both appear across fields', () => {
      const out = sanitizeFields(
        {
          narrative: 'Savings of $8.5M/yr.',
          fabricated: 'Plus a hidden $99M windfall.',
        },
        input,
      );
      expect(out).toEqual({ narrative: 'Savings of $8.5M/yr.' });
    });
  });
});

// --------------------------------------------------------------------------
// buildFieldWriterPrompt
// --------------------------------------------------------------------------

describe('ADR-111 — buildFieldWriterPrompt', () => {
  const input = makeInput();
  const prompt = buildFieldWriterPrompt(input);

  it('includes the family focus text', () => {
    expect(prompt).toContain(input.family.focus);
  });

  it('includes every placeholder name', () => {
    for (const p of input.placeholders) {
      expect(prompt).toContain(p);
    }
  });

  it('includes the canonical figures', () => {
    expect(prompt).toContain(input.canonicalFigures);
  });

  it('instructs the writer to output ONLY JSON', () => {
    expect(prompt).toContain('Output ONLY the JSON object');
  });

  it('instructs the writer to never invent dollar figures', () => {
    expect(prompt).toContain('NEVER invent dollar figures');
  });
});
