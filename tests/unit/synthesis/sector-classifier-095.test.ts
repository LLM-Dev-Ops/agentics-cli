/**
 * ADR-PIPELINE-095 — Sector classifier calibration.
 *
 * The originating failure: run `911d93ad-...` (Archibus / workplace-strategy
 * / hybrid-work / 68k employees / sustainability brief) was misclassified as
 * `hospitality` because the hospitality rule matched a bare `/\boccupanc/i`
 * pattern on "office occupancy". The cascading wrong unit-economics
 * ($0.82/orn × 1360 hotel rooms = $1,115/yr enterprise savings) drove the
 * financial-vs-executive-summary divergence the user has been seeing.
 *
 * These tests pin the realistic shape of CRE / office briefs against the
 * tighter hospitality patterns and the broader CRE patterns.
 */

import { describe, it, expect } from '@jest/globals';

import { classifySector } from '../../../src/synthesis/domain-unit-registry.js';

const ARCHIBUS_BRIEF = `I lead sustainability and workplace strategy for a global technology company with approximately 68,000 employees operating offices across North America, Europe, and Asia. Our facilities management, space planning, and financial operations are managed through Archibus ERP.

One of the challenges we face is reducing the environmental impact of our office spaces. Many offices are underutilized due to hybrid work, yet we still consume energy, heating, and resources as if they are fully occupied.

Right now, our teams review occupancy and energy data separately. It's difficult to clearly see which spaces are being underused or how changes to office layouts or schedules would impact both cost and sustainability.

We believe AI could help us make better decisions about how we use office space.`;

describe('ADR-095 — classifySector against the originating Archibus brief', () => {
  it('classifies the originating-run brief as commercial-real-estate (NOT hospitality)', () => {
    expect(classifySector(ARCHIBUS_BRIEF)).toBe('commercial-real-estate');
  });

  it('Archibus alone is a strong CRE signal', () => {
    expect(classifySector('We use Archibus to track our buildings.')).toBe('commercial-real-estate');
  });

  it('"workplace strategy" is a CRE signal (was previously unclassified)', () => {
    expect(classifySector('I lead workplace strategy for a tech company.')).toBe('commercial-real-estate');
  });

  it('"facilities management" (plural) is a CRE signal — handles the originating-run wording', () => {
    expect(classifySector('Our facilities management team uses an enterprise system.')).toBe('commercial-real-estate');
  });

  it('"office space" is a CRE signal', () => {
    expect(classifySector('We want to optimize our office space across regions.')).toBe('commercial-real-estate');
  });

  it('"underused offices" + "hybrid work" is a CRE signal', () => {
    expect(classifySector('Many offices are underused due to hybrid work patterns.')).toBe('commercial-real-estate');
  });

  it('"office and occupancy data" is a CRE signal — the exact originating-run phrasing', () => {
    expect(classifySector('Our teams review office and occupancy data separately.')).toBe('commercial-real-estate');
  });
});

describe('ADR-095 — hospitality patterns no longer false-positive on bare "occupancy"', () => {
  it('"office occupancy" alone does NOT classify as hospitality', () => {
    // Pre-095 this matched `/\boccupanc/i` and tipped to hospitality.
    expect(classifySector('We track office occupancy patterns weekly.')).not.toBe('hospitality');
  });

  it('"meeting room occupancy" alone does NOT classify as hospitality', () => {
    expect(classifySector('Conference and meeting room occupancy is tracked.')).not.toBe('hospitality');
  });

  it('"building occupancy" alone does NOT classify as hospitality', () => {
    expect(classifySector('Building occupancy varies by floor.')).not.toBe('hospitality');
  });
});

describe('ADR-095 — hospitality classifier still works on real hospitality briefs', () => {
  it('"hotel" classifies as hospitality', () => {
    expect(classifySector('We run a hotel chain and want to optimize linen.')).toBe('hospitality');
  });

  it('"resort" classifies as hospitality', () => {
    expect(classifySector('Our resort properties span 12 sites globally.')).toBe('hospitality');
  });

  it('"room night" + housekeeping classifies as hospitality', () => {
    expect(classifySector('Room nights and housekeeping costs are our biggest line items.')).toBe('hospitality');
  });

  it('"hotel occupancy" still classifies as hospitality (tightened pattern)', () => {
    expect(classifySector('Hotel occupancy at our 54-property portfolio dropped.')).toBe('hospitality');
  });

  it('"guest occupancy" classifies as hospitality (tightened pattern)', () => {
    expect(classifySector('Guest occupancy data drives the housekeeping schedule.')).toBe('hospitality');
  });
});

describe('ADR-095 — other sectors still classify correctly', () => {
  it('healthcare', () => {
    expect(classifySector('Our hospital network has 12 clinics and 4 patient-facing systems.')).toBe('healthcare');
  });
  it('manufacturing', () => {
    expect(classifySector('Our factory production line OEE has dropped.')).toBe('manufacturing');
  });
  it('data-center', () => {
    expect(classifySector('Our data center PUE is 1.6 and we want to lower it.')).toBe('data-center');
  });
  it('fleet', () => {
    expect(classifySector('Our truck fleet electrification is 40% complete.')).toBe('fleet');
  });
  it('retail', () => {
    expect(classifySector('Our retail chain has 200 stores with point-of-sale data.')).toBe('retail');
  });
});
