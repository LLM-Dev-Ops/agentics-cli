/**
 * QE Gating Config (ADR-PIPELINE-086)
 *
 * Resolves the AGENTICS_QE_GATING mode from either the env var or a persisted
 * config file in ~/.agentics/qe-gating.json. Emits structured bypass records
 * when the mode is not `on`.
 *
 * Source precedence (highest → lowest):
 *   1. AGENTICS_QE_GATING env var
 *   2. Persisted config at <configDir>/qe-gating.json
 *   3. Default: `on`
 *
 * The persisted file is the mechanism on-call uses outside of env-var
 * environments (e.g., managed deployments where env vars require a redeploy).
 * Both paths require a non-empty reason when setting anything other than `on`
 * — callers that persist without a reason will throw.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export type QeGatingMode = 'on' | 'advisory' | 'off';

export const DEFAULT_MODE: QeGatingMode = 'on';
export const ENV_VAR_NAME = 'AGENTICS_QE_GATING';
export const CONFIG_FILE = 'qe-gating.json';
export const DEFAULT_CONFIG_DIR = join(homedir(), '.agentics');

export interface PersistedQeGating {
  mode: QeGatingMode;
  reason: string;
  applied_at: string;
  applied_by?: string;
  correlation_id?: string;
}

export interface ResolvedQeGating {
  mode: QeGatingMode;
  source: 'env' | 'persisted' | 'default';
  /** The reason string, if available (empty for env-default paths). */
  reason?: string;
  /** The raw env var value, if that was the source. */
  rawEnv?: string;
}

export interface ResolveOptions {
  /**
   * Override the environment. Defaults to `process.env`. Tests pass a fixture.
   */
  env?: NodeJS.ProcessEnv;
  /** Override the config dir. Defaults to `~/.agentics`. */
  configDir?: string;
}

export interface PersistOptions {
  configDir?: string;
  correlationId?: string;
  appliedBy?: string;
  /** Clock override for tests. */
  now?: Date;
}

// ============================================================================
// Parsing
// ============================================================================

export class InvalidGatingValueError extends Error {
  readonly code = 'INVALID_QE_GATING_VALUE' as const;
  readonly value: string;

  constructor(value: string) {
    super(`Invalid ${ENV_VAR_NAME} value "${value}" — must be one of: on, advisory, off`);
    this.value = value;
    this.name = 'InvalidGatingValueError';
  }
}

export class EmptyReasonError extends Error {
  readonly code = 'EMPTY_QE_GATING_REASON' as const;
  constructor() {
    super(`Non-empty reason is required when setting ${ENV_VAR_NAME} to advisory or off (ADR-086 §2 audit trail requirement)`);
    this.name = 'EmptyReasonError';
  }
}

/**
 * Parse a raw env-var value. Accepts exactly one of: on, advisory, off
 * (case-insensitive; whitespace-trimmed). Empty / undefined returns null so
 * callers can fall through to persisted / default resolution.
 */
export function parseGatingValue(raw: string | undefined): QeGatingMode | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === 'on' || trimmed === 'advisory' || trimmed === 'off') return trimmed;
  throw new InvalidGatingValueError(raw);
}

// ============================================================================
// Persisted config (file-backed)
// ============================================================================

function persistedPath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

export function loadPersistedQeGating(opts: ResolveOptions = {}): PersistedQeGating | null {
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const path = persistedPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedQeGating;
    // Round-trip validation: mode must be a legal value.
    if (parseGatingValue(parsed.mode) === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a gating decision. Throws `EmptyReasonError` if mode is not `on`
 * and reason is empty. Creates the config dir if missing.
 */
export function persistQeGating(
  mode: QeGatingMode,
  reason: string,
  opts: PersistOptions = {},
): PersistedQeGating {
  if (mode !== 'on' && (!reason || reason.trim() === '')) {
    throw new EmptyReasonError();
  }

  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const path = persistedPath(configDir);
  mkdirSync(dirname(path), { recursive: true });

  const now = opts.now ?? new Date();
  const record: PersistedQeGating = {
    mode,
    reason: reason.trim(),
    applied_at: now.toISOString(),
    ...(opts.appliedBy !== undefined ? { applied_by: opts.appliedBy } : {}),
    ...(opts.correlationId !== undefined ? { correlation_id: opts.correlationId } : {}),
  };

  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return record;
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Resolve the effective gating mode from env > persisted > default.
 */
export function resolveQeGatingMode(opts: ResolveOptions = {}): ResolvedQeGating {
  const env = opts.env ?? process.env;
  const rawEnv = env[ENV_VAR_NAME];

  const fromEnv = parseGatingValue(rawEnv);
  if (fromEnv !== null) {
    const result: ResolvedQeGating = { mode: fromEnv, source: 'env' };
    if (rawEnv !== undefined) result.rawEnv = rawEnv;
    return result;
  }

  const persisted = loadPersistedQeGating(opts);
  if (persisted !== null) {
    return { mode: persisted.mode, source: 'persisted', reason: persisted.reason };
  }

  return { mode: DEFAULT_MODE, source: 'default' };
}

// ============================================================================
// Short-hand helpers
// ============================================================================

export function isGatingOn(opts: ResolveOptions = {}): boolean {
  return resolveQeGatingMode(opts).mode === 'on';
}

export function isGatingAdvisory(opts: ResolveOptions = {}): boolean {
  return resolveQeGatingMode(opts).mode === 'advisory';
}

export function isGatingOff(opts: ResolveOptions = {}): boolean {
  return resolveQeGatingMode(opts).mode === 'off';
}
