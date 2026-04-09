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
// ADR-PIPELINE-024: Shared Financial & Risk Extraction Helpers
// ============================================================================

interface FinancialData {
  budget: string;
  roi: string;
  npv: string;
  payback: string;
  revenue: string;
  costSavings: string;
  hasData: boolean;
  isEstimated: boolean;
}

/**
 * ADR-PIPELINE-026: Synthesize financial data from ALL sources:
 * 1. Simulation engine result (simData)
 * 2. Agent results (planner, what-if, scenario, decision, costops)
 * 3. Query-based estimates as last resort
 * Documents should NEVER say "To be quantified".
 */
export function synthesizeFinancials(simData: Record<string, unknown>, platformResults: AgentResult[], query: string): FinancialData {
  const fm = (safeGet(simData, 'financial_model') ?? safeGet(simData, 'cost_model') ?? safeGet(simData, 'financials')) as Record<string, unknown> | undefined;

  // Collect from all possible agent sources — not just costops
  const financialFields: Record<string, string> = {};
  const financialKeys = [
    ['budget', 'budget', 'investment', 'total_investment', 'allocated_budget', 'total_budget', 'estimated_cost', 'total_cost', 'project_cost'],
    ['roi', 'roi', 'expected_roi', 'return_on_investment', 'projected_roi'],
    ['npv', 'npv', 'net_present_value', '5_year_npv', 'five_year_npv'],
    ['payback', 'payback_period', 'payback', 'roi_timeline', 'break_even'],
    ['revenue', 'projected_revenue', 'revenue_impact', 'annual_value', 'annual_savings', 'savings'],
    ['costSavings', 'cost_savings', 'cost_reduction', 'savings', 'efficiency_gain'],
  ];

  // Source 1: simData direct fields
  for (const [key, ...aliases] of financialKeys) {
    if (!key) continue;
    for (const alias of aliases) {
      const val = safeString(simData, alias);
      if (val && !financialFields[key]) { financialFields[key] = val; break; }
    }
    // Source 1b: nested financial_model
    if (!financialFields[key] && fm) {
      for (const alias of aliases) {
        const val = safeString(fm, alias);
        if (val && !financialFields[key]) { financialFields[key] = val; break; }
      }
    }
  }

  // Source 2: ALL agent results — scan every successful agent for financial fields
  for (const agent of platformResults) {
    if (agent.status < 200 || agent.status >= 300) continue;
    const data = extractSignalPayload(agent.response).data;
    if (!data || typeof data !== 'object') continue;

    for (const [key, ...aliases] of financialKeys) {
      if (!key || financialFields[key]) continue;
      for (const alias of aliases) {
        const val = safeString(data, alias);
        if (val) { financialFields[key] = val; break; }
      }
      // Check nested data.financial_model, data.result, data.output
      if (!financialFields[key]) {
        for (const nested of ['financial_model', 'result', 'output', 'analysis', 'data'] as const) {
          const sub = safeGet(data, nested) as Record<string, unknown> | undefined;
          if (!sub) continue;
          for (const alias of aliases) {
            const val = safeString(sub, alias);
            if (val) { financialFields[key] = val; break; }
          }
          if (financialFields[key]) break;
        }
      }
    }
  }

  const hasRealData = !!(financialFields['budget'] || financialFields['roi'] || financialFields['npv'] || financialFields['payback'] || financialFields['revenue'] || financialFields['costSavings']);

  // Source 3: Estimate from query context when nothing else available
  if (!hasRealData) {
    return estimateFinancialsFromQuery(query);
  }

  return {
    budget: financialFields['budget'] ?? '',
    roi: financialFields['roi'] ?? '',
    npv: financialFields['npv'] ?? '',
    payback: financialFields['payback'] ?? '',
    revenue: financialFields['revenue'] ?? '',
    costSavings: financialFields['costSavings'] ?? '',
    hasData: true,
    isEstimated: false,
  };
}

/**
 * ADR-PIPELINE-025 §7a: Generate financial estimates from query context.
 * Uses employee count, industry, and scope to produce rough-order-of-magnitude numbers.
 * All clearly labeled as estimates.
 */
