/**
 * Quantify Command - CRUD Command for ROI Report Management
 *
 * ARCHITECTURE:
 * - This module supports both orchestration commands AND local CRUD operations
 * - Local CRUD uses file-based persistence in .agentics/quantify/
 * - Has its own error handling and exit codes
 *
 * SUBCOMMANDS (Local CRUD):
 * - list      List all ROI reports
 * - inspect   Inspect a specific report by ID
 * - create    Create a new ROI report record
 * - delete    Delete a report
 * - compare   Compare two reports (stubbed math)
 *
 * ORCHESTRATION (External):
 * - Default command executes via enterprise-roi-engine
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CommandOptions,
  RoiReportReference,
  SimulationReference,
  RoiReportType,
  FlexibleInput,
  NaturalLanguageInput,
} from '../types/index.js';
import { isNaturalLanguage } from '../types/index.js';
import { RoiEngineAdapter } from '../adapters/base-adapter.js';
import {
  createOrchestrationEngine,
  type OrchestrationStage,
} from '../modules/orchestration-engine.js';
import { createArtifactHandoff } from '../modules/artifact-handoff.js';
import { createAuditTrail } from '../audit/audit-trail.js';
import { failFast, toError, CLIError } from '../errors/index.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import {
  validateRequest,
  validateResponse,
  RequestSchemas,
  ResponseSchemas,
} from '../contracts/validator.js';
import type { QuantifyRequestContract } from '../contracts/validator.js';

// ============================================================================
// Quantify-Specific Exit Codes
// ============================================================================

export const QUANTIFY_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  NOT_FOUND: 100,
  IO_ERROR: 74,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// ROI Report Record Types (Local CRUD)
// ============================================================================

export interface QuantifyRecord {
  id: string;
  name: string;
  description: string;
  report_type: RoiReportType;
  simulation_id?: string;
  status: QuantifyStatus;
  metrics: RoiMetrics;
  created_at: string;
  updated_at: string;
  version: number;
  metadata?: Record<string, unknown>;
}

export type QuantifyStatus = 'draft' | 'pending' | 'completed' | 'archived';

export interface RoiMetrics {
  total_cost_savings?: number;
  total_revenue_impact?: number;
  roi_percentage?: number;
  payback_period_months?: number;
  net_present_value?: number;
  internal_rate_of_return?: number;
  currency: string;
  time_horizon: string;
}

// ============================================================================
// CRUD Input/Output Types
// ============================================================================

export interface QuantifyCreateInput {
  name: string;
  description?: string;
  report_type?: RoiReportType;
  simulation_id?: string;
  metrics?: Partial<RoiMetrics>;
  metadata?: Record<string, unknown>;
}

export interface QuantifyCreateResult {
  report: QuantifyRecord;
  timing: number;
}

export interface QuantifyListInput {
  status?: QuantifyStatus;
  report_type?: RoiReportType;
  limit?: number;
}

export interface QuantifyListResult {
  reports: QuantifySummary[];
  count: number;
  timing: number;
}

export interface QuantifySummary {
  id: string;
  name: string;
  report_type: RoiReportType;
  status: string;
  created_at: string;
  roi_percentage?: number;
}

export interface QuantifyInspectInput {
  id: string;
}

export interface QuantifyInspectResult {
  report: QuantifyRecord | null;
  found: boolean;
  timing: number;
}

export interface QuantifyDeleteInput {
  id: string;
}

export interface QuantifyDeleteResult {
  deleted: boolean;
  id: string;
  timing: number;
}

export interface QuantifyCompareInput {
  idA: string;
  idB: string;
}

export interface QuantifyCompareResult {
  reportA: QuantifyRecord | null;
  reportB: QuantifyRecord | null;
  comparison: ComparisonSummary | null;
  timing: number;
}

export interface ComparisonSummary {
  delta_roi: number | null;
  delta_cost_savings: number | null;
  delta_revenue_impact: number | null;
  percentage_difference: number | null;
  better_report: string | null;
  summary: string;
}

// ============================================================================
// Storage Configuration
// ============================================================================

function getQuantifyDir(): string {
  const baseDir = process.env['AGENTICS_DATA_DIR'] ?? process.cwd();
  return path.join(baseDir, '.agentics', 'quantify');
}

function ensureQuantifyDir(): void {
  const dir = getQuantifyDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getQuantifyPath(id: string): string {
  return path.join(getQuantifyDir(), `${id}.json`);
}

// ============================================================================
// Storage Operations
// ============================================================================

function loadQuantifyRecord(id: string): QuantifyRecord | null {
  const filePath = getQuantifyPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as QuantifyRecord;
  } catch {
    return null;
  }
}

function saveQuantifyRecord(record: QuantifyRecord): void {
  ensureQuantifyDir();
  const filePath = getQuantifyPath(record.id);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

function deleteQuantifyFile(id: string): boolean {
  const filePath = getQuantifyPath(id);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

function listAllQuantifyRecords(): QuantifyRecord[] {
  const dir = getQuantifyDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const records: QuantifyRecord[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      records.push(JSON.parse(content) as QuantifyRecord);
    } catch {
      // Skip invalid files
    }
  }
  return records;
}

// ============================================================================
// ID Generation
// ============================================================================

function generateQuantifyId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `roi-${timestamp}-${random}`;
}

// ============================================================================
// Validation
// ============================================================================

function validateQuantifyId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-QUANTIFY-001',
      category: 'INPUT_ERROR',
      message: 'Report ID is required',
      details: { provided: id },
      module: 'quantify',
      correlationId,
      recoverable: false,
      exitCode: QUANTIFY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validateQuantifyName(name: string, correlationId?: string): void {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new CLIError({
      code: 'ECLI-QUANTIFY-002',
      category: 'INPUT_ERROR',
      message: 'Report name is required',
      details: { provided: name },
      module: 'quantify',
      correlationId,
      recoverable: false,
      exitCode: QUANTIFY_EXIT_CODES.INPUT_ERROR,
    });
  }
  if (name.length > 256) {
    throw new CLIError({
      code: 'ECLI-QUANTIFY-003',
      category: 'INPUT_ERROR',
      message: 'Report name cannot exceed 256 characters',
      details: { provided_length: name.length, max_length: 256 },
      module: 'quantify',
      correlationId,
      recoverable: false,
      exitCode: QUANTIFY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatQuantifyForDisplay(record: QuantifyRecord): string {
  const lines: string[] = [];
  const statusIcon = record.status === 'completed' ? '[OK]'
    : record.status === 'pending' ? '[PEND]'
    : record.status === 'archived' ? '[ARCH]'
    : '[DRAFT]';

  lines.push(`${statusIcon} ${record.id}`);
  lines.push(`   Name:         ${record.name}`);
  lines.push(`   Report Type:  ${record.report_type}`);
  lines.push(`   Status:       ${record.status}`);
  lines.push(`   Description:  ${record.description || '(none)'}`);
  if (record.simulation_id) {
    lines.push(`   Simulation:   ${record.simulation_id}`);
  }
  lines.push(`   Version:      ${record.version}`);
  lines.push(`   Created:      ${new Date(record.created_at).toLocaleString()}`);
  lines.push(`   Updated:      ${new Date(record.updated_at).toLocaleString()}`);

  // Metrics
  const m = record.metrics;
  lines.push(`   Currency:     ${m.currency}`);
  lines.push(`   Time Horizon: ${m.time_horizon}`);
  if (m.roi_percentage !== undefined) {
    lines.push(`   ROI:          ${m.roi_percentage.toFixed(2)}%`);
  }
  if (m.total_cost_savings !== undefined) {
    lines.push(`   Cost Savings: ${m.total_cost_savings.toLocaleString()} ${m.currency}`);
  }
  if (m.total_revenue_impact !== undefined) {
    lines.push(`   Revenue Impact: ${m.total_revenue_impact.toLocaleString()} ${m.currency}`);
  }
  if (m.payback_period_months !== undefined) {
    lines.push(`   Payback:      ${m.payback_period_months} months`);
  }
  if (m.net_present_value !== undefined) {
    lines.push(`   NPV:          ${m.net_present_value.toLocaleString()} ${m.currency}`);
  }
  if (m.internal_rate_of_return !== undefined) {
    lines.push(`   IRR:          ${m.internal_rate_of_return.toFixed(2)}%`);
  }

  return lines.join('\n');
}

export function formatQuantifyListForDisplay(reports: QuantifySummary[]): string {
  if (reports.length === 0) {
    return 'No ROI reports found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${reports.length} report${reports.length === 1 ? '' : 's'}:`);
  lines.push('');

  for (const report of reports) {
    const roiStr = report.roi_percentage !== undefined ? ` (${report.roi_percentage.toFixed(1)}% ROI)` : '';
    lines.push(`  ${report.id} - ${report.name} [${report.status}]${roiStr}`);
    lines.push(`    Type: ${report.report_type}`);
    lines.push(`    Created: ${new Date(report.created_at).toLocaleString()}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatCompareForDisplay(result: QuantifyCompareResult): string {
  const lines: string[] = [];

  if (!result.reportA || !result.reportB) {
    if (!result.reportA) {
      lines.push('Report A not found.');
    }
    if (!result.reportB) {
      lines.push('Report B not found.');
    }
    return lines.join('\n');
  }

  lines.push('ROI Report Comparison');
  lines.push('=====================');
  lines.push('');
  lines.push(`Report A: ${result.reportA.id} - ${result.reportA.name}`);
  lines.push(`Report B: ${result.reportB.id} - ${result.reportB.name}`);
  lines.push('');

  if (result.comparison) {
    const c = result.comparison;
    if (c.delta_roi !== null) {
      lines.push(`ROI Difference: ${c.delta_roi >= 0 ? '+' : ''}${c.delta_roi.toFixed(2)}%`);
    }
    if (c.delta_cost_savings !== null) {
      lines.push(`Cost Savings Difference: ${c.delta_cost_savings >= 0 ? '+' : ''}${c.delta_cost_savings.toLocaleString()}`);
    }
    if (c.delta_revenue_impact !== null) {
      lines.push(`Revenue Impact Difference: ${c.delta_revenue_impact >= 0 ? '+' : ''}${c.delta_revenue_impact.toLocaleString()}`);
    }
    if (c.percentage_difference !== null) {
      lines.push(`Overall Difference: ${c.percentage_difference >= 0 ? '+' : ''}${c.percentage_difference.toFixed(2)}%`);
    }
    lines.push('');
    lines.push(`Summary: ${c.summary}`);
    if (c.better_report) {
      lines.push(`Better Report: ${c.better_report}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Command Interface
// ============================================================================

export interface QuantifyCommandInput {
  simRef: FlexibleInput<SimulationReference>;
  reportType?: RoiReportType;
  timeHorizon?: 'quarterly' | 'annual' | '3-year' | '5-year';
  currency?: string;
  discountRate?: number;
}

export interface QuantifyCommandResult {
  reference: RoiReportReference;
  timing: number;
}

// ============================================================================
// Quantify Command Implementation
// ============================================================================

export async function executeQuantifyCommand(
  input: QuantifyCommandInput,
  options: CommandOptions
): Promise<QuantifyCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const startTime = Date.now();

  // Initialize components
  const engine = createOrchestrationEngine(correlationId);
  const handoff = createArtifactHandoff();
  const audit = createAuditTrail();

  // Create adapter
  const roiConfig = loadEndpointConfig('enterprise-roi-engine');
  const roiAdapter = new RoiEngineAdapter(roiConfig, correlationId);

  // Default report type
  const reportType = input.reportType ?? 'cfo-grade';

  // Define orchestration stages
  const stages: OrchestrationStage[] = [
    {
      name: 'generate-roi-report',
      adapter: roiAdapter,
      request: {
        endpoint: '/v1/roi',
        method: 'POST',
        buildBody: () => {
          let requestBody: QuantifyRequestContract;

          if (isNaturalLanguage(input.simRef)) {
            // ============================================================================
            // CONTRACT VALIDATION - Natural language format
            // ============================================================================
            requestBody = {
              sim_ref: {
                natural_language: (input.simRef as NaturalLanguageInput).description,
              },
              report_type: reportType,
              time_horizon: input.timeHorizon,
              currency: input.currency,
              discount_rate: input.discountRate,
            };
          } else {
            // ============================================================================
            // CONTRACT VALIDATION - Structured reference format
            // ============================================================================
            const simRef = input.simRef as SimulationReference;
            requestBody = {
              sim_ref: {
                id: simRef.id,
                type: 'SimulationReference',
                repository: simRef.repository,
                created_at: simRef.created_at,
                checksum: simRef.checksum,
              },
              report_type: reportType,
              time_horizon: input.timeHorizon,
              currency: input.currency,
              discount_rate: input.discountRate,
            };
          }

          // Validate request against contract BEFORE sending
          validateRequest<QuantifyRequestContract>(
            RequestSchemas.QUANTIFY,
            requestBody,
            correlationId
          );

          return requestBody;
        },
      },
    },
  ];

  try {
    // Execute orchestration
    const result = await engine.execute(stages, options);

    if (!result.success) {
      const failedStage = result.stages.find(s => s.status === 'failed');
      throw new Error(failedStage?.error?.message ?? 'ROI report generation failed');
    }

    // ============================================================================
    // RESPONSE VALIDATION - execution_metadata REQUIRED
    // ============================================================================

    const roiStage = result.stages.find(s => s.name === 'generate-roi-report');
    const validatedRoi = validateResponse(
      ResponseSchemas.ROI_REPORT,
      roiStage?.response,
      correlationId
    );

    const roiRef = handoff.extractReference(validatedRoi) as RoiReportReference;

    // Record audit entry
    const simRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'quantify',
      inputs: { simRef: simRefId, reportType },
      outputs: roiRef,
      dependencies: [
        { service: 'enterprise-roi-engine', method: 'generate', timestamp: new Date().toISOString(), duration_ms: result.timing.total, success: true },
      ],
      duration_ms: result.timing.total,
      status: 'SUCCESS',
      trace_id: correlationId,
    });

    return {
      reference: roiRef,
      timing: Date.now() - startTime,
    };
  } catch (error) {
    // Record failure in audit
    const failedSimRefId = isNaturalLanguage(input.simRef)
      ? `nl:${(input.simRef as NaturalLanguageInput).description.slice(0, 50)}`
      : (input.simRef as SimulationReference).id;
    audit.record({
      command: 'quantify',
      inputs: { simRef: failedSimRefId, reportType },
      outputs: null,
      dependencies: [],
      duration_ms: Date.now() - startTime,
      status: 'FAILED',
      error_code: error instanceof Error ? error.name : 'UNKNOWN',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      trace_id: correlationId,
    });

    // Fail fast
    failFast({
      command: 'quantify',
      phase: 'generation',
      upstreamError: toError(error),
      inputs: input,
      correlationId,
    });
  }
}

// ============================================================================
// CRUD Command Implementations
// ============================================================================

/**
 * Create a new ROI report record
 */
