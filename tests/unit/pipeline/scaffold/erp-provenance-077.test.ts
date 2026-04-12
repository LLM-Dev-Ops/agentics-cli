/**
 * ADR-PIPELINE-077 tests: ERP schema provenance tag.
 *
 * Two layers:
 *   1. Static contract on ERP_SCHEMA_PROVENANCE_SCAFFOLD —
 *      exports, types, ECLI-ERP-077 error code, AGENTICS_ERP_STRICT env check
 *   2. Runtime: transpile + dynamic-import, verify
 *      assertErpProvenanceOrFail throws on strict+invented, passes on
 *      non-strict or validated, and formatProvenanceBanner output shape
 *
 * Also verifies OWNED_SCAFFOLD_MODULES entry.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

import {
  ERP_SCHEMA_PROVENANCE_SCAFFOLD,
  OWNED_SCAFFOLD_MODULES,
} from '../../../../src/pipeline/auto-chain.js';

// ============================================================================
// Helpers
// ============================================================================

function mkTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adr077-${label}-`));
}

function writeScaffoldAsMjs(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const compiled = ts.transpileModule(ERP_SCHEMA_PROVENANCE_SCAFFOLD, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
    },
    fileName: 'schema-provenance.ts',
    reportDiagnostics: false,
  });
  const filePath = path.join(targetDir, 'schema-provenance.mjs');
  fs.writeFileSync(filePath, compiled.outputText, 'utf-8');
  return filePath;
}

interface ProvenanceShape {
  erp_system: string;
  module: string;
  source: 'invented' | 'catalog' | 'validated';
  catalog_version: string | null;
  validated_at: string | null;
  reviewer: { name: string; role: string } | null;
  notes: string;
}

interface ScaffoldExports {
  assertErpProvenanceOrFail: (
    provenance: ProvenanceShape,
    env?: Record<string, string | undefined>,
  ) => void;
  formatProvenanceBanner: (provenance: ProvenanceShape) => string;
  printProvenanceBanner: (provenance: ProvenanceShape) => void;
}

async function loadScaffold(filePath: string): Promise<ScaffoldExports> {
  const url = pathToFileURL(filePath).href + `?t=${Date.now()}-${Math.random()}`;
  return (await import(url)) as ScaffoldExports;
}

function invented() {
  return {
    erp_system: 'Ramco Aviation',
    module: 'Flight Catering Order',
    source: 'invented' as const,
    catalog_version: null,
    validated_at: null,
    reviewer: null,
    notes: 'Not validated.',
  };
}

function validated() {
  return {
    erp_system: 'Oracle OPERA',
    module: 'Housekeeping Policy',
    source: 'validated' as const,
    catalog_version: 'v2024.1',
    validated_at: '2026-04-12',
    reviewer: { name: 'Jane Doe', role: 'Integration Lead' },
    notes: 'Reviewed against live Oracle catalog.',
  };
}

// ============================================================================
// Static contract
// ============================================================================

describe('ADR-077 — ERP_SCHEMA_PROVENANCE_SCAFFOLD static contract', () => {
  it('exports the ErpSchemaProvenance interface with required fields', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('export interface ErpSchemaProvenance');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('erp_system');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('module');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('source');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('catalog_version');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('validated_at');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('reviewer');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('notes');
  });

  it('ErpProvenanceSource has the three expected values', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain("'invented' | 'catalog' | 'validated'");
  });

  it('exports assertErpProvenanceOrFail with ECLI-ERP-077 error code', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('export function assertErpProvenanceOrFail');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('ECLI-ERP-077');
  });

  it('assertErpProvenanceOrFail checks AGENTICS_ERP_STRICT env var', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('AGENTICS_ERP_STRICT');
  });

  it('exports formatProvenanceBanner', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('export function formatProvenanceBanner');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('ERP SCHEMA PROVENANCE');
  });

  it('exports printProvenanceBanner as a stderr wrapper', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('export function printProvenanceBanner');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('process.stderr.write');
  });

  it('formatProvenanceBanner includes a warning block for invented source', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('WARNING');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('not been validated');
  });

  it('uses ✅ 🟡 ⚠️ icons for validated/catalog/invented', () => {
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('✅');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('🟡');
    expect(ERP_SCHEMA_PROVENANCE_SCAFFOLD).toContain('⚠️');
  });
});

// ============================================================================
// OWNED_SCAFFOLD_MODULES
// ============================================================================

describe('ADR-077 — OWNED_SCAFFOLD_MODULES entry', () => {
  it('lists src/erp/schema-provenance.ts with the expected exports', () => {
    const entry = OWNED_SCAFFOLD_MODULES.find(m => m.path === 'src/erp/schema-provenance.ts');
    expect(entry).toBeDefined();
    expect(entry!.exports).toEqual(
      expect.arrayContaining([
        'ErpProvenanceSource',
        'ErpSchemaProvenance',
        'assertErpProvenanceOrFail',
        'formatProvenanceBanner',
        'printProvenanceBanner',
      ]),
    );
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe('ADR-077 — scaffolded module runtime', () => {
  it('assertErpProvenanceOrFail throws ECLI-ERP-077 on invented + strict', async () => {
    const dir = mkTempDir('strict-invented');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      expect(() =>
        mod.assertErpProvenanceOrFail(invented(), { AGENTICS_ERP_STRICT: 'true' }),
      ).toThrow(/ECLI-ERP-077/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assertErpProvenanceOrFail does NOT throw on invented + non-strict', async () => {
    const dir = mkTempDir('nonstrict-invented');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      expect(() =>
        mod.assertErpProvenanceOrFail(invented(), { AGENTICS_ERP_STRICT: 'false' }),
      ).not.toThrow();
      expect(() =>
        mod.assertErpProvenanceOrFail(invented(), {}),
      ).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assertErpProvenanceOrFail does NOT throw on validated (regardless of strict)', async () => {
    const dir = mkTempDir('validated');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      expect(() =>
        mod.assertErpProvenanceOrFail(validated(), { AGENTICS_ERP_STRICT: 'true' }),
      ).not.toThrow();
      expect(() =>
        mod.assertErpProvenanceOrFail(validated(), {}),
      ).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('error message mentions the ERP system and module', async () => {
    const dir = mkTempDir('error-details');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      try {
        mod.assertErpProvenanceOrFail(invented(), { AGENTICS_ERP_STRICT: 'true' });
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const msg = (err as Error).message;
        expect(msg).toContain('Ramco Aviation');
        expect(msg).toContain('Flight Catering Order');
        expect(msg).toContain("source='invented'");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatProvenanceBanner uses ⚠️ + warning block for invented', async () => {
    const dir = mkTempDir('banner-invented');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      const banner = mod.formatProvenanceBanner(invented());
      expect(banner).toContain('⚠️');
      expect(banner).toContain('ERP SCHEMA PROVENANCE');
      expect(banner).toContain('Ramco Aviation');
      expect(banner).toContain('Flight Catering Order');
      expect(banner).toContain("source: invented");
      expect(banner).toContain('WARNING');
      expect(banner).toContain('AGENTICS_ERP_STRICT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatProvenanceBanner uses ✅ + reviewer line for validated', async () => {
    const dir = mkTempDir('banner-validated');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      const banner = mod.formatProvenanceBanner(validated());
      expect(banner).toContain('✅');
      expect(banner).toContain('Oracle OPERA');
      expect(banner).toContain('v2024.1');
      expect(banner).toContain('2026-04-12');
      expect(banner).toContain('Jane Doe');
      expect(banner).toContain('Integration Lead');
      // Warning block must NOT appear on validated
      expect(banner).not.toContain('WARNING');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatProvenanceBanner uses 🟡 for catalog source', async () => {
    const dir = mkTempDir('banner-catalog');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);
      const p = {
        ...invented(),
        source: 'catalog' as const,
        catalog_version: 'v2024.Q1',
      };
      const banner = mod.formatProvenanceBanner(p);
      expect(banner).toContain('🟡');
      expect(banner).toContain('v2024.Q1');
      expect(banner).not.toContain('WARNING');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('printProvenanceBanner writes to stderr', async () => {
    const dir = mkTempDir('print-banner');
    try {
      const filePath = writeScaffoldAsMjs(dir);
      const mod = await loadScaffold(filePath);

      // Monkey-patch process.stderr.write to capture the emitted string
      const originalWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        captured.push(chunk);
        return true;
      };
      try {
        mod.printProvenanceBanner(invented());
      } finally {
        process.stderr.write = originalWrite;
      }

      const joined = captured.join('');
      expect(joined).toContain('ERP SCHEMA PROVENANCE');
      expect(joined).toContain('Ramco Aviation');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
