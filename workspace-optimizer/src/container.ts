import { config, type AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { CircuitBreaker } from './middleware.js';
import { ScoringService } from './services/scoring.js';
import { ScenarioService } from './services/scenarios.js';
import { DecisionService } from './services/decisions.js';
import { AuditService } from './services/audit.js';
import { ERPAdapter } from './erp/adapter.js';
import { DecisionLifecycleService } from './services/lifecycle.js';
import { SensitivityService } from './services/sensitivity.js';
import { PhaseGateService } from './services/phase-gates.js';
import { CompetitiveAnalysisService } from './services/competitive-analysis.js';
import { seedFleetData } from './data/seed.js';
import type { FleetDataProvider } from './types.js';

const logger = createLogger('container');

export interface Container {
  config: AppConfig;
  fleetData: FleetDataProvider;
  scoring: ScoringService;
  scenarios: ScenarioService;
  decisions: DecisionService;
  audit: AuditService;
  erp: ERPAdapter;
  lifecycle: DecisionLifecycleService;
  sensitivity: SensitivityService;
  phaseGates: PhaseGateService;
  competitive: CompetitiveAnalysisService;
  circuitBreaker: CircuitBreaker;
}

/** ADR-055: Factory function for test isolation — creates a fresh dependency graph */
/** ADR-PRR-007: Accepts an optional FleetDataProvider override for swapping data sources */
export function createContainer(overrideConfig?: AppConfig, fleetData: FleetDataProvider = seedFleetData): Container {
  const cfg = overrideConfig ?? config;
  const audit = new AuditService(createLogger('audit'));
  const scoring = new ScoringService(cfg, createLogger('scoring'));
  const scenarios = new ScenarioService(cfg, createLogger('scenarios'));
  const decisions = new DecisionService(cfg, createLogger('decisions'), audit);
  const circuitBreaker = new CircuitBreaker(
    cfg.erp.circuitBreakerThreshold,
    cfg.erp.circuitBreakerResetMs,
    createLogger('circuit-breaker'),
  );
  const erp = new ERPAdapter(cfg, createLogger('erp'), circuitBreaker);
  const lifecycle = new DecisionLifecycleService(audit, erp, createLogger('lifecycle'));
  const sensitivity = new SensitivityService(cfg, createLogger('sensitivity'));
  const phaseGates = new PhaseGateService(cfg, createLogger('phase-gates'));
  const competitive = new CompetitiveAnalysisService(createLogger('competitive'));

  return { config: cfg, fleetData, scoring, scenarios, decisions, audit, erp, lifecycle, sensitivity, phaseGates, competitive, circuitBreaker };
}

// Default singleton for production / demo usage
export const container = createContainer();

logger.info('container.initialized', { simulationId: config.simulationId });
