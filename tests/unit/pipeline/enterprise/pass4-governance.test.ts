/**
 * Pass 4 — Governance, Compliance & CostOps (ADR-036) — Unit Tests
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  executePass4,
  PASS4_WORKSTREAM_CONFIGS,
} from '../../../../src/pipeline/enterprise/pass4-governance.js';
import type {
  Pass4Result,
} from '../../../../src/pipeline/enterprise/pass4-governance.js';
import { DecisionGraph } from '../../../../src/pipeline/enterprise/decision-graph.js';
import { ProvenanceTracker } from '../../../../src/pipeline/enterprise/provenance-tracker.js';
import type { AgentRef, AgentInvocationResult, PassNumber } from '../../../../src/pipeline/enterprise/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeResult(agent: AgentRef, response: unknown, status = 200): AgentInvocationResult {
  return { agent, status, response, durationMs: 50, pass: 4, timestamp: new Date().toISOString() };
}

function createMockInvoker(
  map: Record<string, { response: unknown; status?: number }>,
): (agents: readonly AgentRef[], payload: Record<string, unknown>, pass: PassNumber, timeoutMs: number) => Promise<AgentInvocationResult[]> {
  return async (agents) =>
    agents.map(a => {
      const key = `${a.domain}/${a.agent}`;
      const entry = map[key];
      return entry ? makeResult(a, entry.response, entry.status ?? 200) : makeResult(a, { error: 'no mock' }, 500);
    });
}

describe('Pass 4 — Governance, Compliance & CostOps (ADR-036)', () => {
  let graph: DecisionGraph;
  let tracker: ProvenanceTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass4-test-'));
    graph = new DecisionGraph('pass4-exec-001', tmpDir);
    tracker = new ProvenanceTracker('pass4-exec-001');

    // Seed Pass 1 nodes
    graph.createNode({
      type: 'problem_definition', name: 'Problem', content: { domain: 'fintech' },
      summary: 'Fintech payment platform', producedBy: { domain: 'copilot', agent: 'planner', role: 'P' }, pass: 1,
    });
    graph.createNode({
      type: 'business_context', name: 'Business', content: { industry: 'financial_services', geography: 'EU' },
      summary: 'EU-based financial services', producedBy: { domain: 'copilot', agent: 'clarifier', role: 'C' }, pass: 1,
    });

    // Seed Pass 2 nodes (scenarios + risk signals feed CostOps)
    graph.createNode({
      type: 'scenario', name: 'Deploy Scenario', content: { type: 'deployment', name: 'Cloud Deploy', mitigationStrategy: 'Phased rollout' },
      summary: 'Phased cloud deployment', producedBy: { domain: 'simulator', agent: 'what-if', role: 'S' }, pass: 2,
    });
    graph.createNode({
      type: 'risk_signal', name: 'Auth Risk', content: { category: 'security', severity: 'high' },
      summary: 'Authentication vulnerability', producedBy: { domain: 'sentinel', agent: 'anomaly', role: 'R' }, pass: 2,
    });

    // Seed Pass 3 nodes
    graph.createNode({
      type: 'system_architecture', name: 'Architecture', content: { services: ['payment-api', 'auth-service'] },
      summary: 'Microservices architecture', producedBy: { domain: 'orchestrator', agent: 'workflow', role: 'A' }, pass: 3,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Workstream Configurations
  // ==========================================================================

  describe('PASS4_WORKSTREAM_CONFIGS', () => {
    test('has 4 workstreams', () => {
      expect(PASS4_WORKSTREAM_CONFIGS).toHaveLength(4);
    });

    test('workstream A has 9 shield agents', () => {
      const ws = PASS4_WORKSTREAM_CONFIGS.find(w => w.id === 'security-compliance');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(9);
      expect(ws!.agents.every(a => a.domain === 'shield')).toBe(true);
    });

    test('workstream B has 3 policy-engine agents', () => {
      const ws = PASS4_WORKSTREAM_CONFIGS.find(w => w.id === 'policy-enforcement');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(3);
      expect(ws!.agents.every(a => a.domain === 'policy-engine')).toBe(true);
    });

    test('workstream C has 5 costops agents', () => {
      const ws = PASS4_WORKSTREAM_CONFIGS.find(w => w.id === 'financial-modeling');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(5);
      expect(ws!.agents.every(a => a.domain === 'costops')).toBe(true);
    });

    test('workstream D has 3 governance-dashboard agents', () => {
      const ws = PASS4_WORKSTREAM_CONFIGS.find(w => w.id === 'governance-visibility');
      expect(ws).toBeDefined();
      expect(ws!.agents).toHaveLength(3);
      expect(ws!.agents.every(a => a.domain === 'governance-dashboard')).toBe(true);
    });
  });

  // ==========================================================================
  // Full Execution with Mock Agents
  // ==========================================================================

  describe('executePass4 with successful agents', () => {
    const mockInvoker = createMockInvoker({
      // Shield
      'shield/prompt-injection': { response: { vectors: ['XSS via user input'], riskLevel: 'medium' } },
      'shield/pii': { response: { exposures: [{ dataType: 'PII - email', location: 'API response', risk: 'Unencrypted', remediation: 'Encrypt' }] } },
      'shield/redaction': { response: { result: 'ok' } },
      'shield/secrets': { response: { exposures: [{ dataType: 'API key', location: 'config', risk: 'Hardcoded', remediation: 'Use vault' }] } },
      'shield/toxicity': { response: { risks: ['Prompt manipulation risk'] } },
      'shield/safety-boundary': { response: { violations: ['No sandbox isolation'] } },
      'shield/moderation': { response: { result: 'ok' } },
      'shield/abuse': { response: { abuseVectors: ['Token replay attack'] } },
      'shield/credential-exposure': { response: { authFlows: ['OAuth2'], storageLocations: ['Redis session store'] } },
      // Policy
      'policy-engine/enforce': { response: { frameworks: [{ framework: 'GDPR', applicability: 'EU data processing', complianceGaps: ['No DPO appointed'], remediationSteps: ['Appoint DPO'] }], complianceStatus: 'gaps_identified' } },
      'policy-engine/constraints': { response: { aiGovernance: { explainabilityScore: 'partial', biasAssessment: 'Low bias detected', humanOversightRequired: true, requirements: ['Human review for decisions > $10k'] } } },
      'policy-engine/approval': { response: { approvalRouting: [{ approver: 'CTO', reason: 'Architecture change', threshold: 'Any production deployment' }] } },
      // CostOps
      'costops/attribution': { response: { infrastructure: [{ category: 'compute', provider: 'AWS', monthlyCost: 5000, annualCost: 60000, assumptions: ['t3.xlarge instances'] }] } },
      'costops/forecast': { response: { tco: { year1: 120000, year3: 320000, year5: 500000 } } },
      'costops/budget': { response: { budgetRisk: { contingencyRequired: 20000, budgetExceedanceProbability: 0.15, riskFactors: ['Cloud pricing changes'] } } },
      'costops/roi': { response: { roi: { expectedReturn: 300000, paybackPeriodMonths: 14, confidenceLevel: 'medium' } } },
      'costops/tradeoff': { response: { result: 'ok' } },
      // Governance
      'governance-dashboard/audit': { response: { auditTrail: [{ decision: 'Use microservices', madeBy: 'orchestrator', rationale: 'Scalability requirements' }] } },
      'governance-dashboard/impact': { response: { changeImpact: [{ affectedSystem: 'Payment API', changeType: 'New service', impactLevel: 'high', stakeholders: ['Engineering', 'Compliance'] }] } },
      'governance-dashboard/oversight': { response: { governanceReadiness: { overallScore: 'conditionally_ready', conditions: ['DPO appointment'], strengths: ['Strong architecture'], gaps: ['Missing compliance role'] } } },
    });

    let result: Pass4Result;

    beforeEach(async () => {
      result = await executePass4({
        prompt: 'Fintech payment platform',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });
    });

    test('returns 4 workstream results', () => {
      expect(result.workstreamResults).toHaveLength(4);
    });

    // ── Security Analysis ──

    test('security analysis has risk level', () => {
      expect(['critical', 'high', 'medium', 'low']).toContain(result.securityAnalysis.overallRiskLevel);
    });

    test('security analysis has data exposure map', () => {
      expect(result.securityAnalysis.dataExposureMap.length).toBeGreaterThan(0);
      expect(result.securityAnalysis.dataExposureMap[0]!.dataType).toBeTruthy();
    });

    test('security analysis has safety assessment', () => {
      expect(result.securityAnalysis.safetyAssessment.injectionVectors.length).toBeGreaterThan(0);
    });

    test('security analysis has credential analysis', () => {
      expect(result.securityAnalysis.credentialAnalysis.authFlows.length).toBeGreaterThan(0);
    });

    // ── Policy Analysis ──

    test('policy analysis has applicable frameworks', () => {
      expect(result.policyAnalysis.applicableFrameworks.length).toBeGreaterThan(0);
      expect(result.policyAnalysis.applicableFrameworks[0]!.framework).toBe('GDPR');
    });

    test('policy analysis has AI governance', () => {
      expect(result.policyAnalysis.aiGovernance.explainabilityScore).toBe('partial');
      expect(result.policyAnalysis.aiGovernance.humanOversightRequired).toBe(true);
    });

    test('policy analysis has approval routing', () => {
      expect(result.policyAnalysis.approvalRouting.length).toBeGreaterThan(0);
      expect(result.policyAnalysis.approvalRouting[0]!.approver).toBe('CTO');
    });

    test('policy analysis has compliance status', () => {
      expect(['compliant', 'gaps_identified', 'non_compliant']).toContain(result.policyAnalysis.overallComplianceStatus);
    });

    // ── Cost Model ──

    test('cost model has infrastructure costs', () => {
      expect(result.costModel.infrastructure.length).toBeGreaterThan(0);
      expect(result.costModel.infrastructure[0]!.category).toBe('compute');
    });

    test('cost model has TCO projections', () => {
      expect(result.costModel.tco.year1).toBe(120000);
      expect(result.costModel.tco.year3).toBe(320000);
      expect(result.costModel.tco.year5).toBe(500000);
    });

    test('cost model has ROI', () => {
      expect(result.costModel.roi.expectedReturn).toBe(300000);
      expect(result.costModel.roi.paybackPeriodMonths).toBe(14);
    });

    test('cost model has scenario variants from Pass 2', () => {
      expect(result.costModel.scenarioVariants.length).toBeGreaterThan(0);
    });

    test('cost model has budget risk', () => {
      expect(result.costModel.budgetRisk.contingencyRequired).toBe(20000);
    });

    // ── Governance Report ──

    test('governance report has audit trail', () => {
      expect(result.governanceReport.auditTrail.length).toBeGreaterThan(0);
    });

    test('governance report has change impact', () => {
      expect(result.governanceReport.changeImpact.length).toBeGreaterThan(0);
      expect(result.governanceReport.changeImpact[0]!.affectedSystem).toBe('Payment API');
    });

    test('governance report has readiness score', () => {
      expect(['ready', 'conditionally_ready', 'not_ready']).toContain(result.governanceReport.governanceReadiness.overallScore);
    });

    // ── Convergence ──

    test('convergence aggregates all four workstreams', () => {
      expect(result.convergence.securityRiskLevel).toBeTruthy();
      expect(result.convergence.complianceStatus).toBeTruthy();
      expect(result.convergence.financialViability).toBeTruthy();
      expect(result.convergence.governanceReadiness).toBeTruthy();
      expect(result.convergence.overallAssessment).toContain('Security:');
      expect(result.convergence.overallAssessment).toContain('Compliance:');
      expect(result.convergence.overallAssessment).toContain('Financial:');
      expect(result.convergence.overallAssessment).toContain('Governance:');
    });

    // ── DecisionGraph ──

    test('writes security_analysis node', () => {
      expect(graph.getNodesByType('security_analysis')).toHaveLength(1);
    });

    test('writes policy_analysis node', () => {
      expect(graph.getNodesByType('policy_analysis')).toHaveLength(1);
    });

    test('writes compliance_report node', () => {
      expect(graph.getNodesByType('compliance_report')).toHaveLength(1);
    });

    test('writes cost_model node', () => {
      expect(graph.getNodesByType('cost_model')).toHaveLength(1);
    });

    test('writes governance_report nodes (report + convergence)', () => {
      expect(graph.getNodesByType('governance_report').length).toBeGreaterThanOrEqual(2);
    });

    test('all pass 4 nodes are pass 4', () => {
      const pass4Nodes = graph.getNodesByPass(4);
      expect(pass4Nodes.length).toBeGreaterThanOrEqual(5);
      for (const n of pass4Nodes) {
        expect(n.pass).toBe(4);
      }
    });

    test('collects all agent results (9+3+5+3=20)', () => {
      expect(result.totalAgentResults.length).toBe(20);
    });
  });

  // ==========================================================================
  // All Agents Failing
  // ==========================================================================

  describe('All agents failing (degraded mode)', () => {
    test('returns valid defaults when all agents fail', async () => {
      const result = await executePass4({
        prompt: 'Failing test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: createMockInvoker({}),
      });

      expect(result.securityAnalysis.overallRiskLevel).toBe('medium');
      expect(result.policyAnalysis.overallComplianceStatus).toBe('gaps_identified');
      expect(result.costModel.tco.year1).toBe(0);
      expect(result.governanceReport.governanceReadiness.overallScore).toBe('not_ready');
      // Auto-generated audit trail from prior nodes
      expect(result.governanceReport.auditTrail.length).toBeGreaterThan(0);
      // Still writes to graph
      expect(result.graphNodeIds.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Partial Workstream Failure
  // ==========================================================================

  describe('Partial workstream failure', () => {
    test('successful CostOps but failed Shield still produces cost model', async () => {
      const result = await executePass4({
        prompt: 'Partial test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: createMockInvoker({
          'costops/attribution': { response: { infrastructure: [{ category: 'compute', provider: 'AWS', monthlyCost: 3000, annualCost: 36000 }] } },
          'costops/forecast': { response: { tco: { year1: 50000, year3: 130000, year5: 200000 } } },
          'costops/budget': { response: {} },
          'costops/roi': { response: { roi: { expectedReturn: 100000, paybackPeriodMonths: 18, confidenceLevel: 'medium' } } },
          'costops/tradeoff': { response: {} },
        }),
      });

      expect(result.costModel.tco.year1).toBe(50000);
      expect(result.costModel.roi.expectedReturn).toBe(100000);
      // Shield failed — defaults
      expect(result.securityAnalysis.dataExposureMap).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Prior Context
  // ==========================================================================

  describe('Prior context', () => {
    test('payload includes context from Passes 1-3', async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const mockInvoker = async (agents: readonly AgentRef[], payload: Record<string, unknown>) => {
        capturedPayload = payload;
        return agents.map(a => makeResult(a, { result: 'ok' }));
      };

      await executePass4({
        prompt: 'Context test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: mockInvoker,
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload!['pass']).toBe(4);
      const ctx = capturedPayload!['context'] as Record<string, unknown>;
      expect(ctx['problemDefinition']).toBeDefined();
      expect(ctx['businessContext']).toBeDefined();
      expect(ctx['scenarios']).toBeDefined();
      expect(ctx['riskSignals']).toBeDefined();
      expect(ctx['architecture']).toBeDefined();
    });
  });

  // ==========================================================================
  // Provenance
  // ==========================================================================

  describe('Provenance tracking', () => {
    test('records convergence provenance', async () => {
      await executePass4({
        prompt: 'Provenance test',
        graph,
        tracker,
        timeoutMs: 10000,
        verbose: false,
        invokeAgents: createMockInvoker({
          'shield/prompt-injection': { response: {} }, 'shield/pii': { response: {} }, 'shield/redaction': { response: {} },
          'shield/secrets': { response: {} }, 'shield/toxicity': { response: {} }, 'shield/safety-boundary': { response: {} },
          'shield/moderation': { response: {} }, 'shield/abuse': { response: {} }, 'shield/credential-exposure': { response: {} },
          'policy-engine/enforce': { response: {} }, 'policy-engine/constraints': { response: {} }, 'policy-engine/approval': { response: {} },
          'costops/attribution': { response: {} }, 'costops/forecast': { response: {} }, 'costops/budget': { response: {} },
          'costops/roi': { response: {} }, 'costops/tradeoff': { response: {} },
          'governance-dashboard/audit': { response: {} }, 'governance-dashboard/impact': { response: {} }, 'governance-dashboard/oversight': { response: {} },
        }),
      });

      const records = tracker.getRecordsByPass(4);
      expect(records.length).toBeGreaterThan(0);
      expect(records.some(r => r.workstream === 'convergence')).toBe(true);
    });
  });
});
