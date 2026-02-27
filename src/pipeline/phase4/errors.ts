/**
 * Phase 4 (ERP Integration) Errors
 *
 * Error classes for Phase 4 execution:
 *   ECLI-P4-001  Phase 3 validation failed
 *   ECLI-P4-002  ERP target resolution failed
 *   ECLI-P4-003  Platform repo missing/not cached
 *   ECLI-P4-004  Schema generation failed
 *   ECLI-P4-005  Phase 4 already exists
 *   ECLI-P4-006  No Phase 3 runs found
 */

import { CLIError } from '../../errors/index.js';

// ============================================================================
// ECLI-P4-001: Phase 3 Validation Failed
// ============================================================================

export class Phase3ValidationError extends CLIError {
  constructor(reason: string) {
    super({
      code: 'ECLI-P4-001',
      category: 'INPUT_ERROR',
      message: `Phase 3 validation failed: ${reason}`,
      details: {},
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
    this.name = 'Phase3ValidationError';
  }
}

// ============================================================================
// ECLI-P4-002: ERP Target Resolution Failed
// ============================================================================

export class ERPTargetError extends CLIError {
  constructor(reason: string) {
    super({
      code: 'ECLI-P4-002',
      category: 'INPUT_ERROR',
      message: `ERP target resolution failed: ${reason}`,
      details: {},
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
    this.name = 'ERPTargetError';
  }
}

// ============================================================================
// ECLI-P4-003: Platform Repo Missing
// ============================================================================

export class PlatformRepoMissingError extends CLIError {
  constructor(repoName: string) {
    super({
      code: 'ECLI-P4-003',
      category: 'CONFIG_ERROR',
      message: `Platform repo '${repoName}' is not cached. Resolve platform repos before running Phase 4.`,
      details: { repo: repoName },
      module: 'phase4',
      recoverable: false,
      exitCode: 78,
    });
    this.name = 'PlatformRepoMissingError';
  }
}

// ============================================================================
// ECLI-P4-004: Schema Generation Failed
// ============================================================================

export class SchemaGenerationError extends CLIError {
  constructor(reason: string) {
    super({
      code: 'ECLI-P4-004',
      category: 'INTERNAL_ERROR',
      message: `Schema generation failed: ${reason}`,
      details: {},
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
    this.name = 'SchemaGenerationError';
  }
}

// ============================================================================
// ECLI-P4-005: Phase 4 Already Exists
// ============================================================================

export class Phase4ExistsError extends CLIError {
  constructor(phase4Dir: string) {
    super({
      code: 'ECLI-P4-005',
      category: 'INPUT_ERROR',
      message: `Phase 4 already exists for this run. Output is append-only: ${phase4Dir}`,
      details: { directory: phase4Dir },
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
    this.name = 'Phase4ExistsError';
  }
}

// ============================================================================
// ECLI-P4-006: No Runs Found
// ============================================================================

export class NoRunsFoundError extends CLIError {
  constructor() {
    super({
      code: 'ECLI-P4-006',
      category: 'INPUT_ERROR',
      message: 'No Phase 3 runs found. Run Phase 1, Phase 2, and Phase 3 first.',
      details: {},
      module: 'phase4',
      recoverable: false,
      exitCode: 1,
    });
    this.name = 'NoRunsFoundError';
  }
}
