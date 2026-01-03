/**
 * Output Rendering Module (Module E)
 *
 * SPARC Architecture Reference: §2.6
 *
 * PURPOSE: Format output for display
 *
 * DEPENDENCIES: None
 *
 * FORBIDDEN:
 * - Data Transformation (NO semantic changes)
 * - Data Validation (NO schema checking)
 * - Business Logic (NO conditional processing)
 * - Side Effects (NO logging or metrics)
 */

import type {
  OutputOptions,
  BaseReference,
  OrchestrationResult,
  ErrorInfo,
} from '../types/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface IOutputRenderer {
  render(data: unknown, options: OutputOptions): string;
  renderReference(ref: BaseReference, options: OutputOptions): string;
  renderResult(result: OrchestrationResult, options: OutputOptions): string;
  renderError(error: ErrorInfo, options: OutputOptions): string;
}

// ============================================================================
// Output Renderer Implementation
// ============================================================================

export class OutputRenderer implements IOutputRenderer {
  /**
   * Render arbitrary data to specified format
   * PASSTHROUGH: No transformation of data semantics
   */
  render(data: unknown, options: OutputOptions): string {
    switch (options.format) {
      case 'json':
        return this.toJson(data, options.pretty ?? false);
      case 'yaml':
        return this.toYaml(data);
      case 'table':
        return this.toTable(data);
      case 'csv':
        return this.toCsv(data);
      case 'text':
      default:
        return this.toText(data);
    }
  }

  /**
   * Render a reference object
   */
  renderReference(ref: BaseReference, options: OutputOptions): string {
    return this.render(ref, options);
  }

  /**
   * Render orchestration result
   */
  renderResult(result: OrchestrationResult, options: OutputOptions): string {
    return this.render(result, options);
  }

  /**
   * Render error information
   */
  renderError(error: ErrorInfo, options: OutputOptions): string {
    if (options.format === 'json') {
      return this.toJson(error, options.pretty ?? false);
    }

    // Text format for errors
    let output = `Error [${error.code}]: ${error.message}`;
    if (error.details && Object.keys(error.details).length > 0) {
      output += `\n  Details: ${JSON.stringify(error.details)}`;
    }
    if (error.correlationId) {
      output += `\n  Correlation ID: ${error.correlationId}`;
    }
    return output;
  }

  // ============================================================================
  // Format Converters
  // ============================================================================

  private toJson(data: unknown, pretty: boolean): string {
    return pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
  }

  private toYaml(data: unknown): string {
    // Simple YAML conversion (no external dependencies per SPARC)
    return this.objectToYaml(data, 0);
  }

  private objectToYaml(data: unknown, indent: number): string {
    const prefix = '  '.repeat(indent);

    if (data === null || data === undefined) {
      return 'null';
    }

    if (typeof data === 'string') {
      // Quote strings that need it
      if (data.includes('\n') || data.includes(':') || data.includes('#')) {
        return `"${data.replace(/"/g, '\\"')}"`;
      }
      return data;
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
      return String(data);
    }

    if (Array.isArray(data)) {
      if (data.length === 0) return '[]';
      return data
        .map(item => `${prefix}- ${this.objectToYaml(item, indent + 1).trimStart()}`)
        .join('\n');
    }

    if (typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      return keys
        .map(key => {
          const value = obj[key];
          const valueStr = this.objectToYaml(value, indent + 1);
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            return `${prefix}${key}:\n${valueStr}`;
          }
          return `${prefix}${key}: ${valueStr}`;
        })
        .join('\n');
    }

    return String(data);
  }

  private toTable(data: unknown): string {
    if (!data || typeof data !== 'object') {
      return String(data);
    }

    // Handle array of objects
    if (Array.isArray(data)) {
      if (data.length === 0) return '(empty)';

      const firstItem = data[0];
      if (typeof firstItem !== 'object' || firstItem === null) {
        return data.map(String).join('\n');
      }

      const headers = Object.keys(firstItem as object);
      const rows = data.map(item => {
        const obj = item as Record<string, unknown>;
        return headers.map(h => String(obj[h] ?? '')).join('\t');
      });

      return [headers.join('\t'), ...rows].join('\n');
    }

    // Handle single object
    const obj = data as Record<string, unknown>;
    return Object.entries(obj)
      .map(([key, value]) => `${key}: ${this.formatValue(value)}`)
      .join('\n');
  }

  private toCsv(data: unknown): string {
    if (!Array.isArray(data)) {
      return this.toTable(data);
    }

    if (data.length === 0) return '';

    const firstItem = data[0];
    if (typeof firstItem !== 'object' || firstItem === null) {
      return data.map(item => this.escapeCsv(String(item))).join('\n');
    }

    const headers = Object.keys(firstItem as object);
    const headerRow = headers.map(h => this.escapeCsv(h)).join(',');

    const rows = data.map(item => {
      const obj = item as Record<string, unknown>;
      return headers.map(h => this.escapeCsv(String(obj[h] ?? ''))).join(',');
    });

    return [headerRow, ...rows].join('\n');
  }

  private escapeCsv(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private toText(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data === null || data === undefined) return '';
    if (typeof data === 'object') {
      return JSON.stringify(data, null, 2);
    }
    return String(data);
  }

  private formatValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createOutputRenderer(): IOutputRenderer {
  return new OutputRenderer();
}
