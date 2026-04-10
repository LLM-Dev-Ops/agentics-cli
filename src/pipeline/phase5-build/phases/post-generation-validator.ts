/**
 * Phase 5 Build — Stage 7: Post-Generation Code Validator
 *
 * Implements ADR-PIPELINE-065 (which is the implementation spec for the
 * Accepted-but-unimplemented ADR-PIPELINE-042 Post-Generation Code Validation).
 *
 * Unlike `implementation-quality-gate.ts` which is a PRE-generation prompt
 * quality gate (it scans Phase 2 artifacts BEFORE code is generated), this
 * validator scans the GENERATED project tree AFTER all other Phase 5 stages
 * have run. It applies 10 rules that enforce the patterns documented in
 * ADR-PIPELINE-046/047/049/051/059/064 and catches regressions in observability,
 * typed API boundaries, audit trails, and test coverage.
 *
 * Non-blocking by default. When AGENTICS_STRICT_POSTGEN=true, any rule at
 * severity 'error' fails the stage and — per coordinator configuration —
 * can block the pipeline.
 *
 * Error codes:
 *   ECLI-P5-040  Post-generation validation failed (strict mode)
 *   ECLI-P5-041  Generated project directory not found
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Phase5BuildContext, Phase5BuildStage } from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Result Types
// ============================================================================

export interface ValidationFinding {
  readonly ruleId: string;
  readonly filePath: string;       // relative to the project root
  readonly line: number;           // 1-based; 0 = file-level finding
  readonly message: string;
  readonly severity: 'error' | 'warn';
}

export interface PostGenerationReport {
  readonly passed: boolean;
  readonly score: number;          // 0-100
  readonly findings: ValidationFinding[];
  readonly filesScanned: number;
  readonly rulesApplied: number;
  readonly errorCount: number;
  readonly warnCount: number;
  readonly projectDir: string | null;
}

export interface PostGenerationStageOutput {
  readonly stage: 'post-generation-validation';
  readonly status: 'completed' | 'failed';
  readonly timing: number;
  readonly artifacts: string[];
  readonly summary: string;
  readonly data: PostGenerationReport;
}

// ============================================================================
// Rule Framework
// ============================================================================

/**
 * A validation rule. Receives the full file map so rules can do per-file
 * regex scans or cross-file analysis (e.g., route file without sibling test).
 */
export interface GeneratedCodeValidationRule {
  readonly id: string;
  readonly title: string;
  readonly severity: 'error' | 'warn';
  readonly adrReference: string;
  readonly check: (files: ReadonlyMap<string, string>) => ValidationFinding[];
}

// ============================================================================
// File Walking & Helpers
// ============================================================================

const SCAN_EXTENSIONS = new Set(['.ts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next']);

/**
 * Walk a directory recursively and return a map of relative paths → file contents.
 * Safe: ignores unreadable files, caps file size at 1MB to avoid blowup.
 */
function loadProjectFiles(rootDir: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(rootDir)) return files;

  const walk = (currentDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(currentDir, entry.name));
        continue;
      }
      const ext = path.extname(entry.name);
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      const fullPath = path.join(currentDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 1_000_000) continue; // skip files > 1MB
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relPath = path.relative(rootDir, fullPath);
        files.set(relPath, content);
      } catch {
        // skip unreadable
      }
    }
  };

  walk(rootDir);
  return files;
}

/**
 * Convert a character offset into a 1-based line number.
 */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Path predicates used by multiple rules.
 */
function isTestFile(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').toLowerCase();
  return n.endsWith('.test.ts') || n.endsWith('.spec.ts') || n.includes('/tests/') || n.includes('/__tests__/');
}

function isScriptOrDemo(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').toLowerCase();
  return n.includes('/scripts/') || n.includes('/demo') || n.endsWith('/demo.ts');
}

function isServerFile(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').toLowerCase();
  return n.includes('/server/') || n.includes('/routes/') || n.endsWith('/app.ts') || n.endsWith('/api.ts');
}

function isServiceFile(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').toLowerCase();
  return n.includes('/services/') || n.includes('/application/') || n.includes('/domain/services/');
}

function isPublicTypesFile(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').toLowerCase();
  return n.includes('/domain/types/') || n.includes('/contracts/') || n.endsWith('/types.ts');
}

/**
 * Collect all regex matches with line numbers for a per-file scan.
 */