export async function executeQuantifyCreateCommand(
  input: QuantifyCreateInput,
  options: CommandOptions
): Promise<QuantifyCreateResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateQuantifyName(input.name, correlationId);

  const now = new Date().toISOString();
  const report: QuantifyRecord = {
    id: generateQuantifyId(),
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    report_type: input.report_type ?? 'cfo-grade',
    simulation_id: input.simulation_id,
    status: 'draft',
    metrics: {
      currency: input.metrics?.currency ?? 'USD',
      time_horizon: input.metrics?.time_horizon ?? 'annual',
      total_cost_savings: input.metrics?.total_cost_savings,
      total_revenue_impact: input.metrics?.total_revenue_impact,
      roi_percentage: input.metrics?.roi_percentage,
      payback_period_months: input.metrics?.payback_period_months,
      net_present_value: input.metrics?.net_present_value,
      internal_rate_of_return: input.metrics?.internal_rate_of_return,
    },
    created_at: now,
    updated_at: now,
    version: 1,
    metadata: input.metadata,
  };

  try {
    saveQuantifyRecord(report);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-QUANTIFY-IO-001',
      category: 'INTERNAL_ERROR',
      message: 'Failed to save ROI report',
      details: { error: error instanceof Error ? error.message : String(error) },
      module: 'quantify',
      correlationId,
      recoverable: false,
      exitCode: QUANTIFY_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    report,
    timing: Date.now() - startTime,
  };
}

