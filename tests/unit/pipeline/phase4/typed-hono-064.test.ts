/**
 * ADR-PIPELINE-064 verification: the http-server-generator emits Hono code
 * that passes the post-generation validator's PGV-001 and PGV-002 rules
 * (typed Hono context variables, no `as string` casts).
 *
 * This is the proof that ADR-PIPELINE-064 is actually implemented — not just
 * documented. We build a tiny generated-project tree from the three generator
 * helpers and run the real validator against it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  tsServerTypes,
  tsMiddleware,
  tsHealth,
} from '../../../../src/pipeline/phase4/phases/http-server-generator.js';
import { validateGeneratedCode } from '../../../../src/pipeline/phase5-build/phases/post-generation-validator.js';

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adr-064-test-'));
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

describe('ADR-PIPELINE-064 — typed Hono context variables', () => {
  describe('tsServerTypes()', () => {
    it('emits ContextVariables interface with correlationId', () => {
      const content = tsServerTypes();
      expect(content).toContain('export interface ContextVariables');
      expect(content).toContain('correlationId: string');
    });

    it('emits IamClaims interface with standard JWT fields', () => {
      const content = tsServerTypes();
      expect(content).toContain('export interface IamClaims');
      expect(content).toContain('sub?: string');
      expect(content).toContain('roles?: string[]');
    });

    it('emits AppEnv type alias usable as Hono generic', () => {
      const content = tsServerTypes();
      expect(content).toContain('export type AppEnv = { Variables: ContextVariables }');
    });
  });

  describe('tsMiddleware()', () => {
    it('imports AppEnv from ./types.js', () => {
      const content = tsMiddleware();
      expect(content).toContain("import type { AppEnv, IamClaims } from './types.js'");
    });

    it('parameterizes createMiddleware with AppEnv', () => {
      const content = tsMiddleware();
      expect(content).toContain('createMiddleware<AppEnv>');
      expect(content).not.toMatch(/createMiddleware\(async/);
    });

    it('does not emit `as string` casts on context reads', () => {
      const content = tsMiddleware();
      expect(content).not.toMatch(/c\.get\(['"][\w-]+['"]\)\s*as\s+string/);
    });

    it('type-narrows JWT payload before c.set("iamClaims", ...)', () => {
      const content = tsMiddleware();
      expect(content).toContain("typeof payload === 'string'");
      expect(content).toContain('payload as IamClaims');
    });
  });

  describe('tsHealth()', () => {
    it('imports AppEnv and parameterizes Hono<AppEnv>', () => {
      const content = tsHealth();
      expect(content).toContain("import type { AppEnv } from './types.js'");
      expect(content).toContain('new Hono<AppEnv>()');
      expect(content).toContain('createHealthRouter');
    });

    it('does not emit bare `new Hono()` without generic', () => {
      const content = tsHealth();
      // Match `new Hono(` NOT followed by `<`
      expect(content).not.toMatch(/new\s+Hono\s*\((?!\s*<)/);
    });
  });

  describe('end-to-end: post-gen validator against generator output', () => {
    it('emits code that passes PGV-001 (no `as string` casts on context)', () => {
      const dir = makeTempProject();
      try {
        writeFile(dir, 'src/server/types.ts', tsServerTypes());
        writeFile(dir, 'src/server/middleware.ts', tsMiddleware());
        writeFile(dir, 'src/server/health.ts', tsHealth());

        const report = validateGeneratedCode(dir);
        const pgv001 = report.findings.filter(f => f.ruleId === 'PGV-001');

        if (pgv001.length > 0) {
          // eslint-disable-next-line no-console
          console.error('PGV-001 findings:', JSON.stringify(pgv001, null, 2));
        }
        expect(pgv001).toHaveLength(0);
      } finally {
        cleanup(dir);
      }
    });

    it('emits code that passes PGV-002 (Hono typed with Variables generic)', () => {
      const dir = makeTempProject();
      try {
        writeFile(dir, 'src/server/types.ts', tsServerTypes());
        writeFile(dir, 'src/server/middleware.ts', tsMiddleware());
        writeFile(dir, 'src/server/health.ts', tsHealth());

        const report = validateGeneratedCode(dir);
        const pgv002 = report.findings.filter(f => f.ruleId === 'PGV-002');

        if (pgv002.length > 0) {
          // eslint-disable-next-line no-console
          console.error('PGV-002 findings:', JSON.stringify(pgv002, null, 2));
        }
        expect(pgv002).toHaveLength(0);
      } finally {
        cleanup(dir);
      }
    });

    it('emits a scannable types.ts, middleware.ts, and health.ts', () => {
      const dir = makeTempProject();
      try {
        writeFile(dir, 'src/server/types.ts', tsServerTypes());
        writeFile(dir, 'src/server/middleware.ts', tsMiddleware());
        writeFile(dir, 'src/server/health.ts', tsHealth());

        const report = validateGeneratedCode(dir);
        expect(report.filesScanned).toBe(3);
        expect(report.rulesApplied).toBe(10);
      } finally {
        cleanup(dir);
      }
    });
  });
});
