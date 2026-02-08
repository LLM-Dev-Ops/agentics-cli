/**
 * Readiness Command — `agentics readiness show|explain <scenario>`
 *
 * PURPOSE: Display and explain the canonical readiness surface for a
 * simulation scenario. Two modes:
 *
 * SUBCOMMANDS:
 * - show <scenario>      Structured readiness state (JSON + human-readable)
 * - explain <scenario>   Executive briefing in plain language (human-readable only)
 *
 * READ-ONLY: This command never modifies state. It reads from:
 * - ~/.agentics/exports/decision-readiness/readiness-state.json
 * - ~/.agentics/exports/decision-readiness/decision-readiness-summary.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CommandOptions } from '../types/index.js';
import type { ReadinessStateFile } from '../gates/readiness-gate.js';

// ============================================================================
// Types
// ============================================================================

export interface ReadinessShowResult {
  state: ReadinessStateFile | null;
  found: boolean;
  scenario: string;
  timing: number;
}

// ============================================================================
// Command Executors
// ============================================================================

/**
 * Execute `agentics readiness show <scenario>`.
 * Loads the readiness state artifact and returns it for rendering.
 */
export async function executeReadinessShowCommand(
  params: { scenario: string },
  _options: CommandOptions,
): Promise<ReadinessShowResult> {
  const start = Date.now();

  const statePath = path.join(
    os.homedir(),
    '.agentics',
    'exports',
    'decision-readiness',
    'readiness-state.json',
  );

  let state: ReadinessStateFile | null = null;
  let found = false;

  try {
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf-8');
      const parsed = JSON.parse(content) as ReadinessStateFile;

      // If a specific scenario is requested, validate it matches
      if (params.scenario && parsed.simulation_id) {
        const matches =
          parsed.simulation_id === params.scenario ||
          parsed.simulation_id.startsWith(params.scenario);
        if (matches) {
          state = parsed;
          found = true;
        }
      } else {
        // No scenario filter — return whatever is there
        state = parsed;
        found = true;
      }
    }
  } catch {
    // File doesn't exist or is invalid
  }

  return {
    state,
    found,
    scenario: params.scenario,
    timing: Date.now() - start,
  };
}

// ============================================================================
// Display Formatters
// ============================================================================

/**
 * Execute `agentics readiness explain <scenario>`.
 * Loads the readiness state and produces an executive-level briefing.
 * Always human-readable — no JSON mode.
 */
export async function executeReadinessExplainCommand(
  params: { scenario: string },
  options: CommandOptions,
): Promise<ReadinessShowResult> {
  // Reuse the same loader — the difference is in rendering, not loading
  return executeReadinessShowCommand(params, options);
}

/**
 * Format readiness state as an executive briefing in plain language.
 * No technical jargon. No JSON. Reads like a memo to leadership.
 */