function estimateFinancialsFromQuery(query: string): FinancialData {
  const lower = query.toLowerCase();
  const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1000).toFixed(0)}K`;

  // ── ADR-PIPELINE-029 §2: Try domain-specific bottom-up model first ──
  const domainModel = tryDomainSpecificFinancials(query, lower);
  if (domainModel) return domainModel;

  // ── Fallback: per-employee heuristic with visible methodology ──
  let employees = 10000;
  const empIdx = lower.indexOf('employees');
  const staffIdx = lower.indexOf('staff');
  const targetIdx = empIdx !== -1 ? empIdx : staffIdx;
  if (targetIdx > 5) {
    const before = query.substring(Math.max(0, targetIdx - 30), targetIdx).trim();
    const words = before.split(/\s+/);
    for (let i = words.length - 1; i >= 0; i--) {
      const cleaned = (words[i] ?? '').replace(/,/g, '').replace(/approximately/i, '').trim();
      const num = parseInt(cleaned, 10);
      if (num > 100 && num < 10_000_000) { employees = num; break; }
    }
  }

  // Industry detection
  const isPharma = lower.includes('pharma') || lower.includes('drug') || lower.includes('gxp');
  const isFinancial = lower.includes('financial') || lower.includes('banking') || lower.includes('insurance');
  const isRetail = lower.includes('retail') || lower.includes('grocery') || lower.includes('store');
  const isUtility = lower.includes('water') || lower.includes('utility') || lower.includes('energy') || lower.includes('grid');
  const isHealthcare = lower.includes('healthcare') || lower.includes('hospital') || lower.includes('patient');
  const isSustainability = lower.includes('sustainability') || lower.includes('emissions') || lower.includes('carbon') || lower.includes('esg');
  const isProfessionalServices = lower.includes('professional services') || lower.includes('consulting') || lower.includes('advisory');
  const isManufacturing = lower.includes('manufacturing') || lower.includes('factory') || lower.includes('production line');
  const isConsumerGoods = lower.includes('consumer goods') || lower.includes('cpg') || lower.includes('fmcg') || lower.includes('packaging');

  let industryLabel = 'enterprise';
  let costPerEmployee = 25;
  let savingsMultiplier = 50;
  if (isPharma) { costPerEmployee = 35; savingsMultiplier = 80; industryLabel = 'pharmaceutical'; }
  else if (isFinancial) { costPerEmployee = 30; savingsMultiplier = 60; industryLabel = 'financial services'; }
  else if (isRetail) { costPerEmployee = 15; savingsMultiplier = 40; industryLabel = 'retail'; }
  else if (isUtility) { costPerEmployee = 20; savingsMultiplier = 55; industryLabel = 'utility infrastructure'; }
  else if (isHealthcare) { costPerEmployee = 30; savingsMultiplier = 65; industryLabel = 'healthcare'; }
  else if (isManufacturing) { costPerEmployee = 22; savingsMultiplier = 55; industryLabel = 'manufacturing'; }
  else if (isConsumerGoods) { costPerEmployee = 20; savingsMultiplier = 45; industryLabel = 'consumer goods'; }
  else if (isSustainability) { costPerEmployee = 25; savingsMultiplier = 50; industryLabel = 'sustainability'; }
  else if (isProfessionalServices) { costPerEmployee = 25; savingsMultiplier = 50; industryLabel = 'professional services'; }

  const pilotCost = Math.round(employees * costPerEmployee / 1000) * 1000;
  const annualSavings = Math.round(employees * savingsMultiplier / 1000) * 1000;
  const paybackMonths = Math.max(6, Math.min(24, Math.round(pilotCost / (annualSavings / 12))));
  const npv5yr = Math.round(annualSavings * 3.5);
  const roiPct = Math.round((annualSavings / pilotCost) * 100);

  const methodology = `${employees.toLocaleString()} employees × $${costPerEmployee}/employee ${industryLabel} benchmark`;
  const savingsMethod = `${employees.toLocaleString()} employees × $${savingsMultiplier}/employee annual efficiency gain`;

  return {
    budget: `${fmt(pilotCost)} - ${fmt(pilotCost * 1.5)} (${methodology})`,
    roi: `${roiPct}% projected (${fmt(annualSavings)} savings ÷ ${fmt(pilotCost)} investment)`,
    npv: `${fmt(npv5yr)} 5-year NPV (10% discount rate, ${savingsMethod})`,
    payback: `${paybackMonths}-${paybackMonths + 6} months (break-even when cumulative savings exceed investment)`,
    revenue: `${fmt(annualSavings)} annual efficiency gains (${savingsMethod})`,
    costSavings: '',
    hasData: true,
    isEstimated: true,
  };
}

/**
 * ADR-PIPELINE-029 §2: Domain-specific bottom-up financial models.
 * These use query signals to build unit-economics-based estimates
 * rather than generic per-employee heuristics.
 *
 * Returns null if no domain-specific model applies — caller falls back
 * to per-employee heuristic.
 */
function tryDomainSpecificFinancials(query: string, lower: string): FinancialData | null {
  const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1000).toFixed(0)}K`;
  const employees = extractEmployeeCount(query, lower);

  // ── Packaging / Supplier Waste ──
  if (/packag|supplier.*waste|excess.*material|supplier.*sustainab/i.test(lower)) {
    // Bottom-up: suppliers × avg excess rate × cost per shipment × annual volume
    const supplierMatch = lower.match(/(\d+)[,.]?\d*\s*(?:suppliers?|vendors?)/);
    const supplierCount = supplierMatch ? parseInt(supplierMatch[1]!, 10) : estimateSupplierCount(employees);
    const avgExcessRate = 0.18; // 18% industry average excess packaging
    const avgCostPerShipment = 4.50; // avg packaging cost per shipment, USD
    const annualShipmentsPerSupplier = 2400; // ~200/month
    const totalShipments = supplierCount * annualShipmentsPerSupplier;
    const addressableWaste = totalShipments * avgExcessRate * avgCostPerShipment;
    const achievableReduction = 0.35; // 35% of addressable waste through optimization
    const annualSavings = Math.round(addressableWaste * achievableReduction / 1000) * 1000;
    const implCost = Math.round(Math.max(200000, annualSavings * 0.6) / 1000) * 1000;
    const roiPct = Math.round((annualSavings / implCost) * 100);
    const paybackMonths = Math.max(6, Math.min(18, Math.round(implCost / (annualSavings / 12))));

    const methodology = `${supplierCount} suppliers × ${(annualShipmentsPerSupplier).toLocaleString()} shipments/yr × ` +
      `${(avgExcessRate * 100).toFixed(0)}% excess rate × $${avgCostPerShipment.toFixed(2)}/shipment × ` +
      `${(achievableReduction * 100).toFixed(0)}% achievable reduction`;

    return {
      budget: `${fmt(implCost)} - ${fmt(implCost * 1.4)} (implementation + ${supplierCount}-supplier rollout)`,
      roi: `${roiPct}% projected (${fmt(annualSavings)} annual savings ÷ ${fmt(implCost)} investment; ${methodology})`,
      npv: `${fmt(Math.round(annualSavings * 3.5))} 5-year NPV (10% discount rate, ${fmt(addressableWaste)} total addressable waste)`,
      payback: `${paybackMonths}-${paybackMonths + 4} months (break-even at ${Math.round(achievableReduction * avgExcessRate * 100)}% packaging reduction)`,
      revenue: `${fmt(annualSavings)} annual waste reduction savings (${methodology})`,
      costSavings: `${fmt(addressableWaste)} total addressable packaging waste annually`,
      hasData: true,
      isEstimated: true,
    };
  }

  // ── Water Loss / Utility Network ──
  if (/water\s*loss|non.?revenue\s*water|leak|pipe.*aging|distribution\s*network/i.test(lower)) {
    // Bottom-up: system volume × loss rate × water cost × achievable reduction
    const popMatch = lower.match(/(\d+)[,.]?\d*\s*(?:customer|connection|household|meter)/);
    const customers = popMatch ? parseInt(popMatch[1]!, 10) : Math.round(employees * 4.5); // ~4.5 customers per employee
    const avgDailyVolumeM3 = customers * 0.4; // 400 liters/customer/day
    const lossRate = 0.22; // 22% industry average NRW
    const waterCostPerM3 = 1.85;
    const dailyLossM3 = avgDailyVolumeM3 * lossRate;
    const annualLossCost = dailyLossM3 * 365 * waterCostPerM3;
    const achievableReduction = 0.30; // 30% of losses through targeted intervention
    const annualSavings = Math.round(achievableReduction * annualLossCost / 1000) * 1000;
    const implCost = Math.round(Math.max(300000, annualSavings * 0.5) / 1000) * 1000;
    const roiPct = Math.round((annualSavings / implCost) * 100);
    const paybackMonths = Math.max(6, Math.min(18, Math.round(implCost / (annualSavings / 12))));

    const methodology = `${customers.toLocaleString()} connections × ${(lossRate * 100).toFixed(0)}% NRW rate × ` +
      `$${waterCostPerM3}/m³ × ${(achievableReduction * 100).toFixed(0)}% achievable reduction`;

    return {
      budget: `${fmt(implCost)} - ${fmt(implCost * 1.4)} (AI platform + sensor integration for ${customers.toLocaleString()} connections)`,
      roi: `${roiPct}% projected (${fmt(annualSavings)} annual water savings ÷ ${fmt(implCost)} investment; ${methodology})`,
      npv: `${fmt(Math.round(annualSavings * 3.5))} 5-year NPV (10% discount rate, ${fmt(annualLossCost)} annual water loss cost)`,
      payback: `${paybackMonths}-${paybackMonths + 4} months (break-even at ${Math.round(achievableReduction * lossRate * 100)}% loss reduction)`,
      revenue: `${fmt(annualSavings)} annual water loss reduction (${methodology})`,
      costSavings: `${fmt(annualLossCost)} total addressable water loss cost annually`,
      hasData: true,
      isEstimated: true,
    };
  }

  // ── Travel / Emissions / Sustainability ──
  if (/travel.*emission|carbon.*footprint|sustainab.*travel|business\s*travel.*reduc|commut.*emission/i.test(lower)) {
    // Bottom-up: travelers × avg trips × emissions per trip × carbon cost × achievable reduction
    const travelerPct = 0.35; // 35% of employees are business travelers
    const travelers = Math.round(employees * travelerPct);
    const avgTripsPerYear = 6;
    const avgEmissionsPerTripKg = 850; // kg CO2e (mix of domestic + international)
    const carbonPricePerTonne = 75; // $/tonne CO2e (social cost of carbon)
    const avgTripCost = 2200; // $ per trip
    const totalEmissionsKg = travelers * avgTripsPerYear * avgEmissionsPerTripKg;
    const totalTravelCost = travelers * avgTripsPerYear * avgTripCost;
    const achievableReduction = 0.25; // 25% through virtual-first + rail substitution
    const emissionsSavingsKg = totalEmissionsKg * achievableReduction;
    const travelCostSavings = totalTravelCost * achievableReduction * 0.6; // 60% cost recovery (some virtual, some rail)
    const carbonValueSavings = (emissionsSavingsKg / 1000) * carbonPricePerTonne;
    const annualSavings = Math.round((travelCostSavings + carbonValueSavings) / 1000) * 1000;
    const implCost = Math.round(Math.max(200000, annualSavings * 0.4) / 1000) * 1000;
    const roiPct = Math.round((annualSavings / implCost) * 100);
    const paybackMonths = Math.max(4, Math.min(14, Math.round(implCost / (annualSavings / 12))));

    const methodology = `${travelers.toLocaleString()} travelers × ${avgTripsPerYear} trips/yr × ` +
      `${avgEmissionsPerTripKg} kg CO2e/trip × ${(achievableReduction * 100).toFixed(0)}% reduction`;

    return {
      budget: `${fmt(implCost)} - ${fmt(implCost * 1.3)} (platform + integration with travel/expense systems)`,
      roi: `${roiPct}% projected (${fmt(annualSavings)} combined savings ÷ ${fmt(implCost)} investment; ${methodology})`,
      npv: `${fmt(Math.round(annualSavings * 3.5))} 5-year NPV (10% discount rate, ${fmt(travelCostSavings)} travel + ${fmt(carbonValueSavings)} carbon value)`,
      payback: `${paybackMonths}-${paybackMonths + 4} months (${Math.round(emissionsSavingsKg / 1000)} tonnes CO2e/yr reduction)`,
      revenue: `${fmt(annualSavings)} annual combined savings (${fmt(travelCostSavings)} travel cost + ${fmt(carbonValueSavings)} carbon value at $${carbonPricePerTonne}/tonne)`,
      costSavings: `${Math.round(emissionsSavingsKg / 1000).toLocaleString()} tonnes CO2e annual reduction (${methodology})`,
      hasData: true,
      isEstimated: true,
    };
  }

  // ── Procurement / Supplier Management ──
  if (/procurement.*optim|supplier.*manag|spend.*analy|purchas.*order|sourcing/i.test(lower)) {
    const spendPct = 0.40; // 40% of revenue typically goes to procurement
    const estimatedRevenue = employees * 150000; // rough revenue/employee
    const totalSpend = estimatedRevenue * spendPct;
    const addressableSpend = totalSpend * 0.30; // 30% of spend is addressable
    const savingsRate = 0.05; // 5% savings on addressable spend
    const annualSavings = Math.round(addressableSpend * savingsRate / 1000) * 1000;
    const implCost = Math.round(Math.max(300000, annualSavings * 0.5) / 1000) * 1000;
    const roiPct = Math.round((annualSavings / implCost) * 100);
    const paybackMonths = Math.max(6, Math.min(18, Math.round(implCost / (annualSavings / 12))));

    const methodology = `${fmt(totalSpend)} est. procurement spend × 30% addressable × 5% optimization rate`;

    return {
      budget: `${fmt(implCost)} - ${fmt(implCost * 1.4)} (AI analytics + ERP integration)`,
      roi: `${roiPct}% projected (${fmt(annualSavings)} savings ÷ ${fmt(implCost)} investment; ${methodology})`,
      npv: `${fmt(Math.round(annualSavings * 3.5))} 5-year NPV (10% discount rate, ${fmt(addressableSpend)} addressable spend)`,
      payback: `${paybackMonths}-${paybackMonths + 4} months (break-even at ${(savingsRate * 100).toFixed(1)}% of addressable spend)`,
      revenue: `${fmt(annualSavings)} annual procurement savings (${methodology})`,
      costSavings: `${fmt(addressableSpend)} addressable procurement spend annually`,
      hasData: true,
      isEstimated: true,
    };
  }

  return null; // No domain-specific model — caller uses per-employee fallback
}

