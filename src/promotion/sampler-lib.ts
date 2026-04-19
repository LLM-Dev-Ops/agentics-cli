/**
 * Pure logic for the promotion sampler (ADR-PIPELINE-084 §2.1).
 *
 * Parses, filters, and samples domain agent findings for human FP-rate review.
 * The CLI wrapper lives in tools/promotion-sampler.ts and handles I/O + args;
 * all deterministic logic is here and independently testable.
 */

export interface Finding {
  id: string;
  timestamp: string;
  domain: string;
  agent: string;
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  blocking: boolean;
  summary: string;
}

export interface SampleOptions {
  /** Random seed for reproducibility in tests. */
  seed?: number;
}

/**
 * Parse a blob that is either JSON array of findings or newline-delimited
 * JSON (JSONL). Returns [] for empty input.
 */
export function parseFindings(raw: string): Finding[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as Finding[];
    return Array.isArray(arr) ? arr : [];
  }

  return trimmed
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as Finding);
}

/**
 * Keep findings from the specified domain whose timestamps fall within
 * [now - windowDays, now].
 */
export function filterInWindow(
  findings: Finding[],
  domain: string,
  windowDays: number,
  now: Date = new Date(),
): Finding[] {
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return findings.filter(f => {
    if (f.domain !== domain) return false;
    const ts = new Date(f.timestamp);
    return ts >= cutoff && ts <= now;
  });
}

/**
 * Keep only blocking findings (ADR-084 §2 — FP rate is computed against
 * findings the agent marked blocking).
 */
export function filterBlocking(findings: Finding[]): Finding[] {
  return findings.filter(f => f.blocking === true);
}

/**
 * Draw a random sample. Size = max(floor(0.1 * N), 30), capped at 200.
 * If N ≤ 30, returns everything.
 */
export function drawSample(findings: Finding[], options: SampleOptions = {}): Finding[] {
  const n = findings.length;
  if (n === 0) return [];
  if (n <= 30) return [...findings];

  const tenPercent = Math.floor(n * 0.1);
  const targetSize = Math.min(Math.max(tenPercent, 30), 200);

  const rng = makeRng(options.seed ?? Date.now());
  const copy = [...findings];

  for (let i = 0; i < targetSize; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }

  return copy.slice(0, targetSize);
}

function makeRng(seed: number): () => number {
  // Mulberry32 — deterministic, seedable PRNG for reproducible tests.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Emit a CSV with a blank fp_label column for the reviewer.
 */
export function toCsv(sample: Finding[]): string {
  const header = 'id,timestamp,domain,agent,severity,blocking,summary,fp_label';
  const rows = sample.map(f => {
    const summary = escapeCsv(f.summary ?? '');
    return [f.id, f.timestamp, f.domain, f.agent, f.severity, f.blocking, summary, ''].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

function escapeCsv(value: string): string {
  if (/[,"\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
