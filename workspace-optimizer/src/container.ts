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

const logger = createLogger('container');

export interface Container {
  config: AppConfig;
  scoring: ScoringService;
  scenarios: ScenarioService;
  decisions: DecisionService;
  audit: AuditService;
  erp: ERPAdapter;
  lifecycle: DecisionLifecycleService;
  sensitivity: SensitivityService;
  circuitBreaker: CircuitBreaker;
}

/** ADR-055: Factory function for test isolation — creates a fresh dependency graph */
export function createContainer(overrideConfig?: AppConfig): Container {
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

  return { config: cfg, scoring, scenarios, decisions, audit, erp, lifecycle, sensitivity, circuitBreaker };
}

// Default singleton for production / demo usage
export const container = createContainer();

logger.info('container.initialized', { simulationId: config.simulationId });
