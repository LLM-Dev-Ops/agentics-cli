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
// ADR-PIPELINE-020: Agent result extraction utilities
// ============================================================================

/** Extract all successful agent results for a given domain. */
function extractAgentsByDomain(results: AgentResult[], domain: string): AgentResult[] {
  return results.filter(r => r.domain === domain && r.status >= 200 && r.status < 300);
}

/** Extract a single agent's data payload. Returns null if not found or failed. */
function extractAgentData(results: AgentResult[], domain: string, agent: string): Record<string, unknown> | null {
  const r = results.find(a => a.domain === domain && a.agent === agent && a.status >= 200 && a.status < 300);
  if (!r) return null;
  const payload = extractSignalPayload(r.response);
  return (payload.data ?? r.response) as Record<string, unknown>;
}

/** Summarize agent fleet metrics for reporting. */
export function computeFleetMetrics(results: AgentResult[]): {
  totalInvoked: number;
  successful: number;
  failed: number;
  domainBreakdown: Record<string, { success: number; fail: number; agents: string[] }>;
} {
  const domainBreakdown: Record<string, { success: number; fail: number; agents: string[] }> = {};
  let successful = 0;
  let failed = 0;

  for (const r of results) {
    if (!domainBreakdown[r.domain]) {
      domainBreakdown[r.domain] = { success: 0, fail: 0, agents: [] };
    }
    const d = domainBreakdown[r.domain]!;
    d.agents.push(r.agent);
    if (r.status >= 200 && r.status < 300) {
      d.success++;
      successful++;
    } else {
      d.fail++;
      failed++;
    }
  }

  return { totalInvoked: results.length, successful, failed, domainBreakdown };
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
// Engine Data Extraction — derives success_probability from real engine metrics
// ============================================================================

/**
 * Extract success probability from simulation engine response.
 * The engine returns scenarioResult.coverage and policyResult.complianceScore
 * instead of a direct success_probability. This computes it from real data.
 */
function extractSuccessProbability(simData: Record<string, unknown>): number {
  // Direct field takes priority (still capped)
  const direct = safeNumber(simData, 'success_probability') || safeNumber(simData, 'outcome', 'success_probability');
  if (direct > 0) return Math.min(direct, 0.88);

  // Engine response: { success, result: { scenarioResult, policyResult, ... } }
  // Also handles command result wrapper: { simulationData: { success, result: {...} } }
  const engineData = (safeGet(simData, 'simulationData') ?? simData) as Record<string, unknown>;
  const result = safeGet(engineData, 'result') as Record<string, unknown> | undefined;
  if (!result) return 0;

  const scenarioStatus = safeString(result, 'scenarioResult', 'status');
  const stepsPassed = safeNumber(result, 'scenarioResult', 'coverage', 'stepsPassed');
  const stepsTotal = safeNumber(result, 'scenarioResult', 'coverage', 'stepsTotal');
  const complianceScore = safeNumber(result, 'policyResult', 'complianceScore');

  // Compute from coverage and compliance
  let prob = 0;
  if (stepsTotal > 0) {
    prob = stepsPassed / stepsTotal;
  } else if (scenarioStatus === 'passed') {
    prob = 0.85;
  }

  // Weight by compliance score
  if (complianceScore > 0) {
    prob = prob * 0.7 + (complianceScore / 100) * 0.3;
  }

  // Engine returned success: true with no coverage data — assign moderate confidence
  if (engineData['success'] === true && prob === 0) {
    prob = 0.72;
  }

  // Cap at 0.88 — no simulation can guarantee 100% success.
  // Enterprise projects always carry residual risk, and showing 100% destroys credibility.
  return Math.min(prob, 0.88);
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
  const successProb = extractSuccessProbability(simData);
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

  // Distill query into concise problem statement instead of echoing verbatim
  const problemStatement = distillProblemStatement(query);

  const lines: string[] = [
    '# Executive Summary',
    '',
    `**Date:** ${now}`,
    `**Assessment:** ${problemStatement}`,
    `**Confidence Level:** ${confidence}`,
    `**Recommendation:** ${recommendation}`,
    '',
    '---',
    '',
    '## Strategic Assessment',
    '',
    `This enterprise feasibility analysis evaluates the proposed initiative: **${problemStatement}**.`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Success Probability | ${(successProb * 100).toFixed(0)}% |`,
    `| Estimated Timeline | ${timeline || '12-18 weeks (to be refined)'} |`,
    `| Confidence Level | ${confidence} |`,
    '',
  ];

  if (riskFactors.length > 0) {
    lines.push('## Key Risk Factors', '');
    for (const risk of riskFactors) {
      if (typeof risk === 'string') {
        lines.push(`- ${risk}`);
      } else if (risk && typeof risk === 'object') {
        const r = risk as Record<string, unknown>;
        lines.push(`- **${r['category'] ?? r['name'] ?? 'Risk'}**: ${r['description'] ?? r['mitigation'] ?? JSON.stringify(risk)}`);
      }
    }
    lines.push('');
  }

  if (recommendations.length > 0) {
    lines.push('## Recommendations', '');
    for (const rec of recommendations) {
      lines.push(`- ${typeof rec === 'object' && rec !== null ? (rec as Record<string, unknown>)['text'] ?? (rec as Record<string, unknown>)['description'] ?? JSON.stringify(rec) : String(rec)}`);
    }
    lines.push('');
  }

  // Synthesize platform agent insights into prose (no raw JSON)
  if (execSummaryAgent && execSummaryAgent.status >= 200 && execSummaryAgent.status < 300) {
    const execPayload = extractSignalPayload(execSummaryAgent.response);
    if (execPayload.data) {
      lines.push('## Platform Analysis', '');
      const insights = synthesizeAgentInsights(execPayload.data, 'executive-summary');
      lines.push(...insights);
      lines.push('');
    }
  }

  if (decisionAgent && decisionAgent.status >= 200 && decisionAgent.status < 300) {
    const decPayload = extractSignalPayload(decisionAgent.response);
    if (decPayload.data) {
      lines.push('## Decision Context', '');
      const insights = synthesizeAgentInsights(decPayload.data, 'decision-memo');
      lines.push(...insights);
      lines.push('');
    }
  }

  // ADR-PIPELINE-020: Financial overview from costops agents
  const roiAgent = extractAgentData(platformResults, 'costops', 'roi');
  const forecastAgent = extractAgentData(platformResults, 'costops', 'forecast');
  if (roiAgent || forecastAgent) {
    lines.push('## Financial Overview', '');
    if (roiAgent) {
      const insights = synthesizeAgentInsights(roiAgent, 'costops-roi');
      lines.push(...insights);
    }
    if (forecastAgent) {
      const insights = synthesizeAgentInsights(forecastAgent, 'costops-forecast');
      lines.push(...insights);
    }
    lines.push('');
  }

  // ADR-PIPELINE-020: Provenance footer
  const execSources = [
    execSummaryAgent && 'platform/executive-summary',
    riskAgent && 'platform/risk-score',
    decisionAgent && 'platform/decision-memo',
    roiAgent && 'costops/roi',
    forecastAgent && 'costops/forecast',
  ].filter(Boolean);
  lines.push('---', '');
  if (execSources.length > 0) {
    lines.push(`*Sources: ${execSources.join(', ')}*`);
  }
  lines.push(`*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// Decision Memo Renderer
// ============================================================================

export function renderDecisionMemo(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const successProb = extractSuccessProbability(simData);
  const riskFactors = safeArray(simData, 'risk_factors');
  const recommendations = safeArray(simData, 'recommendations');

  // ADR-PIPELINE-020: Extract agent data for enrichment
  const roiData = extractAgentData(platformResults, 'costops', 'roi');
  const tradeoffData = extractAgentData(platformResults, 'costops', 'tradeoff');
  const riskScoreData = extractAgentData(platformResults, 'platform', 'risk-score');
  const plannerData = extractAgentData(platformResults, 'copilot', 'planner');

  let recommendation = 'DEFER';
  let rationale = 'Insufficient confidence to proceed.';
  if (successProb >= 0.9) {
    recommendation = 'PROCEED';
    rationale = 'High probability of success with manageable risks.';
  } else if (successProb >= 0.7) {
    recommendation = 'CONDITIONAL PROCEED';
    rationale = 'Moderate confidence; recommend addressing identified risks before full commitment.';
  }

  // Extract domain context for next steps
  const extracted = extractScenarioFromQuery(query);
  const problemStatement = distillProblemStatement(query);

  const lines: string[] = [
    '# Decision Memo',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    '',
    '---',
    '',
    '## Recommendation',
    '',
    `**Decision:** ${recommendation}`,
    '',
    `**Rationale:** ${rationale}`,
    '',
    `**Success Probability:** ${(successProb * 100).toFixed(0)}%`,
    '',
  ];

  // ADR-PIPELINE-020: Financial impact from costops agents
  if (roiData || tradeoffData) {
    lines.push('## Financial Impact', '');
    if (roiData) {
      const roi = safeString(roiData, 'roi') || safeString(roiData, 'expected_roi') || safeString(roiData, 'return_on_investment');
      const payback = safeString(roiData, 'payback_period') || safeString(roiData, 'payback');
      const totalCost = safeString(roiData, 'total_cost') || safeString(roiData, 'estimated_cost');
      if (roi) lines.push(`- **Expected ROI:** ${roi}`);
      if (payback) lines.push(`- **Payback Period:** ${payback}`);
      if (totalCost) lines.push(`- **Estimated Total Cost:** ${totalCost}`);
      const insights = synthesizeAgentInsights(roiData, 'costops-roi');
      if (insights.length > 0) lines.push('', ...insights);
    }
    if (tradeoffData) {
      lines.push('', '**Cost-Quality Tradeoff:**');
      const insights = synthesizeAgentInsights(tradeoffData, 'costops-tradeoff');
      lines.push(...insights);
    }
    lines.push('');
  }

  lines.push('## Risk Summary', '');

  // Combine simulation risks with platform risk-score agent
  const allRisks = [...riskFactors];
  if (riskScoreData) {
    const agentRisks = safeArray(riskScoreData, 'risk_factors')
      .concat(safeArray(riskScoreData, 'risks'))
      .concat(safeArray(riskScoreData, 'factors'));
    allRisks.push(...agentRisks);
  }

  if (allRisks.length > 0) {
    for (const risk of allRisks) {
      lines.push(`- ${typeof risk === 'string' ? risk : JSON.stringify(risk)}`);
    }
  } else {
    lines.push('- No specific risk factors identified');
  }

  lines.push('', '## Next Steps', '');
  const nextSteps = buildDomainNextSteps(recommendation, extracted);
  for (const step of nextSteps) {
    lines.push(step);
  }

  if (recommendations.length > 0) {
    lines.push('', '## Additional Recommendations', '');
    for (const rec of recommendations) {
      lines.push(`- ${typeof rec === 'object' && rec !== null ? JSON.stringify(rec) : String(rec)}`);
    }
  }

  // ADR-PIPELINE-020: Implementation approach from copilot/planner
  if (plannerData) {
    lines.push('', '## Implementation Approach', '');
    const insights = synthesizeAgentInsights(plannerData, 'copilot-planner');
    lines.push(...insights);
  }

  // Provenance footer
  const sources = [roiData && 'costops/roi', tradeoffData && 'costops/tradeoff', riskScoreData && 'platform/risk-score', plannerData && 'copilot/planner'].filter(Boolean);
  lines.push('', '---', '');
  if (sources.length > 0) {
    lines.push(`*Sources: ${sources.join(', ')}*`);
  }
  lines.push(`*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// Scenario Artifact Builder
// ============================================================================

// ============================================================================
// NLP Extraction — extract structured domain data from free-form queries
// ============================================================================

interface ExtractedScenario {
  scenario_type: string;
  stakeholders: string[];
  constraints: string[];
  success_criteria: string[];
  systems: string[];
  domain_entities: string[];
  capabilities: string[];
}

/** Known enterprise systems with regex patterns. */
const SYSTEM_PATTERNS: Array<[RegExp, string]> = [
  [/\bworkday\b/i, 'Workday'],
  [/\bsap\s*s\/4\s*hana\b/i, 'SAP S/4HANA'],
  [/\bsap\b/i, 'SAP'],
  [/\bnetsuite\b/i, 'NetSuite'],
  [/\boracle\s*(hcm|erp|cloud|financials)?\b/i, 'Oracle'],
  [/\bsalesforce\b/i, 'Salesforce'],
  [/\bservicenow\b/i, 'ServiceNow'],
  [/\bsuccess\s*factors\b/i, 'SuccessFactors'],
  [/\bjira\b/i, 'Jira'],
  [/\bslack\b/i, 'Slack'],
  [/\bsnowflake\b/i, 'Snowflake'],
  [/\bbigquery\b/i, 'BigQuery'],
  [/\bdataflow\b/i, 'Dataflow'],
  [/\bkafka\b/i, 'Kafka'],
  [/\bredis\b/i, 'Redis'],
  [/\bpostgres(?:ql)?\b/i, 'PostgreSQL'],
  [/\bmongodb\b/i, 'MongoDB'],
  [/\bdynamodb\b/i, 'DynamoDB'],
  [/\belasticsearch\b/i, 'Elasticsearch'],
  [/\bgoogle\s*cloud\b/i, 'Google Cloud'],
  [/\baws\b/i, 'AWS'],
  [/\bazure\b/i, 'Azure'],
  [/\bcloud\s*run\b/i, 'Cloud Run'],
  [/\bcloud\s*functions\b/i, 'Cloud Functions'],
  [/\bpub\s*\/?\s*sub\b/i, 'Pub/Sub'],
  [/\bodata\b/i, 'OData'],
];

/** Domain classifiers: scenario_type detection from query content. */
const DOMAIN_CLASSIFIERS: Array<{ keywords: string[]; type: string }> = [
  { keywords: ['attrition', 'turnover', 'retention', 'employee lifecycle', 'workforce', 'hr operations', 'recruiting', 'talent'], type: 'hr-workforce-analytics' },
  { keywords: ['supply chain', 'logistics', 'warehouse', 'inventory', 'procurement', 'shipping'], type: 'supply-chain-management' },
  { keywords: ['financial', 'accounting', 'revenue', 'billing', 'invoice', 'payment', 'ledger', 'reconciliation'], type: 'financial-operations' },
  { keywords: ['manufacturing', 'production', 'quality control', 'plant', 'factory', 'assembly'], type: 'manufacturing-operations' },
  { keywords: ['customer', 'crm', 'sales pipeline', 'lead', 'opportunity', 'account management'], type: 'customer-relationship' },
  { keywords: ['compliance', 'audit', 'regulatory', 'governance', 'risk management', 'sox'], type: 'compliance-governance' },
  { keywords: ['monitoring', 'observability', 'alerting', 'telemetry', 'incident', 'sla', 'uptime'], type: 'operations-monitoring' },
  { keywords: ['vendor', 'supplier', 'contract', 'procurement', 'sourcing'], type: 'vendor-management' },
  { keywords: ['security', 'authentication', 'authorization', 'access control', 'identity'], type: 'security-identity' },
  { keywords: ['data pipeline', 'etl', 'data warehouse', 'analytics', 'reporting', 'dashboard'], type: 'data-analytics' },
  { keywords: ['migration', 'modernization', 'legacy', 'replatform'], type: 'system-migration' },
];

/** Role/stakeholder patterns found in natural language. */
const STAKEHOLDER_PATTERNS: Array<[RegExp, string]> = [
  [/\bhr\s*(team|leader|director|operations|manager|department)\b/i, 'HR Leadership'],
  [/\bmanager[s]?\b/i, 'Team Managers'],
  [/\bemployee[s]?\b/i, 'Employees'],
  [/\bc-suite|ceo|cfo|cto|cio|chro\b/i, 'Executive Leadership'],
  [/\bit\s*(team|department|operations)\b/i, 'IT Operations'],
  [/\bdata\s*(team|scientist|engineer|analyst)\b/i, 'Data Team'],
  [/\bcompliance\s*(team|officer|department)\b/i, 'Compliance Team'],
  [/\bfinance\s*(team|department|controller)\b/i, 'Finance Team'],
  [/\bsecurity\s*(team|officer|department)\b/i, 'Security Team'],
  [/\boperations\s*(team|manager|department)\b/i, 'Operations Team'],
  [/\bvendor[s]?\b/i, 'External Vendors'],
  [/\bcustomer[s]?\b/i, 'Customers'],
  [/\bstakeholder[s]?\b/i, 'Stakeholders'],
  [/\bboard\s*(of directors|members)\b/i, 'Board of Directors'],
  [/\bregulator[s]?\b/i, 'Regulators'],
  [/\bauditor[s]?\b/i, 'Auditors'],
];

/** Constraint signal phrases in natural language. */
const CONSTRAINT_SIGNALS = [
  /\b(?:must|need to|require[sd]?|should|has to|have to|essential(?:ly)?)\s+(?:respect|maintain|ensure|comply|meet|follow|adhere)\s+(.{10,80})/gi,
  /\b(?:privacy|compliance|regulatory|security|auditability|gdpr|hipaa|sox|pci|ferpa)\s+(?:requirement|standard|regulation|constraint|obligation|mandate)[s]?/gi,
  /\bsubject to\s+(.{10,80})/gi,
  /\bwithout\s+(?:disrupting|breaking|affecting|impacting)\s+(.{10,80})/gi,
  /\bcompatib(?:le|ility)\s+with\s+(.{10,60})/gi,
];

/** Success criteria signal phrases. */
const SUCCESS_SIGNALS = [
  /\b(?:ideally|goal is to|want to|objective is|aim to|purpose is)\s+(.{10,120})/gi,
  /\b(?:identify|detect|predict|alert|notify|flag|highlight)\s+(.{10,120})/gi,
  /\b(?:working prototype|proof of concept|poc|demo|demonstration)\s+(?:that\s+)?(.{5,120})/gi,
  /\b(?:evaluate|assess|measure|benchmark|validate)\s+(.{10,120})/gi,
];

/** Domain entity patterns — multi-word and single-word nouns. */
const ENTITY_PATTERNS: Array<[RegExp, string]> = [
  [/\bemployee\s*(?:attrition|turnover)\b/i, 'EmployeeAttrition'],
  [/\battrition\s*risk\b/i, 'AttritionRisk'],
  [/\bturnover\s*(?:rate|risk|trend|pattern)\b/i, 'TurnoverMetric'],
  [/\bengagement\s*(?:score|survey|result|data)\b/i, 'EngagementScore'],
  [/\bperformance\s*review[s]?\b/i, 'PerformanceReview'],
  [/\bpromotion\s*history\b/i, 'PromotionHistory'],
  [/\binternal\s*(?:transfer|mobility)\b/i, 'InternalTransfer'],
  [/\bemployee\s*tenure\b/i, 'EmployeeTenure'],
  [/\bworkload[s]?\b/i, 'Workload'],
  [/\bretention\s*(?:conversation|action|plan|strategy)\b/i, 'RetentionAction'],
  [/\brecruiting\s*pipeline[s]?\b/i, 'RecruitingPipeline'],
  [/\bworkforce\s*data\b/i, 'WorkforceData'],
  [/\bemployee\s*lifecycle\b/i, 'EmployeeLifecycle'],
  [/\binvoice[s]?\b/i, 'Invoice'],
  [/\bpurchase\s*order[s]?\b/i, 'PurchaseOrder'],
  [/\bsupplier[s]?\b/i, 'Supplier'],
  [/\bvendor[s]?\b/i, 'Vendor'],
  [/\bcontract[s]?\b/i, 'Contract'],
  [/\bshipment[s]?\b/i, 'Shipment'],
  [/\bemission[s]?\b/i, 'EmissionsRecord'],
  [/\bscope\s*3\b/i, 'Scope3Emission'],
  [/\bbusiness\s*partner[s]?\b/i, 'BusinessPartner'],
  [/\bmaterial[s]?\b/i, 'Material'],
  [/\bpayment[s]?\b/i, 'Payment'],
  [/\breceipt[s]?\b/i, 'Receipt'],
  [/\baudit\s*(?:trail|log|entry|record)\b/i, 'AuditRecord'],
  [/\balert[s]?\b/i, 'Alert'],
  [/\bdashboard[s]?\b/i, 'Dashboard'],
  [/\breport[s]?\b/i, 'Report'],
  [/\bproduction\s*(?:order|line|schedule)\b/i, 'ProductionOrder'],
  [/\bquality\s*(?:check|inspection|control)\b/i, 'QualityCheck'],
  [/\bcustomer\s*(?:account|record|profile)\b/i, 'CustomerAccount'],
  [/\bsales\s*lead[s]?\b|\blead\s*(?:generation|scoring|qualification|nurturing|management)\b/i, 'Lead'],
  [/\bopportunit(?:y|ies)\b/i, 'Opportunity'],
  [/\bbudget[s]?\b/i, 'Budget'],
  [/\bforecast[s]?\b/i, 'Forecast'],
  // Manufacturing / ERP / Supply Chain
  [/\binventory\b/i, 'Inventory'],
  [/\bwarehouse\b/i, 'Warehouse'],
  [/\bmanufactur(?:ing|er)?\b/i, 'ManufacturingOrder'],
  [/\bwork\s*order[s]?\b/i, 'WorkOrder'],
  [/\bbill\s*of\s*material[s]?\b/i, 'BillOfMaterials'],
  [/\bbom\b/i, 'BillOfMaterials'],
  [/\bprocurement\b/i, 'ProcurementRequest'],
  [/\bgeneral\s*ledger\b/i, 'GeneralLedger'],
  [/\baccounts?\s*payable\b/i, 'AccountsPayable'],
  [/\baccounts?\s*receivable\b/i, 'AccountsReceivable'],
  [/\bsupply\s*chain\b/i, 'SupplyChain'],
  [/\bdemand\s*(?:planning|forecast)\b/i, 'DemandForecast'],
  [/\bmrp\b/i, 'MaterialRequirements'],
  [/\berp\b/i, 'ERPTransaction'],
  [/\bplant\b/i, 'Plant'],
  [/\bcost\s*center\b/i, 'CostCenter'],
  [/\brouting[s]?\b/i, 'ProductionRouting'],
  [/\bassembly\b/i, 'Assembly'],
  [/\bfinancial\s*(?:report|statement|data)\b/i, 'FinancialReport'],
  [/\border\s*(?:management|processing|fulfillment)\b/i, 'SalesOrder'],
  [/\bsales\s*order[s]?\b/i, 'SalesOrder'],
  [/\btransfer\s*order[s]?\b/i, 'TransferOrder'],
  [/\bchart\s*of\s*accounts?\b/i, 'ChartOfAccounts'],
  [/\btax\s*(?:calculation|compliance|code)\b/i, 'TaxRecord'],
  [/\bjournal\s*entr(?:y|ies)\b/i, 'JournalEntry'],
  [/\bitem\s*(?:master|record|catalog)\b/i, 'ItemMaster'],
  [/\bbin\s*(?:location|management)\b/i, 'BinLocation'],
  [/\blot\s*(?:tracking|number|control)\b/i, 'LotTracking'],
  [/\bserial\s*(?:number|tracking)\b/i, 'SerialNumber'],
  // Healthcare / Pharma
  [/\bpatient\b/i, 'Patient'],
  [/\bprescription[s]?\b/i, 'Prescription'],
  [/\bclinical\s*trial[s]?\b/i, 'ClinicalTrial'],
  [/\bdrug\s*(?:product|substance)\b/i, 'DrugProduct'],
  [/\bformulary\b/i, 'Formulary'],
  [/\bclaim[s]?\b/i, 'InsuranceClaim'],
  // Logistics / Transportation
  [/\bfreight\b/i, 'FreightShipment'],
  [/\bcarrier[s]?\b/i, 'Carrier'],
  [/\broute\s*(?:planning|optimization)\b/i, 'RouteOptimization'],
  [/\bfleet\s*(?:management|tracking)\b/i, 'FleetAsset'],
  [/\bdelivery\s*(?:order|schedule|route)\b/i, 'DeliveryOrder'],
  // Retail / Commerce
  [/\bproduct\s*catalog\b/i, 'ProductCatalog'],
  [/\bpricing\s*(?:rule|engine|strategy)\b/i, 'PricingRule'],
  [/\bpromotion[s]?\b/i, 'Promotion'],
  [/\bcart\b/i, 'ShoppingCart'],
  [/\bcheckout\b/i, 'Checkout'],
  [/\bloyalty\s*(?:program|point|reward)\b/i, 'LoyaltyProgram'],
];

/** Capability patterns — what the system should be able to do. */
const CAPABILITY_SIGNALS = [
  /\b(?:analyze|analyse)\s+(?:patterns?\s+in\s+)?(.{10,100})/gi,
  /\b(?:detect|identify|predict|forecast)\s+(.{5,100})/gi,
  /\b(?:notify|alert|create records?|update records?|trigger)\s+(.{5,100})/gi,
  /\b(?:integrate with|connect to|interface with)\s+(.{5,80})/gi,
  /\b(?:monitor|track|measure)\s+(.{5,100})/gi,
  /\b(?:generate|produce|create)\s+(?:reports?|dashboards?|visualizations?)\b/gi,
];

/**
 * Trim text to the end of the nearest sentence boundary (period, comma, semicolon).
 * If no boundary found within the text, truncate at maxLen.
 */
function trimToSentence(text: string, maxLen = 100): string {
  const trimmed = text.slice(0, maxLen);
  // Find last sentence boundary
  const lastPeriod = trimmed.lastIndexOf('.');
  const lastComma = trimmed.lastIndexOf(',');
  const lastSemicolon = trimmed.lastIndexOf(';');
  const boundary = Math.max(lastPeriod, lastComma, lastSemicolon);
  if (boundary > 15) {
    return trimmed.slice(0, boundary).trim();
  }
  return trimmed.trim();
}

/**
 * Extract structured scenario data from a free-form natural language query.
 * Uses pattern matching to identify stakeholders, constraints, success criteria,
 * systems, domain entities, and capabilities.
 */
function extractScenarioFromQuery(query: string): ExtractedScenario {
  const lowerQuery = query.toLowerCase();

  // 1. Classify scenario type
  let scenarioType = 'enterprise-solution';
  let bestScore = 0;
  for (const classifier of DOMAIN_CLASSIFIERS) {
    const score = classifier.keywords.filter(kw => lowerQuery.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      scenarioType = classifier.type;
    }
  }

  // 2. Extract systems
  const systems: string[] = [];
  const seenSystems = new Set<string>();
  for (const [re, name] of SYSTEM_PATTERNS) {
    if (re.test(query) && !seenSystems.has(name)) {
      seenSystems.add(name);
      systems.push(name);
    }
  }

  // 3. Extract stakeholders
  const stakeholders: string[] = [];
  const seenStakeholders = new Set<string>();
  for (const [re, name] of STAKEHOLDER_PATTERNS) {
    if (re.test(query) && !seenStakeholders.has(name)) {
      seenStakeholders.add(name);
      stakeholders.push(name);
    }
  }

  // 4. Extract constraints from signal phrases
  const constraints: string[] = [];
  const seenConstraints = new Set<string>();
  // Direct constraint phrases
  for (const re of CONSTRAINT_SIGNALS) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(query)) !== null) {
      const text = trimToSentence((match[1] ?? match[0]).trim().replace(/[.!?,;]+$/, ''));
      if (text.length > 8 && !seenConstraints.has(text.toLowerCase())) {
        seenConstraints.add(text.toLowerCase());
        constraints.push(text);
      }
    }
  }
  // Add keyword-detected constraints
  if (lowerQuery.includes('privacy')) constraints.push('Respect employee privacy and data protection requirements');
  if (lowerQuery.includes('auditab')) constraints.push('Maintain strong auditability for all operations');
  if (lowerQuery.includes('compliance')) constraints.push('Meet compliance and regulatory requirements');
  if (lowerQuery.includes('gdpr')) constraints.push('GDPR compliance for personal data processing');
  if (lowerQuery.includes('hipaa')) constraints.push('HIPAA compliance for health data');
  if (lowerQuery.includes('without disrupting')) constraints.push('Non-disruptive to existing workflows');

  // 5. Extract success criteria from signal phrases
  const successCriteria: string[] = [];
  const seenCriteria = new Set<string>();
  for (const re of SUCCESS_SIGNALS) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(query)) !== null) {
      const text = trimToSentence((match[1] ?? match[0]).trim().replace(/[.!?,;]+$/, ''));
      if (text.length > 8 && !seenCriteria.has(text.toLowerCase())) {
        seenCriteria.add(text.toLowerCase());
        successCriteria.push(text);
      }
    }
  }

  // 6. Extract domain entities
  const domainEntities: string[] = [];
  const seenEntities = new Set<string>();
  for (const [re, name] of ENTITY_PATTERNS) {
    if (re.test(query) && !seenEntities.has(name)) {
      seenEntities.add(name);
      domainEntities.push(name);
    }
  }

  // 7. Extract capabilities
  const capabilities: string[] = [];
  const seenCaps = new Set<string>();
  for (const re of CAPABILITY_SIGNALS) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(query)) !== null) {
      const text = trimToSentence((match[1] ?? match[0]).trim().replace(/[.!?,;]+$/, ''));
      if (text.length > 8 && text.length < 150 && !seenCaps.has(text.toLowerCase())) {
        seenCaps.add(text.toLowerCase());
        capabilities.push(text);
      }
    }
  }

  return {
    scenario_type: scenarioType,
    stakeholders,
    constraints: [...new Set(constraints)],
    success_criteria: successCriteria,
    systems,
    domain_entities: domainEntities,
    capabilities,
  };
}

// ============================================================================
// Executive Output Helpers — transform raw data into consulting-grade prose
// ============================================================================

/**
 * Distill a verbose natural-language query into a concise problem statement.
 * Strips preambles ("I want to build...", "Create a prototype for..."),
 * capitalizes the first word, and truncates to a readable length.
 */
function distillProblemStatement(query: string): string {
  // Remove common preambles
  let cleaned = query
    .replace(/^(?:I want to|I'd like to|I need to|We need to|We want to|Please|Can you|Could you)\s+/i, '')
    .replace(/^(?:build|create|design|develop|implement|generate|make)\s+(?:a\s+|an\s+)?/i, '')
    .replace(/^(?:working\s+)?prototype\s+(?:for|of|that)\s+/i, '')
    .replace(/^(?:proof of concept|poc)\s+(?:for|of|that)\s+/i, '')
    .trim();

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned[0]!.toUpperCase() + cleaned.slice(1);
  }

  // Truncate at sentence boundary if too long
  if (cleaned.length > 120) {
    const boundary = cleaned.lastIndexOf('.', 120);
    if (boundary > 40) {
      cleaned = cleaned.slice(0, boundary + 1);
    } else {
      cleaned = cleaned.slice(0, 120).trim() + '...';
    }
  }

  return cleaned || query.slice(0, 120);
}

/**
 * Synthesize agent response data into readable prose bullet points.
 * Extracts key findings, recommendations, and metrics from agent JSON
 * and presents them as narrative text — never raw JSON.
 */
function synthesizeAgentInsights(data: Record<string, unknown>, agentType: string): string[] {
  const lines: string[] = [];

  // Extract common fields across agent response shapes
  const summary = safeString(data, 'summary') || safeString(data, 'executive_summary') || safeString(data, 'description');
  const recommendations = safeArray(data, 'recommendations');
  const findings = safeArray(data, 'findings') || safeArray(data, 'key_findings');
  const metrics = safeGet(data, 'metrics') as Record<string, unknown> | undefined;
  const score = safeNumber(data, 'score') || safeNumber(data, 'confidence') || safeNumber(data, 'risk_score');
  const status = safeString(data, 'status') || safeString(data, 'outcome');

  if (summary) {
    lines.push(summary);
    lines.push('');
  }

  if (findings.length > 0) {
    lines.push('**Key Findings:**');
    for (const finding of findings.slice(0, 5)) {
      const text = typeof finding === 'string' ? finding : safeString(finding as Record<string, unknown>, 'description') || safeString(finding as Record<string, unknown>, 'finding') || JSON.stringify(finding);
      lines.push(`- ${text}`);
    }
    lines.push('');
  }

  if (recommendations.length > 0 && agentType !== 'decision-memo') {
    lines.push('**Recommendations:**');
    for (const rec of recommendations.slice(0, 5)) {
      lines.push(`- ${typeof rec === 'object' && rec !== null ? JSON.stringify(rec) : String(rec)}`);
    }
    lines.push('');
  }

  if (metrics && typeof metrics === 'object') {
    const metricEntries = Object.entries(metrics).filter(([, v]) => typeof v === 'number' || typeof v === 'string').slice(0, 5);
    if (metricEntries.length > 0) {
      lines.push('**Key Metrics:**');
      for (const [key, value] of metricEntries) {
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        lines.push(`- ${label}: ${value}`);
      }
      lines.push('');
    }
  }

  if (score > 0) {
    lines.push(`**Agent Confidence Score:** ${typeof score === 'number' && score <= 1 ? (score * 100).toFixed(0) + '%' : score}`);
    lines.push('');
  }

  if (status && lines.length === 0) {
    lines.push(`Assessment status: ${status}`);
    lines.push('');
  }

  // If we couldn't extract anything meaningful, provide a brief note
  if (lines.length === 0) {
    lines.push(`Analysis completed by ${agentType} agent. Detailed findings incorporated into overall assessment.`);
    lines.push('');
  }

  return lines;
}

/**
 * Build domain-specific next steps based on the recommendation and extracted scenario.
 * Produces actionable, contextualized steps instead of generic boilerplate.
 */
function buildDomainNextSteps(
  recommendation: string,
  extracted: ExtractedScenario,
): string[] {
  const primarySystem = extracted.systems[0] ?? 'target enterprise system';
  const scenarioLabel = extracted.scenario_type.replace(/-/g, ' ');
  const stakeholders = extracted.stakeholders.slice(0, 2).join(' and ') || 'key stakeholders';

  if (recommendation === 'PROCEED') {
    return [
      `1. **Initiate ${scenarioLabel} prototype** — Stand up development environment with ${primarySystem} sandbox credentials`,
      `2. **Stakeholder alignment** — Conduct kickoff with ${stakeholders} to validate requirements and acceptance criteria`,
      `3. **Integration assessment** — Verify ${primarySystem} API access, authentication flow, and rate limits`,
      ...(extracted.constraints.length > 0
        ? [`4. **Compliance checkpoint** — Validate ${extracted.constraints[0]} before proceeding to implementation`]
        : [`4. **Establish governance** — Define project governance structure and review cadence`]),
      `5. **Sprint 1 planning** — Prioritize ${extracted.domain_entities.slice(0, 3).join(', ') || 'core domain entities'} for initial implementation`,
    ];
  } else if (recommendation === 'CONDITIONAL PROCEED') {
    return [
      `1. **Risk mitigation plan** — Address identified risk factors with targeted spikes and proof-of-concept work`,
      `2. **${primarySystem} feasibility** — Validate API capabilities and data model compatibility with a focused technical spike`,
      `3. **Stakeholder review** — Present risk assessment to ${stakeholders} for informed go/no-go decision`,
      `4. **Scoped pilot** — Reduce initial scope to ${extracted.domain_entities.slice(0, 2).join(' and ') || 'core entities'} for validated learning`,
      `5. **Re-evaluate** — After risk mitigation, re-run feasibility analysis with updated parameters`,
    ];
  }

  return [
    `1. **Requirements review** — Clarify ${scenarioLabel} scope and success criteria with ${stakeholders}`,
    `2. **Alternative assessment** — Evaluate alternative approaches to ${extracted.capabilities[0] || 'stated objectives'}`,
    `3. **Technical discovery** — Assess ${primarySystem} capabilities and integration constraints`,
    `4. **Revised proposal** — Develop refined approach addressing identified gaps`,
  ];
}

export function buildScenarioArtifact(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): Record<string, unknown> {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};

  // Extract structured domain data from the free-form query
  const extracted = extractScenarioFromQuery(query);

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
    // Structured extraction from query — drives Phase 2+ quality
    query: query,
    scenario_type: extracted.scenario_type,
    stakeholders: extracted.stakeholders,
    constraints: extracted.constraints,
    success_criteria: extracted.success_criteria,
    systems: extracted.systems,
    domain_entities: extracted.domain_entities,
    capabilities: extracted.capabilities,
    analysis: {
      success_probability: extractSuccessProbability(simData),
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

  // Extract phases from timeline or generate domain-specific structure
  const phases = safeArray(simData, 'timeline', 'phases');
  const extracted = extractScenarioFromQuery(query);
  const systemList = extracted.systems.length > 0 ? extracted.systems.join(', ') : 'target platform';
  const entityList = extracted.domain_entities.slice(0, 3).join(', ') || 'core domain models';
  const primarySystem = extracted.systems[0] ?? 'enterprise platform';

  const defaultPhases = phases.length > 0 ? phases : [
    {
      id: 'phase-1',
      name: 'Discovery & Planning',
      duration: '2-4 weeks',
      focus: `Requirements analysis for ${extracted.scenario_type}, stakeholder alignment with ${extracted.stakeholders.slice(0, 3).join(', ') || 'key stakeholders'}, ${systemList} integration assessment`,
      deliverables: [
        `${extracted.scenario_type} requirements specification`,
        `${primarySystem} API integration assessment`,
        `Domain model definition (${entityList})`,
        `Stakeholder alignment document`,
      ],
    },
    {
      id: 'phase-2',
      name: 'Prototype Development',
      duration: '4-8 weeks',
      focus: `Core ${extracted.scenario_type} implementation with ${systemList} integration`,
      deliverables: [
        `Working ${extracted.scenario_type} prototype`,
        `${primarySystem} integration layer`,
        `${entityList} domain services`,
        `Test suite with domain-specific assertions`,
      ],
    },
    {
      id: 'phase-3',
      name: 'Validation & Refinement',
      duration: '2-4 weeks',
      focus: `End-to-end testing with ${primarySystem}, performance optimization, ${extracted.constraints.length > 0 ? 'compliance validation' : 'security review'}`,
      deliverables: [
        `Integration test results with ${primarySystem}`,
        `Performance benchmarks`,
        `${extracted.constraints.length > 0 ? 'Compliance and privacy audit' : 'Security audit'}`,
        `User acceptance test plan`,
      ],
    },
    {
      id: 'phase-4',
      name: 'Deployment & Handover',
      duration: '2-4 weeks',
      focus: `Production deployment to ${extracted.systems.find(s => /cloud|aws|azure/i.test(s)) ?? 'cloud platform'}, documentation, knowledge transfer`,
      deliverables: [
        `Production deployment on ${extracted.systems.find(s => /cloud|aws|azure/i.test(s)) ?? 'cloud infrastructure'}`,
        `Operations runbook`,
        `${extracted.stakeholders[0] ?? 'User'} training materials`,
        `API documentation`,
      ],
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
    // ADR-PIPELINE-020: Enrich roadmap with planner and costops data
    cost_estimate: extractAgentData(platformResults, 'costops', 'forecast'),
    implementation_plan: extractAgentData(platformResults, 'copilot', 'planner'),
    resource_requirements: extractAgentData(platformResults, 'costops', 'budget'),
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
  const successProb = extractSuccessProbability(simData);
  const riskFactors = safeArray(simData, 'risk_factors');

  // Extract risk agent data if available
  const riskAgent = platformResults.find(r => r.agent === 'risk-score');
  const riskAgentData = riskAgent ? extractSignalPayload(riskAgent.response).data : null;

  // ADR-PIPELINE-020: Extract sentinel and shield agents for deeper risk analysis
  const sentinelAgents = extractAgentsByDomain(platformResults, 'sentinel');
  const shieldAgents = extractAgentsByDomain(platformResults, 'shield');
  const observatoryAgents = extractAgentsByDomain(platformResults, 'observatory');

  let overallRisk = 'HIGH';
  if (successProb >= 0.9) overallRisk = 'LOW';
  else if (successProb >= 0.7) overallRisk = 'MEDIUM';

  // Combine risk factors from all sources
  const allRiskFactors = [...riskFactors];

  // Extract sentinel findings (anomaly, drift, correlation, rca)
  for (const agent of sentinelAgents) {
    const data = extractSignalPayload(agent.response).data;
    if (data) {
      const findings = safeArray(data, 'findings').concat(safeArray(data, 'anomalies')).concat(safeArray(data, 'risks'));
      for (const finding of findings) {
        allRiskFactors.push(typeof finding === 'string' ? finding : finding);
      }
    }
  }

  // Extract shield findings (pii, secrets, credential-exposure)
  const securityFindings: unknown[] = [];
  for (const agent of shieldAgents) {
    const data = extractSignalPayload(agent.response).data;
    if (data) {
      const findings = safeArray(data, 'findings').concat(safeArray(data, 'vulnerabilities')).concat(safeArray(data, 'issues'));
      securityFindings.push(...findings);
    }
  }

  // Extract observatory health data
  const healthFindings: unknown[] = [];
  for (const agent of observatoryAgents) {
    const data = extractSignalPayload(agent.response).data;
    if (data) {
      const findings = safeArray(data, 'findings').concat(safeArray(data, 'failures')).concat(safeArray(data, 'health_issues'));
      healthFindings.push(...findings);
    }
  }

  return {
    metadata: {
      title: `Risk Assessment: ${query}`,
      version: '1.0.0',
      created: now,
    },
    overall_risk_level: overallRisk,
    success_probability: successProb,
    risk_factors: allRiskFactors.map((r, i) => {
      if (typeof r === 'string') {
        return { id: `risk-${i + 1}`, description: r, severity: 'medium', mitigation: 'To be determined' };
      }
      return r;
    }),
    platform_risk_analysis: riskAgentData ?? null,
    security_findings: securityFindings.length > 0 ? securityFindings : null,
    health_findings: healthFindings.length > 0 ? healthFindings : null,
    sentinel_analysis: sentinelAgents.length > 0 ? sentinelAgents.map(a => ({
      agent: a.agent,
      data: extractSignalPayload(a.response).data,
    })) : null,
    mitigation_strategy: {
      immediate: allRiskFactors.length > 0
        ? ['Address highest-severity risks before proceeding']
        : ['No immediate mitigations required'],
      ongoing: ['Continuous monitoring during implementation', 'Regular stakeholder reviews'],
    },
    sources: [
      riskAgentData && 'platform/risk-score',
      ...sentinelAgents.map(a => `sentinel/${a.agent}`),
      ...shieldAgents.map(a => `shield/${a.agent}`),
      ...observatoryAgents.map(a => `observatory/${a.agent}`),
    ].filter(Boolean),
  };
}

// ============================================================================
// ADR-PIPELINE-020: Financial Analysis Renderer (costops agents)
// ============================================================================

export function renderFinancialAnalysis(
  query: string,
  _simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const problemStatement = distillProblemStatement(query);

  const roiData = extractAgentData(platformResults, 'costops', 'roi');
  const forecastData = extractAgentData(platformResults, 'costops', 'forecast');
  const attributionData = extractAgentData(platformResults, 'costops', 'attribution');
  const budgetData = extractAgentData(platformResults, 'costops', 'budget');
  const tradeoffData = extractAgentData(platformResults, 'costops', 'tradeoff');

  const lines: string[] = [
    '# Financial Analysis',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    '',
    '---',
    '',
  ];

  // ROI Analysis
  lines.push('## Return on Investment', '');
  if (roiData) {
    const insights = synthesizeAgentInsights(roiData, 'costops-roi');
    lines.push(...insights);
  } else {
    lines.push('*ROI analysis pending — costops/roi agent data not available.*', '');
  }

  // Cost Forecast
  lines.push('## Cost Forecast', '');
  if (forecastData) {
    const insights = synthesizeAgentInsights(forecastData, 'costops-forecast');
    lines.push(...insights);
  } else {
    lines.push('*Cost forecast pending — costops/forecast agent data not available.*', '');
  }

  // Cost Attribution
  lines.push('## Cost Attribution', '');
  if (attributionData) {
    const insights = synthesizeAgentInsights(attributionData, 'costops-attribution');
    lines.push(...insights);
  } else {
    lines.push('*Cost attribution pending — costops/attribution agent data not available.*', '');
  }

  // Budget Allocation
  lines.push('## Budget Allocation', '');
  if (budgetData) {
    const insights = synthesizeAgentInsights(budgetData, 'costops-budget');
    lines.push(...insights);
  } else {
    lines.push('*Budget allocation pending — costops/budget agent data not available.*', '');
  }

  // Cost-Quality Tradeoff
  lines.push('## Cost-Quality Tradeoff Analysis', '');
  if (tradeoffData) {
    const insights = synthesizeAgentInsights(tradeoffData, 'costops-tradeoff');
    lines.push(...insights);
  } else {
    lines.push('*Tradeoff analysis pending — costops/tradeoff agent data not available.*', '');
  }

  const sources = [roiData && 'costops/roi', forecastData && 'costops/forecast', attributionData && 'costops/attribution', budgetData && 'costops/budget', tradeoffData && 'costops/tradeoff'].filter(Boolean);
  lines.push('---', '');
  lines.push(`*Sources: ${sources.length > 0 ? sources.join(', ') : 'none — costops agents not invoked'}*`);
  lines.push(`*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// ADR-PIPELINE-020: Security Assessment Renderer (shield agents)
// ============================================================================

export function renderSecurityAssessment(
  query: string,
  _simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const problemStatement = distillProblemStatement(query);
  const shieldAgents = extractAgentsByDomain(platformResults, 'shield');
  const govAgents = extractAgentsByDomain(platformResults, 'governance-dashboard');

  const lines: string[] = [
    '# Security & Compliance Assessment',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    '',
    '---',
    '',
    '## Security Posture', '',
  ];

  if (shieldAgents.length > 0) {
    for (const agent of shieldAgents) {
      const data = extractSignalPayload(agent.response).data;
      if (data) {
        lines.push(`### ${agent.agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Scan`, '');
        const insights = synthesizeAgentInsights(data, `shield-${agent.agent}`);
        lines.push(...insights);
      }
    }
  } else {
    lines.push('*Security scan pending — shield agents not invoked.*', '');
  }

  lines.push('## Governance & Compliance', '');
  if (govAgents.length > 0) {
    for (const agent of govAgents) {
      const data = extractSignalPayload(agent.response).data;
      if (data) {
        lines.push(`### ${agent.agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`, '');
        const insights = synthesizeAgentInsights(data, `governance-${agent.agent}`);
        lines.push(...insights);
      }
    }
  } else {
    lines.push('*Governance analysis pending — governance-dashboard agents not invoked.*', '');
  }

  const sources = [...shieldAgents.map(a => `shield/${a.agent}`), ...govAgents.map(a => `governance-dashboard/${a.agent}`)];
  lines.push('---', '');
  lines.push(`*Sources: ${sources.length > 0 ? sources.join(', ') : 'none'}*`);
  lines.push(`*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// ADR-PIPELINE-020: Integration Assessment Renderer (connector-hub agents)
// ============================================================================

export function renderIntegrationAssessment(
  query: string,
  _simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const problemStatement = distillProblemStatement(query);
  const connectorAgents = extractAgentsByDomain(platformResults, 'connector-hub');
  const edgeAgents = extractAgentsByDomain(platformResults, 'edge');
  const extracted = extractScenarioFromQuery(query);

  const lines: string[] = [
    '# Integration Assessment',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    `**Target Systems:** ${extracted.systems.join(', ') || 'To be identified'}`,
    '',
    '---',
    '',
    '## ERP & System Integration', '',
  ];

  if (connectorAgents.length > 0) {
    for (const agent of connectorAgents) {
      const data = extractSignalPayload(agent.response).data;
      if (data) {
        lines.push(`### ${agent.agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`, '');
        const insights = synthesizeAgentInsights(data, `connector-hub-${agent.agent}`);
        lines.push(...insights);
      }
    }
  } else {
    lines.push('*Integration analysis pending — connector-hub agents not invoked.*', '');
  }

  lines.push('## Edge & Resilience Patterns', '');
  if (edgeAgents.length > 0) {
    for (const agent of edgeAgents) {
      const data = extractSignalPayload(agent.response).data;
      if (data) {
        lines.push(`### ${agent.agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`, '');
        const insights = synthesizeAgentInsights(data, `edge-${agent.agent}`);
        lines.push(...insights);
      }
    }
  } else {
    lines.push('*Edge analysis pending — edge agents not invoked.*', '');
  }

  const sources = [...connectorAgents.map(a => `connector-hub/${a.agent}`), ...edgeAgents.map(a => `edge/${a.agent}`)];
  lines.push('---', '');
  lines.push(`*Sources: ${sources.length > 0 ? sources.join(', ') : 'none'}*`);
  lines.push(`*Generated: ${now}*`);
  return lines.join('\n');
}

// ============================================================================
// ADR-PIPELINE-020: Agent Fleet Report Renderer
// ============================================================================

export function renderAgentFleetReport(
  query: string,
  _simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const problemStatement = distillProblemStatement(query);
  const metrics = computeFleetMetrics(platformResults);

  const effectivenessScore = metrics.totalInvoked > 0
    ? Math.round((metrics.successful / metrics.totalInvoked) * 100)
    : 0;

  const lines: string[] = [
    '# Agent Fleet Report',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    '',
    '---',
    '',
    '## Fleet Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Agents Invoked | ${metrics.totalInvoked} |`,
    `| Successful (real data) | ${metrics.successful} (${metrics.totalInvoked > 0 ? Math.round((metrics.successful / metrics.totalInvoked) * 100) : 0}%) |`,
    `| Failed / Error | ${metrics.failed} (${metrics.totalInvoked > 0 ? Math.round((metrics.failed / metrics.totalInvoked) * 100) : 0}%) |`,
    `| Fleet Effectiveness Score | ${effectivenessScore}% |`,
    '',
    '## Per-Domain Breakdown',
    '',
    '| Domain | Agents | Success | Failed | Agents Used |',
    '|--------|--------|---------|--------|-------------|',
  ];

  const sortedDomains = Object.entries(metrics.domainBreakdown)
    .sort(([, a], [, b]) => (b.success + b.fail) - (a.success + a.fail));

  for (const [domain, data] of sortedDomains) {
    const total = data.success + data.fail;
    const agentList = [...new Set(data.agents)].join(', ');
    lines.push(`| ${domain} | ${total} | ${data.success} | ${data.fail} | ${agentList} |`);
  }

  lines.push('');

  // Agent contribution to documents
  lines.push('## Agent Contributions to Documents', '');
  const docMap: Record<string, string[]> = {
    'executive-summary.md': ['platform/executive-summary', 'platform/risk-score', 'platform/decision-memo', 'costops/roi', 'costops/forecast'],
    'decision-memo.md': ['costops/roi', 'costops/tradeoff', 'platform/risk-score', 'copilot/planner'],
    'financial-analysis.md': ['costops/roi', 'costops/forecast', 'costops/attribution', 'costops/budget', 'costops/tradeoff'],
    'security-assessment.md': ['shield/prompt-injection', 'shield/pii', 'shield/secrets', 'shield/credential-exposure', 'governance-dashboard/audit'],
    'integration-assessment.md': ['connector-hub/erp-surface', 'connector-hub/database-query', 'connector-hub/webhook-ingest', 'edge/circuit-breaker', 'edge/failover'],
    'risk-assessment.json': ['platform/risk-score', 'sentinel/anomaly', 'sentinel/drift', 'shield/pii', 'shield/secrets', 'observatory/failures'],
    'roadmap.json': ['copilot/planner', 'costops/forecast', 'costops/budget', 'research-lab/metrics'],
  };

  for (const [doc, agents] of Object.entries(docMap)) {
    const available = agents.filter(a => {
      const [d, ag] = a.split('/');
      return platformResults.some(r => r.domain === d && r.agent === ag && r.status >= 200 && r.status < 300);
    });
    const status = available.length > 0 ? `${available.length}/${agents.length} agents contributed` : 'no agent data available';
    lines.push(`- **${doc}**: ${status}`);
  }

  lines.push('', '---', '', `*Generated: ${now}*`);
  return lines.join('\n');
}
