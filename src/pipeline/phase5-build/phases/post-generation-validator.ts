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
import { OWNED_SCAFFOLD_MODULES } from '../../auto-chain.js';

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

/** PGV-011: No CommonJS `require(` calls in generated TypeScript (ADR-PIPELINE-068). */
const RULE_PGV_011: GeneratedCodeValidationRule = {
  id: 'PGV-011',
  title: 'No CommonJS require() calls in generated TypeScript',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-068',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    // Match `require('...')` / `require("...")` / `require(\`...\`)` —
    // a CJS module load always passes a string literal as its first arg.
    // Constraints:
    //   - Char before `require` must NOT be `.` (excludes obj.require)
    //     or word/$ (excludes requireSimulationLineage, _require, etc.)
    //   - First argument must be a string literal (excludes method
    //     definitions like `require(name: string)`)
    //   - `createRequire(import.meta.url)` is the one safe interop pattern
    //     and is allowed when the file imports from node:module.
    const pattern = /(?:^|[^.\w$])(require)\s*\(\s*['"`]/g;
    const createRequirePattern = /createRequire\s*\(/;

    for (const [filePath, content] of files) {
      // Skip tests, scripts, and generated demo files. Demo is covered by
      // ADR-068's banner rule — not by the require() ban.
      if (isTestFile(filePath) || isScriptOrDemo(filePath)) continue;
      // Type-only declaration files have no runtime behavior.
      if (filePath.endsWith('.d.ts')) continue;

      const hasCreateRequire = createRequirePattern.test(content);

      const re = new RegExp(pattern.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        // `createRequire(import.meta.url)` produces a `require` binding
        // that's legal in ESM — don't flag its call sites when the file
        // contains the createRequire import.
        if (hasCreateRequire) continue;

        // Skip matches inside comments or string literals (rough check).
        const start = match.index + (match[0]!.length - 'require('.length);
        const lineStart = content.lastIndexOf('\n', start) + 1;
        const prefix = content.slice(lineStart, start);
        if (/^\s*\/\//.test(prefix) || /^\s*\*/.test(prefix)) continue;

        findings.push({
          ruleId: 'PGV-011',
          filePath,
          line: lineAt(content, start),
          severity: 'error',
          message:
            'CommonJS `require()` in generated ESM project — use `import` instead, or `createRequire(import.meta.url)` for CJS interop. Silent `require()` throws at runtime under "type":"module" and severs simulation lineage (ADR-PIPELINE-068).',
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
    return findings;
  },
};

/** PGV-012: No generator-emitted file may redeclare a scaffold-owned export (ADR-PIPELINE-069). */
const RULE_PGV_012: GeneratedCodeValidationRule = {
  id: 'PGV-012',
  title: 'Generator files must not redeclare scaffold-owned exports',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-069',
  check: (files) => {
    const findings: ValidationFinding[] = [];

    // Build (exportName -> ownedPath) lookup. Skip the scaffold-owned
    // files themselves (matched by basename) since they're allowed to
    // declare their own exports.
    const exportToOwned = new Map<string, string>();
    const ownedBasenames = new Set<string>();
    for (const mod of OWNED_SCAFFOLD_MODULES) {
      ownedBasenames.add(path.basename(mod.path));
      for (const ex of mod.exports) {
        if (!exportToOwned.has(ex)) exportToOwned.set(ex, mod.path);
      }
    }

    for (const [filePath, content] of files) {
      const basename = path.basename(filePath);
      // Skip the scaffold-owned files themselves
      if (ownedBasenames.has(basename)) continue;
      // Skip tests, scripts, demos, and type-only declarations
      if (isTestFile(filePath) || isScriptOrDemo(filePath)) continue;
      if (filePath.endsWith('.d.ts')) continue;

      for (const [exportName, ownedPath] of exportToOwned) {
        // Match `export class|function|const|let|interface|type|enum NAME`
        const declRe = new RegExp(
          `\\bexport\\s+(?:class|function|const|let|interface|type|enum)\\s+${exportName}\\b`,
          'g',
        );
        // Match `export { NAME }` (re-export named) — both `export { NAME }` and
        // `export { NAME as ... }`. The wildcard inside braces tolerates
        // extra exports on the same line.
        const reExportRe = new RegExp(`\\bexport\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`, 'g');

        let m: RegExpExecArray | null;
        while ((m = declRe.exec(content)) !== null) {
          findings.push({
            ruleId: 'PGV-012',
            filePath,
            line: lineAt(content, m.index),
            severity: 'error',
            message:
              `Redeclaration of scaffold-owned export \`${exportName}\` (owned by ${ownedPath}). Import from the scaffold path instead of redefining (ADR-PIPELINE-069).`,
          });
          if (m.index === declRe.lastIndex) declRe.lastIndex++;
        }

        let r: RegExpExecArray | null;
        while ((r = reExportRe.exec(content)) !== null) {
          findings.push({
            ruleId: 'PGV-012',
            filePath,
            line: lineAt(content, r.index),
            severity: 'error',
            message:
              `Re-export of scaffold-owned name \`${exportName}\` from a non-scaffold file (owned by ${ownedPath}). Import directly from the scaffold path (ADR-PIPELINE-069).`,
          });
          if (r.index === reExportRe.lastIndex) reExportRe.lastIndex++;
        }
      }
    }
    return findings;
  },
};

/** PGV-016: Ban module-level correlation-ID mutable state (ADR-PIPELINE-074). */
const RULE_PGV_016: GeneratedCodeValidationRule = {
  id: 'PGV-016',
  title: 'No module-level `let currentCorrelationId` in logger / logging files',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-074',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    // Target: any variable binding named correlation* at module scope in
    // logger-shaped files. Inside functions / classes the pattern is fine
    // (AsyncLocalStorage stores are allowed); it's only the MODULE-LEVEL
    // mutable that breaks under concurrent requests.
    const pattern = /^(?:let|var)\s+(\w*[cC]orrelation[A-Za-z0-9_]*)\b/gm;

    for (const [filePath, content] of files) {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      // Match scaffolded logger files + any generator-emitted logging module
      if (!(n.endsWith('/logger.ts') || n.includes('/logging/') || n.endsWith('/correlation.ts'))) continue;
      if (isTestFile(filePath)) continue;

      let match: RegExpExecArray | null;
      const re = new RegExp(pattern.source, 'gm');
      while ((match = re.exec(content)) !== null) {
        findings.push({
          ruleId: 'PGV-016',
          filePath,
          line: lineAt(content, match.index),
          severity: 'error',
          message:
            `Module-level mutable \`${match[1]}\` in logger/logging file — concurrent requests will cross-contaminate log lines. ` +
            'Use `runWithCorrelation` + AsyncLocalStorage from the scaffolded `src/logger.ts` instead (ADR-PIPELINE-074).',
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
    return findings;
  },
};

/** PGV-017: Ban Map-backed service stores (ADR-PIPELINE-075). */
const RULE_PGV_017: GeneratedCodeValidationRule = {
  id: 'PGV-017',
  title: 'Service layers must use Repository<T>, not new Map<string, T>',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-075',
  check: (files) => {
    const findings: ValidationFinding[] = [];

    // Match a class field declared as `new Map<string, T>`. We look for
    // the field-binding form specifically (private/public/readonly/protected
    // prefix + identifier + assignment) so local variables and request-
    // scoped caches inside methods don't trigger.
    const fieldPattern =
      /^\s*(?:private|public|protected)\s+(?:readonly\s+)?\w+\s*(?::\s*[^=]+)?=\s*new\s+Map\s*<\s*string\s*,/gm;

    for (const [filePath, content] of files) {
      if (isTestFile(filePath)) continue;
      // Scope: only flag inside service / application layers
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      const isServiceLayer =
        n.includes('/services/') ||
        n.includes('/application/') ||
        n.includes('/domain/services/');
      if (!isServiceLayer) continue;

      // Only fire when the file defines a *Service class (heuristic).
      // This avoids flagging repositories, controllers, and utility classes
      // that legitimately use Map for in-memory state.
      const serviceClassMatch = content.match(/\bclass\s+(\w*(?:Service|Store|Manager))\b/);
      if (!serviceClassMatch) continue;
      const serviceName = serviceClassMatch[1]!;

      // Soften to a warning when the service clearly depends on a
      // Repository — the Map is probably a request-scoped cache, not the
      // primary store.
      const hasRepositoryDep = /\b(?:private|public|protected|readonly)\s+\w+\s*:\s*\w*Repository\b/.test(content);

      let match: RegExpExecArray | null;
      const re = new RegExp(fieldPattern.source, 'gm');
      while ((match = re.exec(content)) !== null) {
        findings.push({
          ruleId: 'PGV-017',
          filePath,
          line: lineAt(content, match.index),
          severity: hasRepositoryDep ? 'warn' : 'error',
          message:
            `Service class \`${serviceName}\` stores state in a Map<string, T> field — use \`Repository<T>\` from ` +
            '`src/persistence/repository.ts` instead. InMemoryRepository for tests, SqliteRepository for production (ADR-PIPELINE-075).',
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
    return findings;
  },
};

/** PGV-018: /metrics + /health/live + /health/ready routes must exist (ADR-PIPELINE-076). */
const RULE_PGV_018: GeneratedCodeValidationRule = {
  id: 'PGV-018',
  title: 'Generated project must expose /metrics, /health/live, /health/ready',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-076',
  check: (files) => {
    const findings: ValidationFinding[] = [];

    // Collect server-side files across common layouts. Exclude the
    // scaffold's own api/base-app.ts because those routes are emitted
    // there — PGV-018 is verifying downstream integration, not the
    // scaffold file itself.
    const serverFiles = Array.from(files.entries()).filter(([filePath]) => {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      if (isTestFile(filePath)) return false;
      return (
        n.includes('/server/') ||
        n.includes('/api/') ||
        n.endsWith('/app.ts') ||
        n.endsWith('/server.ts') ||
        n.endsWith('/index.ts')
      );
    });
    if (serverFiles.length === 0) return findings;

    // Two paths satisfy the rule:
    //   (a) The project imports createBaseApp from the scaffold (every
    //       generated project inherits the three routes automatically).
    //   (b) The project defines the three routes explicitly in a server file.
    const anyImportsBaseApp = serverFiles.some(([, content]) =>
      /\bcreateBaseApp\b/.test(content) &&
      /from\s+['"][^'"]*base-app(\.js)?['"]/.test(content),
    );
    if (anyImportsBaseApp) return findings;

    const aggregatedContent = serverFiles.map(([, c]) => c).join('\n');
    const missing: string[] = [];
    if (!/['"]\/metrics['"]/.test(aggregatedContent)) missing.push('/metrics');
    if (!/['"]\/health\/live['"]/.test(aggregatedContent)) missing.push('/health/live');
    if (!/['"]\/health\/ready['"]/.test(aggregatedContent)) missing.push('/health/ready');

    if (missing.length > 0) {
      const sample = serverFiles[0]!;
      findings.push({
        ruleId: 'PGV-018',
        filePath: sample[0],
        line: 0,
        severity: 'error',
        message:
          `Generated project does not expose ${missing.join(', ')}. ` +
          'Import `createBaseApp` from `src/api/base-app.ts` and call `app.route()` ' +
          'for your domain routes; the base app wires /metrics, /health/live, and /health/ready automatically (ADR-PIPELINE-076).',
      });
    }
    return findings;
  },
};

/** PGV-019: createBaseApp readiness list must cover declared dependencies (ADR-PIPELINE-076). */
const RULE_PGV_019: GeneratedCodeValidationRule = {
  id: 'PGV-019',
  title: 'createBaseApp readiness list should cover every external dependency',
  severity: 'warn',
  adrReference: 'ADR-PIPELINE-076',
  check: (files) => {
    const findings: ValidationFinding[] = [];

    // Match createBaseApp({...}) invocation blocks and inspect the
    // readiness array. Because the rule is regex-based, we only flag
    // the clearly-wrong cases: readiness is the empty array alongside
    // clear dependencies on db, erp, auditRepo, or circuit-breaker.
    const invocationPattern =
      /createBaseApp\s*\(\s*\{([\s\S]*?)readiness\s*:\s*\[([\s\S]*?)\]([\s\S]*?)\}\s*\)/g;

    for (const [filePath, content] of files) {
      if (isTestFile(filePath)) continue;

      let match: RegExpExecArray | null;
      const re = new RegExp(invocationPattern.source, 'g');
      while ((match = re.exec(content)) !== null) {
        const body = match[2] ?? '';
        const trimmedBody = body.trim();
        // Empty readiness list
        const isEmpty = trimmedBody.length === 0;
        // Only contains unconditional-pass checks like `{ ok: true }`
        const onlyUnconditional =
          !isEmpty &&
          /ok\s*:\s*true/.test(trimmedBody) &&
          !/await|await\s+\w/.test(trimmedBody);

        if (!isEmpty && !onlyUnconditional) continue;

        // Does the file clearly declare downstream dependencies?
        const hasDbDep = /\bDatabase\s*\(|new\s+Database\s*\(|SqliteRepository|drizzle|sqlite/i.test(content);
        const hasErpDep = /ErpAdapter|erp[_-]?client|Ramco|OPERA|Workday|SAP\b/i.test(content);
        const hasCircuitDep = /CircuitBreaker/.test(content);
        const depCount = [hasDbDep, hasErpDep, hasCircuitDep].filter(Boolean).length;
        if (depCount < 1) continue;

        findings.push({
          ruleId: 'PGV-019',
          filePath,
          line: lineAt(content, match.index),
          severity: 'warn',
          message:
            `createBaseApp readiness list is ${isEmpty ? 'empty' : 'unconditional-pass-only'} but the file has ${depCount} external dependencies (db/erp/circuit). ` +
            'Add a readiness check for each dependency so /health/ready fails when they are unavailable (ADR-PIPELINE-076).',
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
    return findings;
  },
};

/** PGV-020: Every ERP adapter/schema file exports ERP_SCHEMA_PROVENANCE (ADR-PIPELINE-077). */
const RULE_PGV_020: GeneratedCodeValidationRule = {
  id: 'PGV-020',
  title: 'ERP adapter/schema files must export ERP_SCHEMA_PROVENANCE',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-077',
  check: (files) => {
    const findings: ValidationFinding[] = [];

    for (const [filePath, content] of files) {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      // Scope: files under src/erp/ that are NOT tests and NOT the
      // scaffolded helper itself (schema-provenance.ts).
      if (!n.includes('/erp/')) continue;
      if (isTestFile(filePath)) continue;
      if (n.endsWith('/schema-provenance.ts')) continue;
      // Skip obvious non-adapter files (enums, constants, utilities).
      // We only require the block on files that export a Zod schema OR
      // look like an adapter class — these are the code paths that talk
      // to the real ERP.
      const looksLikeAdapter =
        /\bz\.object\s*\(/.test(content) ||
        /\bclass\s+\w*(?:Adapter|Client|Schema)\b/.test(content) ||
        /\bexport\s+const\s+\w+Schema\s*=/.test(content);
      if (!looksLikeAdapter) continue;

      const hasBlock = /export\s+const\s+ERP_SCHEMA_PROVENANCE\b/.test(content);
      if (!hasBlock) {
        findings.push({
          ruleId: 'PGV-020',
          filePath,
          line: 0,
          severity: 'error',
          message:
            'ERP adapter/schema file does not export `ERP_SCHEMA_PROVENANCE`. ' +
            "Import `ErpSchemaProvenance` from `src/erp/schema-provenance.ts` and export a constant with `source: 'invented'` as the default (ADR-PIPELINE-077).",
        });
      }
    }
    return findings;
  },
};

/** PGV-021: source='validated' requires non-null reviewer + catalog_version (ADR-PIPELINE-077). */
const RULE_PGV_021: GeneratedCodeValidationRule = {
  id: 'PGV-021',
  title: "ERP_SCHEMA_PROVENANCE source='validated' requires reviewer + catalog_version",
  severity: 'error',
  adrReference: 'ADR-PIPELINE-077',
  check: (files) => {
    const findings: ValidationFinding[] = [];

    // Regex over the provenance literal. We look for the object body
    // between `ERP_SCHEMA_PROVENANCE` and the next top-level `};` so
    // multi-line declarations are captured.
    const literalPattern = /export\s+const\s+ERP_SCHEMA_PROVENANCE[^=]*=\s*\{([\s\S]*?)\}\s*;/g;

    for (const [filePath, content] of files) {
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      if (!n.includes('/erp/')) continue;
      if (isTestFile(filePath)) continue;
      if (n.endsWith('/schema-provenance.ts')) continue;

      let match: RegExpExecArray | null;
      const re = new RegExp(literalPattern.source, 'g');
      while ((match = re.exec(content)) !== null) {
        const body = match[1] ?? '';
        // Extract source value — tolerate single / double quotes + backticks
        const sourceMatch = body.match(/\bsource\s*:\s*['"`](\w+)['"`]/);
        if (!sourceMatch || sourceMatch[1] !== 'validated') continue;

        // Under validated, reviewer and catalog_version must be non-null
        const reviewerMatch = body.match(/\breviewer\s*:\s*([^,}]+)/);
        const catalogMatch = body.match(/\bcatalog_version\s*:\s*([^,}]+)/);
        const reviewerVal = (reviewerMatch?.[1] ?? '').trim();
        const catalogVal = (catalogMatch?.[1] ?? '').trim();
        const reviewerOk = reviewerVal !== '' && reviewerVal !== 'null' && reviewerVal !== 'undefined';
        const catalogOk = catalogVal !== '' && catalogVal !== 'null' && catalogVal !== 'undefined';

        if (!reviewerOk || !catalogOk) {
          const missing: string[] = [];
          if (!reviewerOk) missing.push('reviewer');
          if (!catalogOk) missing.push('catalog_version');
          findings.push({
            ruleId: 'PGV-021',
            filePath,
            line: lineAt(content, match.index),
            severity: 'error',
            message:
              `ERP_SCHEMA_PROVENANCE has source='validated' but ${missing.join(' and ')} is null/missing. ` +
              "Record the SME review details (reviewer name + role, catalog version) — don't rubber-stamp the validation status (ADR-PIPELINE-077).",
          });
        }
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
    return findings;
  },
};

/** PGV-022: Audit services must use hashAuditEntry from the scaffold (ADR-PIPELINE-078). */
const RULE_PGV_022: GeneratedCodeValidationRule = {
  id: 'PGV-022',
  title: 'Audit services must hash with hashAuditEntry, not raw JSON.stringify + SHA-256',
  severity: 'error',
  adrReference: 'ADR-PIPELINE-078',
  check: (files) => {
    const findings: ValidationFinding[] = [];
    // Match the anti-pattern: createHash('sha256').update(JSON.stringify(...))
    // in a file that looks like an audit service.
    const antiPattern = /createHash\s*\(\s*['"]sha256['"]\s*\)[\s\S]{0,80}\.update\s*\(\s*JSON\.stringify/g;

    for (const [filePath, content] of files) {
      if (isTestFile(filePath)) continue;
      const n = filePath.replace(/\\/g, '/').toLowerCase();
      // Only audit-shaped files: audit*.ts, services/audit*.ts, or files
      // that declare a class with Audit in the name.
      const isAuditShaped =
        n.endsWith('/audit.ts') ||
        n.includes('/audit') ||
        /\bclass\s+\w*Audit\w*\b/.test(content);
      if (!isAuditShaped) continue;
      // Skip the scaffolded helper itself
      if (n.endsWith('/audit-hash.ts') || n.endsWith('/canonical-json.ts')) continue;

      let match: RegExpExecArray | null;
      const re = new RegExp(antiPattern.source, 'g');
      while ((match = re.exec(content)) !== null) {
        findings.push({
          ruleId: 'PGV-022',
          filePath,
          line: lineAt(content, match.index),
          severity: 'error',
          message:
            'Raw `JSON.stringify` + `createHash("sha256")` in audit code — use ' +
            '`hashAuditEntry` from `src/persistence/audit-hash.ts` instead. ' +
            'JSON.stringify does not sort keys and nested payload mutations escape tamper detection (ADR-PIPELINE-078).',
        });
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
    return findings;
  },
};

const ALL_RULES: readonly GeneratedCodeValidationRule[] = [
  RULE_PGV_001, RULE_PGV_002, RULE_PGV_003, RULE_PGV_004, RULE_PGV_005,
  RULE_PGV_006, RULE_PGV_007, RULE_PGV_008, RULE_PGV_009, RULE_PGV_010,
  RULE_PGV_011, RULE_PGV_012, RULE_PGV_016, RULE_PGV_017, RULE_PGV_018, RULE_PGV_019,
  RULE_PGV_020, RULE_PGV_021, RULE_PGV_022,
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
