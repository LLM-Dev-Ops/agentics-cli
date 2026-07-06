/**
 * MetaHarness Witness — ADR-PIPELINE-119
 *
 * Computes a content manifest (path → sha256) over the deliverable pack and
 * signs the canonicalised manifest with Ed25519, producing a verifiable
 * `witness.json`. Verification (`verifyWitness`) recomputes the manifest from a
 * pack on disk and checks every hash + the signature — offline, no network, no
 * LLM.
 *
 * Ed25519 is provided natively by Node's `crypto` (no external dependency). The
 * signing key is resolved from AGENTICS_WITNESS_KEY only (a PEM string or a path
 * to one); the pipeline NEVER generates or writes a private key (ADR-119 §D4).
 * Signing is non-blocking and honest: when no key is available or signing fails,
 * the result records `signed: false` with a reason — never a fake signature
 * (ADR-116).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WitnessFileEntry {
  readonly path: string; // pack-relative, forward-slash normalised
  readonly sha256: string;
  readonly size: number;
}

export interface ContentManifest {
  readonly algorithm: 'sha256';
  readonly trace_id: string;
  readonly files: readonly WitnessFileEntry[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Witness {
  readonly algorithm: 'ed25519';
  readonly trace_id: string;
  readonly content_manifest_sha256: string;
  readonly signature: string; // base64
  readonly public_key: string; // base64 (DER/SPKI)
  readonly files: number;
  readonly manifest: ContentManifest;
}

export interface SignResult {
  readonly signed: boolean;
  readonly reason?: string;
  readonly witnessPath?: string;
  readonly files?: number;
}

export interface VerifyResult {
  readonly verified: boolean;
  readonly reason: string;
  readonly mismatched: string[];
  readonly missing: string[];
  readonly extra: string[];
  readonly signatureValid: boolean;
}

/** Default pack roots (relative to runDir) that make up the signed deliverable
 * bundle. Only those that exist on disk are enumerated. */
const DEFAULT_PACK_ROOTS: readonly string[] = [
  'deliverables',
  'phase4/adrs',
  'phase4/ddd',
  'phase5/project',
  'phase6/project',
  'metaharness',
];

/** Single files (relative to runDir) included when present. */
const DEFAULT_PACK_FILES: readonly string[] = [
  'phase6/erp-surface-mapping.json',
  'phase6/phase6-manifest.json',
  'manifest.json',
];

function sha256File(abs: string): string {
  const buf = fs.readFileSync(abs);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256String(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** Recursively collect regular files under `dir`. Never throws. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkFiles(abs));
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Enumerate the deliverable pack under `runDir` and compute the content
 * manifest. `witness.json` itself is always excluded so signing is stable.
 */
export function computeContentManifest(
  runDir: string,
  traceId: string,
  metadata: Record<string, unknown> = {},
  roots: readonly string[] = DEFAULT_PACK_ROOTS,
  singles: readonly string[] = DEFAULT_PACK_FILES,
): ContentManifest {
  const absFiles = new Set<string>();
  for (const r of roots) {
    const abs = path.join(runDir, r);
    if (fs.existsSync(abs)) {
      for (const f of walkFiles(abs)) absFiles.add(f);
    }
  }
  for (const s of singles) {
    const abs = path.join(runDir, s);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) absFiles.add(abs);
  }

  const witnessAbs = path.join(runDir, 'metaharness', 'witness.json');
  const entries: WitnessFileEntry[] = [];
  for (const abs of absFiles) {
    if (abs === witnessAbs) continue; // never sign the witness over itself
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    entries.push({
      path: path.relative(runDir, abs).split(path.sep).join('/'),
      sha256: sha256File(abs),
      size,
    });
  }
  // Deterministic ordering — the manifest must be reproducible for verification.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { algorithm: 'sha256', trace_id: traceId, files: entries, metadata };
}

/** Canonical JSON of the content manifest (stable key order) for hashing/signing. */
export function canonicalizeManifest(m: ContentManifest): string {
  // files[] is already sorted; JSON.stringify with sorted top-level keys.
  const ordered = {
    algorithm: m.algorithm,
    trace_id: m.trace_id,
    files: m.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    metadata: m.metadata,
  };
  return JSON.stringify(ordered);
}

/**
 * Load the Ed25519 private key from AGENTICS_WITNESS_KEY (a PEM string or a path
 * to a PEM file). Returns null when unset or unreadable/invalid. The pipeline
 * never generates a key (ADR-119 §D4).
 */
