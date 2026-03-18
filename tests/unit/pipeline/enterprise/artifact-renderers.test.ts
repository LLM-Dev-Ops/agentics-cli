/**
 * Artifact Renderers — Unit Tests (ADR-034)
 *
 * Tests each of the 14 dedicated artifact renderers to ensure:
 *   - Correct structure per ADR-034 specification
 *   - Consulting analogy present
 *   - Quality criteria footer
 *   - Degraded banner when applicable
 *   - Content populated from graph nodes
 */

import { ARTIFACT_RENDERERS } from '../../../../src/pipeline/enterprise/artifact-renderers.js';
import type { RenderContext } from '../../../../src/pipeline/enterprise/artifact-renderers.js';
import type { DecisionGraphNode } from '../../../../src/pipeline/enterprise/types.js';

function makeNode(overrides: Partial<DecisionGraphNode>): DecisionGraphNode {
  return {
    id: 'test-node-001',
    type: 'problem_definition',
    name: 'Test Node',
    content: {},
    summary: 'Test summary',
    producedBy: { domain: 'test', agent: 'test', role: 'test' },
    pass: 1,
    derivedFrom: [],
    timestamp: '2026-03-18T10:00:00Z',
    confidence: 0.9,
    status: 'complete',
    tags: [],
    version: 1,
    ...overrides,
  };
}

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    executionId: 'test-exec-001',
    prompt: 'Test enterprise analysis',
    timestamp: '2026-03-18T10:00:00Z',
    allNodes: [],
    relevantNodes: [],
    isDegraded: false,
    passesDegraded: [],
    ...overrides,
  };
}

