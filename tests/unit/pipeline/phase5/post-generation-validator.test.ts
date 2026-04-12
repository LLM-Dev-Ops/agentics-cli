/**
 * Tests for Phase 5 Build — Post-Generation Code Validator (ADR-PIPELINE-065)
 *
 * Each rule has at least one positive test (finding emitted) and one negative
 * test (clean code passes). Uses a temp directory to simulate a generated
 * project tree. validateGeneratedCode() is a pure function that takes a
 * directory path, so these tests are fast and deterministic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  validateGeneratedCode,
  RULES,
  executePostGenerationValidator,
} from '../../../../src/pipeline/phase5-build/phases/post-generation-validator.js';
import type { Phase5BuildContext } from '../../../../src/pipeline/phase5-build/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p5-postgen-test-'));
}

function writeFile(projectDir: string, relPath: string, content: string): void {
  const fullPath = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, { encoding: 'utf-8' });
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Framework Tests
// ============================================================================

describe('post-generation-validator — framework', () => {
  it('exports exactly 12 rules (ADR-PIPELINE-065 §2 + PGV-011 + PGV-012)', () => {
    expect(RULES).toHaveLength(12);
  });

  it('every rule has an id, title, severity, and ADR reference', () => {
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^PGV-\d{3}$/);
      expect(rule.title.length).toBeGreaterThan(5);
      expect(['error', 'warn']).toContain(rule.severity);
      expect(rule.adrReference).toMatch(/^ADR-PIPELINE-\d+$/);
      expect(typeof rule.check).toBe('function');
    }
  });

  it('returns passed=true with empty findings on an empty project', () => {
    const dir = makeTempProject();
    try {
      const report = validateGeneratedCode(dir);
      expect(report.filesScanned).toBe(0);
      expect(report.findings).toEqual([]);
      expect(report.errorCount).toBe(0);
      expect(report.warnCount).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.score).toBe(100);
      expect(report.rulesApplied).toBe(12);
    } finally {
      cleanup(dir);
    }
  });

  it('does not crash on unreadable files or nested directories', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/routes/users.ts', 'export const app = new Hono<{ Variables: { correlationId: string } }>();');
      writeFile(dir, 'node_modules/some-package/index.ts', 'const cursed: any = {};');
      const report = validateGeneratedCode(dir);
      // node_modules must be skipped
      expect(report.filesScanned).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('score formula: 100 - (10 × errors, cap 70) - (2 × warns, cap 20)', () => {
    const dir = makeTempProject();
    try {
      // Inject 2 PGV-001 violations (errors) → -20 score
      writeFile(dir, 'src/server/app.ts', [
        'const a = c.get(\'correlationId\') as string;',
        'const b = c.get(\'userId\') as string;',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.errorCount).toBeGreaterThanOrEqual(2);
      expect(report.score).toBeLessThanOrEqual(80);
      expect(report.score).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-001 — No `as string` / `as any` on route inputs
// ============================================================================

describe('PGV-001 — route input casts', () => {
  it('flags Hono `c.get(...) as string` in server files', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/routes/decisions.ts',
        'const corrId = c.get(\'correlationId\') as string;');
      const report = validateGeneratedCode(dir);
      const pgv1 = report.findings.filter(f => f.ruleId === 'PGV-001');
      expect(pgv1.length).toBeGreaterThanOrEqual(1);
      expect(pgv1[0]!.severity).toBe('error');
    } finally {
      cleanup(dir);
    }
  });

  it('flags Express `(req as any)` casts', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/app.ts',
        'const correlationId = (req as any).correlationId ?? "unknown";');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-001')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('flags `req.headers["x-foo"] as string` casts', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/routes/auth.ts',
        'const role = req.headers[\'x-user-role\'] as string;');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-001')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when Hono context is typed (no cast needed)', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/app.ts', [
        'export const app = new Hono<{ Variables: { correlationId: string } }>();',
        'app.get("/x", (c) => { const id = c.get("correlationId"); return c.json({ id }); });',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-001')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does not flag casts in test files', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/routes/decisions.test.ts',
        'const corrId = c.get(\'correlationId\') as string;');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-001')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-002 — `new Hono()` must be typed
// ============================================================================

describe('PGV-002 — untyped new Hono()', () => {
  it('flags `new Hono()` with no generic in server files', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/app.ts', 'export const app = new Hono();');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-002')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when Hono is parameterized', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/app.ts',
        'export const app = new Hono<{ Variables: { correlationId: string } }>();');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-002')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-003 — magic numbers in service files
// ============================================================================

describe('PGV-003 — magic numbers in service files', () => {
  it('flags a 4-digit literal in a service arithmetic expression', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/application/services/pricing.ts',
        'export function price(x: number) { return x * 1550; }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-003')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('does not flag year literals (1900-2100)', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/application/services/reports.ts',
        'const fiscalYear = 2026; export function r() { return fiscalYear; }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-003')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does not flag numbers inside Zod .default() calls', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/domain/services/config.ts',
        'export const PortSchema = z.coerce.number().default(3000);');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-003')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does not flag numbers inside string literals', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/application/services/greeter.ts',
        'export const msg = "Target cost: $1550 USD";');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-003')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-004 — audit trail on state mutations
// ============================================================================

describe('PGV-004 — audit trail on mutations', () => {
  it('flags service file with repo.save() but no audit.append()', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/application/services/order-service.ts', [
        'export class OrderService {',
        '  constructor(private repo: OrderRepository) {}',
        '  async submit(order: Order) { await this.repo.save(order); }',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-004')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when audit.append() is called alongside mutation', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/application/services/order-service.ts', [
        'export class OrderService {',
        '  constructor(private repo: OrderRepository, private audit: AuditService) {}',
        '  async submit(order: Order) {',
        '    await this.repo.save(order);',
        '    this.audit.append({ action: "order_submitted", entityId: order.id });',
        '  }',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-004')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-005 — console.* in production code
// ============================================================================

describe('PGV-005 — console.* in production code', () => {
  it('flags console.log in a domain file', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/domain/pricing.ts',
        'export function p(x: number) { console.log("computing", x); return x; }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-005')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('does not flag console.* in demo.ts', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/demo.ts', 'console.log("welcome");');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-005')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does not flag console.* in test files', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/domain/pricing.test.ts', 'console.log("test debug");');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-005')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-006 — route files have sibling tests
// ============================================================================

describe('PGV-006 — route test coverage', () => {
  it('flags a route file with no sibling .test.ts', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/routes/orders.ts', 'export const ordersRoute = {};');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-006')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when a sibling test file exists', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/routes/orders.ts', 'export const ordersRoute = {};');
      writeFile(dir, 'src/server/routes/orders.test.ts', 'import { ordersRoute } from "./orders.js";');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-006')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-007 — seed data Zod validation
// ============================================================================

describe('PGV-007 — seed data validation', () => {
  it('flags src/data/seed.ts without .parse() or .safeParse()', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/data/seed.ts',
        'export const seedUsers = [{ id: "1", name: "Alice" }];');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-007')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when seed is validated with .parse()', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/data/seed.ts', [
        'const rawSeed = [{ id: "1", name: "Alice" }];',
        'export const seedUsers = z.array(UserSchema).parse(rawSeed);',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-007')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-008 — Record<string, unknown> in public DTOs
// ============================================================================

describe('PGV-008 — Record<string, unknown> in public types', () => {
  it('flags Record<string, unknown> in a contract file', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/contracts/api.ts',
        'export interface ApiResponse { data: Record<string, unknown>; }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-008')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes with a concrete interface', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/contracts/api.ts',
        'export interface ApiResponse { data: { id: string; value: number; }; }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-008')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-009 — circuit breaker has state transition tests
// ============================================================================

describe('PGV-009 — circuit breaker state tests', () => {
  it('flags circuit-breaker.ts with no test covering all three states', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/circuit-breaker.ts',
        'export class CircuitBreaker { state: "closed"|"open"|"half-open" = "closed"; }');
      writeFile(dir, 'src/server/circuit-breaker.test.ts',
        'it("initializes closed", () => { expect(new CircuitBreaker().state).toBe("closed"); });');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-009')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when tests cover closed, open, and half-open', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/server/circuit-breaker.ts',
        'export class CircuitBreaker {}');
      writeFile(dir, 'src/server/circuit-breaker.test.ts', [
        'it("closed state", () => {});',
        'it("open state", () => {});',
        'it("half-open state", () => {});',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-009')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-010 — repository interface has implementation
// ============================================================================

describe('PGV-010 — repository interface implementation', () => {
  it('flags an interface with no class implementing it', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/domain/repositories/order-repository.ts',
        'export interface OrderRepository { save(o: Order): Promise<void>; }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-010')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('passes when a class implements the interface', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/domain/repositories/order-repository.ts',
        'export interface OrderRepository { save(o: Order): Promise<void>; }');
      writeFile(dir, 'src/infrastructure/postgres-order-repository.ts', [
        'export class PostgresOrderRepository implements OrderRepository {',
        '  async save(o: Order): Promise<void> { /* ... */ }',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-010')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-011 — no CommonJS require() in generated TypeScript (ADR-PIPELINE-068)
