import { describe, it, expect, vi } from 'vitest';
import { CompetitiveAnalysisService, maturityLabel } from '../src/services/competitive-analysis.js';
import type { Logger } from '../src/logger.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('ADR-PRR-008: Competitive Analysis', () => {
  describe('CompetitiveAnalysisService.build()', () => {
    it('returns the 3 peer firms', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      expect(analysis.peerFirms).toEqual(['Salesforce', 'Google', 'Siemens']);
    });

    it('returns 5 capability rows', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      expect(analysis.capabilities).toHaveLength(5);
    });

    it('each capability row has current, post-pilot, and all 3 peer states', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      for (const cap of analysis.capabilities) {
        expect(cap.capability).toBeTruthy();
        expect(cap.currentState).toBeDefined();
        expect(cap.postPilotState).toBeDefined();
        expect(cap.peers.Salesforce).toBeDefined();
        expect(cap.peers.Google).toBeDefined();
        expect(cap.peers.Siemens).toBeDefined();
        expect(cap.peers.Salesforce.note).toBeTruthy();
      }
    });

    it('includes Occupancy Telemetry, Space Analytics, ESG Reporting, Facilities Automation, Decision Governance', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      const names = analysis.capabilities.map(c => c.capability);
      expect(names).toContain('Occupancy Telemetry');
      expect(names).toContain('Space Analytics');
      expect(names).toContain('ESG Reporting (Scope 2)');
      expect(names).toContain('Facilities Automation');
      expect(names).toContain('Decision Governance');
    });

    it('post-pilot state is equal to or higher than current state for every capability', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      const rank: Record<string, number> = { none: 0, manual: 1, rule_based: 2, automated: 3, ai_optimized: 4 };
      for (const cap of analysis.capabilities) {
        expect(rank[cap.postPilotState]).toBeGreaterThanOrEqual(rank[cap.currentState]);
      }
    });

    it('returns at least 3 risks of inaction', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      expect(analysis.risksOfInaction.length).toBeGreaterThanOrEqual(3);
    });

    it('every risk has a driver and timeframe', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      for (const risk of analysis.risksOfInaction) {
        expect(risk.risk).toBeTruthy();
        expect(risk.drivenBy).toBeTruthy();
        expect(risk.timeframe).toBeTruthy();
      }
    });

    it('includes EU CSRD regulatory risk', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      const csrdRisk = analysis.risksOfInaction.find(r => r.drivenBy.includes('CSRD'));
      expect(csrdRisk).toBeDefined();
    });

    it('gap-to-close has one entry per capability', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      expect(analysis.gapToClose).toHaveLength(analysis.capabilities.length);
    });

    it('gap-to-close levelsJumped is non-negative', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      for (const gap of analysis.gapToClose) {
        expect(gap.levelsJumped).toBeGreaterThanOrEqual(0);
      }
    });

    it('at least one capability jumps to match or exceed top peer', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      const hasLeadingJump = analysis.gapToClose.some(g => g.comparison.includes('exceeds'));
      expect(hasLeadingJump).toBe(true);
    });

    it('includes at least 4 sources with citations', () => {
      const service = new CompetitiveAnalysisService(mockLogger());
      const analysis = service.build();
      expect(analysis.sources.length).toBeGreaterThanOrEqual(4);
      expect(analysis.sources.some(s => s.includes('Salesforce'))).toBe(true);
      expect(analysis.sources.some(s => s.includes('Google'))).toBe(true);
      expect(analysis.sources.some(s => s.includes('Siemens'))).toBe(true);
      expect(analysis.sources.some(s => s.includes('CSRD'))).toBe(true);
    });
  });

  describe('maturityLabel', () => {
    it('returns human-readable labels for all maturity levels', () => {
      expect(maturityLabel('none')).toBe('None');
      expect(maturityLabel('manual')).toBe('Manual');
      expect(maturityLabel('rule_based')).toBe('Rule-Based');
      expect(maturityLabel('automated')).toBe('Automated');
      expect(maturityLabel('ai_optimized')).toBe('AI-Optimized');
    });
  });
});
