/**
 * Simulation Renderers — Pure rendering functions
 *
 * PURPOSE: Transform raw agent responses into structured artifact content.
 * No I/O, no side effects, no external calls.
 *
 * FORBIDDEN:
 * - File I/O (use simulation-artifact-generator for writes)
 * - External API calls
 * - State mutation
 */

// ============================================================================
// Types
// ============================================================================

export interface AgentResult {
  domain: string;
  agent: string;
  status: number;
  response: unknown;
}

interface SignalPayload {
  type?: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// Helper: safe extraction from unknown agent responses
// ============================================================================

function safeGet(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function safeString(obj: unknown, ...keys: string[]): string {
  const val = safeGet(obj, ...keys);
  return typeof val === 'string' ? val : '';
}

function safeNumber(obj: unknown, ...keys: string[]): number {
  const val = safeGet(obj, ...keys);
  return typeof val === 'number' ? val : 0;
}

function safeArray(obj: unknown, ...keys: string[]): unknown[] {
  const val = safeGet(obj, ...keys);
  return Array.isArray(val) ? val : [];
}

// ============================================================================
// Extract signal payload from nested agent response
// ============================================================================

function extractSignalPayload(response: unknown): SignalPayload {
  // Agent responses often have: { signal: { payload: { type, data } } }
  const signalPayload = safeGet(response, 'signal', 'payload');
  if (signalPayload && typeof signalPayload === 'object') {
    return signalPayload as SignalPayload;
  }
  // Or direct: { data: { result: { ... } } }
  const dataResult = safeGet(response, 'data', 'result');
  if (dataResult && typeof dataResult === 'object') {
    return { data: dataResult as Record<string, unknown> };
  }
  // Fallback: treat entire response as data
  if (response && typeof response === 'object') {
    return { data: response as Record<string, unknown> };
  }
  return {};
}

// ============================================================================
// Executive Summary Renderer
// ============================================================================

export function renderExecutiveSummary(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const execSummaryAgent = platformResults.find(r => r.agent === 'executive-summary');
  const riskAgent = platformResults.find(r => r.agent === 'risk-score');
  const decisionAgent = platformResults.find(r => r.agent === 'decision-memo');

  // Extract simulation outcome
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const successProb = safeNumber(simData, 'success_probability') || safeNumber(simData, 'outcome', 'success_probability');
  const timeline = safeString(simData, 'timeline_estimate') || safeString(simData, 'timeline');
  const recommendations = safeArray(simData, 'recommendations');

  // Extract risk factors
  const riskPayload = extractSignalPayload(execSummaryAgent?.response ?? riskAgent?.response);
  const riskFactors = safeArray(riskPayload.data ?? {}, 'risk_factors')
    .concat(safeArray(simData, 'risk_factors'));

  // Determine confidence level
  let confidence = 'LOW';
  if (successProb >= 0.9) confidence = 'HIGH';
  else if (successProb >= 0.7) confidence = 'MEDIUM';

  // Determine recommendation
  let recommendation = 'DEFER';
  if (successProb >= 0.9) recommendation = 'PROCEED';
  else if (successProb >= 0.7) recommendation = 'CONDITIONAL PROCEED';

  const lines: string[] = [
    '# Executive Summary',
    '',
    `**Date:** ${now}`,
    `**Simulation:** ${query}`,
    `**Confidence:** ${confidence}`,
    `**Recommendation:** ${recommendation}`,
    '',
    '---',
    '',
    '## Simulation Overview',
    '',
    `The enterprise simulation analyzed the feasibility of: *${query}*`,
    '',
    `- **Success Probability:** ${(successProb * 100).toFixed(1)}%`,
    `- **Estimated Timeline:** ${timeline || 'To be determined'}`,
    '',
  ];

  if (riskFactors.length > 0) {
    lines.push('## Key Risk Factors', '');
    for (const risk of riskFactors) {
      if (typeof risk === 'string') {
        lines.push(`- ${risk}`);
      } else if (risk && typeof risk === 'object') {
        const r = risk as Record<string, unknown>;
        lines.push(`- **${r['category'] ?? r['name'] ?? 'Risk'}**: ${r['description'] ?? r['mitigation'] ?? String(risk)}`);
      }
    }
    lines.push('');
  }

  if (recommendations.length > 0) {
    lines.push('## Recommendations', '');
    for (const rec of recommendations) {
      lines.push(`- ${String(rec)}`);
    }
    lines.push('');
  }

  // Add platform agent insights if available
  if (execSummaryAgent && execSummaryAgent.status >= 200 && execSummaryAgent.status < 300) {
    lines.push('## Platform Analysis', '');
    lines.push('*Generated by platform/executive-summary agent*', '');
    const execPayload = extractSignalPayload(execSummaryAgent.response);
    if (execPayload.data) {
      lines.push('```json');
      lines.push(JSON.stringify(execPayload.data, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  if (decisionAgent && decisionAgent.status >= 200 && decisionAgent.status < 300) {
    lines.push('## Decision Context', '');
    lines.push('*Generated by platform/decision-memo agent*', '');
    const decPayload = extractSignalPayload(decisionAgent.response);
    if (decPayload.data) {
      lines.push('```json');
      lines.push(JSON.stringify(decPayload.data, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('---', '', `*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// Decision Memo Renderer
// ============================================================================

export function renderDecisionMemo(
  query: string,
  simulationResult: unknown,
  _platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const successProb = safeNumber(simData, 'success_probability') || safeNumber(simData, 'outcome', 'success_probability');
  const riskFactors = safeArray(simData, 'risk_factors');
  const recommendations = safeArray(simData, 'recommendations');

  let recommendation = 'DEFER';
  let rationale = 'Insufficient confidence to proceed.';
  if (successProb >= 0.9) {
    recommendation = 'PROCEED';
    rationale = 'High probability of success with manageable risks.';
  } else if (successProb >= 0.7) {
    recommendation = 'CONDITIONAL PROCEED';
    rationale = 'Moderate confidence; recommend addressing identified risks before full commitment.';
  }

  const lines: string[] = [
    '# Decision Memo',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${query}`,
    '',
    '---',
    '',
    '## Recommendation',
    '',
    `**Decision:** ${recommendation}`,
    '',
    `**Rationale:** ${rationale}`,
    '',
    `**Success Probability:** ${(successProb * 100).toFixed(1)}%`,
    '',
    '## Risk Summary',
    '',
  ];

  if (riskFactors.length > 0) {
    for (const risk of riskFactors) {
      lines.push(`- ${typeof risk === 'string' ? risk : JSON.stringify(risk)}`);
    }
  } else {
    lines.push('- No specific risk factors identified');
  }

  lines.push('', '## Next Steps', '');
  if (recommendation === 'PROCEED') {
    lines.push('1. Initiate prototype development pipeline');
    lines.push('2. Assign executive sponsor');
    lines.push('3. Establish project governance structure');
  } else if (recommendation === 'CONDITIONAL PROCEED') {
    lines.push('1. Address identified risk factors');
    lines.push('2. Conduct additional feasibility analysis');
    lines.push('3. Re-evaluate after risk mitigation');
  } else {
    lines.push('1. Review simulation parameters');
    lines.push('2. Explore alternative approaches');
    lines.push('3. Re-run with adjusted scope');
  }

  if (recommendations.length > 0) {
    lines.push('', '## Additional Recommendations', '');
    for (const rec of recommendations) {
      lines.push(`- ${String(rec)}`);
    }
  }

  lines.push('', '---', '', `*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// Scenario Artifact Builder
// ============================================================================

export function buildScenarioArtifact(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): Record<string, unknown> {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};

  return {
    metadata: {
      title: query,
      version: '1.0.0',
      created: now,
      status: 'analysis_complete',
      source: 'agentics-simulation-pipeline',
    },
    scenario: {
      description: query,
      id: safeString(simData, 'scenario_id') || `scenario-${Date.now()}`,
      parameters: safeGet(simData, 'parameters') ?? { description: query },
    },
    analysis: {
      success_probability: safeNumber(simData, 'success_probability'),
      complexity: safeString(simData, 'complexity') || 'medium',
      timeline_estimate: safeString(simData, 'timeline_estimate'),
      risk_factors: safeArray(simData, 'risk_factors'),
      recommendations: safeArray(simData, 'recommendations'),
      evidence_items: safeArray(simData, 'evidence_items'),
    },
    platform_analysis: platformResults
      .filter(r => r.status >= 200 && r.status < 300)
      .map(r => ({
        agent: `${r.domain}/${r.agent}`,
        data: extractSignalPayload(r.response).data ?? r.response,
      })),
  };
}

// ============================================================================
// Roadmap Artifact Builder
// ============================================================================

export function buildRoadmapArtifact(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): Record<string, unknown> {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const timeline = safeString(simData, 'timeline_estimate') || '3-6 months';

  // Extract phases from timeline or generate default structure
  const phases = safeArray(simData, 'timeline', 'phases');

  const defaultPhases = phases.length > 0 ? phases : [
    {
      id: 'phase-1',
      name: 'Discovery & Planning',
      duration: '2-4 weeks',
      focus: 'Requirements gathering, stakeholder alignment, technology assessment',
      deliverables: ['Requirements document', 'Stakeholder map', 'Technology assessment'],
    },
    {
      id: 'phase-2',
      name: 'Prototype Development',
      duration: '4-8 weeks',
      focus: 'Core functionality implementation, integration setup',
      deliverables: ['Working prototype', 'Integration layer', 'Test suite'],
    },
    {
      id: 'phase-3',
      name: 'Validation & Refinement',
      duration: '2-4 weeks',
      focus: 'Testing, performance optimization, security review',
      deliverables: ['Test results', 'Performance benchmarks', 'Security audit'],
    },
    {
      id: 'phase-4',
      name: 'Deployment & Handover',
      duration: '2-4 weeks',
      focus: 'Production deployment, documentation, knowledge transfer',
      deliverables: ['Production deployment', 'Documentation', 'Training materials'],
    },
  ];

  return {
    metadata: {
      title: `Roadmap: ${query}`,
      version: '1.0.0',
      created: now,
      estimated_duration: timeline,
      status: 'draft',
    },
    phases: defaultPhases,
    success_criteria: safeArray(simData, 'recommendations').map(r => String(r)),
    risk_factors: safeArray(simData, 'risk_factors'),
    platform_insights: platformResults
      .filter(r => r.agent === 'executive-summary' && r.status >= 200 && r.status < 300)
      .map(r => extractSignalPayload(r.response).data)
      .filter(Boolean),
  };
}

// ============================================================================
// Risk Assessment Builder
// ============================================================================

export function buildRiskAssessment(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): Record<string, unknown> {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const successProb = safeNumber(simData, 'success_probability');
  const riskFactors = safeArray(simData, 'risk_factors');

  // Extract risk agent data if available
  const riskAgent = platformResults.find(r => r.agent === 'risk-score');
  const riskAgentData = riskAgent ? extractSignalPayload(riskAgent.response).data : null;

  let overallRisk = 'HIGH';
  if (successProb >= 0.9) overallRisk = 'LOW';
  else if (successProb >= 0.7) overallRisk = 'MEDIUM';

  return {
    metadata: {
      title: `Risk Assessment: ${query}`,
      version: '1.0.0',
      created: now,
    },
    overall_risk_level: overallRisk,
    success_probability: successProb,
    risk_factors: riskFactors.map((r, i) => {
      if (typeof r === 'string') {
        return { id: `risk-${i + 1}`, description: r, severity: 'medium', mitigation: 'To be determined' };
      }
      return r;
    }),
    platform_risk_analysis: riskAgentData ?? null,
    mitigation_strategy: {
      immediate: riskFactors.length > 0
        ? ['Address highest-severity risks before proceeding']
        : ['No immediate mitigations required'],
      ongoing: ['Continuous monitoring during implementation', 'Regular stakeholder reviews'],
    },
  };
}