export function formatReadinessExplainForDisplay(result: ReadinessShowResult): string {
  if (!result.found || !result.state) {
    return [
      'No readiness assessment has been completed for this scenario.',
      '',
      'Before an executive summary can be produced, the platform must',
      'complete the pre-execution phase: simulation, audit, and ERP',
      'integration mapping. This has not yet occurred.',
    ].join('\n');
  }

  const s = result.state;
  const gate = s.execution_gate;
  const ir = s.integration_readiness;
  const fin = s.financial_posture;
  const audit = s.audit_matrix;

  // Calculate total blocker effort (take max for parallel execution)
  const effortWeeks = gate.critical_blockers.reduce((max, b) => {
    const match = b.effort.match(/(\d+)/);
    const weeks = match?.[1] ? parseInt(match[1], 10) : 0;
    return Math.max(max, weeks);
  }, 0);
  const effortMax = gate.critical_blockers.reduce((max, b) => {
    const parts = b.effort.match(/(\d+)-(\d+)/);
    const weeks = parts?.[2] ? parseInt(parts[2], 10) : 0;
    return Math.max(max, weeks);
  }, 0);

  const lines: string[] = [];

  // ---- Section 1: Why execution is blocked ----
  lines.push('WHY EXECUTION IS BLOCKED');
  lines.push('');
  lines.push('The AI platform has completed its pre-execution phase. All simulation');
  lines.push('data has been corrected, audited, and translated into integration-ready');
  lines.push('artifacts. However, the platform has intentionally locked execution mode');
  lines.push('because the infrastructure required for safe production writes is not');
  lines.push('yet in place.');
  lines.push('');

  if (gate.critical_blockers.length > 0) {
    lines.push(`There are ${gate.prerequisites_total} prerequisites that must be completed`);
    lines.push(`before execution can be unlocked. ${gate.prerequisites_completed} have been`);
    lines.push(`completed so far. The critical blockers are:`);
    lines.push('');
    for (const b of gate.critical_blockers) {
      const systemName = b.system
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      lines.push(`  - ${systemName}: No connector exists to write data to this system.`);
      lines.push(`    Severity: ${b.severity}. Estimated build time: ${b.effort}.`);
    }
    lines.push('');
  }

  lines.push(`Reason: ${gate.reason}.`);
  lines.push('');

  // ---- Section 2: What is safe to do right now ----
  lines.push('WHAT IS SAFE TO DO NOW');
  lines.push('');
  lines.push('The following actions are available and carry no risk:');
  lines.push('');
  lines.push('  - Review the full readiness state:  agentics readiness show');
  lines.push('  - Inspect simulation artifacts:     agentics inspect <run-id>');
  lines.push('  - View ERP system mappings:         agentics erp list');
  lines.push('  - Examine individual ERP surfaces:  agentics erp surface');
  lines.push('  - Generate Terraform scaffolding:   agentics export terraform');
  lines.push('');
  lines.push(`The integration artifacts already produced cover ${ir.entities_ready} of`);
  lines.push(`${ir.entities_total} ERP entities (${ir.readiness_pct}%). The remaining`);
  lines.push(`${ir.entities_blocked} entities are blocked by missing connectors and cannot`);
  lines.push('be addressed without new development.');
  lines.push('');
  const titleCase = (s: string) => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  lines.push(`Systems ready for integration: ${ir.systems_ready.map(titleCase).join(', ')}.`);
  lines.push(`Systems awaiting connectors:   ${ir.systems_blocked.map(titleCase).join(', ')}.`);
  lines.push('');

  // ---- Section 3: What is required to unlock ----
  lines.push('WHAT IS REQUIRED TO UNLOCK EXECUTION');
  lines.push('');
  lines.push(`${gate.prerequisites_total} items must be completed across four categories:`);
  lines.push('');
  lines.push('  Connector Development (4 items):');
  lines.push('    Build the missing ERP connectors for ServiceNow, Thomson Reuters');
  lines.push('    ONESOURCE, Workday, and RSA Archer. These are software development');
  lines.push('    projects requiring engineers with ERP integration experience.');
  lines.push('');
  lines.push('  Platform Fixes (2 items):');
  lines.push('    Fix a known endpoint configuration error in the lineage service');
  lines.push('    and register the usage ledger in the service catalog. Both are');
  lines.push('    code-level changes estimated at less than one day each.');
  lines.push('');
  lines.push('  Infrastructure (3 items):');
  lines.push('    Provision a credential vault, validate network connectivity to');
  lines.push('    all ERP endpoints, and configure any required middleware.');
  lines.push('');
  lines.push('  Governance (3 items):');
  lines.push('    Obtain Change Advisory Board approval, data steward sign-off');
  lines.push('    from all 8 departments, and documented rollback procedures');
  lines.push('    reviewed by the CTO or CISO.');
  lines.push('');

  // ---- Section 4: Estimated effort ----
  lines.push('ESTIMATED EFFORT');
  lines.push('');
  if (effortWeeks > 0) {
    lines.push(`If all connector development workstreams begin in parallel, the`);
    lines.push(`critical path to execution readiness is ${effortWeeks}-${effortMax} weeks.`);
    lines.push(`This timeline is driven by the ONESOURCE connector, which requires`);
    lines.push('compliance SME involvement for regulatory report template validation.');
  } else {
    lines.push('Effort estimates are not available for the current blockers.');
  }
  lines.push('');

  // ---- Section 5: Financial context ----
  lines.push('FINANCIAL CONTEXT');
  lines.push('');
  lines.push(`The audited cost model projects $${(fin.annual_api_spend_usd / 1_000_000).toFixed(1)}M in annual API`);
  lines.push(`spend against $${(fin.annual_savings_usd / 1_000_000).toFixed(1)}M in projected annual savings. The`);
  lines.push(`year-one investment is $${(fin.year1_investment_usd / 1_000_000).toFixed(1)}M with a ${fin.roi_payback_months}-month payback period`);
  lines.push(`and a 5-year NPV of $${(fin.npv_5yr_usd / 1_000_000).toFixed(1)}M. All figures have been audited`);
  lines.push(`(${audit.result} ${audit.checks_passed}/${audit.checks_total}) and are production-quality.`);
  lines.push('');

  // ---- Closing ----
  lines.push('This gate is intentional. The platform is designed to prevent');
  lines.push('production writes until every prerequisite has been verified.');
  lines.push('The artifacts produced to this point are complete and can be');
  lines.push('handed to an implementation team as a fully documented scope');
  lines.push('of work.');

  return lines.join('\n');
}

