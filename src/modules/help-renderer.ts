/**
 * Help Renderer — Auto-Generated from ADR-001
 *
 * This module renders CLI help output directly from the command registry
 * defined in adr-command-semantics.ts. No hand-maintained help strings.
 *
 * The ADR is the single source of truth for:
 * - Command descriptions
 * - Argument names and types
 * - Synthesis classification
 * - Examples
 */

import {
  COMMAND_REGISTRY,
  getSubcommands,
  lookupCommand,
  type CommandSpec,
  type SynthesisClass,
} from '../contracts/adr-command-semantics.js';

// ============================================================================
// Help Rendering
// ============================================================================

/**
 * Render the top-level help screen.
 */
export function renderHelp(): string {
  const lines: string[] = [];

  lines.push('Agentics CLI — Enterprise Orchestration Platform');
  lines.push('');
  lines.push('USAGE:');
  lines.push('  agentics <command> [subcommand] [args] [options]');
  lines.push('');
  lines.push('COMMANDS:');

  // Group commands by primary
  const groups = groupByPrimary();

  for (const [primary, specs] of groups) {
    const mainSpec = specs.find(s => !s.subcommand) ?? specs[0]!;
    const label = primary.padEnd(14);
    const desc = mainSpec.description;
    const tag = formatSynthesisTag(mainSpec.synthesis);
    lines.push(`  ${label} ${desc} ${tag}`);
  }

  lines.push('');
  lines.push('ARGUMENT TYPES:');
  lines.push('  <id>            Stable identifier (lowercase, hyphenated, or UUID)');
  lines.push('  "<description>" Quoted natural language (seeds synthesis)');
  lines.push('  latest          Read-only selector keyword');
  lines.push('');
  lines.push('SYNTHESIS TAGS:');
  lines.push('  [synth]     Command invokes LLM synthesis');
  lines.push('  [commit]    Irreversible command (requires ID + confirmation)');
  lines.push('  (unmarked)  Read-only or identity command, no synthesis');
  lines.push('');
  lines.push('GLOBAL OPTIONS:');
  lines.push('  --verbose       Enable verbose output');
  lines.push('  --format <fmt>  Output format: json | yaml | text');
  lines.push('  --help          Show help for a specific command');
  lines.push('');
  lines.push('Run `agentics <command> --help` for command-specific help.');

  return lines.join('\n');
}

/**
 * Render help for a specific command (including all its subcommands).
 */
export function renderCommandHelp(primary: string): string {
  const specs = getSubcommands(primary);
  if (specs.length === 0) {
    return `Unknown command: ${primary}\n\nRun \`agentics help\` to see available commands.`;
  }

  const lines: string[] = [];

  lines.push(`agentics ${primary} — ${specs[0]!.description}`);
  lines.push('');

  if (specs.length === 1 && !specs[0]!.subcommand) {
    // Single command, no subcommands
    lines.push(...renderSpecDetail(specs[0]!));
  } else {
    lines.push('SUBCOMMANDS:');
    lines.push('');

    for (const spec of specs) {
      if (spec.subcommand) {
        lines.push(...renderSpecDetail(spec));
        lines.push('');
      }
    }

    // Also show main command if it has args
    const mainSpec = specs.find(s => !s.subcommand);
    if (mainSpec !== undefined && mainSpec.args.length > 0) {
      lines.push('DEFAULT (no subcommand):');
      lines.push(...renderSpecDetail(mainSpec));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Render help for a specific command + subcommand.
 */
export function renderSubcommandHelp(primary: string, subcommand: string): string {
  const spec = lookupCommand(primary, subcommand);
  if (!spec) {
    return `Unknown subcommand: ${primary} ${subcommand}\n\n` +
           `Run \`agentics ${primary} --help\` to see available subcommands.`;
  }

  const lines: string[] = [];
  lines.push(`agentics ${spec.command}`);
  lines.push('');
  lines.push(...renderSpecDetail(spec));
  return lines.join('\n');
}

// ============================================================================
// Internal Rendering Helpers
// ============================================================================

function renderSpecDetail(spec: CommandSpec): string[] {
  const lines: string[] = [];
  const tag = formatSynthesisTag(spec.synthesis);
  const subcmd = spec.subcommand ?? '';

  lines.push(`  ${subcmd.padEnd(12)} ${spec.description} ${tag}`);

  if (spec.args.length > 0) {
    const usage = spec.args
      .map(a => a.required ? `<${a.name}>` : `[${a.name}]`)
      .join(' ');
    lines.push(`               Usage: agentics ${spec.command} ${usage}`);

    for (const arg of spec.args) {
      const typeLabel = formatArgumentTypeLabel(arg.type);
      lines.push(`               ${`<${arg.name}>`.padEnd(20)} ${typeLabel}  ${arg.description}`);
      lines.push(`               ${''.padEnd(20)} Example: ${arg.example}`);
    }
  }

  if (spec.irreversible) {
    lines.push(`               WARNING: This command is irreversible.`);
  }
  if (spec.requiresConfirmation) {
    lines.push(`               Requires explicit confirmation (--force or interactive).`);
  }

  return lines;
}

function formatSynthesisTag(synthesis: SynthesisClass): string {
  switch (synthesis) {
    case 'SYNTHESIS_REQUIRED':
      return '[synth]';
    case 'COMMITMENT_GRADE':
      return '[commit]';
    case 'SYNTHESIS_FORBIDDEN':
      return '';
  }
}

function formatArgumentTypeLabel(type: string): string {
  switch (type) {
    case 'ID':
      return '(ID)';
    case 'NATURAL_LANGUAGE':
      return '(text)';
    case 'SELECTOR':
      return '(selector)';
    default:
      return '';
  }
}

function groupByPrimary(): Map<string, CommandSpec[]> {
  const groups = new Map<string, CommandSpec[]>();
  for (const spec of COMMAND_REGISTRY) {
    const existing = groups.get(spec.primary) ?? [];
    existing.push(spec);
    groups.set(spec.primary, existing);
  }
  return groups;
}
