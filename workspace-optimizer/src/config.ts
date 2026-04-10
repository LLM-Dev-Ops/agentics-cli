import { z } from 'zod';
import { createLogger } from './logger.js';

const logger = createLogger('config');

const AppConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Simulation lineage
  simulationId: z.string().uuid().default('65aa51b1-1fe4-4053-a50e-2eaa7f01aa2c'),
  pipelineVersion: z.string().default('0.1.0'),
  confidenceLevel: z.coerce.number().min(0).max(1).default(0.416),

  // Enterprise scaling (ADR-053)
  totalEnterpriseEmployees: z.coerce.number().int().positive().default(68000),
  pilotBuildingCount: z.coerce.number().int().positive().default(3),

  // Scoring weights (ADR-055: weights must sum to 1.0)
  scoring: z.object({
    avgOccupancyWeight: z.coerce.number().min(0).max(1).default(0.60),
    peakVarianceWeight: z.coerce.number().min(0).max(1).default(0.25),
    flexibilityWeight: z.coerce.number().min(0).max(1).default(0.15),
    severelyUnderutilizedThreshold: z.coerce.number().default(0.30),
    underutilizedThreshold: z.coerce.number().default(0.55),
  }).refine(
    (cfg) => Math.abs(cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight - 1.0) < 0.001,
    (cfg) => ({
      message: `Scoring weights must sum to 1.0 (got ${(cfg.avgOccupancyWeight + cfg.peakVarianceWeight + cfg.flexibilityWeight).toFixed(3)})`,
    }),
  ).default({}),

  // Approval thresholds
  approval: z.object({
    vpEmployeeThreshold: z.coerce.number().int().default(50),
    cfoEmployeeThreshold: z.coerce.number().int().default(200),
    vpCostThreshold: z.coerce.number().default(100_000),
    cfoCostThreshold: z.coerce.number().default(500_000),
    minRationaleLength: z.coerce.number().int().default(20),
  }).default({}),

  // ERP
  erp: z.object({
    baseUrl: z.string().url().default('https://archibus.example.com/api/v1'),
    maxRetries: z.coerce.number().int().min(0).max(10).default(3),
    retryBaseDelayMs: z.coerce.number().int().default(1000),
    circuitBreakerThreshold: z.coerce.number().int().default(5),
    circuitBreakerResetMs: z.coerce.number().int().default(30_000),
    dryRun: z.coerce.boolean().default(true),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

function loadConfig(): AppConfig {
  try {
    const raw = {
      env: process.env.NODE_ENV,
      port: process.env.PORT,
      logLevel: process.env.LOG_LEVEL,
      simulationId: process.env.SIMULATION_ID,
      pipelineVersion: process.env.PIPELINE_VERSION,
      confidenceLevel: process.env.CONFIDENCE_LEVEL,
      totalEnterpriseEmployees: process.env.TOTAL_ENTERPRISE_EMPLOYEES,
      pilotBuildingCount: process.env.PILOT_BUILDING_COUNT,
      scoring: {
        avgOccupancyWeight: process.env.SCORING_AVG_OCCUPANCY_WEIGHT,
        peakVarianceWeight: process.env.SCORING_PEAK_VARIANCE_WEIGHT,
        flexibilityWeight: process.env.SCORING_FLEXIBILITY_WEIGHT,
        severelyUnderutilizedThreshold: process.env.SCORING_SEVERELY_UNDERUTILIZED_THRESHOLD,
        underutilizedThreshold: process.env.SCORING_UNDERUTILIZED_THRESHOLD,
      },
      approval: {
        vpEmployeeThreshold: process.env.APPROVAL_VP_EMPLOYEE_THRESHOLD,
        cfoEmployeeThreshold: process.env.APPROVAL_CFO_EMPLOYEE_THRESHOLD,
        vpCostThreshold: process.env.APPROVAL_VP_COST_THRESHOLD,
        cfoCostThreshold: process.env.APPROVAL_CFO_COST_THRESHOLD,
        minRationaleLength: process.env.APPROVAL_MIN_RATIONALE_LENGTH,
      },
      erp: {
        baseUrl: process.env.ERP_BASE_URL,
        maxRetries: process.env.ERP_MAX_RETRIES,
        retryBaseDelayMs: process.env.ERP_RETRY_BASE_DELAY_MS,
        circuitBreakerThreshold: process.env.ERP_CIRCUIT_BREAKER_THRESHOLD,
        circuitBreakerResetMs: process.env.ERP_CIRCUIT_BREAKER_RESET_MS,
        dryRun: process.env.ERP_DRY_RUN,
      },
    };

    const parsed = AppConfigSchema.parse(raw);
    logger.info('config.loaded', { env: parsed.env, simulationId: parsed.simulationId });
    return parsed;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('config.invalid', error);
    throw error;
  }
}

export const config = loadConfig();