function collectMatches(
  content: string,
  pattern: RegExp,
  filePath: string,
  ruleId: string,
  severity: 'error' | 'warn',
  message: string,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    findings.push({
      ruleId,
      filePath,
      line: lineAt(content, match.index),
      message,
      severity,
    });
    if (match.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  return findings;
}

// ============================================================================
// Rule Definitions — 10 rules per ADR-PIPELINE-065
// ============================================================================

/** PGV-001: No `as string` / `as any` casts on route-handler inputs. */
const RULE_PGV_001: GeneratedCodeValidationRule = {
  id: 'PGV-001',
  title: 'No `as string` / `as any` casts on route handler context or request',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-064',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    // Hono: c.get('x') as string
    const honoPattern = /c\.get\(\s*['"][\w.-]+['"]\s*\)\s*as\s+(?:string|any|unknown|Record<[^>]+>)/g;
    // Express: (req as any).x OR req.headers['x-foo'] as string
    const expressReqPattern = /\(\s*req\s+as\s+any\s*\)/g;
    const expressHeaderPattern = /req\.headers\[['"][^'"]+['"]\]\s*as\s+(?:string|any)/g;

    for (const [filePath, content] of files) {
      if (isTestFile(filePath) || !isServerFile(filePath)) continue;

      findings.push(...collectMatches(
        content, honoPattern, filePath, 'PGV-001', 'error',
        'Cast `as string` on Hono `c.get()` — use typed `Hono<{ Variables: ContextVariables }>` generic (ADR-PIPELINE-064).',
      ));
      findings.push(...collectMatches(
        content, expressReqPattern, filePath, 'PGV-001', 'error',
        'Cast `(req as any)` — declare `declare global { namespace Express { interface Request { ... } } }` (ADR-PIPELINE-064).',
      ));
      findings.push(...collectMatches(
        content, expressHeaderPattern, filePath, 'PGV-001', 'error',
        'Cast `req.headers[\'x-foo\'] as string` — use middleware to parse headers into typed request properties (ADR-PIPELINE-064).',
      ));
    }
    return findings;
  },
};

/** PGV-002: `new Hono()` must be typed with a Variables generic. */
const RULE_PGV_002: GeneratedCodeValidationRule = {
  id: 'PGV-002',
  title: '`new Hono()` must be parameterized with Variables generic',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-064',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    // Match `new Hono(` NOT followed by `<`
    const pattern = /new\s+Hono\s*\((?!\s*<)/g;
    for (const [filePath, content] of files) {
      if (isTestFile(filePath) || !isServerFile(filePath)) continue;
      findings.push(...collectMatches(
        content, pattern, filePath, 'PGV-002', 'error',
        '`new Hono()` without type parameter — use `new Hono<{ Variables: ContextVariables }>()` so `c.get()` returns typed values (ADR-PIPELINE-064).',
      ));
    }
    return findings;
  },
};

/** PGV-003: No hardcoded magic numbers in service files. */
const RULE_PGV_003: GeneratedCodeValidationRule = {
  id: 'PGV-003',
  title: 'No hardcoded magic numbers in service files',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-046',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    // Numbers with 4+ digits appearing as a standalone literal in expressions
    // Skip: year constants (19xx/20xx), port numbers inside env fallbacks,
    // Zod default() calls, and values inside string literals.
    const pattern = /(?<![\w$.'"`])(\d{4,})(?![\w$'"`])/g;
    for (const [filePath, content] of files) {
      if (isTestFile(filePath) || !isServiceFile(filePath)) continue;

      let match: RegExpExecArray | null;
      const re = new RegExp(pattern.source, pattern.flags);
      while ((match = re.exec(content)) !== null) {
        const num = parseInt(match[1]!, 10);
        // Skip year literals
        if (num >= 1900 && num <= 2100) continue;
        // Skip common non-magic numbers (bit widths, HTTP status, etc.)
        if ([1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(num)) continue;
        if (num >= 100 && num <= 599) continue; // HTTP status-like
        // Skip if within a default() call
        const windowStart = Math.max(0, match.index - 40);
        const window = content.slice(windowStart, match.index + 10);
        if (/\.default\s*\(\s*$/.test(window)) continue;
        if (/z\.coerce\.(number|int)\(\)/.test(window)) continue;
        // Skip if inside a string literal (crude heuristic: same line has matching quotes around the number)
        const lineStart = content.lastIndexOf('\n', match.index) + 1;
        const lineEnd = content.indexOf('\n', match.index);
        const lineText = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
        const numPosInLine = match.index - lineStart;
        const before = lineText.slice(0, numPosInLine);
        const quoteCount = (before.match(/(?<!\\)['"`]/g) ?? []).length;
        if (quoteCount % 2 === 1) continue; // inside a string
        // Skip comments
        if (/^\s*\/\//.test(lineText) || /^\s*\*/.test(lineText)) continue;

        findings.push({
          ruleId: 'PGV-003',
          filePath,
          line: lineAt(content, match.index),
          severity: 'warn',
          message: `Magic number ${num} in service file — externalize via config or typed constant (ADR-PIPELINE-046).`,
        });
      }
    }
    return findings;
  },
};

/** PGV-004: State-mutating methods must write to the audit trail. */
const RULE_PGV_004: GeneratedCodeValidationRule = {
  id: 'PGV-004',
  title: 'State-mutating service methods must call audit.append / audit.record',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-049',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    const mutationPattern = /\b(?:repo|repository)\.(save|update|delete|insert|upsert)\s*\(/;
    const auditPattern = /\b(?:audit|auditService|auditLog)\.(?:append|record|log|write)\s*\(/;
    for (const [filePath, content] of files) {
      if (isTestFile(filePath) || !isServiceFile(filePath)) continue;
      if (!mutationPattern.test(content)) continue;
      if (auditPattern.test(content)) continue;
      findings.push({
        ruleId: 'PGV-004',
        filePath,
        line: 0,
        severity: 'warn',
        message: 'File contains repository write operations but no audit.append()/record() calls. State mutations must be auditable (ADR-PIPELINE-049).',
      });
    }
    return findings;
  },
};

/** PGV-005: No raw `console.*` calls in production code. */
const RULE_PGV_005: GeneratedCodeValidationRule = {
  id: 'PGV-005',
  title: 'Use createLogger() instead of console.* in production code',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-051',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    const pattern = /console\.(log|error|warn|info|debug)\s*\(/g;
    for (const [filePath, content] of files) {
      if (isTestFile(filePath) || isScriptOrDemo(filePath)) continue;
      findings.push(...collectMatches(
        content, pattern, filePath, 'PGV-005', 'warn',
        'Direct `console.*` call — use `createLogger()` for structured logging (ADR-PIPELINE-051).',
      ));
    }
    return findings;
  },
};

/** PGV-006: Every route file has a sibling test file. */
const RULE_PGV_006: GeneratedCodeValidationRule = {
  id: 'PGV-006',
  title: 'Route files must have a corresponding .test.ts',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-059',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    const allPaths = new Set(files.keys());
    for (const filePath of files.keys()) {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      const isRoute = n.includes('/routes/') && n.endsWith('.ts') && !isTestFile(filePath);
      if (!isRoute) continue;
      // Check sibling test file
      const base = filePath.replace(/\.ts$/i, '');
      const candidates = [`${base}.test.ts`, `${base}.spec.ts`];
      const hasTest = candidates.some(c => allPaths.has(c));
      if (hasTest) continue;
      // Also allow a test file in ../tests/ with the same base name
      const baseName = path.basename(base);
      const looseMatch = Array.from(allPaths).some(p => {
        const pn = p.replace(/\\/g, '/').toLowerCase();
        return isTestFile(p) && pn.includes(`/${baseName}.`);
      });
      if (looseMatch) continue;
      findings.push({
        ruleId: 'PGV-006',
        filePath,
        line: 0,
        severity: 'warn',
        message: `Route file has no corresponding .test.ts (ADR-PIPELINE-059). Expected one of: ${candidates.join(', ')}`,
      });
    }
    return findings;
  },
};

/** PGV-007: Seed data validates via Zod at load. */
const RULE_PGV_007: GeneratedCodeValidationRule = {
  id: 'PGV-007',
  title: 'Seed data must validate via Zod at load',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-046',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    for (const [filePath, content] of files) {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      if (!n.endsWith('/seed.ts') && !n.endsWith('/data/seed.ts')) continue;
      if (isTestFile(filePath)) continue;
      if (/\.\s*(?:safeParse|parse)\s*\(/.test(content)) continue;
      findings.push({
        ruleId: 'PGV-007',
        filePath,
        line: 0,
        severity: 'warn',
        message: 'Seed data file does not call .parse()/.safeParse() — exported arrays should be validated at load (ADR-PIPELINE-046).',
      });
    }
    return findings;
  },
};

/** PGV-008: No `Record<string, unknown | any>` in public DTO types. */
const RULE_PGV_008: GeneratedCodeValidationRule = {
  id: 'PGV-008',
  title: 'No Record<string, unknown|any> in public DTO types',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-039',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    const pattern = /Record\s*<\s*string\s*,\s*(?:unknown|any)\s*>/g;
    for (const [filePath, content] of files) {
      if (isTestFile(filePath) || !isPublicTypesFile(filePath)) continue;
      findings.push(...collectMatches(
        content, pattern, filePath, 'PGV-008', 'warn',
        '`Record<string, unknown>` in public type — replace with concrete interface derived from the DDD model (ADR-PIPELINE-039).',
      ));
    }
    return findings;
  },
};

/** PGV-009: Circuit breaker has state transition tests. */
const RULE_PGV_009: GeneratedCodeValidationRule = {
  id: 'PGV-009',
  title: 'Circuit breaker must have state transition tests',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-050',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    const cbFiles: string[] = [];
    for (const filePath of files.keys()) {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      if ((n.endsWith('/circuit-breaker.ts') || n.endsWith('/circuitbreaker.ts')) && !isTestFile(filePath)) {
        cbFiles.push(filePath);
      }
    }
    if (cbFiles.length === 0) return findings;
    // Look for ANY test file that references all 3 state strings
    const allContent = Array.from(files.entries()).filter(([p]) => isTestFile(p));
    // Match state names with word boundaries. The rule only fires when a
    // circuit-breaker.ts file exists, so false positives on generic "open"
    // are unlikely — we also require the distinctive "half-open" compound.
    const hasTransitionTests = allContent.some(([, c]) =>
      /\bclosed\b/.test(c) && /\bopen\b/.test(c) && /\bhalf[-_]?open\b/.test(c),
    );
    if (hasTransitionTests) return findings;
    for (const filePath of cbFiles) {
      findings.push({
        ruleId: 'PGV-009',
        filePath,
        line: 0,
        severity: 'warn',
        message: 'Circuit breaker implementation has no state transition tests (closed → open → half-open → closed). Add tests referencing all three states (ADR-PIPELINE-050).',
      });
    }
    return findings;
  },
};

/** PGV-010: Repository interfaces have at least one implementation. */
const RULE_PGV_010: GeneratedCodeValidationRule = {
  id: 'PGV-010',
  title: 'Repository interfaces must have at least one implementation',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-047',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    const interfacePattern = /export\s+interface\s+(\w*Repository)\b/g;
    const interfaces = new Map<string, { filePath: string; line: number }>();

    for (const [filePath, content] of files) {
      if (isTestFile(filePath)) continue;
      let match: RegExpExecArray | null;
      const re = new RegExp(interfacePattern.source, interfacePattern.flags);
      while ((match = re.exec(content)) !== null) {
        interfaces.set(match[1]!, { filePath, line: lineAt(content, match.index) });
      }
    }

    for (const [name, loc] of interfaces) {
      // Search for `implements Name` or `class X implements ... Name`
      const implRegex = new RegExp(`\\bimplements\\b[^{]*\\b${name}\\b`);
      let found = false;
      for (const [p, c] of files) {
        if (isTestFile(p)) continue;
        if (implRegex.test(c)) { found = true; break; }
      }
      if (found) continue;
      findings.push({
        ruleId: 'PGV-010',
        filePath: loc.filePath,
        line: loc.line,
        severity: 'warn',
        message: `Repository interface \`${name}\` has no class implementing it. Provide at least one concrete implementation (ADR-PIPELINE-047).`,
      });
    }
    return findings;
  },
};

const ALL_RULES: readonly GeneratedCodeValidationRule[] = [
  RULE_PGV_001, RULE_PGV_002, RULE_PGV_003, RULE_PGV_004, RULE_PGV_005,
  RULE_PGV_006, RULE_PGV_007, RULE_PGV_008, RULE_PGV_009, RULE_PGV_010,
];

// Exported for unit tests that want to run individual rules
export const RULES: readonly GeneratedCodeValidationRule[] = ALL_RULES;

// ============================================================================
// Main Validator
// ============================================================================

/**
 * Run all validation rules against the files in a project directory.
 * Pure function — no I/O side effects beyond reading files.
 */
export function validateGeneratedCode(projectDir: string): PostGenerationReport {
  const files = loadProjectFiles(projectDir);
  const findings: ValidationFinding[] = [];

  for (const rule of ALL_RULES) {
    try {
      findings.push(...rule.check(files));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      findings.push({
        ruleId: rule.id,
        filePath: '<rule-error>',
        line: 0,
        severity: 'warn',
        message: `Rule ${rule.id} threw during execution: ${errMsg}. Skipping.`,
      });
    }
  }

  const errorCount = findings.filter(f => f.severity === 'error').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;

  // Scoring: 100 - (10 * errors, capped at 70) - (2 * warns, capped at 20)
  const errorPenalty = Math.min(70, errorCount * 10);
  const warnPenalty = Math.min(20, warnCount * 2);
  const score = Math.max(0, 100 - errorPenalty - warnPenalty);
  const passed = score >= 70;

  return {
    passed,
    score,
    findings,
    filesScanned: files.size,
    rulesApplied: ALL_RULES.length,
    errorCount,
    warnCount,
    projectDir,
  };
}

// ============================================================================
// Stage Entry Point
// ============================================================================

/**
 * Resolve the generated project directory. Prefers the deploy project,
 * falls back to codegen project. Returns null if neither exists.
 */
function resolveProjectDir(phase5Dir: string): string | null {
  const candidates = [
    path.join(phase5Dir, 'deploy', 'project'),
    path.join(phase5Dir, 'codegen', 'project'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Execute the post-generation code validator as a Phase 5 pipeline stage.
 *
 * Non-blocking by default. When AGENTICS_STRICT_POSTGEN=true, any error-level
 * finding fails the stage. The coordinator decides whether stage failure
 * blocks the pipeline.
 */
export function executePostGenerationValidator(
  context: Phase5BuildContext,
): { stageOutput: PostGenerationStageOutput } {
  const startTime = Date.now();
  const span = createSpan('post-generation-validation', 'validate-generated-code', {
    traceId: context.traceId,
    phase5Dir: context.phase5Dir,
  });

  const projectDir = resolveProjectDir(context.phase5Dir);
  if (!projectDir) {
    const elapsed = Date.now() - startTime;
    const failSpan = endSpan(span, 'error', { reason: 'project-not-found' });
    emitSpan(failSpan);
    context.telemetrySpans.push(failSpan);
    return {
      stageOutput: {
        stage: 'post-generation-validation',
        status: 'failed',
        timing: elapsed,
        artifacts: [],
        summary: 'ECLI-P5-041: No generated project directory found (tried deploy/project and codegen/project).',
        data: {
          passed: false,
          score: 0,
          findings: [],
          filesScanned: 0,
          rulesApplied: ALL_RULES.length,
          errorCount: 0,
          warnCount: 0,
          projectDir: null,
        },
      },
    };
  }

  const report = validateGeneratedCode(projectDir);
  const elapsed = Date.now() - startTime;
  const strict = process.env['AGENTICS_STRICT_POSTGEN'] === 'true';
  const failOnStrict = strict && report.errorCount > 0;

  // Persist a report artifact so reviewers can inspect findings without rerunning
  const reportPath = path.join(context.phase5Dir, 'post-generation-report.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // best-effort
  }

  // Log findings to stderr using the same pattern as implementation-quality-gate.ts
  if (report.findings.length > 0) {
    console.error(`  [POSTGEN] Post-generation validation: ${report.errorCount} errors, ${report.warnCount} warnings (score: ${report.score}/100)`);
    // Group findings by rule for readability
    const byRule = new Map<string, ValidationFinding[]>();
    for (const f of report.findings) {
      const list = byRule.get(f.ruleId) ?? [];
      list.push(f);
      byRule.set(f.ruleId, list);
    }
    for (const [ruleId, findings] of byRule) {
      const first = findings[0]!;
      const severityTag = first.severity === 'error' ? 'ERROR' : 'warn';
      console.error(`    [${severityTag}] ${ruleId} — ${findings.length} finding${findings.length > 1 ? 's' : ''}: ${first.message}`);
      for (const f of findings.slice(0, 5)) {
        console.error(`      ${f.filePath}${f.line > 0 ? `:${f.line}` : ''}`);
      }
      if (findings.length > 5) {
        console.error(`      ... and ${findings.length - 5} more (see post-generation-report.json)`);
      }
    }
  } else {
    console.error(`  [POSTGEN] Post-generation validation: PASSED (score: ${report.score}/100, ${report.filesScanned} files, ${ALL_RULES.length} rules).`);
  }

  const finalSpan = endSpan(span, failOnStrict ? 'error' : 'ok', {
    errorCount: report.errorCount,
    warnCount: report.warnCount,
    score: report.score,
    strict,
  });
  emitSpan(finalSpan);
  context.telemetrySpans.push(finalSpan);

  const status: 'completed' | 'failed' = failOnStrict ? 'failed' : 'completed';
  const summary = failOnStrict
    ? `ECLI-P5-040: Post-generation validation FAILED in strict mode — ${report.errorCount} errors, score ${report.score}/100.`
    : `     Post-generation validation: ${report.errorCount} errors, ${report.warnCount} warnings, score ${report.score}/100 (${report.filesScanned} files scanned, ${ALL_RULES.length} rules).`;

  return {
    stageOutput: {
      stage: 'post-generation-validation' as Phase5BuildStage & 'post-generation-validation',
      status,
      timing: elapsed,
      artifacts: [reportPath],
      summary,
      data: report,
    },
  };
}
