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
import { executeInspectCommand } from '../commands/inspect.js';
import { executeQuantifyCommand } from '../commands/quantify.js';
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

      case 'inspect':
        result = await executeInspectCommand(
          {
            simRef: JSON.parse(parsed.positionalArgs[0] ?? '{}'),
            outputType: (parsed.options['output-type'] ?? 'summary') as 'metrics' | 'logs' | 'state' | 'events' | 'summary' | 'full',
          },
          options
        );
        break;

      case 'quantify':
        result = await executeQuantifyCommand(
          {
            simRef: JSON.parse(parsed.positionalArgs[0] ?? '{}'),
            reportType: (parsed.options['report-type'] ?? 'cfo-grade') as 'executive-summary' | 'detailed-analysis' | 'cfo-grade' | 'custom',
            params: parsed.options['params'] ? JSON.parse(parsed.options['params']) : undefined,
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

WORKFLOW:
  The recommended end-to-end workflow follows these steps:

  plan → simulate → inspect → quantify → deploy → export

  1. plan      - Create a simulation plan from org manifest
  2. simulate  - Execute simulation via agentics-simulation-runner
  3. inspect   - Retrieve deterministic outputs from simulation-engine
  4. quantify  - Generate CFO-grade ROI analysis (optional)
  5. deploy    - Resolve deployment intent from simulation
  6. export    - Generate deployment artifacts (terraform, k8s, etc.)

COMMANDS:
  plan        Create a simulation plan from manifest
              Uses: agentics-simulation-planner
  simulate    Execute a simulation from a plan
              Uses: agentics-simulation-runner → agentics-simulation-engine
  inspect     Retrieve simulation outputs and artifacts
              Uses: agentics-simulation-engine
  quantify    Generate ROI/financial impact analysis
              Uses: enterprise-roi-engine
  deploy      Resolve deployment intent from simulation
              Uses: agentics-deployment-intent
  export      Generate deployment artifacts
              Uses: agentics-deployment-exporters
  diligence   Package compliance artifacts
              Uses: diligence-artifacts
  version     Show version information
  help        Show this help message

GLOBAL OPTIONS:
  --timeout <ms>     Request timeout in milliseconds
  --trace-id <id>    Correlation ID for tracing
  --format <fmt>     Output format: json, yaml, table, text, csv
  --verbose, -v      Enable verbose output
  --pretty           Pretty-print output
  --help, -h         Show help

COMMAND OPTIONS:
  plan:
    --params <json>          Parameters for plan creation

  simulate:
    --config <json>          Runtime configuration
    --iterations <n>         Number of iterations (default: 1)

  inspect:
    --output-type <type>     Output type: metrics, logs, state, events, summary, full
                             (default: summary)

  quantify:
    --report-type <type>     Report type: executive-summary, detailed-analysis,
                             cfo-grade, custom (default: cfo-grade)
    --params <json>          Additional parameters for ROI calculation

  deploy:
    --spec <json>            Intent specification
    --environment <env>      Target environment

  export:
    --export-format <fmt>    Format: terraform, kubernetes, cloudformation,
                             pulumi, ansible, custom (default: terraform)
    --output <path>          Output path for artifacts

  diligence:
    --frameworks <list>      Comma-separated: SOC2, HIPAA, GDPR, PCI-DSS, custom
    --requirements <json>    Custom requirements

EXAMPLES:
  # Complete workflow example
  agentics plan "production-deployment"
  agentics simulate '{"id":"plan-123",...}' --iterations 10
  agentics inspect '{"id":"sim-456",...}' --output-type metrics
  agentics quantify '{"id":"sim-456",...}' --report-type cfo-grade
  agentics deploy '{"id":"sim-456",...}' --environment staging
  agentics export '{"id":"intent-789",...}' --export-format terraform
  agentics diligence '[{"id":"ref-1"},...]' --frameworks SOC2,HIPAA

ENVIRONMENT VARIABLES:
  AGENTICS_MANIFESTS_URL         Override manifests service URL
  AGENTICS_PLANNER_URL           Override planner service URL
  AGENTICS_RUNNER_URL            Override runner service URL
  AGENTICS_SIMULATION_ENGINE_URL Override simulation engine URL
  ENTERPRISE_ROI_ENGINE_URL      Override ROI engine URL
  AGENTICS_INTENT_URL            Override intent service URL
  AGENTICS_EXPORTERS_URL         Override exporters service URL
  DILIGENCE_URL                  Override diligence service URL

PLATFORM UI:
  For API key management and interactive workflows, visit:
  https://platform.agentics.org

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