/**
 * List ROI reports from local storage
 */
export async function executeQuantifyListCommand(
  input: QuantifyListInput,
  _options: CommandOptions
): Promise<QuantifyListResult> {
  const startTime = Date.now();

  let records = listAllQuantifyRecords();

  // Apply filters
  if (input.status) {
    records = records.filter(r => r.status === input.status);
  }
  if (input.report_type) {
    records = records.filter(r => r.report_type === input.report_type);
  }

  // Sort by updated_at descending
  records.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  // Apply limit
  if (input.limit && input.limit > 0) {
    records = records.slice(0, input.limit);
  }

  // Map to summary
  const summaries: QuantifySummary[] = records.map(r => ({
    id: r.id,
    name: r.name,
    report_type: r.report_type,
    status: r.status,
    created_at: r.created_at,
    roi_percentage: r.metrics.roi_percentage,
  }));

  return {
    reports: summaries,
    count: summaries.length,
    timing: Date.now() - startTime,
  };
}

/**
 * Inspect a specific ROI report by ID
 */
export async function executeQuantifyInspectCommand(
  input: QuantifyInspectInput,
  options: CommandOptions
): Promise<QuantifyInspectResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateQuantifyId(input.id, correlationId);

  const report = loadQuantifyRecord(input.id);

  return {
    report,
    found: report !== null,
    timing: Date.now() - startTime,
  };
}

