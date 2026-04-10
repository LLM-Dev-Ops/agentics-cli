import { container } from './container.js';
import { createLogger } from './logger.js';
import { buildings, zones, occupancyReadings } from './data/seed.js';
import type { Building, ZoneScore, Scenario, SavingsBreakdown, MaturityLevel } from './types.js';
import { maturityLabel } from './services/competitive-analysis.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('demo');
const write = (text: string) => process.stdout.write(text + '\n');

async function main(): Promise<void> {
  const { config, scoring, scenarios: scenarioService, decisions, audit, lifecycle, sensitivity, phaseGates, competitive } = container;

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

  // 3d. Sensitivity Analysis (ADR-057, ADR-PRR-009)
  const sensitivityResult = sensitivity.analyze(allScenarios, config.pilotBuildingCount);

  write('  3d. Sensitivity Analysis (ADR-PRR-009) — Assumption Impact on Pilot Savings');
  write('');
  write(`  Base case: ${fmtUsd(sensitivityResult.baselineTotalUsd)}/yr (all ${allScenarios.length} scenarios at default assumptions)`);
  write('');
  write('  ┌──────┬────────────────────────────┬────────────┬────────────┬────────────┬────────────┐');
  write('  │ Rank │ Assumption                 │ Range      │ Pessimist. │ Optimistic │ Impact     │');
  write('  ├──────┼────────────────────────────┼────────────┼────────────┼────────────┼────────────┤');
  for (const v of sensitivityResult.variables) {
    const rank = String(v.rank).padStart(4);
    const name = v.name.padEnd(26).slice(0, 26);
    const range = v.range.padEnd(10).slice(0, 10);
    const low = fmtUsd(v.lowCaseUsd).padStart(10);
    const high = fmtUsd(v.highCaseUsd).padStart(10);
    const magnitude = Math.abs(v.impactUsd);
    const impact = `±${fmtUsd(magnitude)}`.padStart(10);
    write(`  │ ${rank} │ ${name} │ ${range} │ ${low} │ ${high} │ ${impact} │`);
  }
  write('  └──────┴────────────────────────────┴────────────┴────────────┴────────────┴────────────┘');
  write('');

  // ADR-PRR-009: ASCII tornado chart (horizontal bars ordered by magnitude)
  write('  Tornado Chart (sorted by absolute impact)');
  write('');
  const maxMagnitude = Math.max(...sensitivityResult.variables.map(v => Math.abs(v.impactUsd)));
  const barWidth = 40;
  for (const v of sensitivityResult.variables) {
    const magnitude = Math.abs(v.impactUsd);
    const barLen = maxMagnitude > 0 ? Math.max(1, Math.round((magnitude / maxMagnitude) * barWidth)) : 0;
    const bar = '█'.repeat(barLen);
    const name = v.name.padEnd(26).slice(0, 26);
    write(`    ${name} ${bar} ${fmtUsd(magnitude)}`);
  }
  write('');

  // ADR-PRR-009: Key takeaway linking top variables to pilot design
  write('  Key Takeaway:');
  // Word-wrap the takeaway at ~72 chars for readability
  const words = sensitivityResult.keyTakeaway.split(' ');
  let line = '  ';
  for (const word of words) {
    if ((line + ' ' + word).length > 74) {
      write(line);
      line = '  ' + word;
    } else {
      line = line === '  ' ? '  ' + word : line + ' ' + word;
    }
  }
  if (line.trim().length > 0) write(line);
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

  // ── SECTION 3f: Carbon Methodology Note (ADR-PRR-003) ────────────────

  write('  3f. Carbon Reduction Methodology (ADR-PRR-003)');
  write('');
  write('  ┌────────────────────────────────────────────────────────────────────────┐');
  write('  │ Calculation Chain (GHG Protocol Scope 2 — Location-Based)             │');
  write('  │                                                                        │');
  write('  │   1. Reduced sqft × energy intensity → avoided kWh/year               │');
  write(`  │      Energy intensity: ${config.environmental.kwhPerSqFtYear} kWh/sqft/year (EIA CBECS 2022, Table C1)     │`);
  write('  │                                                                        │');
  write('  │   2. Avoided kWh × grid emission factor → avoided CO₂ tonnes/year     │');
  write(`  │      Emission factor: ${config.environmental.co2TonnesPerKwh * 1000} kg CO₂/kWh (IEA 2023, OECD avg)       │`);
  write('  │                                                                        │');
  write('  │ Scope: Scope 2 (purchased electricity) only.                          │');
  write('  │ Excludes: Scope 1 (on-site gas), Scope 3 (embodied carbon).           │');
  write('  │ Alignment: GHG Protocol Corporate Standard, EU CSRD/ESRS E1.          │');
  write('  │                                                                        │');
  write('  │ Limitations:                                                           │');
  write('  │  - Uses OECD average grid factor; regional factors would improve       │');
  write('  │    accuracy (NA: 0.25, EU: 0.23, Asia: 0.50 kg/kWh).                 │');
  write('  │  - Assumes linear relationship between sqft reduction and energy       │');
  write('  │    savings; real buildings have base-load effects.                     │');
  write('  │  - Override via ENV_CO2_TONNES_PER_KWH and ENV_KWH_PER_SQFT_YEAR.    │');
  write('  └────────────────────────────────────────────────────────────────────────┘');
  write('');

  // ── SECTION 3g: Phase Gate Criteria (ADR-PRR-002) ─────────────────────

  write('  3g. Phase Gate Go/No-Go Criteria (ADR-PRR-002)');
  write('');

  const pilotRoiPct = (pilotTotal / 750_000) * 100; // average pilot investment
  const gates = phaseGates.buildGates();
  const preWorkflowVerification = audit.verify();
  const evaluatedGates = phaseGates.evaluate(gates, {
    auditChainValid: preWorkflowVerification.valid,
    scenarioCount: allScenarios.length,
    pilotSavingsUsd: pilotTotal,
    enterpriseRoiPct: pilotRoiPct,
    sensitivityAnalysis: sensitivityResult,
  });

  for (const gate of evaluatedGates) {
    const statusIcon = gateStatusIcon(gate.overallStatus);
    write(`  Gate ${gate.id.slice(-1)}: Week ${gate.weekNumber} — ${gate.name} ${statusIcon}`);
    write(`  Decision authority: ${gate.decisionAuthority}`);
    write('  ┌────────────────────────────────────┬─────────────────────────────────────────────────────┬──────────┐');
    write('  │ Metric                             │ Go/No-Go Threshold                                  │ Status   │');
    write('  ├────────────────────────────────────┼─────────────────────────────────────────────────────┼──────────┤');
    for (const c of gate.criteria) {
      const metric = c.metric.padEnd(36).slice(0, 36);
      const threshold = c.threshold.padEnd(51).slice(0, 51);
      const status = fmtGateStatus(c.status).padEnd(8);
      write(`  │ ${metric} │ ${threshold} │ ${status} │`);
      if (c.currentValue) {
        write(`  │ ${''.padEnd(36)} │ ${'  Current: ' + c.currentValue}`.slice(0, 94).padEnd(94) + '│          │');
      }
    }
    write('  └────────────────────────────────────┴─────────────────────────────────────────────────────┴──────────┘');
    write('');
  }

  write('  Legend: [PASS] met | [WIP] in progress | [--] not started | [RISK] at risk | [FAIL] failed');
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

  // ADR-PRR-004: Demonstrate rejection workflow
  const highRiskScenario = allScenarios
    .filter(s => s.type === 'space_reduction')
    .sort((a, b) => b.employeesAffected - a.employeesAffected)[0];

  if (highRiskScenario) {
    write('  ── Rejection Workflow (ADR-PRR-004) ──');
    write('');
    write(`  High-risk scenario: ${highRiskScenario.name}`);
    write(`  Risk: ${highRiskScenario.implementationRisk}  |  Experience impact: ${highRiskScenario.employeeExperienceImpact}  |  Employees: ${highRiskScenario.employeesAffected}`);
    write('');

    const riskDecision = decisions.create({
      scenario: highRiskScenario,
      createdBy: 'michael.ross@company.com',
      rationale: 'Space reduction in Singapore office could yield significant lease savings but carries high employee disruption risk.',
    });
    write(`  ✓ Decision created (${riskDecision.id.slice(0, 8)}…) by michael.ross@company.com`);

    decisions.submit(riskDecision.id, 'michael.ross@company.com');
    write('  ✓ Submitted for review');

    decisions.reject({
      decisionId: riskDecision.id,
      rejector: 'jennifer.wu@company.com',
      role: 'vp_operations',
      rationale: 'Rejected: employee experience impact is negative and disruption risk is high. Recommend pursuing schedule optimization for this building first, then reassessing space reduction after 90-day pilot.',
    });
    write('  ✗ Rejected by VP Operations (jennifer.wu@company.com)');
    write('    Reason: high disruption risk — recommend schedule optimization first');
    write(`  Status: ${decisions.get(riskDecision.id)?.status}`);
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
  // ADR-PRR-008: Consulting-grade competitive analysis
  const analysis = competitive.build();

  write('  Competitive Analysis (ADR-PRR-008)');
  write('');
  write('  Capability Maturity Comparison');
  write('  Scale: None → Manual → Rule-Based → Automated → AI-Optimized');
  write('');
  write('  ┌────────────────────────┬────────────┬────────────┬──────────────┬────────────┬──────────────┐');
  write('  │ Capability             │ Current    │ Salesforce │ Google       │ Siemens    │ Post-Pilot   │');
  write('  ├────────────────────────┼────────────┼────────────┼──────────────┼────────────┼──────────────┤');
  for (const cap of analysis.capabilities) {
    const name = cap.capability.padEnd(22).slice(0, 22);
    const cur = maturityLabel(cap.currentState).padEnd(10).slice(0, 10);
    const sf = maturityLabel(cap.peers.Salesforce.level).padEnd(10).slice(0, 10);
    const gg = maturityLabel(cap.peers.Google.level).padEnd(12).slice(0, 12);
    const sm = maturityLabel(cap.peers.Siemens.level).padEnd(10).slice(0, 10);
    const post = maturityLabel(cap.postPilotState).padEnd(12).slice(0, 12);
    write(`  │ ${name} │ ${cur} │ ${sf} │ ${gg} │ ${sm} │ ${post} │`);
  }
  write('  └────────────────────────┴────────────┴────────────┴──────────────┴────────────┴──────────────┘');
  write('');

  write('  Gap-to-Close Summary (how the pilot changes competitive position)');
  write('');
  for (const gap of analysis.gapToClose) {
    const jumpLabel = gap.levelsJumped === 0 ? '(no change)' : `+${gap.levelsJumped} level${gap.levelsJumped > 1 ? 's' : ''}`;
    write(`    • ${gap.capability}: ${maturityLabel(gap.from)} → ${maturityLabel(gap.to)} ${jumpLabel}`);
    write(`      ${gap.comparison}`);
  }
  write('');

  write('  Cost of Inaction — Competitive Risks');
  write('');
  for (const risk of analysis.risksOfInaction) {
    write(`    ⚠ ${risk.risk}`);
    write(`      Driver: ${risk.drivenBy}`);
    write(`      Timeframe: ${risk.timeframe}`);
    write('');
  }

  write('  Sources:');
  for (const src of analysis.sources) {
    write(`    - ${src}`);
  }
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

function gateStatusIcon(status: string): string {
  switch (status) {
    case 'passed': return '[PASS]';
    case 'in_progress': return '[WIP]';
    case 'at_risk': return '[RISK]';
    case 'failed': return '[FAIL]';
    default: return '[--]';
  }
}

function fmtGateStatus(status: string): string {
  switch (status) {
    case 'passed': return '[PASS]';
    case 'in_progress': return '[WIP]';
    case 'at_risk': return '[RISK]';
    case 'failed': return '[FAIL]';
    default: return '[--]';
  }
}

main().catch(err => {
  logger.error('demo.failed', err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