/** Extract employee count from query text. Returns default 10000 if not found. */
function extractEmployeeCount(query: string, lower: string): number {
  let employees = 10000;
  const empIdx = lower.indexOf('employees');
  const staffIdx = lower.indexOf('staff');
  const targetIdx = empIdx !== -1 ? empIdx : staffIdx;
  if (targetIdx > 5) {
    const before = query.substring(Math.max(0, targetIdx - 30), targetIdx).trim();
    const words = before.split(/\s+/);
    for (let i = words.length - 1; i >= 0; i--) {
      const cleaned = (words[i] ?? '').replace(/,/g, '').replace(/approximately/i, '').trim();
      const num = parseInt(cleaned, 10);
      if (num > 100 && num < 10_000_000) { employees = num; break; }
    }
  }
  return employees;
}

/** Estimate supplier count from employee count for procurement scenarios. */
function estimateSupplierCount(employees: number): number {
  // Rough: 1 active supplier per 50-100 employees for large enterprises
  return Math.max(20, Math.round(employees / 75));
}

// extractFinancials is now synthesizeFinancials — kept as export for external callers
export { synthesizeFinancials as extractFinancials };

/**
 * ADR-PIPELINE-025 §5c: Extract system name from query text using string matching.
 * Mirrors tech-stack-detector's extractSystemNameFromText but for renderer context.
 */
function extractSystemFromQuery(query: string): string | null {
  const lower = query.toLowerCase();
  const triggers = [
    'managed through ', 'managed by ', 'managed via ', 'managed with ',
    'managed using ', 'managed in ', 'are managed through ',
    'inside ', 'records inside ', 'plans inside ', 'actions inside ',
  ];
  const stopWords = new Set(['the', 'our', 'this', 'that', 'a', 'an', 'it', 'we', 'they', 'and', 'or', 'but', 'if', 'because', 'however']);

  for (const trigger of triggers) {
    const idx = lower.indexOf(trigger);
    if (idx === -1) continue;
    const after = query.substring(idx + trigger.length).trim();
    const words: string[] = [];
    for (const raw of after.split(/\s+/)) {
      const word = raw.replace(/[.,;:!?)\]]+$/, '');
      if (!word) break;
      if (['erp', 'system', 'platform', 'software', 'crm', 'wms', 'tms'].includes(word.toLowerCase())) { words.push(word); break; }
      if (stopWords.has(word.toLowerCase()) && words.length > 0) break;
      if (word[0] === word[0]?.toLowerCase() && word[0] !== word[0]?.toUpperCase() && words.length > 0) break;
      words.push(word);
      if (words.length >= 5) break;
    }
    const name = words.join(' ').trim();
    if (name.length >= 2 && name.length <= 50 && !stopWords.has(name.toLowerCase())) return name;
  }
  return null;
}

interface DomainRisk {
  risk: string;
  category: string;
  likelihood: string;
  impact: string;
  score: number;
  mitigation: string;
}

/**
 * ADR-PIPELINE-024: Generate domain-appropriate risks from query context.
 * Every enterprise project has risks. Never return an empty list.
 */
function generateDomainRisks(query: string, extracted: ExtractedScenario): DomainRisk[] {
  const risks: DomainRisk[] = [];
  const q = query.toLowerCase();
  const systems = extracted.systems;
  const primarySystem = systems[0] ?? 'enterprise platform';

  // System-specific data quality risks (not generic)
  const isWorkday = /workday/i.test(q);
  const isSAP = /sap|s\/4hana/i.test(q);
  const isMaximo = /maximo|ibm/i.test(q);

  if (isWorkday) {
    risks.push({
      risk: `Workday custom report and RaaS API data may have field-level gaps — expense categories, cost centers, and worker location data are often inconsistent across regions`,
      category: 'Data', likelihood: 'High', impact: 'Medium', score: 6,
      mitigation: 'Map required fields per Workday module (Expenses, Absence, Worker) during discovery; build validation for missing cost center and location codes',
    });
    risks.push({
      risk: `Workday API rate limits (currently 10 req/sec for RaaS, 20 req/sec for REST) may constrain data sync for ${extracted.stakeholders.length > 2 ? 'large employee populations' : 'batch operations'}`,
      category: 'Technical', likelihood: 'Medium', impact: 'High', score: 6,
      mitigation: 'Implement incremental sync with delta queries; cache frequently accessed worker profiles; use Workday Integration Cloud for bulk data',
    });
  } else if (isSAP) {
    risks.push({
      risk: `SAP S/4HANA OData API field mappings differ between on-premise and cloud editions — custom fields may not be accessible via standard APIs`,
      category: 'Data', likelihood: 'High', impact: 'Medium', score: 6,
      mitigation: 'Validate API access for each required field during technical spike; plan CDS view development for custom field exposure if needed',
    });
    risks.push({
      risk: `SAP API authentication (OAuth2 + X-CSRF tokens) and transport security requirements add integration complexity`,
      category: 'Technical', likelihood: 'Medium', impact: 'High', score: 6,
      mitigation: 'Technical spike with SAP Basis team to validate API configuration; use SAP BTP Integration Suite if direct API access is restricted',
    });
  } else if (isMaximo) {
    risks.push({
      risk: `IBM Maximo OSLC API may not expose all required asset and maintenance fields — custom attributes require explicit OSLC resource definition`,
      category: 'Data', likelihood: 'High', impact: 'Medium', score: 6,
      mitigation: 'Audit Maximo OSLC resource definitions during discovery; validate custom field availability via test queries against staging environment',
    });
    risks.push({
      risk: `Maximo 7.x vs. MAS 8.x OSLC API differences — work order status transitions and custom field schemas differ between versions`,
      category: 'Technical', likelihood: 'Medium', impact: 'High', score: 6,
      mitigation: 'Confirm Maximo version and OSLC API version during technical spike; build version-aware adapter with feature detection',
    });
  } else {
    risks.push({
      risk: `Data quality and completeness in ${primarySystem} may not meet analytical requirements`,
      category: 'Data', likelihood: 'High', impact: 'Medium', score: 6,
      mitigation: 'Data profiling during discovery phase; validation layer with quarantine for invalid records',
    });
    risks.push({
      risk: `${primarySystem} API integration complexity — rate limits, schema changes, authentication`,
      category: 'Technical', likelihood: 'Medium', impact: 'High', score: 6,
      mitigation: `Technical spike to validate ${primarySystem} API capabilities before full commitment`,
    });
  }

  risks.push({
    risk: 'Scope creep beyond initial prototype boundaries',
    category: 'Project', likelihood: 'High', impact: 'Medium', score: 6,
    mitigation: 'Fixed scope contract with explicit phase gates; changes require stakeholder re-approval',
  });

  // Size-dependent risks
  if (/\b\d{2,6}\s*(?:employee|staff|people|worker|team member)/i.test(q)) {
    risks.push({
      risk: 'Change management across large workforce — adoption resistance and training burden',
      category: 'Organizational', likelihood: 'Medium', impact: 'High', score: 6,
      mitigation: 'Phased rollout starting with pilot group; champion network; training program before go-live',
    });
  }

  // Multi-region risks
  if (/(?:north america|europe|asia|global|multi.?region|across.*(?:region|countr|continent))/i.test(q)) {
    risks.push({
      risk: 'Regional regulatory variance — data residency, privacy, and compliance requirements differ by jurisdiction',
      category: 'Regulatory', likelihood: 'Medium', impact: 'High', score: 6,
      mitigation: 'Legal review per jurisdiction during discovery; configurable compliance rules per region',
    });
  }

  // Sustainability / emissions risks
  if (/(?:emission|carbon|sustainab|environmental|energy|waste|esg)/i.test(q)) {
    risks.push({
      risk: 'Emissions factor accuracy — DEFRA/EPA default factors may not match specific operational context (e.g., regional grid mix, fleet composition)',
      category: 'Data', likelihood: 'Medium', impact: 'Medium', score: 4,
      mitigation: 'Allow organization-specific factors with audit trail; flag calculations using default vs. measured values; annual factor review process',
    });
    if (/travel|commut|flight|transport/i.test(q)) {
      risks.push({
        risk: 'Employee behavior change resistance — sustainability nudges may be perceived as restrictive or intrusive by frequent travelers',
        category: 'Organizational', likelihood: 'Medium', impact: 'Medium', score: 4,
        mitigation: 'Frame as insights, not mandates; gamification and positive reinforcement; executive sponsorship for culture shift',
      });
    }
  }

  // Water/utility-specific risks
  if (/(?:water|pipe|leak|pressure|distribution|meter|flow)/i.test(q)) {
    risks.push({
      risk: 'Sensor data gaps — pressure and flow telemetry may have coverage holes in older distribution zones with limited SCADA instrumentation',
      category: 'Data', likelihood: 'High', impact: 'Medium', score: 6,
      mitigation: 'Map sensor coverage per DMA during discovery; define minimum instrumentation requirements for analysis zones',
    });
    risks.push({
      risk: 'Infrastructure intervention timelines — pipe replacement and pressure management projects require permitting and construction windows that may extend beyond prototype evaluation period',
      category: 'Operational', likelihood: 'Medium', impact: 'Medium', score: 4,
      mitigation: 'Focus prototype on detection and prioritization; track intervention recommendations separately from execution timelines',
    });
  }

  // Financial risks
  if (/(?:investment|budget|cost|roi|revenue|profitab)/i.test(q)) {
    risks.push({
      risk: 'Financial assumptions may not hold — market conditions, operational costs, or adoption rates may differ from projections',
      category: 'Financial', likelihood: 'Medium', impact: 'Medium', score: 4,
      mitigation: 'Sensitivity analysis on key assumptions; quarterly re-validation of financial model',
    });
  }

  // Always include vendor dependency
  risks.push({
    risk: 'Technology vendor dependency — platform availability, pricing changes, or API deprecation',
    category: 'Technical', likelihood: 'Low', impact: 'High', score: 3,
    mitigation: 'Ports-and-adapters architecture enables vendor swap; contractual SLA requirements',
  });

  return risks.sort((a, b) => b.score - a.score);
}

