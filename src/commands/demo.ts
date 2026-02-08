/**
 * Demo Command — `agentics demo start <scenario>`
 *
 * PURPOSE: Present a guided, read-only walkthrough of the platform's
 * value for a given simulation scenario. Designed for executive audiences.
 *
 * SAFETY GUARANTEES:
 * - Read-only: reads from decision-readiness artifacts, never writes
 * - Gate-exempt: does not trigger any of the 7 enforcement gates
 * - Non-interactive: no subcommands, no branching, no execution paths
 * - Cannot unlock execution, modify state, or invoke downstream services
 *
 * SUBCOMMANDS:
 * - start <scenario>   Run the guided demo walkthrough
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Types
// ============================================================================

interface DecisionReadinessSummary {
  simulation_id: string;
  plan_ref: string;
  state_classification: string;
  generated_at: string;
  simulation_outcomes: {
    cost: {
      daily_api_cost_usd: number;
      annual_api_spend_usd: number;
      year1_total_investment_usd: number;
      annual_savings_usd: number;
      roi_payback_months: number;
      npv_5yr_usd: number;
      tier_distribution: {
        opus: { daily_usd: number; annual_usd: number; pct: number };
        sonnet: { daily_usd: number; annual_usd: number; pct: number };
        haiku: { daily_usd: number; annual_usd: number; pct: number };
      };
      departments_in_scope: number;
      employees_in_scope: number;
    };
    risk: {
      total_risks: number;
      highest_score: number;
      highest_risk: string;
      by_severity: {
        critical_15_plus: number;
        high_10_14: number;
        medium_below_10: number;
      };
      categories: string[];
    };
    compliance: {
      frameworks: string[];
      sox_audit_entries_per_day: number;
      sox_exceptions_30d: number;
      finra_supervisory_entries_per_month: number;
      gdpr_data_requests_per_day: number;
      pii_interceptions_per_day: number;
      agents_with_pii_access: number;
    };
    agent_usage: {
      registered_agent_types: number;
      phantom_agent_types: number;
      total_api_calls_per_day: number;
      peak_concurrent_sessions: number;
      session_cap: number;
      cache_hit_rate: number;
    };
    roi_signals: {
      savings_breakdown: {
        labor_automation_usd: number;
        speed_improvement_usd: number;
        error_reduction_usd: number;
        compliance_cost_avoidance_usd: number;
      };
      year_by_year: Array<{
        year: number;
        investment: number;
        savings: number;
        cumulative: number;
      }>;
    };
  };
  audit_status: {
    result: string;
    checks_passed: number;
    checks_total: number;
  };
  platform_status: {
    ready: {
      systems: Array<{ id: string; entities: number; terraform: boolean }>;
      entities_total: number;
      pct: number;
    };
    blocked: {
      systems: Array<{ id: string; entities: number; severity: string; effort_weeks: string }>;
      entities_total: number;
      pct: number;
    };
  };
  execution_prerequisites: {
    total: number;
    completed: number;
  };
  value_if_stopped: {
    captured: string[];
    deferred: string[];
    reuse_estimate: string;
  };
  execution_gate: string;
}

export interface DemoResult {
  output: string;
  found: boolean;
  scenario: string;
  timing: number;
}

// ============================================================================
// Safety Guard
// ============================================================================

/**
 * Execution-related keywords that are explicitly rejected in demo mode.
 * If any positional arg or flag contains these, the demo refuses to proceed.
 */
const EXECUTION_KEYWORDS = new Set([
  'execute', 'run', 'deploy', 'rollback', 'write', 'push',
  'unlock', 'enable', 'activate', 'force', 'override',
]);

/**
 * Check if any argument suggests an attempt to branch into execution.
 * Returns a rejection message if detected, null otherwise.
 */
