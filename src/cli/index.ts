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

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandParser, SUPPORTED_COMMANDS } from '../modules/command-parser.js';
import { createOutputRenderer } from '../modules/output-renderer.js';
import { CLIError, errorHandler, toError } from '../errors/index.js';
import { LocalhostInProductionError } from '../config/endpoints.js';
import { EXIT_CODES, parseFlexibleInput, isNaturalLanguage } from '../types/index.js';
import type { CommandOptions, OutputFormat, BaseReference, PlanReference, SimulationReference, IntentReference } from '../types/index.js';

// ============================================================================
// Executive Synthesis Integration
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Invoke executive synthesis tool after command output.
 * Runs in a detached process so it survives parent exit.
 * Inherits environment variables for API keys.
 *
 * @param jsonOutput - The JSON output from the command
 * @param objective - The user's intent/objective
 * @param commandName - The command name (e.g., 'simulate', 'plan', 'quantify')
 */
function invokeExecutiveSynthesis(jsonOutput: string, objective: string, commandName: string): void {
  try {
    const synthesisToolPath = path.resolve(__dirname, '../../tools/executive-synthesis/dist/index.js');

    // Check if the synthesis tool exists before trying to spawn it
    if (!fs.existsSync(synthesisToolPath)) {
      return;
    }

    const child = spawn('node', [
      synthesisToolPath,
      '--objective', objective,
      '--command', `agentics ${commandName}`,
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
      detached: true,
    });

    child.stdin?.write(jsonOutput);
    child.stdin?.end();
    child.unref();
  } catch {
    // Tool not available or spawn failed, silently skip
  }
}

// Import command executors
import { executeLoginCommand } from '../commands/login.js';
import { executeWhoamiCommand, formatWhoamiForDisplay } from '../commands/whoami.js';
import { executeLogoutCommand, formatLogoutForDisplay } from '../commands/logout.js';
import {
  executePlanCommand,
  executePlanListCommand,
  executePlanCreateCommand,
  executePlanInspectCommand,
  executePlanDeleteCommand,
  executePlanApproveCommand,
  formatPlansListForDisplay,
  formatPlanForDisplay,
} from '../commands/plan.js';
import {
  executeSimulateCommand,
  executeSimulateListCommand,
  executeSimulateCreateCommand,
  executeSimulateInspectCommand,
  executeSimulateDeleteCommand,
  executeSimulateRunCommand,
  formatSimulationsListForDisplay,
  formatSimulationForDisplay,
} from '../commands/simulate.js';
import {
  executeInspectCommand,
  executeInspectLatestCommand,
  executeInspectRunCommand,
  executeInspectArtifactsCommand,
  formatResultsForDisplay,
  formatArtifactsForDisplay,
} from '../commands/inspect.js';
import {
  executeQuantifyCommand,
  executeQuantifyCreateCommand,
  executeQuantifyListCommand,
  executeQuantifyInspectCommand,
  executeQuantifyDeleteCommand,
  executeQuantifyCompareCommand,
  formatQuantifyForDisplay,
  formatQuantifyListForDisplay,
  formatCompareForDisplay,
} from '../commands/quantify.js';
import {
  executeDeployCommand,
  executeDeployPreviewCommand,
  executeDeployRunCommand,
  executeDeployStatusCommand,
  executeDeployRollbackCommand,
  executeDeployListCommand,
  formatDeployForDisplay,
  formatDeployListForDisplay,
} from '../commands/deploy.js';
import {
  executeExportCommand,
  executeExportTerraformCommand,
  executeExportKubernetesCommand,
  executeExportErpCommand,
  formatExportForDisplay,
} from '../commands/export.js';
import { executeDiligenceCommand } from '../commands/diligence.js';
import {
  executeUsageCommand,
  executeUsageHistoryCommand,
  executeUsageLimitsCommand,
  executeUsageResetCommand,
  formatUsageForDisplay,
  formatHistoryForDisplay,
  formatLimitsForDisplay,
} from '../commands/usage.js';
import {
  executePolicyListCommand,
  executePolicyInspectCommand,
  executePolicyCreateCommand,
  executePolicyEditCommand,
  executePolicyDeleteCommand,
  executePolicyEnableCommand,
  executePolicyDisableCommand,
  executePolicyDryRunCommand,
  executePolicyScopeCommand,
  formatPolicyForDisplay,
  formatPoliciesListForDisplay,
  formatDryRunForDisplay,
  formatScopeForDisplay,
} from '../commands/policy.js';
import {
  executeErpListCommand,
  executeErpInspectCommand,
  executeErpSurfaceCommand,
  executeErpMapCommand,
  executeErpExportCommand,
  formatErpListForDisplay,
  formatErpInspectForDisplay,
  formatErpSurfaceForDisplay,
  formatErpMapForDisplay,
  formatErpExportForDisplay,
} from '../commands/erp.js';

// ============================================================================
// CONTROL PLANE HARDENING GATES
// ============================================================================
// Gates are enforced in this order:
// 1. Auth Session Gate - Requires authenticated session
// 2. Service Health Gate - Validates Ruvector-backed service availability
// 3. Output Format Gate - Enforces strict JSON output
// 4. Execution Gate - Entitlement/kill-switch (existing)
//
// CRITICAL: CLI MUST fail loudly if any gate fails. No fallback behavior.
// ============================================================================

// Execution Gate - HARD KILL-SWITCH
import { enforceExecutionGate } from '../gates/execution-gate.js';

// Auth Session Gate - Requires authenticated session
import { enforceAuthSessionGate, requiresAuthentication } from '../gates/auth-session-gate.js';

// Service Health Gate - Validates Ruvector-backed services
import { enforceServiceHealthGate, requiresHealthCheck } from '../gates/service-health-gate.js';

// Output Format Gate - Enforces strict JSON output
import { enforceOutputFormatGate, requiresStructuredOutput, getDefaultFormat } from '../gates/output-format-gate.js';

// Argument Guard Gate - Validates argument types per ADR-001
import { enforceArgumentGuard, requiresArgumentValidation } from '../gates/argument-guard.js';

// Lineage Gate - Enforces simulation traceability per ADR-004
import { enforceLineageGate, requiresLineageValidation } from '../gates/lineage-gate.js';

