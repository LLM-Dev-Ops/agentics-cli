/**
 * Phase2 Telemetry — Structured span emission
 *
 * Every major step emits a span with start/end, inputs, outputs, and file paths.
 * Spans are collected on Phase2Context and written to telemetry.jsonl at the end.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TelemetrySpan } from './types.js';

// Re-export TelemetrySpan so existing imports from telemetry.js continue to work
export type { TelemetrySpan } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const FILE_MODE = 0o600;
const TELEMETRY_FILENAME = 'telemetry.jsonl';

// ============================================================================
// Span Lifecycle
// ============================================================================

/**
 * Create a new telemetry span. The span starts immediately with status 'ok'.
 * Call {@link endSpan} when the operation completes to record duration and
 * final status.
 *
 * @param stage     - Pipeline stage name (e.g. 'scaffold', 'codegen')
 * @param operation - Specific operation within the stage
 * @param attributes - Optional key-value metadata to attach
 * @param parentSpanId - Optional parent span for nested tracing
 * @returns A new TelemetrySpan with startTime set to now
 */
export function createSpan(
  stage: string,
  operation: string,
  attributes?: Record<string, string | number | boolean>,
  parentSpanId?: string,
): TelemetrySpan {
  return {
    spanId: `p2-span-${crypto.randomUUID()}`,
    parentSpanId,
    stage,
    operation,
    startTime: Date.now(),
    status: 'ok',
    attributes: attributes ?? {},
  };
}

/**
 * Finalize a span by recording its end time, duration, and final status.
 * Returns a new span object (does not mutate the original).
 *
 * @param span            - The span to finalize
 * @param status          - Final status: 'ok' or 'error'
 * @param extraAttributes - Optional additional attributes to merge
 * @returns A new span with end-time data
 */
export function endSpan(
  span: TelemetrySpan,
  status: 'ok' | 'error',
  extraAttributes?: Record<string, string | number | boolean>,
): TelemetrySpan {
  const endTime = Date.now();
  return {
    ...span,
    endTime,
    durationMs: endTime - span.startTime,
    status,
    attributes: extraAttributes
      ? { ...span.attributes, ...extraAttributes }
      : span.attributes,
  };
}

// ============================================================================
// Emission
// ============================================================================

/**
 * Emit a single span to stderr for real-time observability.
 * Format: `  [SPAN] stage/operation Xms STATUS`
 *
 * @param span - The span to emit
 */
export function emitSpan(span: TelemetrySpan): void {
  const duration = span.durationMs ?? '?';
  console.error(`  [SPAN] ${span.stage}/${span.operation} ${duration}ms ${span.status.toUpperCase()}`);
}

/**
 * Write an array of spans to a NDJSON file (one JSON object per line).
 * The file is written to `<outputDir>/telemetry.jsonl` with 0o600 permissions.
 *
 * @param spans     - Completed spans to persist
 * @param outputDir - Directory to write the telemetry file into
 */
export function writeSpans(spans: readonly TelemetrySpan[], outputDir: string): void {
  const filePath = path.join(outputDir, TELEMETRY_FILENAME);
  const content = spans.map((s) => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: FILE_MODE });
}