// ============================================================================

describe('PGV-011 — no CommonJS require()', () => {
  it('flags a top-level require() call in a service file', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/services/lineage.ts', [
        'const manifest = require("./manifest.json");',
        'export const id = manifest.run_id;',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      const pgv11 = report.findings.filter(f => f.ruleId === 'PGV-011');
      expect(pgv11.length).toBeGreaterThanOrEqual(1);
      expect(pgv11[0]!.severity).toBe('error');
      expect(pgv11[0]!.message).toContain('ESM');
    } finally {
      cleanup(dir);
    }
  });

  it('flags a require() inside a try/catch lineage helper', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/config.ts', [
        'export function loadSimulationId(): string {',
        '  try {',
        '    const m = require("../.agentics/plans/manifest.json");',
        '    return m.run_id ?? "sim-unknown";',
        '  } catch { return "sim-unknown"; }',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-011')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag identifiers that merely START with require', () => {
    const dir = makeTempProject();
    try {
      // requireSimulationLineage is a legitimate function name from the
      // ADR-068 scaffold helper. It must not match the require() ban.
      writeFile(dir, 'src/services/start.ts', [
        'import { requireSimulationLineage } from "./simulation-lineage.js";',
        'const lineage = requireSimulationLineage();',
        'export const id = lineage.simulationId;',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-011')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag method calls like obj.require()', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/services/dependencies.ts', [
        'export class DependencySpec {',
        '  require(name: string): boolean { return true; }',
        '}',
        'const spec = new DependencySpec();',
        'spec.require("foo");',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-011')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('allows require() when the file uses createRequire(import.meta.url)', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/services/cjs-bridge.ts', [
        'import { createRequire } from "node:module";',
        'const require = createRequire(import.meta.url);',
        'const cjsLib = require("legacy-cjs-package");',
        'export const lib = cjsLib;',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-011')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag require() in test files', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'tests/lineage.test.ts', [
        'const fixture = require("./fixtures/manifest.json");',
        'test("loads", () => { expect(fixture).toBeTruthy(); });',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-011')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag require() inside a single-line comment', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/services/notes.ts', [
        '// historically this used require("./manifest.json")',
        'export const note = "see ADR-068";',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-011')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// PGV-012 — no scaffold-owned redeclaration (ADR-PIPELINE-069)
// ============================================================================

describe('PGV-012 — scaffold-owned redeclaration', () => {
  it('flags a generator file that redeclares CircuitBreaker', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/erp/circuit-breaker-impl.ts', [
        '// Generator-emitted duplicate of the scaffold class.',
        'export class CircuitBreaker {',
        '  constructor(private readonly name: string) {}',
        '  async call<T>(fn: () => Promise<T>): Promise<T> { return fn(); }',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      const pgv12 = report.findings.filter(f => f.ruleId === 'PGV-012');
      expect(pgv12.length).toBeGreaterThanOrEqual(1);
      expect(pgv12[0]!.severity).toBe('error');
      expect(pgv12[0]!.message).toContain('CircuitBreaker');
    } finally {
      cleanup(dir);
    }
  });

  it('flags a redeclaration of createLogger', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/services/my-logger.ts', [
        'export function createLogger(service: string) {',
        '  return { info() {}, warn() {}, error() {} };',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-012' && f.message.includes('createLogger'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('flags a re-export of a scaffold-owned name from a non-scaffold file', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/index.ts', [
        '// Re-exporting a scaffold name from a generator-owned barrel is wrong;',
        '// importers should pull from the scaffold path directly.',
        'export { CircuitBreaker } from "./services/breaker.js";',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.some(f => f.ruleId === 'PGV-012')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag the scaffolded files themselves', () => {
    const dir = makeTempProject();
    try {
      // The actual scaffolded circuit-breaker.ts is allowed to declare CircuitBreaker.
      writeFile(dir, 'src/circuit-breaker.ts',
        'export class CircuitBreaker { constructor(private name: string) {} }');
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-012')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag a class that imports CircuitBreaker (consumer code)', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'src/erp/opera-adapter.ts', [
        'import { CircuitBreaker } from "../circuit-breaker.js";',
        'export class OperaAdapter {',
        '  private breaker = new CircuitBreaker("opera");',
        '}',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-012')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT flag tests that declare a stub CircuitBreaker', () => {
    const dir = makeTempProject();
    try {
      writeFile(dir, 'tests/circuit-breaker.test.ts', [
        'export class CircuitBreaker { call(fn: () => unknown) { return fn(); } }',
      ].join('\n'));
      const report = validateGeneratedCode(dir);
      expect(report.findings.filter(f => f.ruleId === 'PGV-012')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ============================================================================
// Stage Entry Point
// ============================================================================

describe('executePostGenerationValidator — stage entry point', () => {
  function buildContext(phase5Dir: string): Phase5BuildContext {
    return {
      traceId: 'test-trace-postgen',
      phase2Dir: path.join(phase5Dir, '.phase2-merged'),
      phase3Dir: path.join(phase5Dir, 'codegen'),
      phase4Dir: path.join(phase5Dir, 'deploy'),
      phase5Dir,
      scenarioQuery: 'test',
      platformRepoPaths: {},
      telemetrySpans: [],
    };
  }

  it('returns status failed with ECLI-P5-041 when no generated project exists', () => {
    const dir = makeTempProject();
    try {
      const ctx = buildContext(dir);
      const { stageOutput } = executePostGenerationValidator(ctx);
      expect(stageOutput.stage).toBe('post-generation-validation');
      expect(stageOutput.status).toBe('failed');
      expect(stageOutput.summary).toContain('ECLI-P5-041');
      expect(stageOutput.data.projectDir).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it('resolves to deploy/project when it exists', () => {
    const dir = makeTempProject();
    try {
      const deployProject = path.join(dir, 'deploy', 'project');
      fs.mkdirSync(deployProject, { recursive: true });
      writeFile(deployProject, 'src/server/app.ts', 'export const app = new Hono<{ Variables: {} }>();');
      const ctx = buildContext(dir);
      const { stageOutput } = executePostGenerationValidator(ctx);
      expect(stageOutput.status).toBe('completed');
      expect(stageOutput.data.projectDir).toBe(deployProject);
      expect(stageOutput.data.filesScanned).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('falls back to codegen/project when deploy/project is absent', () => {
    const dir = makeTempProject();
    try {
      const codegenProject = path.join(dir, 'codegen', 'project');
      fs.mkdirSync(codegenProject, { recursive: true });
      writeFile(codegenProject, 'src/index.ts', 'export const x = 1;');
      const ctx = buildContext(dir);
      const { stageOutput } = executePostGenerationValidator(ctx);
      expect(stageOutput.status).toBe('completed');
      expect(stageOutput.data.projectDir).toBe(codegenProject);
    } finally {
      cleanup(dir);
    }
  });

  it('writes post-generation-report.json artifact', () => {
    const dir = makeTempProject();
    try {
      const deployProject = path.join(dir, 'deploy', 'project');
      fs.mkdirSync(deployProject, { recursive: true });
      writeFile(deployProject, 'src/index.ts', 'export const x = 1;');
      const ctx = buildContext(dir);
      const { stageOutput } = executePostGenerationValidator(ctx);
      const reportPath = path.join(dir, 'post-generation-report.json');
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(stageOutput.artifacts).toContain(reportPath);
      const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      expect(parsed.rulesApplied).toBe(12);
    } finally {
      cleanup(dir);
    }
  });

  it('in strict mode, any error-level finding fails the stage', () => {
    const dir = makeTempProject();
    const originalStrict = process.env['AGENTICS_STRICT_POSTGEN'];
    try {
      const deployProject = path.join(dir, 'deploy', 'project');
      fs.mkdirSync(deployProject, { recursive: true });
      writeFile(deployProject, 'src/server/app.ts',
        'const id = c.get(\'correlationId\') as string;');
      process.env['AGENTICS_STRICT_POSTGEN'] = 'true';
      const ctx = buildContext(dir);
      const { stageOutput } = executePostGenerationValidator(ctx);
      expect(stageOutput.status).toBe('failed');
      expect(stageOutput.summary).toContain('ECLI-P5-040');
      expect(stageOutput.data.errorCount).toBeGreaterThan(0);
    } finally {
      if (originalStrict === undefined) {
        delete process.env['AGENTICS_STRICT_POSTGEN'];
      } else {
        process.env['AGENTICS_STRICT_POSTGEN'] = originalStrict;
      }
      cleanup(dir);
    }
  });

  it('in non-strict mode, error findings do NOT fail the stage', () => {
    const dir = makeTempProject();
    const originalStrict = process.env['AGENTICS_STRICT_POSTGEN'];
    try {
      const deployProject = path.join(dir, 'deploy', 'project');
      fs.mkdirSync(deployProject, { recursive: true });
      writeFile(deployProject, 'src/server/app.ts',
        'const id = c.get(\'correlationId\') as string;');
      delete process.env['AGENTICS_STRICT_POSTGEN'];
      const ctx = buildContext(dir);
      const { stageOutput } = executePostGenerationValidator(ctx);
      expect(stageOutput.status).toBe('completed');
      expect(stageOutput.data.errorCount).toBeGreaterThan(0);
    } finally {
      if (originalStrict !== undefined) {
        process.env['AGENTICS_STRICT_POSTGEN'] = originalStrict;
      }
      cleanup(dir);
    }
  });
});