// Help Renderer - Schema-driven help from COMMAND_REGISTRY (ADR-002 Decision 1)
import { renderHelp } from '../modules/help-renderer.js';

// Synthesis Router - ADR-006/007/008 Claude Code integration
import { routeSynthesis, isDecisionGrade } from '../synthesis/router.js';
import { createArtifactWriter } from '../synthesis/artifact-writer.js';
import type { SynthesisResult } from '../contracts/adr-007-subcommand-synthesis-router.js';
import type { PlatformReceipt, RunManifest } from '../contracts/adr-008-synthesis-artifact-persistence.js';
import { lookupCommand } from '../contracts/adr-command-semantics.js';

// ============================================================================
// Synthesis Artifact Persistence (ADR-008)
// ============================================================================

/**
 * Persist synthesis artifacts after a successful synthesis + platform handoff.
 * Writes manifest, claude output, platform receipt, and prompt to ~/.agentics/runs/<run-id>/.
 */
function persistSynthesisArtifacts(
  synthesis: SynthesisResult,
  receipt: PlatformReceipt,
  prompt: string,
  userContext: { userId: string; orgId: string; traceId: string },
): string {
  const spec = lookupCommand(synthesis.command, synthesis.subcommand);
  const manifest: RunManifest = {
    run_id: synthesis.runId,
    command: synthesis.command,
    subcommand: synthesis.subcommand,
    synthesis_class: spec?.synthesis === 'COMMITMENT_GRADE' ? 'COMMITMENT_GRADE' : 'SYNTHESIS_REQUIRED',
    contract_schema: synthesis.contractSchema,
    model: synthesis.model,
    duration_ms: synthesis.durationMs,
    created_at: new Date().toISOString(),
    seed: 0,
    user_id: userContext.userId,
    org_id: userContext.orgId,
    trace_id: userContext.traceId,
    artifacts: ['manifest.json', 'claude_output.json', 'platform_receipt.json', 'prompt.txt'],
  };

  const writer = createArtifactWriter();
  const writeResult = writer.write({
    manifest,
    claudeOutput: synthesis.data,
    platformReceipt: receipt,
    prompt,
  });
  return writeResult.runDir;
}

// ============================================================================
// CLI Version
// ============================================================================