describe('Artifact Renderers (ADR-034)', () => {

  describe('Registry', () => {
    test('has 14 renderers (1-14, excluding 15 provenance)', () => {
      expect(Object.keys(ARTIFACT_RENDERERS)).toHaveLength(14);
    });

    test('all renderers are functions', () => {
      for (const renderer of Object.values(ARTIFACT_RENDERERS)) {
        expect(typeof renderer).toBe('function');
      }
    });

    test('no renderer for artifact 15 (provenance)', () => {
      expect(ARTIFACT_RENDERERS[15]).toBeUndefined();
    });
  });

  describe('Artifact 1: Executive Decision Memo', () => {
    const render = ARTIFACT_RENDERERS[1]!;

    test('renders with correct title and consulting analogy', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'executive_memo', content: { decision: 'Approve' } })],
      }));
      expect(result).toContain('Executive Decision Memo');
      expect(result).toContain('McKinsey decision document');
      expect(result).toContain('Decision Requested');
      expect(result).toContain('Problem Statement');
      expect(result).toContain('Recommendation');
    });

    test('populates content from node', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({
          type: 'executive_memo',
          content: { decision: 'Approve with conditions', problem: 'Legacy migration' },
        })],
      }));
      expect(result).toContain('Approve with conditions');
      expect(result).toContain('Legacy migration');
    });

    test('shows degraded banner when degraded', () => {
      const result = render(makeContext({
        isDegraded: true,
        relevantNodes: [makeNode({ type: 'executive_memo' })],
      }));
      expect(result).toContain('DEGRADED');
    });

    test('includes quality criteria', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'executive_memo' })],
      }));
      expect(result).toContain('Quality Criteria');
    });
  });

  describe('Artifact 2: Executive Summary', () => {
    const render = ARTIFACT_RENDERERS[2]!;

    test('renders board briefing structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'executive_summary', content: { context: 'Digital transformation' } })],
      }));
      expect(result).toContain('Executive Summary');
      expect(result).toContain('Board briefing');
      expect(result).toContain('Strategic Context');
      expect(result).toContain('Problem Description');
      expect(result).toContain('Expected Outcomes');
      expect(result).toContain('Key Risks');
      expect(result).toContain('Timeline Summary');
    });
  });

  describe('Artifact 3: Architecture & Prototype Spec', () => {
    const render = ARTIFACT_RENDERERS[3]!;

    test('renders technology blueprint structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'system_architecture', content: { architecture: 'Microservices' } })],
      }));
      expect(result).toContain('Architecture & Prototype');
      expect(result).toContain('Accenture technology blueprint');
      expect(result).toContain('System Architecture');
      expect(result).toContain('Integration Map');
      expect(result).toContain('Service Boundaries');
      expect(result).toContain('Data Model');
      expect(result).toContain('ERP Integration');
    });
  });

  describe('Artifact 4: Simulation & Scenario Analysis', () => {
    const render = ARTIFACT_RENDERERS[4]!;

    test('renders scenario modeling structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'scenario', content: { deployment: 'Phased rollout' } })],
      }));
      expect(result).toContain('Simulation & Scenario');
      expect(result).toContain('CGI scenario modeling');
      expect(result).toContain('Deployment Scenarios');
      expect(result).toContain('Failure Scenarios');
      expect(result).toContain('Scaling Scenarios');
    });
  });

  describe('Artifact 5: Risk Assessment', () => {
    const render = ARTIFACT_RENDERERS[5]!;

    test('renders risk register table', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({
          type: 'risk_assessment',
          content: {
            risks: [
              { risk: 'Integration failure', category: 'technical', probability: 'medium', impact: 'high', mitigation: 'Staged rollout' },
            ],
          },
        })],
      }));
      expect(result).toContain('Risk Assessment');
      expect(result).toContain('Deloitte risk register');
      expect(result).toContain('Risk Register');
      expect(result).toContain('Integration failure');
      expect(result).toContain('Risk Heat Map');
      expect(result).toContain('Residual Risk');
    });
  });

  describe('Artifact 6: CostOps Financial Model', () => {
    const render = ARTIFACT_RENDERERS[6]!;

    test('renders TCO/ROI structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'cost_model', content: { year1: '$2.4M', roi: '158%' } })],
      }));
      expect(result).toContain('CostOps Financial Model');
      expect(result).toContain('Capgemini TCO/ROI');
      expect(result).toContain('Total Cost of Ownership');
      expect(result).toContain('Year 1');
      expect(result).toContain('Year 3');
      expect(result).toContain('Year 5');
      expect(result).toContain('ROI Projection');
    });
  });

  describe('Artifact 7: Compliance & Policy Analysis', () => {
    const render = ARTIFACT_RENDERERS[7]!;

    test('renders regulatory assessment structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'compliance_report', content: { regulatory: 'SOC2, GDPR' } })],
      }));
      expect(result).toContain('Compliance & Policy');
      expect(result).toContain('PwC regulatory');
      expect(result).toContain('Regulatory Landscape');
      expect(result).toContain('Data Governance');
      expect(result).toContain('AI Governance');
      expect(result).toContain('Policy Gaps');
    });
  });

  describe('Artifact 8: Implementation Roadmap', () => {
    const render = ARTIFACT_RENDERERS[8]!;

    test('renders phased roadmap structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'implementation_roadmap', content: { phase1: '3 months pilot' } })],
      }));
      expect(result).toContain('Implementation Roadmap');
      expect(result).toContain('Accenture delivery plan');
      expect(result).toContain('Phase 1');
      expect(result).toContain('Phase 2');
      expect(result).toContain('Phase 3');
      expect(result).toContain('Go/No-Go');
    });
  });

  describe('Artifact 9: Organizational Impact', () => {
    const render = ARTIFACT_RENDERERS[9]!;

    test('renders change management structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'org_impact', content: { teams: ['IT', 'Operations'] } })],
      }));
      expect(result).toContain('Organizational Impact');
      expect(result).toContain('McKinsey change management');
      expect(result).toContain('Teams Affected');
      expect(result).toContain('Training Requirements');
      expect(result).toContain('Readiness Score');
    });
  });

  describe('Artifact 10: Stakeholder Map', () => {
    const render = ARTIFACT_RENDERERS[10]!;

    test('renders RACI matrix structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'stakeholder_map', content: {} })],
      }));
      expect(result).toContain('Stakeholder Map');
      expect(result).toContain('RACI');
      expect(result).toContain('Responsible');
      expect(result).toContain('Accountable');
      expect(result).toContain('Executive Sponsor');
      expect(result).toContain('Decision Authority');
    });
  });

  describe('Artifact 11: Success Metrics & KPIs', () => {
    const render = ARTIFACT_RENDERERS[11]!;

    test('renders KPI dashboard structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'kpi_definition', content: {} })],
      }));
      expect(result).toContain('Success Metrics & KPIs');
      expect(result).toContain('Balanced scorecard');
      expect(result).toContain('KPI Dashboard');
      expect(result).toContain('Operational KPIs');
      expect(result).toContain('Financial KPIs');
      expect(result).toContain('Adoption KPIs');
    });
  });

  describe('Artifact 12: Decision Confidence Score', () => {
    const render = ARTIFACT_RENDERERS[12]!;

    test('renders confidence score structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'confidence_score', content: { overall: 87, financial: 90 } })],
      }));
      expect(result).toContain('Decision Confidence Score');
      expect(result).toContain('Unique to Agentics');
      expect(result).toContain('Component Scores');
      expect(result).toContain('Financial Outcome Stability');
      expect(result).toContain('Operational Risk Level');
      expect(result).toContain('Score Methodology');
    });

    test('includes degradation notes when passes degraded', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'confidence_score', content: { overall: 65 } })],
        passesDegraded: [2, 4],
      }));
      expect(result).toContain('Degradation Notes');
      expect(result).toContain('Pass 2');
      expect(result).toContain('Pass 4');
      expect(result).toContain('-10% penalty');
    });
  });

  describe('Artifact 13: OKRs & Strategic Alignment', () => {
    const render = ARTIFACT_RENDERERS[13]!;

    test('renders OKR structure', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({ type: 'okr_alignment', content: { objectives: ['Digital transformation'] } })],
      }));
      expect(result).toContain('OKRs & Strategic Alignment');
      expect(result).toContain('McKinsey/Capgemini');
      expect(result).toContain('Strategic Objectives');
      expect(result).toContain('Key Results');
      expect(result).toContain('Quarterly Milestones');
      expect(result).toContain('Alignment Score');
    });
  });

  describe('Artifact 14: RAID Log', () => {
    const render = ARTIFACT_RENDERERS[14]!;

    test('renders RAID structure with all 4 sections', () => {
      const result = render(makeContext({
        relevantNodes: [makeNode({
          type: 'raid_log',
          content: {
            risks: [{ risk: 'Budget overrun', severity: 'High' }],
            assumptions: [{ assumption: 'Cloud budget approved' }],
            issues: [{ issue: 'API version unclear' }],
            dependencies: [{ dependency: 'SAP upgrade', owner: 'IT' }],
          },
        })],
      }));
      expect(result).toContain('RAID Log');
      expect(result).toContain('CGI/Accenture PMO');
      expect(result).toContain('## Risks');
      expect(result).toContain('## Assumptions');
      expect(result).toContain('## Issues');
      expect(result).toContain('## Dependencies');
      expect(result).toContain('Budget overrun');
      expect(result).toContain('Cloud budget approved');
      expect(result).toContain('API version unclear');
      expect(result).toContain('SAP upgrade');
    });
  });

  describe('Cross-cutting renderer behavior', () => {
    test('all renderers handle empty relevantNodes gracefully', () => {
      for (const renderer of Object.values(ARTIFACT_RENDERERS)) {
        const result = renderer(makeContext());
        expect(result).toBeTruthy();
        expect(result.length).toBeGreaterThan(0);
      }
    });

    test('all renderers include quality criteria', () => {
      for (const renderer of Object.values(ARTIFACT_RENDERERS)) {
        const result = renderer(makeContext({
          relevantNodes: [makeNode({})],
        }));
        expect(result).toContain('Quality Criteria');
      }
    });
  });
});