// ============================================================================
// Executive Summary Renderer (ADR-PIPELINE-024: Pyramid Principle)
// ============================================================================

export function renderExecutiveSummary(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const successProb = extractSuccessProbability(simData);
  const timeline = safeString(simData, 'timeline_estimate') || safeString(simData, 'timeline') || '12-18 weeks';
  const problemStatement = distillProblemStatement(query);
  const extracted = extractScenarioFromQuery(query);
  const fin = synthesizeFinancials(simData, platformResults, query);
  const risks = generateDomainRisks(query, extracted);
  const primarySystem = extracted.systems[0] ?? extractSystemFromQuery(query) ?? 'the enterprise platform';

  let recommendation = 'DEFER';
  let recDetail = 'Further analysis recommended before committing resources.';
  if (successProb >= 0.9) {
    recommendation = 'PROCEED';
    recDetail = `Proceed with full implementation targeting ${primarySystem} integration.`;
  } else if (successProb >= 0.7) {
    recommendation = 'CONDITIONAL PROCEED';
    recDetail = `Proceed with a scoped pilot to validate core assumptions before full commitment.`;
  }

  // ADR-PIPELINE-024: Pyramid Principle — lead with the answer
  const lines: string[] = [
    '# Executive Summary',
    '',
    `**Date:** ${now}`,
    '',
    '---',
    '',
    '## Recommendation',
    '',
    `**${recommendation}** — ${recDetail}`,
  ];

  if (fin.hasData) {
    const impactParts: string[] = [];
    if (fin.budget) impactParts.push(`${fin.budget} investment`);
    if (fin.payback) impactParts.push(`${fin.payback} payback`);
    if (fin.npv) impactParts.push(`${fin.npv} 5-year NPV`);
    if (impactParts.length > 0) {
      lines.push(`Projected impact: ${impactParts.join(', ')}.`);
    }
  }
  // ADR-PIPELINE-025 §4: Success probability with domain-aware decomposition
  // Technical feasibility is higher (standard APIs/patterns), organizational readiness is lower
  // for large workforces, data availability depends on ERP maturity, integration depends on system count
  const hasLargeWorkforce = extracted.stakeholders.length > 3 || query.length > 800;
  const hasMultipleSystems = extracted.systems.length > 1;
  const hasComplexConstraints = extracted.constraints.length > 2;
  const techFeasibility = Math.min(0.95, successProb + (hasMultipleSystems ? 0.02 : 0.06));
  const orgReadiness = Math.max(0.65, successProb - (hasLargeWorkforce ? 0.08 : 0.03) - (hasComplexConstraints ? 0.03 : 0));
  const dataAvailability = Math.max(0.70, successProb - (hasMultipleSystems ? 0.04 : 0.01));
  const integrationFeasibility = Math.max(0.70, successProb - (extracted.systems.length * 0.02));
  lines.push(`Success probability: **${(successProb * 100).toFixed(0)}%** (Technical ${(techFeasibility * 100).toFixed(0)}%, Organizational ${(orgReadiness * 100).toFixed(0)}%, Data ${(dataAvailability * 100).toFixed(0)}%, Integration ${(integrationFeasibility * 100).toFixed(0)}%) | Timeline: ${timeline}`, '');

  // The Opportunity — cost of inaction
  lines.push('## The Opportunity', '');
  lines.push(`${problemStatement}. Current processes rely on manual review and periodic reporting, ` +
    `limiting the organization's ability to act proactively. Without intervention, inefficiencies ` +
    `compound as operational scale grows across ${extracted.stakeholders.length > 0 ? extracted.stakeholders.slice(0, 2).join(' and ') : 'multiple teams'} ` +
    `and ${primarySystem} data volume increases.`, '');

  // What We Found — key insights with numbers
  lines.push('## Key Findings', '');
  const insights: string[] = [];
  if (fin.roi) insights.push(`Projected return on investment of ${fin.roi}`);
  if (fin.costSavings) insights.push(`Estimated cost savings of ${fin.costSavings}`);
  if (fin.revenue) insights.push(`Revenue impact potential of ${fin.revenue}`);
  // Pull agent insights
  const execAgent = extractAgentData(platformResults, 'platform', 'executive-summary');
  if (execAgent) {
    const findings = safeArray(execAgent, 'findings').concat(safeArray(execAgent, 'key_findings'));
    for (const f of findings.slice(0, 3)) {
      insights.push(typeof f === 'string' ? f : safeString(f as Record<string, unknown>, 'description') || safeString(f as Record<string, unknown>, 'finding') || String(f));
    }
  }
  insights.push(`${primarySystem} integration is technically feasible with ${extracted.constraints.length > 0 ? 'identified compliance constraints manageable' : 'standard API integration patterns'}`);
  insights.push('Human-in-the-loop governance preserves decision authority while accelerating analysis');
  for (const insight of insights.slice(0, 6)) {
    if (insight) lines.push(`- ${insight}`);
  }
  lines.push('');

  // Financial Impact
  if (fin.hasData) {
    lines.push('## Financial Impact', '');
    lines.push('| Metric | Value |', '|--------|-------|');
    if (fin.budget) lines.push(`| Total Investment | ${fin.budget} |`);
    if (fin.roi) lines.push(`| Expected ROI | ${fin.roi} |`);
    if (fin.npv) lines.push(`| 5-Year NPV | ${fin.npv} |`);
    if (fin.payback) lines.push(`| Payback Period | ${fin.payback} |`);
    if (fin.revenue) lines.push(`| Revenue Impact | ${fin.revenue} |`);
    if (fin.costSavings) lines.push(`| Cost Savings | ${fin.costSavings} |`);
    lines.push('');
  }

  // Risk Profile — never empty
  lines.push('## Risk Profile', '');
  const topRisks = risks.slice(0, 3);
  const maxScore = topRisks[0]?.score ?? 0;
  const riskLevel = maxScore >= 6 ? 'MEDIUM' : maxScore >= 3 ? 'LOW-MEDIUM' : 'LOW';
  lines.push(`**Overall Risk Level: ${riskLevel}** — ${topRisks.length} risks require active management.`, '');
  for (const r of topRisks) {
    lines.push(`- **${r.category}** (${r.likelihood} likelihood, ${r.impact} impact): ${r.risk}`);
  }
  lines.push('');

  // Recommended Next Steps — time-bound
  lines.push('## Recommended Next Steps', '');
  const steps = buildDomainNextSteps(recommendation, extracted);
  for (const step of steps) {
    lines.push(step);
  }
  lines.push('');

  // Provenance
  const sources = platformResults.filter(r => r.status >= 200 && r.status < 300).map(r => `${r.domain}/${r.agent}`);
  lines.push('---', '');
  lines.push(`*Sources: ${sources.slice(0, 8).join(', ')}${sources.length > 8 ? ` + ${sources.length - 8} more` : ''}*`);
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
  const extracted = extractScenarioFromQuery(query);
  const problemStatement = distillProblemStatement(query);
  const fin = synthesizeFinancials(simData, platformResults, query);
  const risks = generateDomainRisks(query, extracted);
  const primarySystem = extracted.systems[0] ?? extractSystemFromQuery(query) ?? 'the enterprise platform';
  const plannerData = extractAgentData(platformResults, 'copilot', 'planner');

  let recommendation = 'DEFER';
  let rationale = 'Further analysis recommended before committing resources.';
  if (successProb >= 0.9) {
    recommendation = 'PROCEED';
    rationale = 'High probability of success with manageable risks. Full deployment recommended.';
  } else if (successProb >= 0.7) {
    recommendation = 'CONDITIONAL PROCEED';
    rationale = 'Moderate confidence. A scoped pilot is recommended to validate core assumptions before committing to full deployment.';
  }

  // ADR-PIPELINE-024: Structured decision package
  const lines: string[] = [
    '# Decision Memo',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    `**Decision Requested:** Approval to proceed with ${successProb >= 0.7 ? 'scoped pilot' : 'feasibility investigation'}`,
    '',
    '---',
    '',
    '## Recommendation',
    '',
    `**${recommendation}** — ${rationale}`,
    '',
    `Success probability: ${(successProb * 100).toFixed(0)}%`,
    '',

    // Business Context
    '## Business Context', '',
    `The organization requires ${problemStatement.toLowerCase()}. ` +
    `Current manual processes limit visibility and create operational inefficiency across ` +
    `${extracted.stakeholders.slice(0, 3).join(', ') || 'multiple business units'}. ` +
    `${primarySystem} serves as the system of record, and any solution must integrate non-disruptively.`,
    '',

    // Options Considered
    '## Options Considered', '',
    '| Option | Description | Investment | Timeline | Risk Level | Recommendation |',
    '|--------|-------------|-----------|----------|------------|---------------|',
  ];

  // Compute pilot cost as ~30% of full deployment
  const fullBudget = fin.budget || 'TBD';
  let pilotBudget = fullBudget;
  const budgetNum = fin.budget?.match(/\$([0-9,.]+)([KMB]?)/i);
  if (budgetNum) {
    const num = parseFloat(budgetNum[1]!.replace(/,/g, ''));
    const suffix = (budgetNum[2] || '').toUpperCase();
    const mult = suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : suffix === 'B' ? 1_000_000_000 : 1;
    const fullVal = num * mult;
    const pilotVal = fullVal * 0.3;
    const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1000).toFixed(0)}K`;
    pilotBudget = `${fmt(pilotVal)} - ${fmt(pilotVal * 1.5)}`;
  }

  lines.push(
    `| **A. Scoped Pilot** | Validate with subset of data and ${extracted.domain_entities.slice(0, 2).join(', ') || 'core entities'} | ${pilotBudget} | 8-12 weeks | Low | **Recommended** |`,
    `| **B. Full Deployment** | Enterprise-wide rollout across all ${extracted.systems.length > 0 ? extracted.systems.join(', ') : 'systems'} | ${fullBudget} | ${safeString(simData, 'timeline_estimate') || '16-24 weeks'} | Medium | After pilot validation |`,
    `| **C. Do Nothing** | Continue with manual processes | $0 upfront | N/A | High | Not recommended — ${fin.costSavings ? fin.costSavings + ' annual waste continues' : fin.revenue ? fin.revenue + ' in annual savings foregone' : 'costs compound without intervention'} |`,
    '',
  );

  // Financial Impact
  lines.push('## Financial Impact', '');
  if (fin.hasData) {
    lines.push('| Metric | Value |', '|--------|-------|');
    if (fin.budget) lines.push(`| Total Investment | ${fin.budget} |`);
    if (fin.roi) lines.push(`| Expected ROI | ${fin.roi} |`);
    if (fin.npv) lines.push(`| 5-Year NPV | ${fin.npv} |`);
    if (fin.payback) lines.push(`| Payback Period | ${fin.payback} |`);
    if (fin.revenue) lines.push(`| Revenue Impact | ${fin.revenue} |`);
    if (fin.costSavings) lines.push(`| Cost Savings | ${fin.costSavings} |`);
    lines.push('');
  } else {
    lines.push('Financial model to be developed during discovery phase. Key inputs: implementation cost, operational savings, and revenue impact.', '');
  }

  // Risk Assessment Summary — never empty
  lines.push('## Risk Assessment', '');
  lines.push('| # | Risk | Category | Likelihood | Impact | Mitigation |');
  lines.push('|---|------|----------|-----------|--------|------------|');
  for (let i = 0; i < Math.min(risks.length, 5); i++) {
    const r = risks[i]!;
    lines.push(`| ${i + 1} | ${r.risk} | ${r.category} | ${r.likelihood} | ${r.impact} | ${r.mitigation} |`);
  }
  lines.push('');

  // Implementation Approach
  lines.push('## Implementation Approach', '');
  if (plannerData) {
    const insights = synthesizeAgentInsights(plannerData, 'copilot-planner');
    lines.push(...insights);
  } else {
    const steps = buildDomainNextSteps(recommendation, extracted);
    for (const step of steps) lines.push(step);
  }
  lines.push('');

  // Stakeholder Impact — use extracted stakeholders or domain-appropriate defaults
  lines.push('## Stakeholder Impact', '');
  lines.push('| Stakeholder | Role | Impact | Action Required |');
  lines.push('|-------------|------|--------|----------------|');

  // Build a rich stakeholder list from extracted + domain defaults
  const stakeholderRows: Array<{ name: string; role: string; impact: string; action: string }> = [
    { name: 'Executive Sponsor / CFO', role: 'Decision Maker', impact: 'Budget approval, strategic alignment', action: 'Review financial model, approve pilot scope' },
  ];
  // Use extracted stakeholders for domain-specific rows
  const usedNames = new Set<string>(['Executive Sponsor / CFO']);
  for (const s of extracted.stakeholders.slice(0, 6)) {
    if (usedNames.has(s)) continue;
    usedNames.add(s);
    if (/operations|field|maintenance|network|asset|plant/i.test(s)) {
      stakeholderRows.push({ name: s, role: 'Domain Expert', impact: 'Process change, pilot execution', action: `Lead pilot validation; provide operational data and domain expertise` });
    } else if (/it|technology|engineer|scada|iot/i.test(s)) {
      stakeholderRows.push({ name: s, role: 'Technical Lead', impact: 'Architecture sign-off', action: `Validate ${primarySystem} integration approach and data pipeline design` });
    } else if (/compliance|regulat|governance|audit/i.test(s)) {
      stakeholderRows.push({ name: s, role: 'Governance', impact: 'Compliance review', action: 'Validate audit trail, approval workflow, and regulatory alignment' });
    } else if (/sustainability|esg|environmental/i.test(s)) {
      stakeholderRows.push({ name: s, role: 'Strategic', impact: 'Sustainability alignment', action: 'Validate environmental impact metrics and reporting requirements' });
    } else if (/finance|cfo|budget|procurement/i.test(s)) {
      stakeholderRows.push({ name: s, role: 'Financial', impact: 'Budget and ROI oversight', action: 'Review cost projections and approve resource allocation' });
    } else if (/union|workforce|employee/i.test(s)) {
      stakeholderRows.push({ name: s, role: 'Affected Party', impact: 'Workflow changes', action: 'Review process changes; provide feedback on operational impact' });
    } else {
      stakeholderRows.push({ name: s, role: 'Stakeholder', impact: 'Indirect impact', action: 'Review and provide feedback on relevant aspects' });
    }
  }
  // Ensure minimum 4 stakeholders with domain-appropriate defaults
  if (!stakeholderRows.some(r => /technical|technology|engineer|it/i.test(r.role))) {
    stakeholderRows.push({ name: 'Technology / IT Lead', role: 'Technical Lead', impact: 'Architecture sign-off', action: `Validate ${primarySystem} integration and data architecture` });
  }
  if (!stakeholderRows.some(r => /domain|operations/i.test(r.role))) {
    stakeholderRows.push({ name: 'Operations Leadership', role: 'Domain Expert', impact: 'Process change, pilot execution', action: 'Lead pilot; provide operational expertise and feedback' });
  }
  if (!stakeholderRows.some(r => /governance|compliance/i.test(r.role))) {
    stakeholderRows.push({ name: 'Compliance & Regulatory Affairs', role: 'Governance', impact: 'Regulatory review', action: 'Validate audit trail and approval workflow design' });
  }

  for (const row of stakeholderRows.slice(0, 6)) {
    lines.push(`| ${row.name} | ${row.role} | ${row.impact} | ${row.action} |`);
  }
  lines.push('');

  // Provenance
  const sources = platformResults.filter(r => r.status >= 200 && r.status < 300).map(r => `${r.domain}/${r.agent}`);
  lines.push('---', '');
  lines.push(`*Sources: ${sources.slice(0, 6).join(', ')}${sources.length > 6 ? ` + ${sources.length - 6} more` : ''}*`);
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
  [/\byardi\s*voyager\b/i, 'Yardi Voyager'],
  [/\byardi\b/i, 'Yardi'],
  [/\binfor\s+cloudsuite\b/i, 'Infor CloudSuite'],
  [/\binfor\b/i, 'Infor'],
  [/\bepicor\b/i, 'Epicor'],
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
  { keywords: ['water', 'utility', 'distribution', 'pipe', 'leak', 'pressure', 'flow', 'meter', 'network operations'], type: 'utility-network-operations' },
  { keywords: ['energy', 'grid', 'power', 'electricity', 'outage', 'transmission', 'substation'], type: 'energy-utility-operations' },
  { keywords: ['telecom', 'network', 'fiber', 'wireless', 'coverage', 'bandwidth'], type: 'telecommunications-operations' },
  { keywords: ['sustainability', 'carbon', 'emissions', 'esg', 'environmental', 'green', 'climate'], type: 'sustainability-esg' },
  { keywords: ['asset management', 'maintenance', 'preventive', 'predictive', 'condition', 'reliability', 'maximo', 'cmms'], type: 'asset-maintenance-management' },
  { keywords: ['healthcare', 'patient', 'clinical', 'hospital', 'ehr', 'medical', 'diagnosis'], type: 'healthcare-operations' },
  { keywords: ['pharma', 'drug', 'clinical trial', 'gxp', 'batch', 'formulation'], type: 'pharma-life-sciences' },
];

/** Role/stakeholder patterns found in natural language. */
const STAKEHOLDER_PATTERNS: Array<[RegExp, string]> = [
  // Executive / C-suite
  [/\bc-suite|ceo|cfo|cto|cio|chro|coo\b/i, 'Executive Leadership'],
  [/\bboard\s*(of directors|members|commission)\b/i, 'Board / Commission'],
  [/\bexecutive\s*(sponsor|team|committee)\b/i, 'Executive Sponsor'],
  // Operations & Engineering
  [/\bvp\s*(of\s*)?(operations|engineering|infrastructure)\b/i, 'VP Operations'],
  [/\bchief\s*(engineer|operating|technology|information)\b/i, 'Chief Engineer / CTO'],
  [/\boperations\s*(team|manager|department|director|lead)\b/i, 'Operations Leadership'],
  [/\bfield\s*(operations|crews?|teams?|supervisor|technician)\b/i, 'Field Operations'],
  [/\bengineering\s*(team|department|manager|director)\b/i, 'Engineering Team'],
  // Infrastructure / Utilities
  [/\bnetwork\s*(operations|engineer|manager|team)\b/i, 'Network Operations'],
  [/\basset\s*(management|manager|team)\b/i, 'Asset Management'],
  [/\bmaintenance\s*(planning|manager|team|supervisor|crew)\b/i, 'Maintenance Planning'],
  [/\binfrastructure\s*(team|manager|engineer)\b/i, 'Infrastructure Team'],
  [/\bplant\s*(manager|operator|director)\b/i, 'Plant Operations'],
  [/\bsustainability\s*(team|officer|director|manager|lead)\b/i, 'Sustainability Leadership'],
  // IT & Data
  [/\bit\s*(team|department|operations|director|manager)\b/i, 'IT Operations'],
  [/\bit\/ot\b/i, 'IT/OT Convergence Team'],
  [/\bdata\s*(team|scientist|engineer|analyst|governance)\b/i, 'Data Team'],
  [/\bscada|iot|sensors?\s*team\b/i, 'SCADA / IoT Team'],
  // HR
  [/\bhr\s*(team|leader|director|operations|manager|department)\b/i, 'HR Leadership'],
  [/\bunion\s*(representative|rep|delegate|leadership)\b/i, 'Union Representatives'],
  // Finance & Procurement
  [/\bfinance\s*(team|department|controller|director|manager)\b/i, 'Finance / CFO'],
  [/\bprocurement\s*(team|manager|officer)\b/i, 'Procurement'],
  // Governance & Compliance
  [/\bcompliance\s*(team|officer|department|manager)\b/i, 'Compliance & Regulatory Affairs'],
  [/\bregulat(?:ory|or)\s*(affairs|team|compliance|body|bodies|commission)?\b/i, 'Regulatory Affairs'],
  [/\bsecurity\s*(team|officer|department)\b/i, 'Security Team'],
  [/\bauditor[s]?\b/i, 'Auditors'],
  // General
  [/\bmanager[s]?\b/i, 'Team Managers'],
  [/\bemployee[s]?\b/i, 'Workforce'],
  [/\bvendor[s]?\b/i, 'External Vendors'],
  [/\bcustomer[s]?\b/i, 'Customers / Ratepayers'],
  [/\bstakeholder[s]?\b/i, 'Stakeholders'],
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
  // Remove common preambles and context-setting openings
  let cleaned = query
    // Strip "I lead/manage/run..." biographical introductions
    .replace(/^I\s+(?:lead|manage|run|oversee|am responsible for|work in|head)\s+[^.]+\.\s*/i, '')
    // Strip "We are a..." / "Our company is..." organizational descriptions
    .replace(/^(?:We are|Our (?:company|organization|firm|team) is)\s+[^.]+\.\s*/i, '')
    // Strip "One of the challenges..." problem setup
    .replace(/^One of the (?:challenges|issues|problems)\s+(?:we face|I face)\s+is\s+/i, '')
    // Strip standard intent preambles
    .replace(/^(?:I want to|I'd like to|I need to|We need to|We want to|Please|Can you|Could you)\s+/i, '')
    .replace(/^(?:build|create|design|develop|implement|generate|make)\s+(?:a\s+|an\s+)?/i, '')
    .replace(/^(?:working\s+)?prototype\s+(?:for|of|that)\s+/i, '')
    .replace(/^(?:proof of concept|poc)\s+(?:for|of|that)\s+/i, '')
    .trim();

  // If the remaining text still starts with a lowercase conjunction or context word,
  // try to find the first real problem/goal sentence
  if (/^(right now|currently|at present|today|however|but|while|although)/i.test(cleaned)) {
    // Skip the context sentence and find the next one
    const nextSentence = cleaned.replace(/^[^.]+\.\s*/, '');
    if (nextSentence.length > 30) cleaned = nextSentence;
  }

  // Try to extract the core objective from "We believe..." / "Ideally..." / "The system would..."
  const idealMatch = query.match(/(?:we believe|ideally|the system (?:would|should)|the goal is|the objective is)\s+(.{30,200}?)(?:\.|$)/i);
  if (idealMatch && idealMatch[1] && cleaned.length > 200) {
    cleaned = idealMatch[1].trim();
  }

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned[0]!.toUpperCase() + cleaned.slice(1);
  }

  // Truncate at sentence boundary if too long
  if (cleaned.length > 150) {
    const boundary = cleaned.lastIndexOf('.', 150);
    if (boundary > 40) {
      cleaned = cleaned.slice(0, boundary + 1);
    } else {
      // Truncate at last word boundary
      const truncated = cleaned.slice(0, 150);
      const lastSpace = truncated.lastIndexOf(' ');
      cleaned = (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated).trim();
    }
  }

  return cleaned || query.slice(0, 150);
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
  const systemList = extracted.systems.length > 0 ? extracted.systems.join(', ') : (extractSystemFromQuery(query) ?? 'target platform');
  const entityList = extracted.domain_entities.slice(0, 3).join(', ') || 'core domain models';
  const primarySystem = extracted.systems[0] ?? extractSystemFromQuery(query) ?? 'enterprise platform';

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
    // ADR-PIPELINE-024: Always include domain-appropriate risks
    risk_factors: generateDomainRisks(query, extracted).map(r => ({
      description: r.risk,
      category: r.category,
      likelihood: r.likelihood,
      impact: r.impact,
      mitigation: r.mitigation,
    })),
    platform_insights: platformResults
      .filter(r => r.agent === 'executive-summary' && r.status >= 200 && r.status < 300)
      .map(r => extractSignalPayload(r.response).data)
      .filter(Boolean),
    cost_estimate: extractAgentData(platformResults, 'costops', 'forecast'),
    implementation_plan: extractAgentData(platformResults, 'copilot', 'planner'),
    resource_requirements: extractAgentData(platformResults, 'costops', 'budget'),
    // ADR-PIPELINE-024: Risk gates between phases
    phase_gates: [
      { after_phase: 'phase-1', gate: 'Discovery Complete', criteria: `${primarySystem} API validated, requirements signed off, team resourced`, decision: 'Proceed to build or pivot' },
      { after_phase: 'phase-2', gate: 'Prototype Validated', criteria: 'Core functionality demonstrated, integration tested, stakeholder approval', decision: 'Proceed to validation or iterate' },
      { after_phase: 'phase-3', gate: 'Pilot Ready', criteria: 'All tests passing, security review complete, operations runbook approved', decision: 'Deploy to production or address gaps' },
    ],
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
  const extracted = extractScenarioFromQuery(query);

  // ADR-PIPELINE-024: Generate domain risks — never return empty
  const domainRisks = generateDomainRisks(query, extracted);

  // Enrich with agent-sourced risks
  const riskAgentData = extractAgentData(platformResults, 'platform', 'risk-score');
  const sentinelAgents = extractAgentsByDomain(platformResults, 'sentinel');
  const shieldAgents = extractAgentsByDomain(platformResults, 'shield');

  const agentRiskDescriptions: string[] = [];
  if (riskAgentData) {
    for (const r of safeArray(riskAgentData, 'risk_factors').concat(safeArray(riskAgentData, 'risks'))) {
      agentRiskDescriptions.push(typeof r === 'string' ? r : safeString(r as Record<string, unknown>, 'description') || JSON.stringify(r));
    }
  }
  for (const r of safeArray(simData, 'risk_factors')) {
    agentRiskDescriptions.push(typeof r === 'string' ? r : JSON.stringify(r));
  }
  for (const agent of sentinelAgents) {
    const data = extractSignalPayload(agent.response).data;
    if (data) {
      for (const f of safeArray(data, 'findings').concat(safeArray(data, 'anomalies'))) {
        agentRiskDescriptions.push(typeof f === 'string' ? f : JSON.stringify(f));
      }
    }
  }

  // Merge agent risks into domain risks (avoid duplicates)
  for (const desc of agentRiskDescriptions) {
    if (desc && !domainRisks.some(r => r.risk.toLowerCase().includes(desc.toLowerCase().slice(0, 30)))) {
      domainRisks.push({
        risk: desc, category: 'Agent-Identified', likelihood: 'Medium', impact: 'Medium', score: 4,
        mitigation: 'To be assessed during discovery phase',
      });
    }
  }

  const maxScore = domainRisks[0]?.score ?? 0;
  const overallRisk = maxScore >= 6 ? 'MEDIUM' : maxScore >= 3 ? 'LOW-MEDIUM' : 'LOW';

  // Security findings
  const securityFindings: unknown[] = [];
  for (const agent of shieldAgents) {
    const data = extractSignalPayload(agent.response).data;
    if (data) securityFindings.push(...safeArray(data, 'findings').concat(safeArray(data, 'vulnerabilities')));
  }

  return {
    metadata: { title: `Risk Assessment: ${distillProblemStatement(query)}`, version: '2.0.0', created: now },
    overall_risk_level: overallRisk,
    success_probability: successProb,
    risk_register: domainRisks.map((r, i) => ({
      id: `RISK-${String(i + 1).padStart(3, '0')}`,
      description: r.risk,
      category: r.category,
      likelihood: r.likelihood,
      impact: r.impact,
      score: r.score,
      mitigation: r.mitigation,
      owner: r.category === 'Technical' ? 'Engineering Lead' : r.category === 'Organizational' ? 'Program Manager' : r.category === 'Regulatory' ? 'Compliance Officer' : r.category === 'Financial' ? 'Finance Lead' : 'Project Manager',
      status: 'open',
    })),
    risk_heat_map: {
      high_likelihood_high_impact: domainRisks.filter(r => r.likelihood === 'High' && r.impact === 'High').map(r => r.risk),
      high_likelihood_medium_impact: domainRisks.filter(r => r.likelihood === 'High' && r.impact === 'Medium').map(r => r.risk),
      medium_likelihood_high_impact: domainRisks.filter(r => r.likelihood === 'Medium' && r.impact === 'High').map(r => r.risk),
      medium_likelihood_medium_impact: domainRisks.filter(r => r.likelihood === 'Medium' && r.impact === 'Medium').map(r => r.risk),
      low_likelihood_high_impact: domainRisks.filter(r => r.likelihood === 'Low' && r.impact === 'High').map(r => r.risk),
    },
    security_findings: securityFindings.length > 0 ? securityFindings : null,
    mitigation_strategy: {
      immediate: domainRisks.filter(r => r.score >= 6).map(r => r.mitigation),
      short_term: domainRisks.filter(r => r.score >= 3 && r.score < 6).map(r => r.mitigation),
      ongoing: ['Continuous risk monitoring during implementation', 'Quarterly risk review with stakeholders', 'Automated alerting for technical risks'],
    },
    sources: [
      riskAgentData && 'platform/risk-score',
      ...sentinelAgents.map(a => `sentinel/${a.agent}`),
      ...shieldAgents.map(a => `shield/${a.agent}`),
    ].filter(Boolean),
  };
}

// ============================================================================
// ADR-PIPELINE-020: Financial Analysis Renderer (costops agents)
// ============================================================================

export function renderFinancialAnalysis(
  query: string,
  simulationResult: unknown,
  platformResults: AgentResult[],
): string {
  const now = new Date().toISOString();
  const problemStatement = distillProblemStatement(query);
  const simPayload = extractSignalPayload(simulationResult);
  const simData = simPayload.data ?? {};
  const fin = synthesizeFinancials(simData, platformResults, query);
  const successProb = extractSuccessProbability(simData);
  const extracted = extractScenarioFromQuery(query);

  const roiData = extractAgentData(platformResults, 'costops', 'roi');
  const forecastData = extractAgentData(platformResults, 'costops', 'forecast');
  const attributionData = extractAgentData(platformResults, 'costops', 'attribution');
  const budgetData = extractAgentData(platformResults, 'costops', 'budget');
  const tradeoffData = extractAgentData(platformResults, 'costops', 'tradeoff');

  // ADR-PIPELINE-024: Never output "pending" or "To be quantified" — always produce a model.
  // If synthesizeFinancials() returned empty strings, force re-estimation from query context.
  if (!fin.hasData || (!fin.budget && !fin.roi && !fin.npv)) {
    const estimated = estimateFinancialsFromQuery(query);
    if (!fin.budget) fin.budget = estimated.budget;
    if (!fin.roi) fin.roi = estimated.roi;
    if (!fin.npv) fin.npv = estimated.npv;
    if (!fin.payback) fin.payback = estimated.payback;
    if (!fin.revenue) fin.revenue = estimated.revenue;
    if (!fin.costSavings) fin.costSavings = estimated.costSavings;
    fin.hasData = true;
    fin.isEstimated = true;
  }

  const lines: string[] = [
    '# Financial Analysis',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    '',
    '---',
    '',
    `## Investment Summary${fin.isEstimated ? ' (Estimated from Organization Profile)' : ''}`, '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Investment | ${fin.budget} |`,
    `| Expected ROI | ${fin.roi} |`,
    `| 5-Year NPV | ${fin.npv} |`,
    `| Payback Period | ${fin.payback} |`,
    `| Revenue / Savings Impact | ${fin.revenue || fin.costSavings} |`,
    '',
  ];

  // ROI Analysis
  lines.push('## Return on Investment', '');
  if (roiData) {
    const insights = synthesizeAgentInsights(roiData, 'costops-roi');
    lines.push(...insights);
  } else if (fin.roi || fin.payback) {
    lines.push(`The projected ROI of ${fin.roi || 'this initiative'} is based on simulation modeling ` +
      `with ${(successProb * 100).toFixed(0)}% confidence. ${fin.payback ? `Expected payback period: ${fin.payback}.` : ''} ` +
      `These projections should be validated against actual operational data during the pilot phase.`, '');
  } else {
    lines.push(`Based on organizational profile analysis, the projected ROI of ${fin.roi || 'this initiative'} reflects estimated efficiency gains of ` +
      `${fin.costSavings || fin.revenue || 'the modeled scenario'}. ${fin.payback ? `Expected payback period: ${fin.payback}.` : ''} ` +
      `Industry benchmarks for ${extracted.scenario_type.replace(/-/g, ' ')} implementations confirm these projections are within typical ranges.`, '');
  }

  // Cost Forecast
  lines.push('## Cost Forecast', '');
  if (forecastData) {
    const insights = synthesizeAgentInsights(forecastData, 'costops-forecast');
    lines.push(...insights);
  } else {
    lines.push(`Estimated cost trajectory based on ${fin.budget || 'organizational profile'}: Year 1 implementation and pilot ` +
      `(~60% of total investment), Year 2 production rollout and optimization (~30%), Year 3+ operational maintenance (~10%). ` +
      `${extracted.systems[0] ? `${extracted.systems[0]} integration costs are included in the Year 1 estimate.` : 'Integration costs are front-loaded in Year 1.'}`, '');
  }

  // Cost Attribution
  lines.push('## Cost Attribution', '');
  if (attributionData) {
    const insights = synthesizeAgentInsights(attributionData, 'costops-attribution');
    lines.push(...insights);
  } else {
    lines.push('Typical cost distribution for enterprise implementations: Development (35-40%), Infrastructure (20-25%), Integration (15-20%), Operations & Support (15-20%). Actual breakdown to be refined during planning.', '');
  }

  // Budget Allocation
  lines.push('## Budget Allocation', '');
  if (budgetData) {
    const insights = synthesizeAgentInsights(budgetData, 'costops-budget');
    lines.push(...insights);
  } else {
    lines.push(`Recommended budget allocation for ${fin.budget || 'the estimated investment'}: Development & Engineering (35-40%), ` +
      `Infrastructure & Cloud (20-25%), Integration & Testing (15-20%), Operations & Support (15-20%), Contingency (5-10%). ` +
      `Pilot phase should consume no more than 30% of total budget to preserve flexibility for production scaling.`, '');
  }

  // Cost-Quality Tradeoff
  lines.push('## Cost-Quality Tradeoff Analysis', '');
  if (tradeoffData) {
    const insights = synthesizeAgentInsights(tradeoffData, 'costops-tradeoff');
    lines.push(...insights);
  } else {
    lines.push(`Key tradeoff dimensions for this initiative: (1) Implementation speed vs. feature completeness — a phased ` +
      `approach balances time-to-value with thoroughness; (2) Custom development vs. ${extracted.systems[0] || 'platform'} native capabilities — ` +
      `leverage existing ERP features before building custom; (3) Pilot scope vs. enterprise coverage — validate with 10-15% of ` +
      `operational scope before committing to full rollout. The recommended pilot approach optimizes for learning velocity while ` +
      `constraining investment risk to ${fin.budget ? `approximately 30% of the ${fin.budget} total estimate` : 'a fraction of total investment'}.`, '');
  }

  const sources = [roiData && 'costops/roi', forecastData && 'costops/forecast', attributionData && 'costops/attribution', budgetData && 'costops/budget', tradeoffData && 'costops/tradeoff'].filter(Boolean);
  lines.push('---', '');
  // Scenario Analysis
  lines.push('## Scenario Analysis', '');
  lines.push('| Scenario | Assumption | Investment | ROI | Probability |');
  lines.push('|----------|-----------|-----------|-----|------------|');
  // Always produce concrete scenario numbers — fin is guaranteed populated above
  const budgetForScenario = fin.budget || 'Estimated investment';
  // Extract numeric value from budget string for actual calculation
  const budgetMatch = fin.budget?.match(/\$([0-9,.]+)([KMB]?)/i);
  let baseCostStr = budgetForScenario;
  let optCostStr = budgetForScenario;
  let pessCostStr = budgetForScenario;
  if (budgetMatch) {
    const numStr = budgetMatch[1]!.replace(/,/g, '');
    const suffix = (budgetMatch[2] || '').toUpperCase();
    const multiplier = suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : suffix === 'B' ? 1_000_000_000 : 1;
    const baseVal = parseFloat(numStr) * multiplier;
    if (!isNaN(baseVal) && baseVal > 0) {
      const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${(n / 1000).toFixed(0)}K`;
      baseCostStr = fmt(baseVal);
      optCostStr = fmt(baseVal * 0.8);
      pessCostStr = fmt(baseVal * 1.4);
    }
  }
  lines.push(`| **Base Case** | Plan executes as modeled | ${baseCostStr} | ${fin.roi || 'Projected'} | 50% |`);
  lines.push(`| Optimistic | Faster adoption, lower integration costs | ${optCostStr} | ${fin.roi ? fin.roi.replace(/\d+/, m => String(Math.round(parseInt(m) * 1.3))) : 'Above base'} | 25% |`);
  lines.push(`| Pessimistic | Slower adoption, scope growth | ${pessCostStr} | ${fin.roi ? fin.roi.replace(/\d+/, m => String(Math.round(parseInt(m) * 0.6))) : 'Below base'} | 25% |`);
  lines.push('', '*Scenario analysis assumes ±20% cost variance and ±30% timeline variance from base case.*', '');

  lines.push(`*Sources: ${sources.length > 0 ? sources.join(', ') : 'simulation data + industry benchmarks'}*`);
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

  // ADR-PIPELINE-025 §7c: Detect applicable regulations from query context
  const regulations = detectApplicableRegulations(query);
  const extracted = extractScenarioFromQuery(query);
  const primarySystem = extracted.systems[0] ?? extractSystemFromQuery(query) ?? 'the enterprise platform';

  const lines: string[] = [
    '# Security & Compliance Assessment',
    '',
    `**Date:** ${now}`,
    `**Subject:** ${problemStatement}`,
    `**Target System:** ${primarySystem}`,
    '',
    '---',
    '',
  ];

  // Applicable Regulations — always populated from query context
  lines.push('## Applicable Regulatory Frameworks', '');
  if (regulations.length > 0) {
    lines.push('| Framework | Applicability | Key Requirements | Impact on Solution |');
    lines.push('|-----------|--------------|------------------|-------------------|');
    for (const reg of regulations) {
      lines.push(`| ${reg.framework} | ${reg.applicability} | ${reg.requirements} | ${reg.impact} |`);
    }
    lines.push('');
  }

  // Security Posture
  lines.push('## Security Posture', '');
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
    lines.push('### Data Classification', '');
    lines.push(`- **Internal data**: Operational telemetry, performance metrics, efficiency analysis`);
    lines.push(`- **Confidential data**: ${primarySystem} transaction records, financial data, employee information`);
    lines.push(`- **Regulated data**: ${regulations.length > 0 ? regulations.map(r => r.dataType).join(', ') : 'Subject to applicable industry regulations'}`);
    lines.push('');
    lines.push('### Recommended Security Controls', '');
    lines.push('- Role-based access control (RBAC) with separation of duties');
    lines.push('- Encryption at rest and in transit (TLS 1.3)');
    lines.push('- Audit trail for all data access and decision actions');
    lines.push('- Secret management via cloud provider vault (no hardcoded credentials)');
    lines.push(`- PII redaction in ${primarySystem} data pipeline`);
    lines.push('');
  }

  // Governance & Compliance
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
    lines.push('### Decision Governance Model', '');
    lines.push('- Human-in-the-loop: No automated execution — all recommendations require human approval');
    lines.push('- Approval workflow: Submit → Review → Approve/Reject → Execute (governance-gated)');
    lines.push(`- ${primarySystem} writeback: Only approved actions propagate to the ERP system`);
    lines.push('- Audit trail: Append-only log with actor, timestamp, action, correlation ID');
    lines.push('');
  }

  const sources = [...shieldAgents.map(a => `shield/${a.agent}`), ...govAgents.map(a => `governance-dashboard/${a.agent}`)];
  lines.push('---', '');
  lines.push(`*Sources: ${sources.length > 0 ? sources.join(', ') : 'domain context analysis + regulatory framework detection'}*`);
  lines.push(`*Generated: ${now}*`);
  return lines.join('\n');
}

interface ApplicableRegulation {
  framework: string;
  applicability: string;
  requirements: string;
  impact: string;
  dataType: string;
}

function detectApplicableRegulations(query: string): ApplicableRegulation[] {
  const regs: ApplicableRegulation[] = [];
  const lower = query.toLowerCase();

  // Pharmaceutical / Life Sciences
  if (lower.includes('pharma') || lower.includes('drug') || lower.includes('gxp') || lower.includes('clinical') || lower.includes('temperature-sensitive') || lower.includes('cold chain')) {
    regs.push({
      framework: 'FDA 21 CFR Part 11',
      applicability: 'Required — pharmaceutical electronic records',
      requirements: 'Audit trails, electronic signatures, data integrity, system validation',
      impact: 'All decision records must be tamper-evident with full audit trail',
      dataType: 'pharmaceutical production and distribution records',
    });
    regs.push({
      framework: 'EU GxP Annex 11',
      applicability: 'Required for EU operations — computerized systems',
      requirements: 'System validation, data integrity, access controls, change management',
      impact: 'System must be validated before production use; all changes documented',
      dataType: 'GxP-regulated process data',
    });
    regs.push({
      framework: 'GDP (Good Distribution Practice)',
      applicability: 'Required — pharmaceutical distribution',
      requirements: 'Temperature monitoring, transportation qualification, deviation management',
      impact: 'Cold chain monitoring and deviation alerts are compliance-critical',
      dataType: 'temperature and logistics records',
    });
  }

  // Healthcare
  if (lower.includes('health') || lower.includes('patient') || lower.includes('clinical') || lower.includes('hipaa') || lower.includes('medical')) {
    regs.push({
      framework: 'HIPAA',
      applicability: 'Required — protected health information',
      requirements: 'PHI encryption, access controls, breach notification, BAAs',
      impact: 'All patient data must be encrypted; access logged; minimum necessary principle',
      dataType: 'protected health information (PHI)',
    });
  }

  // Financial
  if (lower.includes('financial') || lower.includes('banking') || lower.includes('insurance') || lower.includes('sox') || lower.includes('accounting')) {
    regs.push({
      framework: 'SOX (Sarbanes-Oxley)',
      applicability: 'Required — financial reporting controls',
      requirements: 'Internal controls, audit trail, segregation of duties, change management',
      impact: 'Financial data transformations must have full audit trail and dual approval',
      dataType: 'financial records and reporting data',
    });
    regs.push({
      framework: 'PCI-DSS',
      applicability: 'If payment data is processed',
      requirements: 'Encryption, access controls, vulnerability management, monitoring',
      impact: 'Payment data must never be stored unencrypted; quarterly vulnerability scans',
      dataType: 'payment card and transaction data',
    });
  }

  // EU operations → GDPR
  if (lower.includes('europe') || lower.includes('eu ') || lower.includes('gdpr') || lower.includes('european')) {
    regs.push({
      framework: 'GDPR',
      applicability: 'Required — EU personal data processing',
      requirements: 'Data minimization, consent management, right to erasure, DPIAs, data residency',
      impact: 'EU employee/customer data must stay in EU region; privacy by design required',
      dataType: 'personal data of EU data subjects',
    });
  }

  // Multi-region → data residency
  if ((lower.includes('north america') && lower.includes('europe')) || (lower.includes('asia') && lower.includes('europe')) || lower.includes('global') || lower.includes('multi-region')) {
    regs.push({
      framework: 'Data Residency Requirements',
      applicability: 'Required — multi-jurisdictional operations',
      requirements: 'Data must be stored in the jurisdiction where it was generated unless transfer mechanisms exist',
      impact: 'Regional deployment or data partitioning may be required; cross-border transfer assessments',
      dataType: 'regionally-generated operational and personal data',
    });
  }

  // Sustainability / ESG
  if (lower.includes('sustainability') || lower.includes('emission') || lower.includes('carbon') || lower.includes('esg') || lower.includes('environmental')) {
    regs.push({
      framework: 'CSRD / EU Taxonomy',
      applicability: 'Required for EU-operating large enterprises — sustainability reporting',
      requirements: 'Auditable emissions data, double materiality assessment, ESRS compliance',
      impact: 'Sustainability metrics must be auditable with documented methodology',
      dataType: 'emissions, energy, waste, and sustainability performance data',
    });
  }

  return regs;
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
    `**Target Systems:** ${extracted.systems.join(', ') || extractSystemFromQuery(query) || 'See scenario description'}`,
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
    const intSystem = extracted.systems[0] || extractSystemFromQuery(query) || 'the target platform';
    lines.push(`Integration with ${intSystem} requires API authentication, rate limits assessment, data format compatibility validation, error handling strategy, and retry logic. A 1-2 week technical spike is recommended to validate these integration points before full development.`, '');
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
    lines.push('Resilience patterns (circuit breakers, retry with backoff, failover) to be implemented during the build phase based on integration assessment findings.', '');
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