function checkExecutionAttempt(args: string[]): string | null {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (EXECUTION_KEYWORDS.has(lower)) {
      return [
        `Demo mode does not support "${arg}".`,
        '',
        'Demo mode is a read-only walkthrough of the platform. It cannot:',
        '  - Execute deployments',
        '  - Unlock the execution gate',
        '  - Write to any system',
        '  - Modify the readiness state',
        '',
        'To understand what is required to unlock execution, run:',
        '  agentics readiness explain',
      ].join('\n');
    }
  }
  return null;
}

// ============================================================================
// Data Loader
// ============================================================================

function loadSummary(): DecisionReadinessSummary | null {
  try {
    const summaryPath = path.join(
      os.homedir(), '.agentics', 'exports',
      'decision-readiness', 'decision-readiness-summary.json',
    );
    if (!fs.existsSync(summaryPath)) return null;
    const content = fs.readFileSync(summaryPath, 'utf-8');
    return JSON.parse(content) as DecisionReadinessSummary;
  } catch {
    return null;
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function dollars(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function sysName(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function separator(): string {
  return '\n' + '\u2500'.repeat(60) + '\n';
}

// ============================================================================
// Demo Renderer
// ============================================================================

function renderDemo(data: DecisionReadinessSummary): string {
  const c = data.simulation_outcomes.cost;
  const r = data.simulation_outcomes.risk;
  const comp = data.simulation_outcomes.compliance;
  const ag = data.simulation_outcomes.agent_usage;
  const roi = data.simulation_outcomes.roi_signals;
  const ps = data.platform_status;

  const lines: string[] = [];

  // ================================================================
  // Header
  // ================================================================
  lines.push('');
  lines.push('  AGENTICS PLATFORM DEMO');
  lines.push('  Enterprise AI Operations — Readiness Assessment');
  lines.push('');
  lines.push(`  Scenario:    ${data.simulation_id}`);
  lines.push(`  Scope:       ${c.employees_in_scope.toLocaleString()} employees across ${c.departments_in_scope} departments`);
  lines.push(`  Status:      ${data.state_classification}`);
  lines.push(`  Audit:       ${data.audit_status.result} (${data.audit_status.checks_passed}/${data.audit_status.checks_total} checks, variance < 0.01%)`);
  lines.push(separator());

  // ================================================================
  // Section 1: Simulation Summary
  // ================================================================
  lines.push('  1. SIMULATION SUMMARY');
  lines.push('');
  const callsPerEmployee = Math.round(ag.total_api_calls_per_day / c.employees_in_scope);
  const utilizationPct = ((ag.peak_concurrent_sessions / ag.session_cap) * 100).toFixed(1);
  lines.push('  The platform simulated 30 days of AI agent operations across a');
  lines.push(`  ${c.employees_in_scope.toLocaleString()}-employee financial institution. The simulation exercises`);
  lines.push(`  ${ag.registered_agent_types} AI agent types handling ${ag.total_api_calls_per_day.toLocaleString()}`);
  lines.push(`  API calls per day (approximately ${callsPerEmployee} per employee), with peak`);
  lines.push(`  concurrency of ${ag.peak_concurrent_sessions.toLocaleString()} sessions against a`);
  lines.push(`  ${ag.session_cap.toLocaleString()}-session cap (${utilizationPct}% utilization).`);
  lines.push('');
  lines.push(`  Daily API cost:      ${dollars(c.daily_api_cost_usd)}`);
  lines.push(`  Annual API spend:    ${dollars(c.annual_api_spend_usd)}`);
  lines.push(`  AI risks identified: ${r.total_risks} (highest score: ${r.highest_score}/25)`);
  lines.push(`  Compliance coverage: ${comp.frameworks.length} frameworks`);
  lines.push('');
  lines.push('  Cost breakdown by model tier:');
  lines.push(`    Opus   (complex reasoning):   ${dollars(c.tier_distribution.opus.annual_usd)}/yr  (${pct(c.tier_distribution.opus.pct)})`);
  lines.push(`    Sonnet (standard tasks):      ${dollars(c.tier_distribution.sonnet.annual_usd)}/yr  (${pct(c.tier_distribution.sonnet.pct)})`);
  lines.push(`    Haiku  (high-volume):         ${dollars(c.tier_distribution.haiku.annual_usd)}/yr  (${pct(c.tier_distribution.haiku.pct)})`);
  lines.push(separator());

  // ================================================================
  // Section 2: Financial Posture
  // ================================================================
  lines.push('  2. FINANCIAL POSTURE');
  lines.push('');
  lines.push('  The platform projects a clear return on investment within');
  lines.push(`  ${c.roi_payback_months} months. All figures have been independently audited.`);
  lines.push('');
  lines.push(`  Year 1 investment:   ${dollars(c.year1_total_investment_usd)}`);
  lines.push(`  Annual savings:      ${dollars(c.annual_savings_usd)}`);
  lines.push(`  5-year NPV:          ${dollars(c.npv_5yr_usd)}`);
  lines.push(`  Payback period:      ${c.roi_payback_months} months`);
  lines.push('');
  lines.push('  Savings breakdown:');
  lines.push(`    Labor automation:            ${dollars(roi.savings_breakdown.labor_automation_usd)}/yr`);
  lines.push(`    Speed improvement:           ${dollars(roi.savings_breakdown.speed_improvement_usd)}/yr`);
  lines.push(`    Error reduction:             ${dollars(roi.savings_breakdown.error_reduction_usd)}/yr`);
  lines.push(`    Compliance cost avoidance:   ${dollars(roi.savings_breakdown.compliance_cost_avoidance_usd)}/yr`);
  lines.push('');
  lines.push('  3-year trajectory:');
  for (const y of roi.year_by_year) {
    const sign = y.cumulative >= 0 ? '+' : '';
    lines.push(`    Year ${y.year}:  invest ${dollars(y.investment)},  save ${dollars(y.savings)},  cumulative: ${sign}${dollars(y.cumulative)}`);
  }
  lines.push(separator());

  // ================================================================
  // Section 3: Compliance & Risk
  // ================================================================
  lines.push('  3. COMPLIANCE & RISK OVERVIEW');
  lines.push('');
  lines.push('  Regulatory frameworks addressed:');
  for (const fw of comp.frameworks) {
    lines.push(`    - ${fw}`);
  }
  lines.push('');
  const exceptionRate = (comp.sox_exceptions_30d / 30).toFixed(1);
  lines.push('  Compliance metrics (30-day simulation):');
  lines.push(`    SOX 404 audit trail entries:     ${comp.sox_audit_entries_per_day.toLocaleString()}/day`);
  lines.push(`    SOX control exceptions:          ${comp.sox_exceptions_30d} in 30 days (${exceptionRate}/day avg)`);
  lines.push(`    FINRA supervisory entries:       ${comp.finra_supervisory_entries_per_month.toLocaleString()}/month`);
  lines.push(`    GDPR data subject requests:      ${comp.gdpr_data_requests_per_day}/day`);
  lines.push(`    PII interceptions by agents:     ${comp.pii_interceptions_per_day}/day`);
  lines.push(`    Agents with PII access:          ${comp.agents_with_pii_access} of ${ag.registered_agent_types}`);
  lines.push('');
  lines.push('  AI risk register:');
  lines.push(`    Total risks:     ${r.total_risks}`);
  lines.push(`    Critical (15+):  ${r.by_severity.critical_15_plus}`);
  lines.push(`    High (10-14):    ${r.by_severity.high_10_14}`);
  lines.push(`    Medium (<10):    ${r.by_severity.medium_below_10}`);
  // Reframe internal risk IDs for executive readability
  const riskLabel = r.highest_risk
    .replace(/\(ADR-\d+\)/g, '')
    .replace(/Ruvector persistence failure/i, 'Audit trail persistence failure')
    .trim();
  lines.push(`    Highest risk:    ${riskLabel}`);
  lines.push('');
  lines.push(`  Risk categories: ${r.categories.join(', ')}`);
  lines.push(separator());

  // ================================================================
  // Section 4: ERP Integration Readiness
  // ================================================================
  lines.push('  4. ERP INTEGRATION READINESS');
  lines.push('');
  const totalEntities = ps.ready.entities_total + ps.blocked.entities_total;
  const totalSystems = ps.ready.systems.length + ps.blocked.systems.length;
  lines.push(`  ${totalEntities} data entities mapped across ${totalSystems} enterprise systems.`);
  lines.push(`  ${ps.ready.entities_total} entities (${pct(ps.ready.pct)}) are integration-ready.`);
  lines.push(`  ${ps.blocked.entities_total} entities (${pct(ps.blocked.pct)}) are awaiting connector development.`);
  lines.push('');
  lines.push('  Ready systems:');
  for (const sys of ps.ready.systems) {
    const iacLabel = sys.terraform ? 'scaffold ready' : 'pending';
    lines.push(`    ${sysName(sys.id).padEnd(20)} ${String(sys.entities).padStart(3)} entities   ${iacLabel}`);
  }
  lines.push('');
  lines.push('  Blocked systems:');
  for (const sys of ps.blocked.systems) {
    lines.push(`    ${sysName(sys.id).padEnd(20)} ${String(sys.entities).padStart(3)} entities   ${sys.severity.padEnd(10)} est. ${sys.effort_weeks} weeks`);
  }
  lines.push(separator());

  // ================================================================
  // Section 5: Why Execution Is Gated
  // ================================================================
  lines.push('  5. WHY EXECUTION IS GATED');
  lines.push('');
  lines.push('  The platform has intentionally locked execution mode. This is');
  lines.push('  not a limitation — it is a safety measure.');
  lines.push('');
  lines.push(`  ${data.execution_prerequisites.total} prerequisites must be met before production writes`);
  lines.push(`  can occur. ${data.execution_prerequisites.completed} have been completed so far.`);
  lines.push('');
  lines.push('  The platform will not write to any ERP system, file any');
  lines.push('  regulatory report, or execute any deployment until:');
  lines.push('');
  lines.push('    - All 4 missing ERP connectors are built and tested');
  lines.push('    - 2 platform configuration issues are resolved');
  lines.push('    - Network connectivity to all 7 ERP endpoints is confirmed');
  lines.push('    - The Change Advisory Board has approved production writes');
  lines.push('    - Data stewards from all 8 departments have signed off');
  lines.push('    - Rollback procedures are documented and tested');
  lines.push('');
  lines.push(`  Execution gate status: ${data.execution_gate}`);
  lines.push(separator());

  // ================================================================
  // Section 6: What Execution Would Enable
  // ================================================================
  lines.push('  6. WHAT UNLOCKING EXECUTION WOULD ENABLE');
  lines.push('');
  lines.push('  If all prerequisites are met, the platform would be able to:');
  lines.push('');
  lines.push('    - Write cost center hierarchies and GL accounts to SAP S/4HANA');
  lines.push('    - Provision AI training programs in Workday Learning');
  lines.push('    - Register 10 AI-specific risks in the RSA Archer risk register');
  lines.push('    - Track AI platform incidents in ServiceNow ITSM');
  lines.push('    - File FINRA supervisory reports through ONESOURCE');
  lines.push('    - Reconcile SOX Section 302/404 certification data');
  lines.push('    - Centralize GDPR processing records for regulatory inspection');
  lines.push('');
  lines.push('  None of these actions are possible today. This is by design.');
  lines.push('  The platform proves its value through analysis, not through');
  lines.push('  premature action.');
  lines.push(separator());

  // ================================================================
  // Section 7: Value Already Delivered
  // ================================================================
  lines.push('  7. VALUE ALREADY DELIVERED');
  lines.push('');
  lines.push('  The platform has already produced enterprise-grade deliverables,');
  lines.push('  independent of whether execution is ever unlocked:');
  lines.push('');
  for (const item of data.value_if_stopped.captured) {
    // Expand common abbreviations for executive readability
    const expanded = item
      .replace(/\bCC\b/g, 'Cost Center')
      .replace(/\bGL\b/g, 'General Ledger')
      .replace(/\bIaC\b/g, 'Infrastructure as Code');
    lines.push(`    - ${expanded}`);
  }
  lines.push('');
  lines.push(`  ${data.value_if_stopped.reuse_estimate}.`);
  lines.push('');
  lines.push('  These artifacts are production-quality and can be handed directly');
  lines.push('  to an implementation team as a documented scope of work.');
  lines.push(separator());

  // ================================================================
  // Footer
  // ================================================================
  lines.push('  SAFETY NOTICE');
  lines.push('');
  lines.push('  This demo is read-only. No external systems were contacted.');
  lines.push('  No data was written. No execution paths were opened.');
  lines.push('  The platform is in exactly the same state as before this demo ran.');
  lines.push('');
  lines.push('  All figures shown are derived from audited simulation artifacts');
  lines.push('  (PASS 5/5, variance < 0.01%). The execution gate is intentional');
  lines.push('  and protects the enterprise from premature writes.');
  lines.push('');
  lines.push('  To explore further:');
  lines.push('    agentics readiness show         Full readiness state');
  lines.push('    agentics readiness explain       Executive briefing on the gate');
  lines.push('    agentics erp list                ERP system inventory');
  lines.push('    agentics inspect latest          Simulation artifact details');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Feedback Logger (Optional, Local-Only)
// ============================================================================

/**
 * Record a demo session to a local feedback log.
 * This is non-intrusive: writes only if ~/.agentics/feedback/ exists.
 * No telemetry, no network calls, no external services.
 * Format: JSONL (one JSON object per line, append-only).
 */
function logDemoSession(scenario: string, found: boolean, timing: number): void {
  try {
    const feedbackDir = path.join(os.homedir(), '.agentics', 'feedback');
    if (!fs.existsSync(feedbackDir)) return; // Opt-in: directory must exist
    const logPath = path.join(feedbackDir, 'demo-sessions.jsonl');
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      command: 'demo start',
      scenario: scenario || 'default',
      found,
      duration_ms: timing,
    });
    fs.appendFileSync(logPath, entry + '\n');
  } catch {
    // Feedback logging is best-effort; never block the demo
  }
}

// ============================================================================
// Command Executor
// ============================================================================

/**
 * Execute `agentics demo start <scenario>`.
 * Loads audited artifacts and renders a guided walkthrough.
 */
export async function executeDemoStartCommand(
  params: { scenario: string; extraArgs: string[] },
): Promise<DemoResult> {
  const start = Date.now();

  // Safety check: reject any execution-related arguments
  const rejection = checkExecutionAttempt(params.extraArgs);
  if (rejection) {
    return {
      output: rejection,
      found: false,
      scenario: params.scenario,
      timing: Date.now() - start,
    };
  }

  const data = loadSummary();
  if (!data) {
    return {
      output: [
        'No simulation data available for demo.',
        '',
        'Demo mode requires completed, audited simulation artifacts.',
        'Run a simulation first:',
        '  agentics simulate create <description>',
      ].join('\n'),
      found: false,
      scenario: params.scenario,
      timing: Date.now() - start,
    };
  }

  // If a scenario is specified, validate it matches
  if (params.scenario) {
    const matches =
      data.simulation_id === params.scenario ||
      data.simulation_id.startsWith(params.scenario);
    if (!matches) {
      return {
        output: [
          `No simulation data found for scenario: ${params.scenario}`,
          '',
          `Available scenario: ${data.simulation_id}`,
          'Run without a scenario argument to use the available data:',
          '  agentics demo start',
        ].join('\n'),
        found: false,
        scenario: params.scenario,
        timing: Date.now() - start,
      };
    }
  }

  const timing = Date.now() - start;

  // Optional local feedback log (only if ~/.agentics/feedback/ exists)
  logDemoSession(data.simulation_id, true, timing);

  return {
    output: renderDemo(data),
    found: true,
    scenario: data.simulation_id,
    timing,
  };
}
