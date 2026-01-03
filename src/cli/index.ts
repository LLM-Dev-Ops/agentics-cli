#!/usr/bin/env node
/**
 * Agentics CLI Entry Point
 *
 * SPARC Architecture Reference: Main CLI Entry
 *
 * PURPOSE: Parse arguments, dispatch to commands, render output
 *
 * FORBIDDEN:
 * - Business Logic (NO data interpretation)
 * - State Storage (NO caching)
 * - Direct API Calls (delegate to adapters)
 */

import { createCommandParser, SUPPORTED_COMMANDS } from '../modules/command-parser.js';
import { createOutputRenderer } from '../modules/output-renderer.js';
import { CLIError, errorHandler } from '../errors/index.js';
import { EXIT_CODES } from '../types/index.js';
import type { CommandOptions, OutputFormat, BaseReference } from '../types/index.js';

// Import command executors
import { executePlanCommand } from '../commands/plan.js';
import { executeSimulateCommand } from '../commands/simulate.js';
import { executeDeployCommand } from '../commands/deploy.js';
import { executeExportCommand } from '../commands/export.js';
import { executeDiligenceCommand } from '../commands/diligence.js';

// ============================================================================
// CLI Version
// ============================================================================

const VERSION = '1.0.0';

// ============================================================================
// Main CLI Function
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parser = createCommandParser();
  const renderer = createOutputRenderer();

  // Parse command line arguments
  let parsed;
  try {
    parsed = parser.parse(args);
  } catch (error) {
    if (error instanceof CLIError) {
      const formatted = renderer.renderError(error.toErrorInfo(), {
        format: 'text',
        pretty: true,
      });
      console.error(formatted);
      process.exit(error.exitCode);
    }
    throw error;
  }

  // Extract common options
  const options: CommandOptions = {
    timeout: parsed.options['timeout'] ? parseInt(parsed.options['timeout'], 10) : undefined,
    trace_id: parsed.options['trace-id'] ?? crypto.randomUUID(),
    format: (parsed.options['format'] as OutputFormat) ?? 'json',
    verbose: parsed.flags['verbose'] ?? false,
  };

  // Handle built-in commands
  if (parsed.command === 'version' || parsed.flags['version']) {
    console.log(VERSION);
    process.exit(EXIT_CODES.SUCCESS);
  }

  if (parsed.command === 'help' || parsed.flags['help']) {
    printHelp();
    process.exit(EXIT_CODES.SUCCESS);
  }

  // Dispatch to command handlers
  try {
    let result: { reference: BaseReference; timing: number };

    switch (parsed.command) {
      case 'plan':
        result = await executePlanCommand(
          {
            manifestQuery: parsed.positionalArgs[0] ?? '',
            params: parsed.options['params'] ? JSON.parse(parsed.options['params']) : undefined,
          },
          options
        );
        break;

      case 'simulate':
        result = await executeSimulateCommand(
          {
            planRef: JSON.parse(parsed.positionalArgs[0] ?? '{}'),
            config: parsed.options['config'] ? JSON.parse(parsed.options['config']) : undefined,
            iterations: parsed.options['iterations'] ? parseInt(parsed.options['iterations'], 10) : undefined,
          },
          options
        );
        break;

      case 'deploy':
        result = await executeDeployCommand(
          {
            simRef: JSON.parse(parsed.positionalArgs[0] ?? '{}'),
            spec: parsed.options['spec'] ? JSON.parse(parsed.options['spec']) : undefined,
            environment: parsed.options['environment'],
          },
          options
        );
        break;

      case 'export':
        result = await executeExportCommand(
          {
            intentRef: JSON.parse(parsed.positionalArgs[0] ?? '{}'),
            format: (parsed.options['export-format'] ?? 'terraform') as 'terraform' | 'kubernetes' | 'cloudformation' | 'pulumi' | 'ansible' | 'custom',
            outputPath: parsed.options['output'],
          },
          options
        );
        break;

      case 'diligence':
        result = await executeDiligenceCommand(
          {
            refs: JSON.parse(parsed.positionalArgs[0] ?? '[]'),
            frameworks: (parsed.options['frameworks'] ?? 'SOC2').split(',') as ('SOC2' | 'HIPAA' | 'GDPR' | 'PCI-DSS' | 'custom')[],
            requirements: parsed.options['requirements'] ? JSON.parse(parsed.options['requirements']) : undefined,
          },
          options
        );
        break;

      default:
        console.error(`Unknown command: ${parsed.command}`);
        console.error(`Supported commands: ${SUPPORTED_COMMANDS.join(', ')}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
    }

    // Output result
    const output = renderer.renderReference(result.reference, {
      format: options.format ?? 'json',
      pretty: parsed.flags['pretty'] ?? true,
    });
    console.log(output);

    // Verbose timing output
    if (options.verbose) {
      console.error(`Completed in ${result.timing}ms`);
    }

    process.exit(EXIT_CODES.SUCCESS);
  } catch (error) {
    // Handle errors
    const errorInfo = errorHandler.handle(
      error instanceof Error ? error : new Error(String(error)),
      { command: parsed.command, correlationId: options.trace_id }
    );

    const formatted = renderer.renderError(errorInfo, {
      format: options.format ?? 'text',
      pretty: true,
      includeStack: options.verbose,
    });
    console.error(formatted);

    // Exit with appropriate code
    if (error instanceof CLIError) {
      process.exit(error.exitCode);
    }
    process.exit(EXIT_CODES.GENERAL_ERROR);
  }
}

// ============================================================================
// Help Output
// ============================================================================

function printHelp(): void {
  console.log(`
agentics - CLI for the Agentics Platform

USAGE:
  agentics <command> [options] [arguments]

COMMANDS:
  plan        Create a simulation plan from manifest
  simulate    Execute a simulation from a plan
  deploy      Resolve deployment intent from simulation
  export      Generate deployment artifacts
  diligence   Package compliance artifacts
  version     Show version information
  help        Show this help message

GLOBAL OPTIONS:
  --timeout <ms>     Request timeout in milliseconds
  --trace-id <id>    Correlation ID for tracing
  --format <fmt>     Output format: json, yaml, table, text, csv
  --verbose, -v      Enable verbose output
  --pretty           Pretty-print output
  --help, -h         Show help

EXAMPLES:
  agentics plan "production-deployment"
  agentics simulate '{"id":"plan-123",...}' --iterations 10
  agentics deploy '{"id":"sim-456",...}' --environment staging
  agentics export '{"id":"intent-789",...}' --export-format terraform
  agentics diligence '[{"id":"ref-1"},...]' --frameworks SOC2,HIPAA

For more information, visit: https://docs.agentics.org/cli
`);
}

// ============================================================================
// Entry Point
// ============================================================================

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(EXIT_CODES.INTERNAL_CLI_ERROR);
});
