/**
 * MetaHarness Witness — ADR-PIPELINE-119
 *
 * London-school unit tests exercising the REAL Ed25519 crypto path
 * (`node:crypto`). A keypair is generated in-test, its private PEM written to a
 * temp file and pointed at via AGENTICS_WITNESS_KEY. Every test is hermetic
 * (offline, temp dirs) and restores process.env in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeContentManifest,
  canonicalizeManifest,
  signWitness,
  verifyWitness,
} from '../../../src/pipeline/metaharness-witness.js';

/** Write a file, creating parent directories as needed. */
function writeFile(abs: string, contents: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf-8');
}

/** Seed a runDir with a small, representative deliverable pack. */
function seedPack(runDir: string): void {
  writeFile(path.join(runDir, 'deliverables', 'a.txt'), 'alpha\n');
  writeFile(path.join(runDir, 'deliverables', 'sub', 'b.txt'), 'bravo\n');
  writeFile(path.join(runDir, 'phase4', 'adrs', 'ADR-001.md'), '# adr\n');
  writeFile(path.join(runDir, 'manifest.json'), '{"trace":"t"}\n');
}

describe('ADR-119 — MetaHarness Witness', () => {
  let tmpRoot: string;
  let runDir: string;
  let keyPath: string;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env['AGENTICS_WITNESS_KEY'];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-witness-'));
    runDir = path.join(tmpRoot, 'run');
    seedPack(runDir);

    // Real Ed25519 keypair; export the private key PEM to a temp file.
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    keyPath = path.join(tmpRoot, 'witness-ed25519.pem');
    fs.writeFileSync(keyPath, pem, 'utf-8');
    process.env['AGENTICS_WITNESS_KEY'] = keyPath;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env['AGENTICS_WITNESS_KEY'];
    else process.env['AGENTICS_WITNESS_KEY'] = savedKey;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // ---- computeContentManifest ---------------------------------------------

  it('computeContentManifest is deterministic and returns a sorted files[]', () => {
    const m1 = computeContentManifest(runDir, 'trace-1');
    const m2 = computeContentManifest(runDir, 'trace-1');

    expect(m1).toEqual(m2);
    const paths = m1.files.map((f) => f.path);
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toEqual(sorted);
    expect(paths).toContain('deliverables/a.txt');
    expect(paths).toContain('deliverables/sub/b.txt');
    expect(paths).toContain('phase4/adrs/ADR-001.md');
    expect(m1.algorithm).toBe('sha256');
    expect(canonicalizeManifest(m1)).toBe(canonicalizeManifest(m2));
  });

  // ---- sign → verify happy path -------------------------------------------

  it('signs the pack and verifies it end-to-end (verified + signatureValid true)', () => {
    const signed = signWitness(runDir, 'trace-happy', { origin: 'test' });

    expect(signed.signed).toBe(true);
    expect(signed.witnessPath).toBe(path.join(runDir, 'metaharness', 'witness.json'));
    expect(fs.existsSync(signed.witnessPath!)).toBe(true);
    expect(signed.files).toBeGreaterThan(0);

    const result = verifyWitness(runDir);

    expect(result.verified).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.mismatched).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('excludes witness.json from its own signed manifest', () => {
    const signed = signWitness(runDir, 'trace-self');
    expect(signed.signed).toBe(true);

    const witness = JSON.parse(fs.readFileSync(signed.witnessPath!, 'utf-8'));
    const manifestPaths: string[] = witness.manifest.files.map((f: { path: string }) => f.path);

    expect(manifestPaths).not.toContain('metaharness/witness.json');
    // And a fresh manifest computed with the witness present still excludes it.
    const recomputed = computeContentManifest(runDir, 'trace-self');
    expect(recomputed.files.map((f) => f.path)).not.toContain('metaharness/witness.json');
  });

  // ---- tamper / missing / extra -------------------------------------------

  it('detects a tampered file (verified:false, path in mismatched)', () => {
    signWitness(runDir, 'trace-tamper');

    fs.writeFileSync(path.join(runDir, 'deliverables', 'a.txt'), 'ALPHA-CHANGED\n', 'utf-8');

    const result = verifyWitness(runDir);

    expect(result.verified).toBe(false);
    expect(result.mismatched).toContain('deliverables/a.txt');
    expect(result.missing).toEqual([]);
    // Signature over the embedded manifest is still cryptographically valid.
    expect(result.signatureValid).toBe(true);
  });

  it('detects a deleted file (verified:false, path in missing)', () => {
    signWitness(runDir, 'trace-missing');

    fs.rmSync(path.join(runDir, 'deliverables', 'sub', 'b.txt'));

    const result = verifyWitness(runDir);

    expect(result.verified).toBe(false);
    expect(result.missing).toContain('deliverables/sub/b.txt');
    expect(result.mismatched).toEqual([]);
  });

  it('detects an added file under a pack root (verified:false, path in extra)', () => {
    signWitness(runDir, 'trace-extra');

    writeFile(path.join(runDir, 'deliverables', 'new-file.txt'), 'unexpected\n');

    const result = verifyWitness(runDir);

    expect(result.verified).toBe(false);
    expect(result.extra).toContain('deliverables/new-file.txt');
    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.signatureValid).toBe(true);
  });

  // ---- honest no-key behaviour --------------------------------------------

  it('returns {signed:false, reason} and writes NO witness.json when no key is set', () => {
    delete process.env['AGENTICS_WITNESS_KEY'];

    const result = signWitness(runDir, 'trace-nokey');

    expect(result.signed).toBe(false);
    expect(result.reason).toMatch(/no Ed25519 signing key/i);
    expect(result.witnessPath).toBeUndefined();
    expect(fs.existsSync(path.join(runDir, 'metaharness', 'witness.json'))).toBe(false);
  });

  it('accepts an inline PEM value in AGENTICS_WITNESS_KEY (not just a path)', () => {
    process.env['AGENTICS_WITNESS_KEY'] = fs.readFileSync(keyPath, 'utf-8');

    const signed = signWitness(runDir, 'trace-inline');
    expect(signed.signed).toBe(true);
    expect(verifyWitness(runDir).verified).toBe(true);
  });
});