function loadPrivateKey(): crypto.KeyObject | null {
  const raw = process.env['AGENTICS_WITNESS_KEY']?.trim();
  if (!raw) return null;
  let pem = raw;
  try {
    // Treat as a path if it points at an existing file; else treat as inline PEM.
    if (!raw.includes('BEGIN') && fs.existsSync(raw) && fs.statSync(raw).isFile()) {
      pem = fs.readFileSync(raw, 'utf-8');
    }
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * Sign the deliverable pack under `runDir`. Writes `<runDir>/metaharness/witness.json`
 * on success. Non-blocking and honest: returns `{ signed: false, reason }` when no
 * key is available or signing fails — never writes a placeholder witness.
 */
export function signWitness(
  runDir: string,
  traceId: string,
  metadata: Record<string, unknown> = {},
): SignResult {
  const key = loadPrivateKey();
  if (!key) {
    return {
      signed: false,
      reason: 'no Ed25519 signing key (set AGENTICS_WITNESS_KEY to a PEM path/value)',
    };
  }

  const manifest = computeContentManifest(runDir, traceId, metadata);
  const canonical = canonicalizeManifest(manifest);
  const manifestHash = sha256String(canonical);

  let signature: Buffer;
  let publicKeyDer: Buffer;
  try {
    signature = crypto.sign(null, Buffer.from(canonical, 'utf-8'), key);
    publicKeyDer = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  } catch (err) {
    return { signed: false, reason: `signing failed: ${(err as Error).message}` };
  }

  const witness: Witness = {
    algorithm: 'ed25519',
    trace_id: traceId,
    content_manifest_sha256: manifestHash,
    signature: signature.toString('base64'),
    public_key: publicKeyDer.toString('base64'),
    files: manifest.files.length,
    manifest,
  };

  try {
    const outDir = path.join(runDir, 'metaharness');
    fs.mkdirSync(outDir, { recursive: true });
    const witnessPath = path.join(outDir, 'witness.json');
    fs.writeFileSync(witnessPath, JSON.stringify(witness, null, 2) + '\n', 'utf-8');
    return { signed: true, witnessPath, files: witness.files };
  } catch (err) {
    return { signed: false, reason: `witness write failed: ${(err as Error).message}` };
  }
}

/**
 * Verify a witness against a pack on disk. Recomputes each file's hash and
 * checks the Ed25519 signature over the canonical manifest. Offline; no deps.
 *
 * @param packRoot the run/pack directory that the witness's paths are relative to
 * @param witnessPath path to witness.json (defaults to <packRoot>/metaharness/witness.json)
 */
export function verifyWitness(packRoot: string, witnessPath?: string): VerifyResult {
  const wPath = witnessPath ?? path.join(packRoot, 'metaharness', 'witness.json');
  let witness: Witness;
  try {
    witness = JSON.parse(fs.readFileSync(wPath, 'utf-8')) as Witness;
  } catch (err) {
    return {
      verified: false,
      reason: `cannot read witness at ${wPath}: ${(err as Error).message}`,
      mismatched: [],
      missing: [],
      extra: [],
      signatureValid: false,
    };
  }

  // 1. Verify the signature over the embedded canonical manifest.
  const canonical = canonicalizeManifest(witness.manifest);
  let signatureValid = false;
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.from(witness.public_key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    signatureValid = crypto.verify(
      null,
      Buffer.from(canonical, 'utf-8'),
      pub,
      Buffer.from(witness.signature, 'base64'),
    );
  } catch {
    signatureValid = false;
  }

  // 2. Recompute file hashes from disk and diff against the manifest.
  const mismatched: string[] = [];
  const missing: string[] = [];
  const manifestPaths = new Set(witness.manifest.files.map((f) => f.path));
  for (const entry of witness.manifest.files) {
    const abs = path.join(packRoot, entry.path);
    if (!fs.existsSync(abs)) {
      missing.push(entry.path);
      continue;
    }
    if (sha256File(abs) !== entry.sha256) mismatched.push(entry.path);
  }

  // 3. Detect files present in the pack roots but absent from the manifest.
  const recomputed = computeContentManifest(packRoot, witness.trace_id, witness.manifest.metadata);
  const extra = recomputed.files
    .map((f) => f.path)
    .filter((p) => !manifestPaths.has(p));

  const clean = signatureValid && mismatched.length === 0 && missing.length === 0 && extra.length === 0;
  return {
    verified: clean,
    reason: clean
      ? `VERIFIED — ${witness.files} files, Ed25519 signature valid`
      : `verification failed (sig=${signatureValid}, mismatched=${mismatched.length}, missing=${missing.length}, extra=${extra.length})`,
    mismatched,
    missing,
    extra,
    signatureValid,
  };
}
