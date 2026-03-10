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
// Engine Data Extraction — derives success_probability from real engine metrics
// ============================================================================

/**
 * Extract success probability from simulation engine response.
 * The engine returns scenarioResult.coverage and policyResult.complianceScore
 * instead of a direct success_probability. This computes it from real data.
 */
function extractSuccessProbability(simData: Record<string, unknown>): number {
  // Direct field takes priority
  const direct = safeNumber(simData, 'success_probability') || safeNumber(simData, 'outcome', 'success_probability');
  if (direct > 0) return direct;

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

  // Engine returned success: true
  if (engineData['success'] === true && prob === 0) {
    prob = 0.75;
  }

  return Math.min(prob, 1.0);
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
  const successProb = extractSuccessProbability(simData);
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
  [/\blead[s]?\b/i, 'Lead'],
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
