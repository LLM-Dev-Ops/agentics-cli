/**
 * ADR-PIPELINE-078 tests: deep canonical JSON for audit hash chains.
 *
 * Two layers:
 *   1. Static contract on CANONICAL_JSON_SCAFFOLD + AUDIT_HASH_SCAFFOLD
 *   2. Runtime: transpile + dynamic-import, exercise canonicalJson for
 *      determinism at every depth, rejection of invalid inputs, and
 *      hashAuditEntry consistency + tamper detection
 *
 * Also verifies OWNED_SCAFFOLD_MODULES entries.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

import {
  CANONICAL_JSON_SCAFFOLD,
  AUDIT_HASH_SCAFFOLD,
  OWNED_SCAFFOLD_MODULES,
} from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr078-${label}-`));
}

function transpileToMjs(source: string, outPath: string, tsName: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
    },
    fileName: tsName,
    reportDiagnostics: false,
  });
  let out = compiled.outputText;
  // Rewrite the audit-hash import to point at the sibling canonical-json.mjs
  out = out.replace(
    /from\s+['"]\.\/canonical-json\.js['"]/g,
    `from '${pathToFileURL(path.join(path.dirname(outPath), 'canonical-json.mjs')).href}'`,
  );
  fs.writeFileSync(outPath, out, 'utf-8');
}

interface CanonicalExports {
  canonicalJson: (value: unknown) => string;
  CanonicalJsonError: new (msg: string) => Error;
}

interface AuditHashExports {
  hashAuditEntry: (input: {
    prevHash: string;
    entryId: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    payload: unknown;
    createdAt: string;
  }) => string;
}

async function loadCanonical(dir: string): Promise<CanonicalExports> {
  transpileToMjs(CANONICAL_JSON_SCAFFOLD, path.join(dir, 'canonical-json.mjs'), 'canonical-json.ts');
  const url = pathToFileURL(path.join(dir, 'canonical-json.mjs')).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)) as CanonicalExports;
}

async function loadAuditHash(dir: string): Promise<AuditHashExports> {
  transpileToMjs(CANONICAL_JSON_SCAFFOLD, path.join(dir, 'canonical-json.mjs'), 'canonical-json.ts');
  transpileToMjs(AUDIT_HASH_SCAFFOLD, path.join(dir, 'audit-hash.mjs'), 'audit-hash.ts');
  const url = pathToFileURL(path.join(dir, 'audit-hash.mjs')).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)) as AuditHashExports;
}

// ============================================================================
// Static contract
// ============================================================================

describe('ADR-078 — CANONICAL_JSON_SCAFFOLD static contract', () => {
  it('exports canonicalJson + CanonicalJsonError', () => {
    expect(CANONICAL_JSON_SCAFFOLD).toContain('export function canonicalJson');
    expect(CANONICAL_JSON_SCAFFOLD).toContain('export class CanonicalJsonError');
    expect(CANONICAL_JSON_SCAFFOLD).toContain('ECLI-CJ-078');
  });

  it('sorts keys at every depth via Object.keys().sort()', () => {
    expect(CANONICAL_JSON_SCAFFOLD).toContain('Object.keys(record).sort()');
  });

  it('rejects undefined, BigInt, and circular references', () => {
    expect(CANONICAL_JSON_SCAFFOLD).toContain('undefined is not canonicalizable');
    expect(CANONICAL_JSON_SCAFFOLD).toContain('BigInt is not canonicalizable');
    expect(CANONICAL_JSON_SCAFFOLD).toContain('circular reference');
  });
});

describe('ADR-078 — AUDIT_HASH_SCAFFOLD static contract', () => {
  it('exports hashAuditEntry + HashChainInput', () => {
    expect(AUDIT_HASH_SCAFFOLD).toContain('export function hashAuditEntry');
    expect(AUDIT_HASH_SCAFFOLD).toContain('export interface HashChainInput');
  });

  it('imports canonicalJson from the canonical-json scaffold', () => {
    expect(AUDIT_HASH_SCAFFOLD).toContain("from './canonical-json.js'");
    expect(AUDIT_HASH_SCAFFOLD).toContain('canonicalJson');
  });

  it('uses SHA-256 via createHash', () => {
    expect(AUDIT_HASH_SCAFFOLD).toContain("createHash('sha256')");
  });
});

// ============================================================================
// OWNED_SCAFFOLD_MODULES
// ============================================================================

describe('ADR-078 — OWNED_SCAFFOLD_MODULES entries', () => {
  it('lists both canonical-json and audit-hash files', () => {
    const paths = OWNED_SCAFFOLD_MODULES.map(m => m.path);
    expect(paths).toContain('src/persistence/canonical-json.ts');
    expect(paths).toContain('src/persistence/audit-hash.ts');
  });

  it('canonical-json exports canonicalJson + CanonicalJsonError', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/persistence/canonical-json.ts');
    expect(entry?.exports).toContain('canonicalJson');
    expect(entry?.exports).toContain('CanonicalJsonError');
  });

  it('audit-hash exports hashAuditEntry + HashChainInput', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/persistence/audit-hash.ts');
    expect(entry?.exports).toContain('hashAuditEntry');
    expect(entry?.exports).toContain('HashChainInput');
  });
});

// ============================================================================
// Runtime — canonicalJson
// ============================================================================

describe('ADR-078 — canonicalJson runtime', () => {
  it('produces identical output for {b:1, a:2} and {a:2, b:1}', async () => {
    const dir = mkTempDir('canon-simple');
    try {
      const mod = await loadCanonical(dir);
      expect(mod.canonicalJson({ b: 1, a: 2 })).toBe(mod.canonicalJson({ a: 2, b: 1 }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts keys at nested depths', async () => {
    const dir = mkTempDir('canon-nested');
    try {
      const mod = await loadCanonical(dir);
      const a = mod.canonicalJson({ x: { b: 1, a: 2 }, y: 3 });
      const b = mod.canonicalJson({ y: 3, x: { a: 2, b: 1 } });
      expect(a).toBe(b);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves array order', async () => {
    const dir = mkTempDir('canon-array');
    try {
      const mod = await loadCanonical(dir);
      const a = mod.canonicalJson([1, 2, 3]);
      const b = mod.canonicalJson([3, 2, 1]);
      expect(a).not.toBe(b);
      expect(a).toBe('[1,2,3]');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-finite numbers', async () => {
    const dir = mkTempDir('canon-nan');
    try {
      const mod = await loadCanonical(dir);
      expect(() => mod.canonicalJson(NaN)).toThrow(/non-finite/);
      expect(() => mod.canonicalJson(Infinity)).toThrow(/non-finite/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects BigInt', async () => {
    const dir = mkTempDir('canon-bigint');
    try {
      const mod = await loadCanonical(dir);
      expect(() => mod.canonicalJson(BigInt(42))).toThrow(/BigInt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects circular references', async () => {
    const dir = mkTempDir('canon-circular');
    try {
      const mod = await loadCanonical(dir);
      const obj: Record<string, unknown> = { a: 1 };
      obj['self'] = obj;
      expect(() => mod.canonicalJson(obj)).toThrow(/circular/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles null, booleans, and strings', async () => {
    const dir = mkTempDir('canon-primitives');
    try {
      const mod = await loadCanonical(dir);
      expect(mod.canonicalJson(null)).toBe('null');
      expect(mod.canonicalJson(true)).toBe('true');
      expect(mod.canonicalJson(false)).toBe('false');
      expect(mod.canonicalJson('hello')).toBe('"hello"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips undefined object properties', async () => {
    const dir = mkTempDir('canon-undef-prop');
    try {
      const mod = await loadCanonical(dir);
      expect(mod.canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Runtime — hashAuditEntry
// ============================================================================

describe('ADR-078 — hashAuditEntry runtime', () => {
  const base = {
    prevHash: '0'.repeat(64),
    entryId: 'e1',
    actor: 'alice',
    action: 'create',
    entityType: 'Recommendation',
    entityId: 'rec-1',
    payload: { score: 0.85, decision: { risk: 'low' } },
    createdAt: '2026-04-12T00:00:00Z',
  };

  it('produces a 64-char hex hash (SHA-256)', async () => {
    const dir = mkTempDir('hash-shape');
    try {
      const mod = await loadAuditHash(dir);
      const h = mod.hashAuditEntry(base);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces identical hashes regardless of payload key insertion order', async () => {
    const dir = mkTempDir('hash-order');
    try {
      const mod = await loadAuditHash(dir);
      const h1 = mod.hashAuditEntry({
        ...base,
        payload: { decision: { risk: 'low' }, score: 0.85 },
      });
      const h2 = mod.hashAuditEntry(base);
      expect(h1).toBe(h2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nested payload mutation changes the hash', async () => {
    const dir = mkTempDir('hash-mutation');
    try {
      const mod = await loadAuditHash(dir);
      const h1 = mod.hashAuditEntry(base);
      const h2 = mod.hashAuditEntry({
        ...base,
        payload: { score: 0.85, decision: { risk: 'HIGH' } },
      });
      expect(h1).not.toBe(h2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('previous hash changes the output', async () => {
    const dir = mkTempDir('hash-prevhash');
    try {
      const mod = await loadAuditHash(dir);
      const h1 = mod.hashAuditEntry(base);
      const h2 = mod.hashAuditEntry({ ...base, prevHash: 'f'.repeat(64) });
      expect(h1).not.toBe(h2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
