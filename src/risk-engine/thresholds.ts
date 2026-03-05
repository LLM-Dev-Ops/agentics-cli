/**
 * Supply risk detection thresholds.
 * Loaded from environment variables with healthcare-appropriate defaults.
 */

export interface RiskThresholds {
  /** Days of supply below which a CRITICAL shortage alert fires. */
  readonly criticalDaysSupply: number;
  /** Days of supply below which a WARNING shortage alert fires. */
  readonly warningDaysSupply: number;
  /** Days of supply above which a SURPLUS alert fires. */
  readonly surplusDaysSupply: number;
  /** Ratio threshold for IMBALANCE — one facility has N× more than another. */
  readonly imbalanceRatio: number;
  /** Whether the engine may auto-create transfer/procurement orders. */
  readonly autoActionEnabled: boolean;
  /** Maximum dollar value for auto-created orders. */
  readonly autoActionMaxValue: number;
  /** Default reorder point in days (overridden per-SKU when configured). */
  readonly defaultReorderPointDays: number;
  /** Maximum days on hand before surplus flagged. */
  readonly maxDaysOnHand: number;
}

export function loadThresholds(): RiskThresholds {
  return {
    criticalDaysSupply: intEnv('CRITICAL_DAYS_SUPPLY', 2),
    warningDaysSupply: intEnv('WARNING_DAYS_SUPPLY', 7),
    surplusDaysSupply: intEnv('SURPLUS_DAYS_SUPPLY', 90),
    imbalanceRatio: intEnv('IMBALANCE_RATIO', 10),
    autoActionEnabled: process.env['AUTO_ACTION_ENABLED'] === 'true',
    autoActionMaxValue: intEnv('AUTO_ACTION_MAX_VALUE', 10000),
    defaultReorderPointDays: intEnv('DEFAULT_REORDER_POINT_DAYS', 7),
    maxDaysOnHand: intEnv('MAX_DAYS_ON_HAND', 90),
  };
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
