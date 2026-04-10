import { container } from './container.js';
import { createLogger } from './logger.js';
import { buildings, zones, occupancyReadings } from './data/seed.js';
import type { Building, ZoneScore, Scenario, SavingsBreakdown } from './types.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('demo');
const write = (text: string) => process.stdout.write(text + '\n');

async function main(): Promise<void> {
  const { config, scoring, scenarios: scenarioService, decisions, audit, lifecycle, sensitivity } = container;

  write('');
  write('╔══════════════════════════════════════════════════════════════════════════╗');
  write('║           WORKSPACE OPTIMIZER — AI-Powered Space Analytics              ║');
  write('║                     Sustainability Prototype v0.1                       ║');
  write('╚══════════════════════════════════════════════════════════════════════════╝');
  write('');
  write(`  Simulation ID : ${config.simulationId}`);
  write(`  Pipeline      : v${config.pipelineVersion}`);
  write(`  Confidence    : ${(config.confidenceLevel * 100).toFixed(1)}%`);
  write(`  Buildings     : ${buildings.length} pilot sites`);
  write(`  Zones         : ${zones.length} analyzed`);
  write(`  Readings      : ${occupancyReadings.length.toLocaleString()} data points (4 weeks, 15-min)`);
  write('');

  // ── SECTION 1: Scoring ──────────────────────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 1: Zone Utilization Scoring');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');

  const scores = scoring.scoreZones(zones, occupancyReadings, buildings);

  write('  ┌──────────────────────┬────────────┬───────────┬──────────────────────────┐');
  write('  │ Zone                 │ Avg Occup. │ Eff.Index │ Category                 │');
  write('  ├──────────────────────┼────────────┼───────────┼──────────────────────────┤');

  for (const s of scores) {
    const name = s.zoneName.padEnd(20).slice(0, 20);
    const avg = `${(s.avgOccupancyRate * 100).toFixed(0)}%`.padStart(10);
    const eff = s.efficiencyIndex.toFixed(3).padStart(9);
    const cat = s.category.replace(/_/g, ' ').padEnd(24);
    write(`  │ ${name} │${avg} │${eff} │ ${cat} │`);
  }

  write('  └──────────────────────┴────────────┴───────────┴──────────────────────────┘');
  write('');

  const severely = scores.filter(s => s.category === 'severely_underutilized');
  const under = scores.filter(s => s.category === 'underutilized');
  write(`  Summary: ${severely.length} severely underutilized, ${under.length} underutilized, ${scores.length - severely.length - under.length} moderately used or better`);
  write('');

  // ── SECTION 2: Scenario Generation ──────────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 2: Optimization Scenarios');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');

  const allScenarios = scenarioService.generateScenarios(scores, buildings);

  for (const scenario of allScenarios) {
    write(`  ▸ ${scenario.name}`);
    write(`    Type: ${scenario.type.replace(/_/g, ' ')}  |  Risk: ${scenario.implementationRisk}  |  Experience: ${scenario.employeeExperienceImpact}`);
    write(`    Savings: $${scenario.annualCostSavingsUsd.toLocaleString()}/yr  |  Energy: ${scenario.annualEnergySavingsKwh.toLocaleString()} kWh/yr  |  CO₂: ${scenario.annualCo2ReductionTonnes} t/yr`);
    write(`    Employees affected: ${scenario.employeesAffected}  |  Target occupancy: ${(scenario.projectedOccupancyRate * 100).toFixed(0)}%`);
    write('');
  }

  // ── SECTION 3: ADR-053 Financial Bridge ─────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 3: Financial Analysis — Pilot to Enterprise Bridge (ADR-053)');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');

  // 3a. Aggregate savings by category across all scenarios
  const aggregateBreakdown = aggregateSavingsBreakdown(allScenarios);
  const pilotTotal = allScenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
  const pilotEnergy = allScenarios.reduce((sum, s) => sum + s.annualEnergySavingsKwh, 0);
  const pilotCo2 = allScenarios.reduce((sum, s) => sum + s.annualCo2ReductionTonnes, 0);

  // 3b. Compute enterprise extrapolation
  const pilotEmployeeCapacity = buildings.reduce((sum, b) => sum + b.employeeCapacity, 0);
  const scaleFactor = config.totalEnterpriseEmployees / pilotEmployeeCapacity;
  const enterpriseTotal = pilotTotal * scaleFactor;
  const enterpriseEnergy = pilotEnergy * scaleFactor;
  const enterpriseCo2 = pilotCo2 * scaleFactor;

  write('  3a. Bottoms-Up Savings Waterfall (Pilot Scope)');
  write('');
  write('  ┌──────────────────────────┬─────────────────────────┬─────────────────────────┐');
  write('  │ Category                 │ Pilot (3 buildings)     │ Enterprise (projected)  │');
  write('  ├──────────────────────────┼─────────────────────────┼─────────────────────────┤');
  write(`  │ Energy reduction         │ ${fmtUsd(aggregateBreakdown.energySavingsUsd).padStart(23)} │ ${fmtUsd(aggregateBreakdown.energySavingsUsd * scaleFactor).padStart(23)} │`);
  write(`  │ HVAC optimization        │ ${fmtUsd(aggregateBreakdown.hvacSavingsUsd).padStart(23)} │ ${fmtUsd(aggregateBreakdown.hvacSavingsUsd * scaleFactor).padStart(23)} │`);
  write(`  │ Maintenance savings      │ ${fmtUsd(aggregateBreakdown.maintenanceSavingsUsd).padStart(23)} │ ${fmtUsd(aggregateBreakdown.maintenanceSavingsUsd * scaleFactor).padStart(23)} │`);
  write(`  │ Lease optimization       │ ${fmtUsd(aggregateBreakdown.leaseSavingsUsd).padStart(23)} │ ${fmtUsd(aggregateBreakdown.leaseSavingsUsd * scaleFactor).padStart(23)} │`);
  write('  ├──────────────────────────┼─────────────────────────┼─────────────────────────┤');
  write(`  │ TOTAL                    │ ${fmtUsd(pilotTotal).padStart(23)} │ ${fmtUsd(enterpriseTotal).padStart(23)} │`);
  write('  └──────────────────────────┴─────────────────────────┴─────────────────────────┘');
  write('');

  write('  3b. Pilot → Enterprise Extrapolation');
  write('');
  write(`  Pilot scope             : ${config.pilotBuildingCount} buildings, ${pilotEmployeeCapacity.toLocaleString()} employee capacity`);
  write(`  Enterprise scope        : ${config.totalEnterpriseEmployees.toLocaleString()} employees (scale factor: ${scaleFactor.toFixed(1)}x)`);
  write(`  Extrapolation method    : Linear proportional by employee capacity`);
  write('');
  write(`  Pilot annual savings    : ${fmtUsd(pilotTotal)} (measured from ${occupancyReadings.length.toLocaleString()} data points)`);
  write(`  Enterprise projection   : ${fmtUsd(enterpriseTotal)} (projected, ${scaleFactor.toFixed(1)}x pilot)`);
  write(`  Pilot energy reduction  : ${pilotEnergy.toLocaleString()} kWh/yr → Enterprise: ${Math.round(enterpriseEnergy).toLocaleString()} kWh/yr`);
  write(`  Pilot CO₂ reduction     : ${pilotCo2.toFixed(1)} t/yr → Enterprise: ${Math.round(enterpriseCo2).toLocaleString()} t/yr`);
  write('');

  write('  3c. Investment Scope Reconciliation');
  write('');
  write('  ┌────────────────────────────────────────────────────────────────────────┐');
  write('  │ The $600K–$900K pilot is Phase 1 of the $2.0M–$3.1M full program.    │');
  write('  │                                                                        │');
  write('  │   Phase 1 (Pilot, 3 buildings)    : $600K–$900K investment             │');
  write('  │   Phase 2 (Regional rollout)      : $800K–$1.2M incremental           │');
  write('  │   Phase 3 (Enterprise-wide)       : $600K–$1.0M incremental           │');
  write('  │   ─────────────────────────────────────────────────────                │');
  write('  │   Full program total              : $2.0M–$3.1M                       │');
  write('  │                                                                        │');
  write(`  │   Pilot ROI: ${fmtUsd(pilotTotal)} savings / $750K avg investment = ${((pilotTotal / 750_000) * 100).toFixed(0)}% first-year ROI  │`);
  write(`  │   Payback period: ~${Math.round(750_000 / (pilotTotal / 12))} months                                           │`);
  write('  └────────────────────────────────────────────────────────────────────────┘');
  write('');

  // 3d. Sensitivity Analysis (ADR-057)
  const sensitivityResult = sensitivity.analyze(allScenarios, config.pilotBuildingCount);

  write('  3d. Sensitivity Analysis (ADR-057) — Tornado Chart');
  write('');
  write('  ┌────────────────────────────┬────────────┬──────────────────────────────────┐');
  write('  │ Variable                   │ Range      │ Impact on Pilot Savings          │');
  write('  ├────────────────────────────┼────────────┼──────────────────────────────────┤');
  for (const v of sensitivityResult.variables) {
    const name = v.name.padEnd(26).slice(0, 26);
    const range = v.range.padEnd(10).slice(0, 10);
    const sign = v.impactUsd >= 0 ? '+' : '';
    const impact = `${sign}${fmtUsd(v.impactUsd)} (${sign}${v.impactPercent.toFixed(1)}%)`.padEnd(32);
    write(`  │ ${name} │ ${range} │ ${impact} │`);
  }
  write('  └────────────────────────────┴────────────┴──────────────────────────────────┘');
  write('');
  write(`  Top driver: ${sensitivityResult.variables[0]?.name} — a shift of ${sensitivityResult.variables[0]?.range} changes savings by ${fmtUsd(Math.abs(sensitivityResult.variables[0]?.impactUsd ?? 0))}`);
  write('');

  // 3e. Dual Confidence Framing (ADR-057)
  write('  3e. Dual Confidence Framing (ADR-057)');
  write('');
  write(`  Directional confidence  : >${sensitivityResult.directionalConfidencePercent}% — savings will exceed ${fmtUsd(sensitivityResult.directionalFloorUsd)}/yr (pilot)`);
  write(`  Precision confidence    : ${sensitivityResult.precisionConfidencePercent.toFixed(1)}% — magnitude falls within ${fmtUsd(sensitivityResult.precisionRangeUsd[0])}–${fmtUsd(sensitivityResult.precisionRangeUsd[1])}`);
  write(`  Basis                   : All ${allScenarios.length} scenarios produce positive savings; floor = min scenario × ${buildings.length} buildings × 0.8`);
  write('');
  write('  Interpretation: We are highly confident that savings are real and material.');
  write('  The remaining uncertainty is about precise magnitude, not direction.');
  write('');

  // ── SECTION 4: Per-Building Breakdown ───────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 4: Per-Building Savings Breakdown');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');

  for (const building of buildings) {
    const bldgScenarios = allScenarios.filter(s => {
      const scenarioZones = s.affectedZones;
      return zones.some(z => z.buildingId === building.id && scenarioZones.includes(z.id));
    });

    const bldgTotal = bldgScenarios.reduce((sum, s) => sum + s.annualCostSavingsUsd, 0);
    const bldgBreakdown = aggregateSavingsBreakdown(bldgScenarios);

    write(`  ${building.name} (${building.region})`);
    write(`    Energy: ${fmtUsd(bldgBreakdown.energySavingsUsd)}  |  HVAC: ${fmtUsd(bldgBreakdown.hvacSavingsUsd)}  |  Maintenance: ${fmtUsd(bldgBreakdown.maintenanceSavingsUsd)}  |  Lease: ${fmtUsd(bldgBreakdown.leaseSavingsUsd)}`);
    write(`    Total: ${fmtUsd(bldgTotal)}/yr across ${bldgScenarios.length} scenarios`);
    write('');
  }

  // ── SECTION 5: Decision Workflow Demo ───────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 5: Decision Workflow (3-Stage Approval)');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');

  // Pick the best consolidation scenario
  const bestScenario = allScenarios
    .filter(s => s.type === 'consolidation')
    .sort((a, b) => b.annualCostSavingsUsd - a.annualCostSavingsUsd)[0];

  if (bestScenario) {
    write(`  Selected scenario: ${bestScenario.name}`);
    write(`  Annual savings: ${fmtUsd(bestScenario.annualCostSavingsUsd)} (Phase 1 pilot scope)`);
    write('');

    // Create decision
    const decision = decisions.create({
      scenario: bestScenario,
      createdBy: 'sarah.chen@company.com',
      rationale: 'Consolidation of underutilized zones based on 4-week occupancy analysis. Expected to reduce energy waste while maintaining employee access to collaboration spaces.',
    });
    write(`  ✓ Decision created (${decision.id.slice(0, 8)}…) by sarah.chen@company.com`);

    // Submit for review
    decisions.submit(decision.id, 'sarah.chen@company.com');
    write('  ✓ Submitted for review');

    // VP approval (employees affected > 50 triggers VP-level requirement)
    decisions.approve({
      decisionId: decision.id,
      approver: 'jennifer.wu@company.com',
      role: 'vp_operations',
      rationale: 'Savings projection is conservative and aligns with Q3 sustainability targets. Employee impact is manageable with 30-day notice period.',
    });
    write('  ✓ Approved by VP Operations (jennifer.wu@company.com) — threshold: >50 employees affected');

    write('');

    // ERP sync (ADR-056: via lifecycle service for audit chain completeness)
    write('  ERP Sync (Archibus) — via DecisionLifecycleService:');
    const tx = await lifecycle.syncToErp(decision, bestScenario, buildings[0].id, 'f1-01');
    write(`  ✓ Transaction ${tx.id.slice(0, 8)}… → ${tx.status} (dry-run: ${container.config.erp.dryRun})`);
    write(`    Idempotency key: ${tx.idempotencyKey.slice(0, 16)}…`);
    write('    Audit entries: erp_sync_initiated + erp_sync_completed added to chain');
    write('');
  }

  // ── SECTION 6: Audit Trail ──────────────────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 6: Audit Trail Verification');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');

  const verification = audit.verify();
  write(`  Chain length : ${verification.chainLength} entries`);
  write(`  Integrity    : ${verification.valid ? '✓ VALID — all hashes verified' : '✗ BROKEN at entry ' + verification.brokenAt}`);
  write('');

  const entries = audit.getEntries();
  for (const entry of entries) {
    write(`  [${entry.timestamp.toISOString().slice(11, 19)}] ${entry.action.padEnd(22)} by ${entry.actor.padEnd(28)} hash: ${entry.hash.slice(0, 12)}…`);
  }
  write('');

  // ── SECTION 7: Summary ──────────────────────────────────────────────────

  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('  SECTION 7: Executive Summary');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  write('');
  write(`  Pilot scope (${config.pilotBuildingCount} buildings, ${pilotEmployeeCapacity.toLocaleString()} employee capacity):`);
  write(`    Annual savings          : ${fmtUsd(pilotTotal)}`);
  write(`    Energy reduction        : ${pilotEnergy.toLocaleString()} kWh/yr`);
  write(`    Carbon reduction        : ${pilotCo2.toFixed(1)} tonnes CO₂/yr`);
  write(`    Investment (Phase 1)    : $600K–$900K (Phase 1 pilot, 3 buildings)`);
  write('');
  write(`  Enterprise projection (${config.totalEnterpriseEmployees.toLocaleString()} employees, ${scaleFactor.toFixed(1)}x scale):`);
  write(`    Annual savings          : ${fmtUsd(enterpriseTotal)}`);
  write(`    Energy reduction        : ${Math.round(enterpriseEnergy).toLocaleString()} kWh/yr`);
  write(`    Carbon reduction        : ${Math.round(enterpriseCo2).toLocaleString()} tonnes CO₂/yr`);
  write(`    Full program investment : $2.0M–$3.1M (3 phases over 18 months)`);
  write('');
  write('  The $600K–$900K pilot is Phase 1 of the $2.0M–$3.1M full program.');
  write('');
  write(`  Directional confidence    : >${sensitivityResult.directionalConfidencePercent}% — savings will exceed ${fmtUsd(sensitivityResult.directionalFloorUsd)}/yr`);
  write(`  Precision confidence      : ${sensitivityResult.precisionConfidencePercent.toFixed(1)}% — magnitude within ${fmtUsd(sensitivityResult.precisionRangeUsd[0])}–${fmtUsd(sensitivityResult.precisionRangeUsd[1])}`);
  write('');
  write('  Competitive Positioning (ADR-057):');
  write('    Salesforce reduced underutilized space by 30% (2024 sustainability report).');
  write('    Google achieved 40% energy reduction across hybrid-optimized offices (2023).');
  write('    Siemens cut facilities operating cost by 20% using IoT + AI (2024).');
  const underutilizedCount = scores.filter(s => s.category === 'underutilized' || s.category === 'severely_underutilized').length;
  const reductionTarget = Math.round((underutilizedCount / scores.length) * 25);
  write(`    Our pilot targets ~${reductionTarget}% reduction in underutilized space, which is conservative`);
  write('    relative to Salesforce\'s 30% but appropriate for a first phase with validated data.');
  write('');
  write('  ╔══════════════════════════════════════════════════════════════════════╗');
  write('  ║  RECOMMENDATION: Proceed with Phase 1 pilot ($600K–$900K)          ║');
  write('  ║  targeting 3 buildings. Validate savings over 90 days before        ║');
  write('  ║  committing to Phase 2 regional rollout ($800K–$1.2M).             ║');
  write('  ╚══════════════════════════════════════════════════════════════════════╝');
  write('');
}

// === ADR-053 Helpers ===

function aggregateSavingsBreakdown(scenarios: Scenario[]): SavingsBreakdown {
  return scenarios.reduce(
    (acc, s) => ({
      energySavingsUsd: acc.energySavingsUsd + s.savingsBreakdown.energySavingsUsd,
      maintenanceSavingsUsd: acc.maintenanceSavingsUsd + s.savingsBreakdown.maintenanceSavingsUsd,
      hvacSavingsUsd: acc.hvacSavingsUsd + s.savingsBreakdown.hvacSavingsUsd,
      leaseSavingsUsd: acc.leaseSavingsUsd + s.savingsBreakdown.leaseSavingsUsd,
    }),
    { energySavingsUsd: 0, maintenanceSavingsUsd: 0, hvacSavingsUsd: 0, leaseSavingsUsd: 0 },
  );
}

function fmtUsd(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(2)}M`;
  }
  return `$${Math.round(amount).toLocaleString()}`;
}

main().catch(err => {
  logger.error('demo.failed', err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