/**
 * Delete an ROI report
 */
export async function executeQuantifyDeleteCommand(
  input: QuantifyDeleteInput,
  options: CommandOptions
): Promise<QuantifyDeleteResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateQuantifyId(input.id, correlationId);

  const deleted = deleteQuantifyFile(input.id);

  if (!deleted) {
    throw new CLIError({
      code: 'ECLI-QUANTIFY-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `ROI report not found: ${input.id}`,
      details: { id: input.id },
      module: 'quantify',
      correlationId,
      recoverable: false,
      exitCode: QUANTIFY_EXIT_CODES.NOT_FOUND,
    });
  }

  return {
    deleted: true,
    id: input.id,
    timing: Date.now() - startTime,
  };
}

/**
 * Compare two ROI reports (stubbed math)
 */
export async function executeQuantifyCompareCommand(
  input: QuantifyCompareInput,
  options: CommandOptions
): Promise<QuantifyCompareResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateQuantifyId(input.idA, correlationId);
  validateQuantifyId(input.idB, correlationId);

  const reportA = loadQuantifyRecord(input.idA);
  const reportB = loadQuantifyRecord(input.idB);

  let comparison: ComparisonSummary | null = null;

  if (reportA && reportB) {
    const mA = reportA.metrics;
    const mB = reportB.metrics;

    const deltaRoi = (mA.roi_percentage !== undefined && mB.roi_percentage !== undefined)
      ? mA.roi_percentage - mB.roi_percentage
      : null;

    const deltaCostSavings = (mA.total_cost_savings !== undefined && mB.total_cost_savings !== undefined)
      ? mA.total_cost_savings - mB.total_cost_savings
      : null;

    const deltaRevenueImpact = (mA.total_revenue_impact !== undefined && mB.total_revenue_impact !== undefined)
      ? mA.total_revenue_impact - mB.total_revenue_impact
      : null;

    // Simple percentage difference based on ROI
    const percentageDifference = deltaRoi;

    let betterReport: string | null = null;
    let summary: string;

    if (deltaRoi !== null) {
      if (deltaRoi > 0) {
        betterReport = reportA.id;
        summary = `Report A shows ${deltaRoi.toFixed(2)}% higher ROI than Report B.`;
      } else if (deltaRoi < 0) {
        betterReport = reportB.id;
        summary = `Report B shows ${Math.abs(deltaRoi).toFixed(2)}% higher ROI than Report A.`;
      } else {
        summary = 'Both reports show equivalent ROI.';
      }
    } else {
      summary = 'Unable to compare ROI - metrics not available in one or both reports.';
    }

    comparison = {
      delta_roi: deltaRoi,
      delta_cost_savings: deltaCostSavings,
      delta_revenue_impact: deltaRevenueImpact,
      percentage_difference: percentageDifference,
      better_report: betterReport,
      summary,
    };
  }

  return {
    reportA,
    reportB,
    comparison,
    timing: Date.now() - startTime,
  };
}