/**
 * Format readiness state for human-readable terminal output.
 */
export function formatReadinessForDisplay(result: ReadinessShowResult): string {
  if (!result.found || !result.state) {
    const lines = [
      'Readiness State: NOT FOUND',
      '',
      result.scenario
        ? `No readiness state found for scenario: ${result.scenario}`
        : 'No readiness state file found.',
      '',
      'To generate a readiness state, complete the pre-execution phase:',
      '  1. Run a simulation: agentics simulate create <description>',
      '  2. Inspect results:  agentics inspect <simulation-id>',
      '  3. Generate ERP mapping: agentics erp surface --simulation-id <id>',
      '  4. Decision readiness artifacts are generated automatically.',
    ];
    return lines.join('\n');
  }

  const s = result.state;
  const gate = s.execution_gate;
  const ir = s.integration_readiness;
  const fin = s.financial_posture;
  const audit = s.audit_matrix;

  const stateLabel = s.state === 'EXECUTION_READY'
    ? 'EXECUTION READY'
    : s.state === 'INTEGRATION_READY_EXECUTION_GATED'
      ? 'INTEGRATION READY, EXECUTION GATED'
      : 'INSPECTION ONLY';

  const gateIcon = gate.locked ? 'LOCKED' : 'UNLOCKED';

  const lines: string[] = [
    `Readiness State: ${stateLabel}`,
    `Simulation:      ${s.simulation_id}`,
    `Plan:            ${s.plan_ref}`,
    `Determined:      ${s.determined_at}`,
    '',
    '--- Execution Gate ---',
    `  Status:           ${gateIcon}`,
    `  Reason:           ${gate.reason}`,
    `  Prerequisites:    ${gate.prerequisites_completed}/${gate.prerequisites_total} completed`,
  ];

  if (gate.critical_blockers.length > 0) {
    lines.push('  Critical Blockers:');
    for (const b of gate.critical_blockers) {
      lines.push(`    - ${b.system} (${b.severity}, est. ${b.effort})`);
    }
  }

  lines.push('');
  lines.push('--- Integration Readiness ---');
  lines.push(`  Entities Ready:   ${ir.entities_ready}/${ir.entities_total} (${ir.readiness_pct}%)`);
  lines.push(`  Entities Blocked: ${ir.entities_blocked}`);
  lines.push(`  Systems Ready:    ${ir.systems_ready.join(', ')}`);
  lines.push(`  Systems Blocked:  ${ir.systems_blocked.join(', ')}`);

  lines.push('');
  lines.push('--- Financial Posture ---');
  lines.push(`  Annual API Spend: $${(fin.annual_api_spend_usd / 1_000_000).toFixed(2)}M`);
  lines.push(`  Year 1 Investment: $${(fin.year1_investment_usd / 1_000_000).toFixed(2)}M`);
  lines.push(`  Annual Savings:   $${(fin.annual_savings_usd / 1_000_000).toFixed(2)}M`);
  lines.push(`  ROI Payback:      ${fin.roi_payback_months} months`);
  lines.push(`  5-Year NPV:       $${(fin.npv_5yr_usd / 1_000_000).toFixed(2)}M`);

  lines.push('');
  lines.push('--- Audit Matrix ---');
  lines.push(`  Result:           ${audit.result}`);
  lines.push(`  Checks:           ${audit.checks_passed}/${audit.checks_total} PASS`);
  lines.push(`  Last Audit:       ${audit.last_audit}`);

  return lines.join('\n');
}