const VERSION = '1.4.5';

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

  // ============================================================================
  // CONTROL PLANE HARDENING - Multi-Gate Enforcement
  // ============================================================================
  // Gates are enforced in strict order. Each gate MUST pass before proceeding.
  // Failure at any gate results in immediate process exit with clear error.
  //
  // Gate 1: Execution Gate (kill-switch)
  // Gate 2: Authentication Gate (session required)
  // Gate 3: Service Health Gate (Ruvector availability)
  // Gate 4: Output Format Gate (strict JSON enforcement)
  // Gate 5: Argument Guard Gate (ADR-001 argument type validation)
  // Gate 6: Lineage Gate (ADR-004 simulation traceability)
  // ============================================================================

  // ============================================================================
  // GATE 1: HARD EXECUTION GATE - Enforced before ANY command dispatch
  // ============================================================================
  // This is a global kill-switch that blocks all operational commands unless
  // execution is explicitly enabled. Only identity/help commands are allowed
  // when execution is disabled. This gate does NOT check entitlements, usage,
  // or billing - it is a binary on/off switch.
  enforceExecutionGate(parsed.command);

  // ============================================================================
  // GATE 2: AUTHENTICATION SESSION GATE - Requires valid credentials
  // ============================================================================
  // CLI requires authenticated session for ALL operational commands.
  // Checks platform credentials first, then falls back to GCP credentials.
  // CRITICAL: No anonymous operations are permitted.
  if (requiresAuthentication(parsed.command)) {
    await enforceAuthSessionGate();
  }

  // ============================================================================
  // GATE 3: SERVICE HEALTH GATE - Validates Ruvector-backed services
  // ============================================================================
  // CLI MUST validate that Ruvector service is healthy before any operation.
  // This ensures all operations are properly persisted and verifiable.
  // CRITICAL: Abort immediately if service health check fails.
  if (requiresHealthCheck(parsed.command)) {
    await enforceServiceHealthGate();
  }

  // ============================================================================
  // GATE 4: OUTPUT FORMAT GATE - Enforces strict JSON output
  // ============================================================================
  // CLI enforces strict JSON output for operational commands.
  // Narrative output formats (text, table, csv) are blocked.
  // CRITICAL: Only json and yaml formats are permitted.
  if (requiresStructuredOutput(parsed.command)) {
    const validatedFormat = enforceOutputFormatGate(options.format, parsed.command);
    options.format = validatedFormat;
  } else {
    // For non-operational commands, use default format
    options.format = options.format ?? getDefaultFormat(parsed.command);
  }

  // ============================================================================
  // GATE 5: ARGUMENT GUARD - Validates argument types per ADR-001
  // ============================================================================
  // Enforces ID vs natural language rules, blocks forbidden synthesis,
  // and validates required arguments before any command dispatch.
  // Derived from the ADR command registry (adr-command-semantics.ts).
  if (requiresArgumentValidation(parsed.command)) {
    enforceArgumentGuard(parsed);
  }

  // ============================================================================
  // GATE 6: LINEAGE GATE - Enforces simulation traceability (ADR-004)
  // ============================================================================
  // Enterprise artifact-producing commands (erp surface, erp map, erp export)
  // must reference a governed simulation. This ensures every integration
  // proposal and ERP mapping traces back to a simulation run.
  // CRITICAL: No enterprise artifact without simulation lineage.
  if (requiresLineageValidation(parsed.command, parsed.subcommand)) {
    enforceLineageGate(parsed);
  }

  // Dispatch to command handlers
  try {
    let result: { reference: BaseReference; timing: number } | null = null;
    // Track objectives for executive synthesis artifact generation
    let executiveArtifact: { objective: string; command: string } | null = null;

    switch (parsed.command) {
      case 'login': {
        const loginResult = await executeLoginCommand(
          {
            noBrowser: parsed.flags['no-browser'] ?? false,
          },
          options
        );
        // Login command outputs its own messages, just exit successfully
        if (loginResult.success) {
          process.exit(EXIT_CODES.SUCCESS);
        } else {
          process.exit(EXIT_CODES.AUTH_ERROR);
        }
        break;
      }

      case 'whoami': {
        const whoamiResult = await executeWhoamiCommand();
        if (options.format === 'json') {
          console.log(JSON.stringify(whoamiResult, null, parsed.flags['pretty'] ? 2 : 0));
        } else {
          console.log(formatWhoamiForDisplay(whoamiResult));
        }
        process.exit(EXIT_CODES.SUCCESS);
        break;
      }

      case 'logout': {
        const logoutResult = await executeLogoutCommand();
        if (options.format === 'json') {
          console.log(JSON.stringify(logoutResult, null, parsed.flags['pretty'] ? 2 : 0));
        } else {
          console.log(formatLogoutForDisplay(logoutResult));
        }
        process.exit(logoutResult.success ? EXIT_CODES.SUCCESS : EXIT_CODES.GENERAL_ERROR);
        break;
      }

      case 'plan': {
        // Handle subcommands: list, create, inspect, delete, approve
        if (parsed.subcommand === 'list') {
          const planListResult = await executePlanListCommand(
            {
              status: parsed.options['status'] as 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'archived' | undefined,
              limit: parsed.options['limit'] ? parseInt(parsed.options['limit'], 10) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              plans: planListResult.plans,
              count: planListResult.count,
              timing: planListResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatPlansListForDisplay(planListResult.plans));
          }

          if (options.verbose) {
            console.error(`Query completed in ${planListResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'create') {
          const planName = parsed.options['name'] ?? parsed.positionalArgs[0] ?? '';
          const planCreateResult = await executePlanCreateCommand(
            {
              name: planName,
              description: parsed.options['description'],
              manifest_query: parsed.options['manifest-query'],
              metadata: parsed.options['metadata'] ? JSON.parse(parsed.options['metadata']) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              plan: planCreateResult.plan,
              timing: planCreateResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Plan created: ${planCreateResult.plan.id}`);
            console.log(formatPlanForDisplay(planCreateResult.plan));
          }

          if (options.verbose) {
            console.error(`Created in ${planCreateResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'inspect') {
          const planId = parsed.positionalArgs[0] ?? '';
          const planInspectResult = await executePlanInspectCommand({ id: planId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              plan: planInspectResult.plan,
              found: planInspectResult.found,
              timing: planInspectResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (planInspectResult.found && planInspectResult.plan) {
              console.log(formatPlanForDisplay(planInspectResult.plan));
            } else {
              console.log(`Plan not found: ${planId}`);
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${planInspectResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'delete') {
          const planId = parsed.positionalArgs[0] ?? '';
          const planDeleteResult = await executePlanDeleteCommand({ id: planId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              deleted: planDeleteResult.deleted,
              id: planDeleteResult.id,
              timing: planDeleteResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Plan deleted: ${planDeleteResult.id}`);
          }

          if (options.verbose) {
            console.error(`Deleted in ${planDeleteResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'approve') {
          const planId = parsed.positionalArgs[0] ?? '';
          const planApproveResult = await executePlanApproveCommand(
            {
              id: planId,
              approved_by: parsed.options['approved-by'],
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              plan: planApproveResult.plan,
              previous_status: planApproveResult.previous_status,
              advisory: planApproveResult.advisory,
              timing: planApproveResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Plan approved: ${planApproveResult.plan.id}`);
            console.log(`  Previous status: ${planApproveResult.previous_status}`);
            console.log(`  New status: ${planApproveResult.plan.status}`);
            console.log(`  Approved by: ${planApproveResult.plan.approved_by ?? 'cli-user'}`);
          }

          if (options.verbose) {
            console.error(`Approved in ${planApproveResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Default plan behavior (create plan via orchestration)
        const planInput = parsed.subcommand ?? parsed.positionalArgs[0] ?? '';
        result = await executePlanCommand(
          {
            manifestQuery: planInput,
            params: parsed.options['params'] ? JSON.parse(parsed.options['params']) : undefined,
          },
          options
        );
        // Track objective for executive synthesis
        executiveArtifact = { objective: planInput, command: 'plan' };
        break;
      }

      case 'simulate': {
        // Handle subcommands: list, create, inspect, delete, run
        if (parsed.subcommand === 'list') {
          const simListResult = await executeSimulateListCommand(
            {
              status: parsed.options['status'] as 'running' | 'completed' | 'failed' | 'pending' | undefined,
              limit: parsed.options['limit'] ? parseInt(parsed.options['limit'], 10) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              simulations: simListResult.simulations,
              count: simListResult.count,
              timing: simListResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatSimulationsListForDisplay(simListResult.simulations));
          }

          if (options.verbose) {
            console.error(`Query completed in ${simListResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'create') {
          const simName = parsed.options['name'] ?? parsed.positionalArgs[0] ?? '';

          // ================================================================
          // ADR-006/007/008: Claude Code Synthesis Integration
          // ================================================================
          // For decision-grade subcommands, run synthesis BEFORE the command
          // executor. Claude Code produces the structured plan/intent, which
          // is then passed to the platform for execution.
          // ================================================================
          if (isDecisionGrade(parsed.command, parsed.subcommand)) {
            const synthesisResult = routeSynthesis({
              command: parsed.command,
              subcommand: parsed.subcommand ?? '',
              positionalArgs: parsed.positionalArgs,
              options: parsed.options,
              flags: parsed.flags,
              userContext: {
                userId: 'cli-user',
                orgId: 'cli-org',
                traceId: options.trace_id ?? crypto.randomUUID(),
              },
            });

            if (synthesisResult) {
              // Create the simulation using the synthesis output as metadata
              const simCreateResult = await executeSimulateCreateCommand(
                {
                  name: simName,
                  description: parsed.options['description'],
                  plan_id: parsed.options['plan-id'],
                  iterations: parsed.options['iterations'] ? parseInt(parsed.options['iterations'], 10) : undefined,
                  metadata: {
                    ...(parsed.options['metadata'] ? JSON.parse(parsed.options['metadata']) : {}),
                    synthesis_run_id: synthesisResult.runId,
                    synthesis_model: synthesisResult.model,
                  },
                },
                options
              );

              // Persist synthesis artifacts (ADR-008)
              const receipt: PlatformReceipt = {
                success: true,
                platform_id: simCreateResult.simulation.id,
                platform_type: 'SimulationReference',
                status: simCreateResult.simulation.status,
                timestamp: new Date().toISOString(),
                trace_id: options.trace_id ?? '',
              };

              const runDir = persistSynthesisArtifacts(
                synthesisResult,
                receipt,
                `[prompt for ${parsed.command} ${parsed.subcommand}]`,
                {
                  userId: 'cli-user',
                  orgId: 'cli-org',
                  traceId: options.trace_id ?? '',
                },
              );

              if (options.format === 'json') {
                console.log(JSON.stringify({
                  simulation: simCreateResult.simulation,
                  synthesis: {
                    run_id: synthesisResult.runId,
                    model: synthesisResult.model,
                    duration_ms: synthesisResult.durationMs,
                    artifacts_dir: runDir,
                  },
                  timing: simCreateResult.timing,
                }, null, parsed.flags['pretty'] ? 2 : 0));
              } else {
                console.log(`Simulation created: ${simCreateResult.simulation.id}`);
                console.log(`Synthesis run: ${synthesisResult.runId}`);
                console.log(formatSimulationForDisplay(simCreateResult.simulation));
              }

              if (options.verbose) {
                console.error(`Created in ${simCreateResult.timing}ms (synthesis: ${synthesisResult.durationMs}ms)`);
                console.error(`Artifacts: ${runDir}`);
              }
              process.exit(EXIT_CODES.SUCCESS);
            }
          }

          // Fallback: no synthesis (Claude Code not available or not decision-grade)
          const simCreateResult = await executeSimulateCreateCommand(
            {
              name: simName,
              description: parsed.options['description'],
              plan_id: parsed.options['plan-id'],
              iterations: parsed.options['iterations'] ? parseInt(parsed.options['iterations'], 10) : undefined,
              metadata: parsed.options['metadata'] ? JSON.parse(parsed.options['metadata']) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              simulation: simCreateResult.simulation,
              timing: simCreateResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Simulation created: ${simCreateResult.simulation.id}`);
            console.log(formatSimulationForDisplay(simCreateResult.simulation));
          }

          if (options.verbose) {
            console.error(`Created in ${simCreateResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'inspect') {
          const simId = parsed.positionalArgs[0] ?? '';
          const simInspectResult = await executeSimulateInspectCommand({ id: simId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              simulation: simInspectResult.simulation,
              found: simInspectResult.found,
              timing: simInspectResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (simInspectResult.found && simInspectResult.simulation) {
              console.log(formatSimulationForDisplay(simInspectResult.simulation));
            } else {
              console.log(`Simulation not found: ${simId}`);
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${simInspectResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'delete') {
          const simId = parsed.positionalArgs[0] ?? '';
          const simDeleteResult = await executeSimulateDeleteCommand({ id: simId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              deleted: simDeleteResult.deleted,
              id: simDeleteResult.id,
              timing: simDeleteResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Simulation deleted: ${simDeleteResult.id}`);
          }

          if (options.verbose) {
            console.error(`Deleted in ${simDeleteResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'run') {
          const simId = parsed.positionalArgs[0] ?? '';
          const simRunResult = await executeSimulateRunCommand({ id: simId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              simulation: simRunResult.simulation,
              previous_status: simRunResult.previous_status,
              advisory: simRunResult.advisory,
              timing: simRunResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Simulation: ${simRunResult.simulation.id}`);
            console.log(`  Name:     ${simRunResult.simulation.name}`);
            console.log(`  Status:   ${simRunResult.simulation.status}`);
            if (simRunResult.simulation.result?.summary) {
              console.log(`  Result:   ${simRunResult.simulation.result.summary}`);
            }
          }

          if (options.verbose) {
            console.error(`Run completed in ${simRunResult.timing}ms`);
          }
          process.exit(simRunResult.simulation.status === 'failed' ? EXIT_CODES.GENERAL_ERROR : EXIT_CODES.SUCCESS);
        }

        // Default simulate behavior (execute simulation via orchestration)
        const simInput = parsed.subcommand ?? parsed.positionalArgs[0] ?? '';
        const simFlexibleInput = parseFlexibleInput<PlanReference>(simInput);
        result = await executeSimulateCommand(
          {
            planRef: isNaturalLanguage(simFlexibleInput)
              ? simFlexibleInput  // Pass NL input directly
              : simFlexibleInput as PlanReference,
            config: parsed.options['config'] ? JSON.parse(parsed.options['config']) : undefined,
            iterations: parsed.options['iterations'] ? parseInt(parsed.options['iterations'], 10) : undefined,
          },
          options
        );
        // Track objective for executive synthesis
        executiveArtifact = { objective: simInput, command: 'simulate' };
        break;
      }

      case 'inspect': {
        // Handle subcommands: latest, run <id>
        if (parsed.subcommand === 'latest') {
          const latestResult = await executeInspectLatestCommand(
            {
              environment: parsed.options['environment'] as 'production' | 'staging' | 'development' | 'test' | undefined,
              status: parsed.options['status'] as 'completed' | 'failed' | 'running' | 'pending' | undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              result: latestResult.result,
              found: latestResult.found,
              timing: latestResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (latestResult.found && latestResult.result) {
              console.log(formatResultsForDisplay([latestResult.result]));
            } else {
              console.log('No matching simulation results found.');
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${latestResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'artifacts') {
          const artifactRunId = parsed.positionalArgs[0] ?? '';
          const artifactsResult = await executeInspectArtifactsCommand({ id: artifactRunId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              artifacts: artifactsResult.artifacts,
              run_id: artifactsResult.run_id,
              count: artifactsResult.count,
              found: artifactsResult.found,
              timing: artifactsResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatArtifactsForDisplay(artifactsResult.artifacts, artifactsResult.run_id));
          }

          if (options.verbose) {
            console.error(`Query completed in ${artifactsResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'run') {
          const runId = parsed.positionalArgs[0] ?? '';
          const runResult = await executeInspectRunCommand({ id: runId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              result: runResult.result,
              found: runResult.found,
              timing: runResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (runResult.found && runResult.result) {
              console.log(formatResultsForDisplay([runResult.result]));
            } else {
              console.log(`No simulation result found with ID: ${runId}`);
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${runResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Default inspect behavior (original)
        const inspectInput = parsed.subcommand ?? parsed.positionalArgs[0] ?? '';
        const inspectFlexibleInput = parseFlexibleInput<{ id: string }>(inspectInput);
        const inspectResult = await executeInspectCommand(
          {
            simRef: isNaturalLanguage(inspectFlexibleInput)
              ? inspectFlexibleInput  // Pass NL input directly
              : inspectFlexibleInput as { id: string },
            depth: (parsed.options['depth'] ?? 'summary') as 'summary' | 'detailed' | 'full',
            includeMetrics: parsed.flags['include-metrics'] ?? false,
            includeTraces: parsed.flags['include-traces'] ?? false,
          },
          options
        );

        // Render inspect output based on format
        if (options.format === 'json') {
          console.log(JSON.stringify({
            results: inspectResult.results,
            query: inspectResult.query,
            count: inspectResult.count,
          }, null, parsed.flags['pretty'] ? 2 : 0));
        } else {
          // Human-readable text output for terminal
          console.log(formatResultsForDisplay(inspectResult.results));
        }

        if (options.verbose) {
          console.error(`Query completed in ${inspectResult.timing}ms`);
        }

        process.exit(EXIT_CODES.SUCCESS);
      }

      case 'quantify': {
        // Handle subcommands: create, list, inspect, delete, compare
        if (parsed.subcommand === 'list') {
          const quantifyListResult = await executeQuantifyListCommand(
            {
              status: parsed.options['status'] as 'draft' | 'pending' | 'completed' | 'archived' | undefined,
              limit: parsed.options['limit'] ? parseInt(parsed.options['limit'], 10) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              reports: quantifyListResult.reports,
              count: quantifyListResult.count,
              timing: quantifyListResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatQuantifyListForDisplay(quantifyListResult.reports));
          }

          if (options.verbose) {
            console.error(`Query completed in ${quantifyListResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'create') {
          const quantifyName = parsed.options['name'] ?? parsed.positionalArgs[0] ?? '';
          const quantifyCreateResult = await executeQuantifyCreateCommand(
            {
              name: quantifyName,
              description: parsed.options['description'],
              simulation_id: parsed.options['simulation-id'],
              report_type: (parsed.options['report-type'] ?? 'cfo-grade') as 'executive-summary' | 'cfo-grade' | 'technical-deep-dive' | 'compliance-audit',
              metadata: parsed.options['metadata'] ? JSON.parse(parsed.options['metadata']) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              report: quantifyCreateResult.report,
              timing: quantifyCreateResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`ROI report created: ${quantifyCreateResult.report.id}`);
            console.log(formatQuantifyForDisplay(quantifyCreateResult.report));
          }

          if (options.verbose) {
            console.error(`Created in ${quantifyCreateResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'inspect') {
          const quantifyId = parsed.positionalArgs[0] ?? '';
          const quantifyInspectResult = await executeQuantifyInspectCommand({ id: quantifyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              report: quantifyInspectResult.report,
              found: quantifyInspectResult.found,
              timing: quantifyInspectResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (quantifyInspectResult.found && quantifyInspectResult.report) {
              console.log(formatQuantifyForDisplay(quantifyInspectResult.report));
            } else {
              console.log(`ROI report not found: ${quantifyId}`);
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${quantifyInspectResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'delete') {
          const quantifyId = parsed.positionalArgs[0] ?? '';
          const quantifyDeleteResult = await executeQuantifyDeleteCommand({ id: quantifyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              deleted: quantifyDeleteResult.deleted,
              id: quantifyDeleteResult.id,
              timing: quantifyDeleteResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`ROI report deleted: ${quantifyDeleteResult.id}`);
          }

          if (options.verbose) {
            console.error(`Deleted in ${quantifyDeleteResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'compare') {
          const idA = parsed.positionalArgs[0] ?? '';
          const idB = parsed.positionalArgs[1] ?? '';
          const quantifyCompareResult = await executeQuantifyCompareCommand(
            { idA, idB },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              reportA: quantifyCompareResult.reportA,
              reportB: quantifyCompareResult.reportB,
              comparison: quantifyCompareResult.comparison,
              timing: quantifyCompareResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatCompareForDisplay(quantifyCompareResult));
          }

          if (options.verbose) {
            console.error(`Comparison completed in ${quantifyCompareResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Default quantify behavior (execute via orchestration)
        const quantifyInput = parsed.positionalArgs[0] ?? '';
        const quantifyFlexibleInput = parseFlexibleInput<SimulationReference>(quantifyInput);
        result = await executeQuantifyCommand(
          {
            simRef: isNaturalLanguage(quantifyFlexibleInput)
              ? quantifyFlexibleInput  // Pass NL input directly
              : quantifyFlexibleInput as SimulationReference,
            reportType: (parsed.options['report-type'] ?? 'cfo-grade') as 'executive-summary' | 'cfo-grade' | 'technical-deep-dive' | 'compliance-audit',
          },
          options
        );
        // Track objective for executive synthesis
        executiveArtifact = { objective: quantifyInput, command: 'quantify' };
        break;
      }

      case 'deploy': {
        // Handle subcommands: preview, run, status, rollback, list
        if (parsed.subcommand === 'list') {
          const deployListResult = await executeDeployListCommand(options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              items: deployListResult.items,
              count: deployListResult.count,
              timing: deployListResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatDeployListForDisplay(deployListResult.items));
          }

          if (options.verbose) {
            console.error(`Query completed in ${deployListResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'preview') {
          const targetId = parsed.positionalArgs[0] ?? '';
          const deployPreviewResult = await executeDeployPreviewCommand(
            {
              target_id: targetId,
              environment: parsed.options['environment'] as 'development' | 'staging' | 'production' | undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              result: deployPreviewResult.result,
              timing: deployPreviewResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Deployment preview created: ${deployPreviewResult.result.id}`);
            console.log(formatDeployForDisplay(deployPreviewResult.result));
          }

          if (options.verbose) {
            console.error(`Preview created in ${deployPreviewResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'run') {
          const deploymentId = parsed.positionalArgs[0] ?? '';
          const deployRunResult = await executeDeployRunCommand(
            { deployment_id: deploymentId },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              result: deployRunResult.result,
              advisory: deployRunResult.advisory,
              timing: deployRunResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Deployment run completed: ${deployRunResult.result.id}`);
            console.log(formatDeployForDisplay(deployRunResult.result));
          }

          if (options.verbose) {
            console.error(`Run completed in ${deployRunResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'status') {
          const deploymentId = parsed.positionalArgs[0] ?? '';
          const deployStatusResult = await executeDeployStatusCommand(
            { deployment_id: deploymentId },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              result: deployStatusResult.result,
              found: deployStatusResult.found,
              timing: deployStatusResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (deployStatusResult.found && deployStatusResult.result) {
              console.log(formatDeployForDisplay(deployStatusResult.result));
            } else {
              console.log(`Deployment not found: ${deploymentId}`);
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${deployStatusResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'rollback') {
          const deploymentId = parsed.positionalArgs[0] ?? '';
          const deployRollbackResult = await executeDeployRollbackCommand(
            { deployment_id: deploymentId },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              result: deployRollbackResult.result,
              advisory: deployRollbackResult.advisory,
              timing: deployRollbackResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Deployment rolled back: ${deployRollbackResult.result.id}`);
            console.log(formatDeployForDisplay(deployRollbackResult.result));
          }

          if (options.verbose) {
            console.error(`Rollback completed in ${deployRollbackResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Default deploy behavior (execute via orchestration)
        const deployInput = parsed.positionalArgs[0] ?? '';
        const deployFlexibleInput = parseFlexibleInput<SimulationReference>(deployInput);
        result = await executeDeployCommand(
          {
            simRef: isNaturalLanguage(deployFlexibleInput)
              ? deployFlexibleInput  // Pass NL input directly
              : deployFlexibleInput as SimulationReference,
            environment: parsed.options['environment'] as 'development' | 'staging' | 'production' | undefined,
            dryRun: parsed.flags['dry-run'] ?? false,
            approvalRequired: parsed.flags['approval-required'] ?? false,
          },
          options
        );
        // Track objective for executive synthesis
        executiveArtifact = { objective: deployInput, command: 'deploy' };
        break;
      }

      case 'export': {
        // Handle subcommands: terraform, kubernetes, erp
        if (parsed.subcommand === 'terraform') {
          const targetId = parsed.positionalArgs[0] ?? '';
          const exportTerraformResult = await executeExportTerraformCommand(
            {
              target_id: targetId,
              output_path: parsed.options['output'],
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              export_type: exportTerraformResult.export_type,
              target_id: exportTerraformResult.target_id,
              artifacts: exportTerraformResult.artifacts.map(a => ({ filename: a.filename, type: a.type })),
              output_path: exportTerraformResult.output_path,
              written: exportTerraformResult.written,
              timing: exportTerraformResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatExportForDisplay(exportTerraformResult));
          }

          if (options.verbose) {
            console.error(`Export completed in ${exportTerraformResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'kubernetes') {
          const targetId = parsed.positionalArgs[0] ?? '';
          const exportK8sResult = await executeExportKubernetesCommand(
            {
              target_id: targetId,
              output_path: parsed.options['output'],
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              export_type: exportK8sResult.export_type,
              target_id: exportK8sResult.target_id,
              artifacts: exportK8sResult.artifacts.map(a => ({ filename: a.filename, type: a.type })),
              output_path: exportK8sResult.output_path,
              written: exportK8sResult.written,
              timing: exportK8sResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatExportForDisplay(exportK8sResult));
          }

          if (options.verbose) {
            console.error(`Export completed in ${exportK8sResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'erp') {
          const targetId = parsed.positionalArgs[0] ?? '';
          const exportErpResult = await executeExportErpCommand(
            {
              target_id: targetId,
              output_path: parsed.options['output'],
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              export_type: exportErpResult.export_type,
              target_id: exportErpResult.target_id,
              artifacts: exportErpResult.artifacts.map(a => ({ filename: a.filename, type: a.type })),
              output_path: exportErpResult.output_path,
              written: exportErpResult.written,
              timing: exportErpResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatExportForDisplay(exportErpResult));
          }

          if (options.verbose) {
            console.error(`Export completed in ${exportErpResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Default export behavior (execute via orchestration)
        const exportInput = parsed.positionalArgs[0] ?? '';
        const exportFlexibleInput = parseFlexibleInput<IntentReference>(exportInput);
        result = await executeExportCommand(
          {
            intentRef: isNaturalLanguage(exportFlexibleInput)
              ? exportFlexibleInput  // Pass NL input directly
              : exportFlexibleInput as IntentReference,
            format: (parsed.options['export-format'] ?? 'terraform') as 'terraform' | 'pulumi' | 'cloudformation' | 'kubernetes' | 'helm' | 'json' | 'yaml',
            outputPath: parsed.options['output'],
          },
          options
        );
        break;
      }

      case 'erp': {
        // Handle ERP subcommands: list, inspect, surface, map, export
        if (parsed.subcommand === 'list' || !parsed.subcommand) {
          const erpListResult = await executeErpListCommand(options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              systems: erpListResult.systems,
              count: erpListResult.count,
              repositories_involved: erpListResult.repositories_involved,
              timing: erpListResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatErpListForDisplay(erpListResult.systems));
            console.log(`\nRepositories involved: ${erpListResult.repositories_involved.length}`);
          }

          if (options.verbose) {
            console.error(`Query completed in ${erpListResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'inspect') {
          const systemId = parsed.positionalArgs[0] ?? '';
          const erpInspectResult = await executeErpInspectCommand({ system: systemId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              system: erpInspectResult.system,
              found: erpInspectResult.found,
              repositories_involved: erpInspectResult.repositories_involved,
              timing: erpInspectResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (erpInspectResult.found && erpInspectResult.system) {
              console.log(formatErpInspectForDisplay(erpInspectResult.system));
              console.log(`\nRepositories involved: ${erpInspectResult.repositories_involved.length}`);
            } else {
              console.log(`ERP system not found: ${systemId}`);
              console.log('Available systems: sap, oracle, netsuite, dynamics365, workday, sage');
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${erpInspectResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'surface') {
          const planId = parsed.options['plan'] ?? parsed.positionalArgs[0] ?? '';
          const erpSurfaceResult = await executeErpSurfaceCommand(
            {
              plan_id: planId,
              erp_systems: parsed.options['systems']?.split(',') as ('sap' | 'oracle' | 'netsuite' | 'dynamics365' | 'workday' | 'sage')[] | undefined,
            },
            options
          );

          const erpSurfaceOutput = JSON.stringify({
            analysis: erpSurfaceResult.analysis,
            repositories_involved: erpSurfaceResult.repositories_involved,
            timing: erpSurfaceResult.timing,
          }, null, parsed.flags['pretty'] ? 2 : 0);

          if (options.format === 'json') {
            console.log(erpSurfaceOutput);
          } else {
            console.log(formatErpSurfaceForDisplay(erpSurfaceResult.analysis));
          }

          // Invoke executive synthesis for ERP surface analysis
          invokeExecutiveSynthesis(erpSurfaceOutput, planId || 'ERP surface analysis', 'erp surface');

          if (options.verbose) {
            console.error(`Analysis completed in ${erpSurfaceResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'map') {
          const planId = parsed.positionalArgs[0] ?? '';
          const erpMapResult = await executeErpMapCommand(
            {
              plan_id: planId,
              target_systems: parsed.options['systems']?.split(',') as ('sap' | 'oracle' | 'netsuite' | 'dynamics365' | 'workday' | 'sage')[] | undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              mapping: erpMapResult.mapping,
              repositories_involved: erpMapResult.repositories_involved,
              timing: erpMapResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatErpMapForDisplay(erpMapResult.mapping));
          }

          if (options.verbose) {
            console.error(`Mapping completed in ${erpMapResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'export') {
          const planId = parsed.positionalArgs[0] ?? '';
          const erpExportResult = await executeErpExportCommand(
            {
              plan_id: planId,
              output_path: parsed.options['output'],
              format: (parsed.options['export-format'] ?? 'json') as 'json' | 'yaml',
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              proposal: erpExportResult.proposal,
              artifacts_written: erpExportResult.artifacts_written,
              output_path: erpExportResult.output_path,
              repositories_involved: erpExportResult.repositories_involved,
              timing: erpExportResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatErpExportForDisplay(erpExportResult.proposal));
            if (erpExportResult.artifacts_written) {
              console.log(`\nArtifacts written to: ${erpExportResult.output_path}`);
            }
          }

          if (options.verbose) {
            console.error(`Export completed in ${erpExportResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Unknown ERP subcommand
        console.error(`Unknown ERP subcommand: ${parsed.subcommand}`);
        console.error('Supported subcommands: list, inspect, surface, map, export');
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      case 'diligence': {
        const diligenceInput = parsed.positionalArgs[0] ?? '';
        const diligenceFlexibleInput = parseFlexibleInput<BaseReference[]>(diligenceInput);
        result = await executeDiligenceCommand(
          {
            refs: isNaturalLanguage(diligenceFlexibleInput)
              ? diligenceFlexibleInput  // Pass NL input directly
              : diligenceFlexibleInput as BaseReference[],
            frameworks: (parsed.options['frameworks'] ?? 'SOC2').split(',') as ('SOC2' | 'HIPAA' | 'GDPR' | 'PCI-DSS' | 'ISO27001' | 'FedRAMP' | 'NIST')[],
          },
          options
        );
        // Track objective for executive synthesis
        executiveArtifact = { objective: diligenceInput, command: 'diligence' };
        break;
      }

      case 'usage': {
        // Handle subcommands: history, limits, reset
        if (parsed.subcommand === 'history') {
          const usageHistoryResult = await executeUsageHistoryCommand(
            {
              limit: parsed.options['limit'] ? parseInt(parsed.options['limit'], 10) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              history: usageHistoryResult.history,
              count: usageHistoryResult.count,
              timing: usageHistoryResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatHistoryForDisplay(usageHistoryResult.history));
          }

          if (options.verbose) {
            console.error(`Query completed in ${usageHistoryResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'limits') {
          const usageLimitsResult = await executeUsageLimitsCommand({}, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              limits: usageLimitsResult.limits,
              timing: usageLimitsResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatLimitsForDisplay(usageLimitsResult.limits));
          }

          if (options.verbose) {
            console.error(`Query completed in ${usageLimitsResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'reset') {
          const usageResetResult = await executeUsageResetCommand(
            {
              force: parsed.flags['force'] ?? false,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              reset: usageResetResult.reset,
              previous_usage: usageResetResult.previous_usage,
              advisory: usageResetResult.advisory,
              message: usageResetResult.message,
              timing: usageResetResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Usage reset: ${usageResetResult.reset}`);
            console.log(`Previous usage: ${usageResetResult.previous_usage}`);
            console.log(usageResetResult.message);
          }

          if (options.verbose) {
            console.error(`Reset completed in ${usageResetResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Default usage behavior (check connectivity and balance)
        const usageResult = await executeUsageCommand(options);

        // Render usage output based on format
        if (options.format === 'json') {
          console.log(JSON.stringify({
            connected: usageResult.connected,
            balance: usageResult.balance,
            message: usageResult.message,
            timing: usageResult.timing,
          }, null, parsed.flags['pretty'] ? 2 : 0));
        } else {
          // Human-readable text output for terminal
          console.log(formatUsageForDisplay(usageResult));
        }

        if (options.verbose) {
          console.error(`Query completed in ${usageResult.timing}ms`);
        }

        process.exit(EXIT_CODES.SUCCESS);
      }

      case 'policy': {
        // Handle policy subcommands: list, inspect, create, edit, delete, enable, disable
        if (parsed.subcommand === 'list' || !parsed.subcommand) {
          const policyListResult = await executePolicyListCommand(
            {
              status: parsed.options['status'] as 'enabled' | 'disabled' | 'draft' | undefined,
              type: parsed.options['type'] as 'access-control' | 'rate-limit' | 'cost-limit' | 'compliance' | 'security' | 'custom' | undefined,
              limit: parsed.options['limit'] ? parseInt(parsed.options['limit'], 10) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policies: policyListResult.policies,
              count: policyListResult.count,
              timing: policyListResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatPoliciesListForDisplay(policyListResult.policies));
          }

          if (options.verbose) {
            console.error(`Query completed in ${policyListResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'inspect') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const policyInspectResult = await executePolicyInspectCommand({ id: policyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyInspectResult.policy,
              found: policyInspectResult.found,
              timing: policyInspectResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            if (policyInspectResult.found && policyInspectResult.policy) {
              console.log(formatPolicyForDisplay(policyInspectResult.policy));
            } else {
              console.log(`Policy not found: ${policyId}`);
            }
          }

          if (options.verbose) {
            console.error(`Query completed in ${policyInspectResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'create') {
          const policyName = parsed.options['name'] ?? parsed.positionalArgs[0] ?? '';
          const policyCreateResult = await executePolicyCreateCommand(
            {
              name: policyName,
              description: parsed.options['description'],
              type: parsed.options['type'] as 'access-control' | 'rate-limit' | 'cost-limit' | 'compliance' | 'security' | 'custom' | undefined,
              rules: parsed.options['rules'] ? JSON.parse(parsed.options['rules']) : undefined,
              metadata: parsed.options['metadata'] ? JSON.parse(parsed.options['metadata']) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyCreateResult.policy,
              timing: policyCreateResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Policy created: ${policyCreateResult.policy.id}`);
            console.log(formatPolicyForDisplay(policyCreateResult.policy));
          }

          if (options.verbose) {
            console.error(`Created in ${policyCreateResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'edit') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const policyEditResult = await executePolicyEditCommand(
            {
              id: policyId,
              name: parsed.options['name'],
              description: parsed.options['description'],
              type: parsed.options['type'] as 'access-control' | 'rate-limit' | 'cost-limit' | 'compliance' | 'security' | 'custom' | undefined,
              rules: parsed.options['rules'] ? JSON.parse(parsed.options['rules']) : undefined,
              metadata: parsed.options['metadata'] ? JSON.parse(parsed.options['metadata']) : undefined,
            },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyEditResult.policy,
              timing: policyEditResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Policy updated: ${policyEditResult.policy.id} (v${policyEditResult.policy.version})`);
            console.log(formatPolicyForDisplay(policyEditResult.policy));
          }

          if (options.verbose) {
            console.error(`Updated in ${policyEditResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'delete') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const policyDeleteResult = await executePolicyDeleteCommand({ id: policyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              deleted: policyDeleteResult.deleted,
              id: policyDeleteResult.id,
              timing: policyDeleteResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Policy deleted: ${policyDeleteResult.id}`);
          }

          if (options.verbose) {
            console.error(`Deleted in ${policyDeleteResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'enable') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const policyEnableResult = await executePolicyEnableCommand({ id: policyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyEnableResult.policy,
              previous_status: policyEnableResult.previous_status,
              timing: policyEnableResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Policy enabled: ${policyEnableResult.policy.id}`);
            if (policyEnableResult.previous_status !== 'enabled') {
              console.log(`  Previous status: ${policyEnableResult.previous_status}`);
            }
          }

          if (options.verbose) {
            console.error(`Enabled in ${policyEnableResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'disable') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const policyDisableResult = await executePolicyDisableCommand({ id: policyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyDisableResult.policy,
              previous_status: policyDisableResult.previous_status,
              timing: policyDisableResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(`Policy disabled: ${policyDisableResult.policy.id}`);
            if (policyDisableResult.previous_status !== 'disabled') {
              console.log(`  Previous status: ${policyDisableResult.previous_status}`);
            }
          }

          if (options.verbose) {
            console.error(`Disabled in ${policyDisableResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'dry-run') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const contextStr = parsed.options['context'];
          const context = contextStr ? JSON.parse(contextStr) : undefined;
          const policyDryRunResult = await executePolicyDryRunCommand(
            { id: policyId, context },
            options
          );

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyDryRunResult.policy,
              evaluation: policyDryRunResult.evaluation,
              timing: policyDryRunResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatDryRunForDisplay(policyDryRunResult));
          }

          if (options.verbose) {
            console.error(`Dry-run completed in ${policyDryRunResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        if (parsed.subcommand === 'scope') {
          const policyId = parsed.positionalArgs[0] ?? '';
          const policyScopeResult = await executePolicyScopeCommand({ id: policyId }, options);

          if (options.format === 'json') {
            console.log(JSON.stringify({
              policy: policyScopeResult.policy,
              scope: policyScopeResult.scope,
              timing: policyScopeResult.timing,
            }, null, parsed.flags['pretty'] ? 2 : 0));
          } else {
            console.log(formatScopeForDisplay(policyScopeResult));
          }

          if (options.verbose) {
            console.error(`Scope query completed in ${policyScopeResult.timing}ms`);
          }
          process.exit(EXIT_CODES.SUCCESS);
        }

        // Unknown subcommand
        console.error(`Unknown policy subcommand: ${parsed.subcommand}`);
        console.error('Supported subcommands: list, inspect, create, edit, delete, enable, disable, dry-run, scope');
        process.exit(EXIT_CODES.USAGE_ERROR);
      }

      default:
        console.error(`Unknown command: ${parsed.command}`);
        console.error(`Supported commands: ${SUPPORTED_COMMANDS.join(', ')}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
    }

    // Output result (skip for commands that handle their own output)
    if (result) {
      const output = renderer.renderReference(result.reference, {
        format: options.format ?? 'json',
        pretty: parsed.flags['pretty'] ?? true,
      });
      console.log(output);

      // Invoke executive synthesis for applicable commands
      // This ensures every decision-making command produces an executive artifact
      if (executiveArtifact) {
        invokeExecutiveSynthesis(output, executiveArtifact.objective, executiveArtifact.command);
      }

      // Verbose timing output
      if (options.verbose) {
        console.error(`Completed in ${result.timing}ms`);
      }
    }

    process.exit(EXIT_CODES.SUCCESS);
  } catch (error) {
    // Handle LocalhostInProductionError specially - display the helpful message directly
    if (error instanceof LocalhostInProductionError) {
      console.error(error.message);
      process.exit(EXIT_CODES.CONFIG_ERROR);
    }

    // Handle other errors
    const errorInfo = errorHandler.handle(
      toError(error),
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
  // ADR-002 Decision 1: Help output generated from COMMAND_REGISTRY.
  // See src/modules/help-renderer.ts — all content derives from the schema.
  console.log(renderHelp());
}

// ============================================================================
// Entry Point
// ============================================================================

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(EXIT_CODES.INTERNAL_CLI_ERROR);
});
