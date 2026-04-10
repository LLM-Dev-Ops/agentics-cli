/**
 * ADR-PRR-002: Phase gate go/no-go criteria evaluation.
 *
 * Defines 3 phase gates with configurable thresholds and evaluates
 * current system state against them. Designed to be run during the
 * demo to show executives what will be measured at each milestone.
 *
 * During the pilot, actual measurements replace simulated values.
 */
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { PhaseGate, GateCriterion, GateStatus, Scenario } from '../types.js';
import type { AuditService } from './audit.js';
import type { SensitivityAnalysis } from './sensitivity.js';

interface GateEvaluationInput {
  auditChainValid: boolean;
  scenarioCount: number;
  pilotSavingsUsd: number;
  enterpriseRoiPct: number;
  sensitivityAnalysis: SensitivityAnalysis;
}

export class PhaseGateService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Build the 3 phase gates with thresholds from config.
   * During prototype: criteria show thresholds and "not_started" status.
   * During pilot: pass actual measurements to evaluate().
   */
  buildGates(): PhaseGate[] {
    const pg = this.config.phaseGates;

    const gate1: PhaseGate = {
      id: 'gate-1',
      name: 'Technical Validation',
      weekNumber: pg.gate1Week,
      decisionAuthority: 'CTO + VP Facilities',
      criteria: [
        {
          metric: 'Archibus API field coverage',
          threshold: `>=${pct(pg.erpFieldCoveragePct)} of required fields validated`,
          dataSource: 'ERP adapter integration test results',
          status: 'not_started',
        },
        {
          metric: 'Scoring model accuracy',
          threshold: `>=${pct(pg.scoringAccuracyPct)} agreement with manual assessment baseline`,
          dataSource: 'Side-by-side comparison with facilities team (50-zone sample)',
          status: 'not_started',
        },
        {
          metric: 'System uptime during pilot',
          threshold: `>=${pct(pg.systemUptimePct)} during business hours`,
          dataSource: 'Health check endpoint logs (/health/ready)',
          status: 'not_started',
        },
        {
          metric: 'Audit trail integrity',
          threshold: `${pct(pg.auditIntegrityPct)} hash chain verification pass`,
          dataSource: 'Automated audit verification endpoint (/api/audit/verify)',
          status: 'not_started',
        },
      ],
      overallStatus: 'not_started',
    };

    const gate2: PhaseGate = {
      id: 'gate-2',
      name: 'Business Validation',
      weekNumber: pg.gate2Week,
      decisionAuthority: 'CFO + CTO',
      criteria: [
        {
          metric: 'Cost savings realized vs. projected',
          threshold: `Within +/-${pct(pg.savingsVariancePct)} of simulation base case`,
          dataSource: 'Finance reconciliation of actual vs. projected savings',
          status: 'not_started',
        },
        {
          metric: 'User adoption',
          threshold: `>=${pct(pg.userAdoptionPct)} of pilot department using system for decisions`,
          dataSource: 'Usage telemetry (API request logs, decision count)',
          status: 'not_started',
        },
        {
          metric: 'False positive rate',
          threshold: `<${pct(pg.falsePositiveRatePct)} of zone consolidation recommendations`,
          dataSource: 'Post-decision audit by facilities management team',
          status: 'not_started',
        },
        {
          metric: 'ERP transaction success rate',
          threshold: `>=${pct(pg.erpTransactionSuccessPct)} (excluding planned dry-run failures)`,
          dataSource: 'Circuit breaker metrics + Archibus response logs',
          status: 'not_started',
        },
      ],
      overallStatus: 'not_started',
    };

    const gate3: PhaseGate = {
      id: 'gate-3',
      name: 'Scale Readiness',
      weekNumber: pg.gate3Week,
      decisionAuthority: 'Steering Committee',
      criteria: [
        {
          metric: 'Projected enterprise-wide ROI',
          threshold: `>=${pct(pg.projectedRoiPct)} (with sensitivity analysis)`,
          dataSource: 'Updated simulation with pilot actuals replacing seed data',
          status: 'not_started',
        },
        {
          metric: 'Security audit findings',
          threshold: `${pg.securityCriticalFindings} critical/high findings`,
          dataSource: 'Security scan report (ADR-049 compliance)',
          status: 'not_started',
        },
        {
          metric: 'Change management readiness',
          threshold: `>=${pct(pg.changeManagementReadinessPct)} of target users trained`,
          dataSource: 'HR/Training completion records',
          status: 'not_started',
        },
        {
          metric: 'Database performance at scale',
          threshold: `<${pg.dbLatencyP95Ms}ms p95 query latency at projected load`,
          dataSource: 'Load test results against PostgreSQL with projected data volume',
          status: 'not_started',
        },
      ],
      overallStatus: 'not_started',
    };

    this.logger.info('phaseGates.built', {
      gateCount: 3,
      gate1Week: pg.gate1Week,
      gate2Week: pg.gate2Week,
      gate3Week: pg.gate3Week,
    });

    return [gate1, gate2, gate3];
  }

  /**
   * Evaluate gates against current prototype state.
   * In prototype mode, only Gate 1's audit integrity criterion can be
   * evaluated (we have a working audit chain). Everything else shows
   * the threshold for reference.
   */
  evaluate(gates: PhaseGate[], input: GateEvaluationInput): PhaseGate[] {
    const evaluated = gates.map(gate => ({
      ...gate,
      criteria: gate.criteria.map(c => ({ ...c })),
    }));

    // Gate 1: evaluate audit integrity (we can check this now)
    const gate1 = evaluated[0];
    const auditCriterion = gate1.criteria.find(c => c.metric === 'Audit trail integrity');
    if (auditCriterion) {
      auditCriterion.currentValue = input.auditChainValid ? '100% — chain valid' : 'FAILED — chain broken';
      auditCriterion.status = input.auditChainValid ? 'passed' : 'failed';
    }

    // Gate 1: scoring model — can verify scenarios were generated
    const scoringCriterion = gate1.criteria.find(c => c.metric === 'Scoring model accuracy');
    if (scoringCriterion && input.scenarioCount > 0) {
      scoringCriterion.currentValue = `${input.scenarioCount} scenarios generated from seed data`;
      scoringCriterion.status = 'in_progress';
    }

    // Gate 2: savings — we can show what the simulation projects
    const gate2 = evaluated[1];
    const savingsCriterion = gate2.criteria.find(c => c.metric === 'Cost savings realized vs. projected');
    if (savingsCriterion) {
      savingsCriterion.currentValue = `Simulation baseline: $${Math.round(input.pilotSavingsUsd).toLocaleString()}/yr`;
      savingsCriterion.status = 'not_started';
    }

    // Gate 3: ROI — we can compute from simulation
    const gate3 = evaluated[2];
    const roiCriterion = gate3.criteria.find(c => c.metric === 'Projected enterprise-wide ROI');
    if (roiCriterion) {
      const pg = this.config.phaseGates;
      roiCriterion.currentValue = `Simulation projects ${Math.round(input.enterpriseRoiPct)}% ROI`;
      roiCriterion.status = input.enterpriseRoiPct >= pg.projectedRoiPct * 100 ? 'passed' : 'at_risk';
    }

    // Compute overall status per gate
    for (const gate of evaluated) {
      gate.overallStatus = this.computeOverallStatus(gate.criteria);
    }

    this.logger.info('phaseGates.evaluated', {
      gates: evaluated.map(g => ({ id: g.id, status: g.overallStatus })),
    });

    return evaluated;
  }

  private computeOverallStatus(criteria: GateCriterion[]): GateStatus {
    if (criteria.some(c => c.status === 'failed')) return 'failed';
    if (criteria.every(c => c.status === 'passed')) return 'passed';
    if (criteria.some(c => c.status === 'at_risk')) return 'at_risk';
    if (criteria.some(c => c.status === 'in_progress')) return 'in_progress';
    return 'not_started';
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
