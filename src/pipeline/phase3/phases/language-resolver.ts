/**
 * Phase 3 Pipeline -- Stage: Language Resolution
 *
 * Deterministic, pure-function language resolution that scores signals from
 * Phase 2 artifacts (SPARC output, ADRs, DDD domain model) plus the original
 * scenario query to decide between Rust and TypeScript.
 *
 * The resolver is fully deterministic: no I/O, no randomness, no side effects.
 * Given the same inputs it always produces the same LanguageResolution.
 *
 * Twelve signal detectors scan different artifact sources for evidence that
 * favors one language over the other. Each signal carries a weight (importance)
 * and a confidence (strength of evidence). The final score for each language
 * is the sum of (weight * confidence) across all signals favoring that language.
 *
 * An explicit mention of "rust" or "typescript" in the scenario query overrides
 * the scoring algorithm entirely.
 *
 * Error codes:
 *   ECLI-P3-005  No language signals detected and no explicit mention
 *
 * Exports:
 *   resolveLanguage                 - Pure builder (no I/O)
 *   resolveImplementationLanguage   - Pipeline stage entry point
 */

import type {
  Phase2SPARCOutput,
  Phase2ADRRecord,
  Phase2DomainModel,
  ImplementationLanguage,
  LanguageSignal,
  LanguageResolution,
  Phase3Context,
  Phase3StageOutput,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// ADR-PIPELINE-115 — Rust-default policy (D2) + workspace-file signals (D1)
// ============================================================================

/**
 * The default implementation language when no language-specific file markers
 * and no strong dossier signal are present (ADR-PIPELINE-115 §D2).
 *
 * Rationale: Rust provides memory safety, deterministic performance, and small
 * binary size — appropriate defaults for a compute-intensive backend when the
 * user has not specified a language. This preference can be overridden by
 * workspace signals (Cargo.toml -> Rust confirmed; package.json -> TypeScript;
 * requirements.txt/pyproject.toml -> Python) or by an explicit --language flag.
 */
export const LANGUAGE_PREFERENCE_DEFAULT: ImplementationLanguage = 'rust';

/** Confidence assigned to a pure Rust default (no markers, no dossier signal). */
const RUST_DEFAULT_CONFIDENCE = 0.4;
/** Confidence for a dossier-only decision read back from a prior resolver run. */
const DOSSIER_RESOLVED_CONFIDENCE = 0.7;

/**
 * Presence of workspace marker files, used as language signals (ADR-115 §D1).
 * The I/O (statSync) is performed by the caller so `resolveLanguage` stays a
 * pure function.
 */
export interface WorkspaceLanguageMarkers {
  packageJson?: boolean;
  requirementsTxt?: boolean;
  pyprojectToml?: boolean;
  setupPy?: boolean;
  pyFiles?: boolean;
  cargoToml?: boolean;
  goMod?: boolean;
}

/**
 * Resolver output surfaced to the scaffold-emission gate (ADR-115 §D1).
 * `confidence` distinguishes a *detection* (>= 0.7) from a *default* (0.4).
 */
export interface ResolvedLanguage {
  primary: ImplementationLanguage;
  fallbacks: ImplementationLanguage[];
  confidence: number;
  rationale: string;
}

/**
 * Enumerated surfaces where TypeScript remains the scaffold language despite
 * the Rust default (ADR-PIPELINE-115 §D4). Listed explicitly so the
 * "TypeScript as fallback" clause cannot expand by drift — any new TS surface
 * must be added here.
 */
export const TS_RETAINED_SURFACES: ReadonlyArray<{ surface: string; reason: string; governedBy: string }> = [
  {
    surface: 'Power BI connector',
    reason: 'Power BI custom visual SDK requires TypeScript; no Rust binding',
    governedBy: 'ADR-032 (ERP surface from detection)',
  },
  {
    surface: 'npm/Node.js ecosystem shims',
    reason: 'package.json present and language-resolver detects TypeScript with confidence >= 0.7',
    governedBy: 'ADR-PIPELINE-115 §D2 confidence threshold',
  },
  {
    surface: 'Browser-side JavaScript SDK',
    reason: 'WASM compilation possible but out of scope for the phase 5b scaffold',
    governedBy: 'Deferred to a future ADR',
  },
];

const KNOWN_FALLBACKS: Record<string, ImplementationLanguage[]> = {
  rust: ['typescript'],
  typescript: ['rust'],
};

function defaultFallbacks(primary: ImplementationLanguage): ImplementationLanguage[] {
  return KNOWN_FALLBACKS[primary] ?? ['rust', 'typescript'];
}

/**
 * Normalize a free-form language string to a supported `ImplementationLanguage`,
 * or `null` when unrecognized. `javascript` collapses to `typescript`.
 */
function normalizeLanguage(value: string | null | undefined): ImplementationLanguage | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'typescript' || v === 'javascript') return 'typescript';
  if (v === 'python') return 'python';
  if (v === 'rust') return 'rust';
  if (v === 'go' || v === 'golang') return 'go';
  return null;
}

/**
 * Detect the language implied by workspace marker files (ADR-115 §D1).
 * Precedence: Cargo.toml (Rust) > package.json (TypeScript) > Python markers >
 * go.mod (Go). A high-weight marker overrides the Rust default and the dossier
 * scoring (but not an explicit query mention).
 */
function detectWorkspaceMarkerLanguage(
  markers?: WorkspaceLanguageMarkers,
): { lang: ImplementationLanguage; weight: number; evidence: string } | null {
  if (!markers) return null;
  if (markers.cargoToml) return { lang: 'rust', weight: 0.95, evidence: 'Cargo.toml present' };
  if (markers.packageJson) return { lang: 'typescript', weight: 0.9, evidence: 'package.json present' };
  if (markers.pyprojectToml || markers.requirementsTxt || markers.setupPy || markers.pyFiles) {
    return { lang: 'python', weight: 0.9, evidence: 'Python workspace marker present (pyproject.toml/requirements.txt/setup.py/*.py)' };
  }
  if (markers.goMod) return { lang: 'go', weight: 0.9, evidence: 'go.mod present' };
  return null;
}

// ============================================================================
// Constants -- Regex patterns and keyword lists
// ============================================================================

/**
 * All supported language mention patterns.
 * Ordered by specificity (longer patterns first to avoid false positives).
 */
const LANGUAGE_MENTION_PATTERNS: ReadonlyArray<{ re: RegExp; lang: ImplementationLanguage }> = [
  { re: /\btypescript\b/i, lang: 'typescript' },
  { re: /\bjavascript\b/i, lang: 'javascript' },
  { re: /\bpython\b/i, lang: 'python' },
  { re: /\bjava\b(?!\s*script)/i, lang: 'java' },
  { re: /\bc\s*#\b|\bcsharp\b|\b\.net\b/i, lang: 'csharp' },
  { re: /\bc\+\+\b|\bcpp\b/i, lang: 'cpp' },
  { re: /\bgolang\b|\bgo\s+(?:lang|service|module)\b/i, lang: 'go' },
  { re: /\brust\b/i, lang: 'rust' },
  { re: /\bswift\b/i, lang: 'swift' },
  { re: /\bkotlin\b/i, lang: 'kotlin' },
  { re: /\bterraform\b|\bhcl\b/i, lang: 'terraform' },
  { re: /\bbash\b|\bshell\s*script\b/i, lang: 'bash' },
];

/** Signal 2: performance-critical keywords in performance target text. */
const PERF_CRITICAL_PATTERNS: ReadonlyArray<RegExp> = [
  /<\s*10\s*ms/i,
  />\s*10\s*k\s*\/\s*s/i,
  /sub-millisecond/i,
  /real-time/i,
  /latency\s+under/i,
];

/** Signal 3: concurrency keywords. */
const CONCURRENCY_KEYWORDS = [
  'concurrent', 'parallel', 'multi-thread', 'lock-free',
] as const;

/** Signal 4: memory safety keywords. */
const MEMORY_SAFETY_KEYWORDS = [
  'memory safety', 'buffer overflow', 'null safety', 'zero-copy',
] as const;

/** Signal 5: cryptographic operations keywords. */
const CRYPTO_KEYWORDS = [
  'cryptographic', 'hashing', 'signing', 'encryption', 'zero-knowledge',
] as const;

/** Signal 6: deterministic runtime keywords. */
const DETERMINISTIC_KEYWORDS = [
  'deterministic runtime', 'governance kernel', 'policy enforcement', 'invariant enforcement',
] as const;

/** Signal 7: integration-heavy service name keywords. */
const INTEGRATION_SERVICE_KEYWORDS = [
  'adapter', 'connector', 'integration', 'gateway',
] as const;

/** Signal 8: I/O-bound pipeline keywords. */
const IO_BOUND_KEYWORDS = [
  'extraction', 'etl', 'pipeline', 'data flow', 'batch', 'ingestion', 'reporting',
] as const;

/** Signal 9: orchestration-focus keywords. */
const ORCHESTRATION_KEYWORDS = [
  'workflow', 'orchestration', 'saga', 'process manager',
] as const;

/** Signal 11: external integration context name keywords. */
const EXTERNAL_INTEGRATION_KEYWORDS = [
  'adapter', 'connector', 'gateway', 'integration',
] as const;

/** Signal 12: technology stack affinity keywords. */
const TECH_STACK_KEYWORDS = [
  'sap', 'bigquery', 'dataflow', 'rest', 'webhook', 'sftp',
  'cloud', 'aws', 'gcp', 'azure',
] as const;

// ============================================================================
// Signal Detectors (private)
// ============================================================================

/**
 * Signal 1: Explicit language mention in the scenario query.
 * Weight 1.0, confidence 1.0 if found.
 * Scans all 17 supported languages. Returns the first match found.
 */
function detectExplicitLanguageMention(scenarioQuery: string): LanguageSignal | null {
  // Find all language mentions with their positions
  const mentions: Array<{ lang: ImplementationLanguage; idx: number }> = [];
  for (const { re, lang } of LANGUAGE_MENTION_PATTERNS) {
    const match = scenarioQuery.search(re);
    if (match >= 0) {
      mentions.push({ lang, idx: match });
    }
  }

  if (mentions.length === 0) return null;

  // Pick the first-mentioned language
  mentions.sort((a, b) => a.idx - b.idx);
  const favors = mentions[0]!.lang;

  return {
    name: 'explicit-language-mention',
    source: 'query',
    favors,
    weight: 1.0,
    confidence: 1.0,
    score: 1.0,
    evidence: `Explicit "${favors}" mention in scenario query`,
  };
}

/**
 * Signal 2: Performance-critical requirements in SPARC refinement targets.
 * Weight 0.8, favors Rust.
 */
function detectPerformanceCritical(sparc: Phase2SPARCOutput): LanguageSignal | null {
  const targets = sparc.refinement.performanceTargets;
  if (targets.length === 0) return null;

  let matches = 0;
  for (const target of targets) {
    const text = target.text;
    if (PERF_CRITICAL_PATTERNS.some((re) => re.test(text))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / targets.length, 1.0);
  const weight = 0.8;
  return {
    name: 'performance-critical',
    source: 'sparc',
    favors: 'rust',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${targets.length} performance targets contain sub-10ms, high-throughput, or real-time requirements`,
  };
}

/**
 * Signal 3: Concurrency requirements in SPARC performance targets + security considerations.
 * Weight 0.7, favors Rust.
 */
function detectConcurrencyRequirements(sparc: Phase2SPARCOutput): LanguageSignal | null {
  const texts: string[] = [
    ...sparc.refinement.performanceTargets.map((t) => t.text),
    ...sparc.refinement.securityConsiderations.map((s) => s.text),
  ];
  if (texts.length === 0) return null;

  let matches = 0;
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (CONCURRENCY_KEYWORDS.some((kw) => lower.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / texts.length, 1.0);
  const weight = 0.7;
  return {
    name: 'concurrency-requirements',
    source: 'sparc',
    favors: 'rust',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${texts.length} performance/security texts reference concurrency or parallelism`,
  };
}

/**
 * Signal 4: Memory safety concerns in ADR context/decision text.
 * Weight 0.7, favors Rust.
 */
function detectMemorySafety(adrs: Phase2ADRRecord[]): LanguageSignal | null {
  if (adrs.length === 0) return null;

  let matches = 0;
  for (const adr of adrs) {
    const combined = (adr.context + ' ' + adr.decision).toLowerCase();
    if (MEMORY_SAFETY_KEYWORDS.some((kw) => combined.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / adrs.length, 1.0);
  const weight = 0.7;
  return {
    name: 'memory-safety',
    source: 'adr',
    favors: 'rust',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${adrs.length} ADRs reference memory safety, buffer overflow, or zero-copy`,
  };
}

/**
 * Signal 5: Cryptographic operations in ADR context/decision text.
 * Weight 0.6, favors Rust.
 */
function detectCryptographicOps(adrs: Phase2ADRRecord[]): LanguageSignal | null {
  if (adrs.length === 0) return null;

  let matches = 0;
  for (const adr of adrs) {
    const combined = (adr.context + ' ' + adr.decision).toLowerCase();
    if (CRYPTO_KEYWORDS.some((kw) => combined.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / adrs.length, 1.0);
  const weight = 0.6;
  return {
    name: 'cryptographic-ops',
    source: 'adr',
    favors: 'rust',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${adrs.length} ADRs reference cryptographic operations`,
  };
}

/**
 * Signal 6: Deterministic runtime requirements in ADR context/decision text.
 * Weight 0.6, favors Rust.
 */
function detectDeterministicRuntime(adrs: Phase2ADRRecord[]): LanguageSignal | null {
  if (adrs.length === 0) return null;

  let matches = 0;
  for (const adr of adrs) {
    const combined = (adr.context + ' ' + adr.decision).toLowerCase();
    if (DETERMINISTIC_KEYWORDS.some((kw) => combined.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / adrs.length, 1.0);
  const weight = 0.6;
  return {
    name: 'deterministic-runtime',
    source: 'adr',
    favors: 'rust',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${adrs.length} ADRs reference deterministic runtime or governance kernel`,
  };
}

/**
 * Signal 7: Integration-heavy architecture in SPARC services.
 * Weight 0.7, favors TypeScript.
 * If >50% of services match, confidence is 1.0; otherwise it is the ratio.
 */
function detectIntegrationHeavy(sparc: Phase2SPARCOutput): LanguageSignal | null {
  const services = sparc.architecture.services;
  if (services.length === 0) return null;

  let matches = 0;
  for (const svc of services) {
    const lower = svc.name.toLowerCase();
    if (INTEGRATION_SERVICE_KEYWORDS.some((kw) => lower.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const ratio = matches / services.length;
  const confidence = ratio > 0.5 ? 1.0 : ratio;
  const weight = 0.7;
  return {
    name: 'integration-heavy',
    source: 'sparc',
    favors: 'typescript',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${services.length} services have adapter/connector/integration/gateway names`,
  };
}

/**
 * Signal 8: I/O-bound pipeline keywords in SPARC service responsibilities + performance targets.
 * Weight 0.7, favors TypeScript.
 */
function detectIOBoundPipeline(sparc: Phase2SPARCOutput): LanguageSignal | null {
  const texts: string[] = [
    ...sparc.architecture.services.map((s) => s.responsibility),
    ...sparc.refinement.performanceTargets.map((t) => t.text),
  ];
  if (texts.length === 0) return null;

  let matches = 0;
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (IO_BOUND_KEYWORDS.some((kw) => lower.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / texts.length, 1.0);
  const weight = 0.7;
  return {
    name: 'io-bound-pipeline',
    source: 'sparc',
    favors: 'typescript',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${texts.length} service responsibilities/targets reference ETL, pipeline, or data flow`,
  };
}

/**
 * Signal 9: Orchestration focus in DDD context names + commands.
 * Weight 0.6, favors TypeScript.
 */
function detectOrchestrationFocus(ddd: Phase2DomainModel): LanguageSignal | null {
  const items: string[] = [
    ...ddd.contexts.map((c) => c.name),
    ...ddd.contexts.flatMap((c) => c.commands.map((cmd) => cmd.name)),
  ];
  if (items.length === 0) return null;

  let matches = 0;
  for (const item of items) {
    const lower = item.toLowerCase();
    if (ORCHESTRATION_KEYWORDS.some((kw) => lower.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / items.length, 1.0);
  const weight = 0.6;
  return {
    name: 'orchestration-focus',
    source: 'ddd',
    favors: 'typescript',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${items.length} DDD context names/commands reference workflow or orchestration`,
  };
}

/**
 * Signal 10: Heavy API surface in SPARC architecture.
 * Weight 0.5, favors TypeScript.
 * If apiContracts.length > 10 then confidence 1.0, else apiContracts.length / 10.
 */
function detectAPISurfaceHeavy(sparc: Phase2SPARCOutput): LanguageSignal | null {
  const count = sparc.architecture.apiContracts.length;
  if (count === 0) return null;

  const confidence = count > 10 ? 1.0 : count / 10;
  const weight = 0.5;
  return {
    name: 'api-surface-heavy',
    source: 'sparc',
    favors: 'typescript',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${count} API contracts defined (threshold: 10 for full confidence)`,
  };
}

/**
 * Signal 11: External integration count in DDD bounded contexts.
 * Weight 0.6, favors TypeScript.
 */
function detectExternalIntegrationCount(ddd: Phase2DomainModel): LanguageSignal | null {
  const contexts = ddd.contexts;
  if (contexts.length === 0) return null;

  let matches = 0;
  for (const ctx of contexts) {
    const lower = ctx.name.toLowerCase();
    if (EXTERNAL_INTEGRATION_KEYWORDS.some((kw) => lower.includes(kw))) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / contexts.length, 1.0);
  const weight = 0.6;
  return {
    name: 'external-integration-count',
    source: 'ddd',
    favors: 'typescript',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${contexts.length} DDD bounded contexts are adapter/connector/gateway/integration`,
  };
}

/**
 * Signal 12: Technology stack affinity keywords in the scenario query.
 * Weight 0.5, favors TypeScript.
 */
function detectTechStackAffinity(scenarioQuery: string): LanguageSignal | null {
  const lower = scenarioQuery.toLowerCase();
  const total = TECH_STACK_KEYWORDS.length;

  let matches = 0;
  for (const kw of TECH_STACK_KEYWORDS) {
    if (lower.includes(kw)) {
      matches++;
    }
  }

  if (matches === 0) return null;

  const confidence = Math.min(matches / total, 1.0);
  const weight = 0.5;
  return {
    name: 'technology-stack-affinity',
    source: 'query',
    favors: 'typescript',
    weight,
    confidence,
    score: weight * confidence,
    evidence: `${matches}/${total} cloud/enterprise technology keywords found in scenario query`,
  };
}

// ============================================================================
// Scoring and Rationale (private)
// ============================================================================

/**
 * Sum scores for all signals favoring the given language.
 */
function sumScores(signals: LanguageSignal[], language: ImplementationLanguage): number {
  let total = 0;
  for (const signal of signals) {
    if (signal.favors === language) {
      total += signal.score;
    }
  }
  return total;
}

/**
 * Build a human-readable rationale string from scores and signals.
 */
function buildRationale(
  language: ImplementationLanguage,
  rustScore: number,
  tsScore: number,
  signals: LanguageSignal[],
): string {
  const winnerScore = language === 'rust' ? rustScore : tsScore;
  const loserScore = language === 'rust' ? tsScore : rustScore;

  // Top 3 signals by score (descending), regardless of which language they favor
  const sorted = [...signals].sort((a, b) => b.score - a.score);
  const top3 = sorted.slice(0, 3);
  const top3Desc = top3
    .map((s) => `${s.name} (${s.score.toFixed(2)})`)
    .join(', ');

  return (
    `Selected ${language} (score: ${winnerScore.toFixed(2)} vs ${loserScore.toFixed(2)}). ` +
    `Primary signals: ${top3Desc}.`
  );
}

// ============================================================================
// Public: Pure Builder
// ============================================================================

/**
 * Pure function that resolves the implementation language from Phase 2 artifacts
 * and the scenario query. Fully deterministic: no I/O, no randomness.
 *
 * Twelve signal detectors are evaluated. Each signal that fires contributes a
 * weighted score toward either Rust or TypeScript. An explicit language mention
 * in the query overrides all scoring.
 *
 * @param sparc         - The SPARC output from Phase 2
 * @param adrs          - The ADR records from Phase 2
 * @param ddd           - The DDD domain model from Phase 2
 * @param scenarioQuery - The original scenario query string
 * @returns A complete LanguageResolution with scores, signals, and rationale
 * @throws {Error} ECLI-P3-005 if no signals detected and no explicit mention
 */
export function resolveLanguage(
  sparc: Phase2SPARCOutput,
  adrs: Phase2ADRRecord[],
  ddd: Phase2DomainModel,
  scenarioQuery: string,
  markers?: WorkspaceLanguageMarkers,
): LanguageResolution {
  const signals: LanguageSignal[] = [];

  // Collect all signals (only include those with confidence > 0)
  const explicitSignal = detectExplicitLanguageMention(scenarioQuery);
  if (explicitSignal) signals.push(explicitSignal);

  const perfSignal = detectPerformanceCritical(sparc);
  if (perfSignal) signals.push(perfSignal);

  const concurrencySignal = detectConcurrencyRequirements(sparc);
  if (concurrencySignal) signals.push(concurrencySignal);

  const memSafetySignal = detectMemorySafety(adrs);
  if (memSafetySignal) signals.push(memSafetySignal);

  const cryptoSignal = detectCryptographicOps(adrs);
  if (cryptoSignal) signals.push(cryptoSignal);

  const deterministicSignal = detectDeterministicRuntime(adrs);
  if (deterministicSignal) signals.push(deterministicSignal);

  const integrationSignal = detectIntegrationHeavy(sparc);
  if (integrationSignal) signals.push(integrationSignal);

  const ioSignal = detectIOBoundPipeline(sparc);
  if (ioSignal) signals.push(ioSignal);

  const orchSignal = detectOrchestrationFocus(ddd);
  if (orchSignal) signals.push(orchSignal);

  const apiSignal = detectAPISurfaceHeavy(sparc);
  if (apiSignal) signals.push(apiSignal);

  const extIntSignal = detectExternalIntegrationCount(ddd);
  if (extIntSignal) signals.push(extIntSignal);

  const techSignal = detectTechStackAffinity(scenarioQuery);
  if (techSignal) signals.push(techSignal);

  // ADR-PIPELINE-115 §D1 — workspace-file presence signal. A strong marker
  // (package.json/Cargo.toml/etc.) overrides the Rust default and the dossier
  // scoring, but not an explicit query mention. For Rust/TypeScript the marker
  // participates in scoring; for Python/Go (outside the binary Rust-vs-TS
  // score) it becomes a direct language override.
  const marker = detectWorkspaceMarkerLanguage(markers);
  let markerOverride: ImplementationLanguage | null = null;
  if (marker) {
    signals.push({
      name: 'workspace-file-marker',
      source: 'explicit',
      favors: marker.lang,
      weight: marker.weight,
      confidence: 1.0,
      score: marker.weight,
      evidence: `Workspace marker: ${marker.evidence}`,
    });
    if (marker.lang !== 'rust' && marker.lang !== 'typescript') {
      markerOverride = marker.lang;
    }
  }

  // Inject Rust default preference baseline signal.
  // This ensures Rust is chosen when no other signals fire, and wins ties.
  // Weight 0.3 is low enough to be overridden by any strong TS signal.
  signals.push({
    name: 'rust-default-preference',
    source: 'explicit',
    favors: 'rust',
    weight: 0.3,
    confidence: 1.0,
    score: 0.3,
    evidence: 'Default preference: Rust for performance, safety, and deterministic behavior',
  });

  // Compute aggregate scores
  const rustScore = sumScores(signals, 'rust');
  const tsScore = sumScores(signals, 'typescript');

  // Determine the winner
  let language: ImplementationLanguage;

  if (explicitSignal) {
    // Explicit mention overrides scoring — supports all 17 languages
    language = explicitSignal.favors;
  } else if (markerOverride) {
    // Strong Python/Go workspace marker (outside the Rust-vs-TS score)
    language = markerOverride;
  } else if (rustScore >= tsScore) {
    // Rust wins on tie (default preference)
    language = 'rust';
  } else {
    language = 'typescript';
  }

  const rationale = buildRationale(language, rustScore, tsScore, signals);

  return {
    language,
    mixed_mode: false,
    rationale,
    signals,
    typescript_score: tsScore,
    rust_score: rustScore,
  };
}

/**
 * Compute the surfaced confidence for a resolution (ADR-115 §D2). An explicit
 * mention is 1.0; a strong workspace marker is >= 0.85; a pure default is 0.4;
 * a dossier-only win scales modestly by margin (0.5–0.8) so it reads as a
 * *detection* rather than a confident pin.
 */
function computeConfidence(resolution: LanguageResolution): number {
  const signals = resolution.signals;
  if (signals.some((s) => s.name === 'explicit-language-mention')) return 1.0;

  const ws = signals.find((s) => s.name === 'workspace-file-marker');
  if (ws && ws.favors === resolution.language) {
    return Math.max(0.85, Math.min(0.95, ws.weight));
  }

  const nonDefault = signals.filter((s) => s.name !== 'rust-default-preference');
  if (nonDefault.length === 0) return RUST_DEFAULT_CONFIDENCE; // pure default

  const winner = resolution.language === 'rust' ? resolution.rust_score : resolution.typescript_score;
  const loser = resolution.language === 'rust' ? resolution.typescript_score : resolution.rust_score;
  const total = winner + loser;
  if (total <= 0) return RUST_DEFAULT_CONFIDENCE;
  const margin = (winner - loser) / total;
  return Math.max(0.5, Math.min(0.8, 0.5 + margin * 0.3));
}

/**
 * Map a {@link LanguageResolution} to the {@link ResolvedLanguage} shape read
 * by the scaffold-emission gate (ADR-115 §D1).
 */
export function toResolvedLanguage(resolution: LanguageResolution): ResolvedLanguage {
  return {
    primary: resolution.language,
    fallbacks: defaultFallbacks(resolution.language),
    confidence: computeConfidence(resolution),
    rationale: resolution.rationale,
  };
}

/**
 * Resolve the scaffold language for the auto-chain emission gate (ADR-115 §D1).
 *
 * This is the single combining function that keeps `language-resolver.ts` the
 * source of truth even when invoked from `auto-chain.ts`. Precedence:
 *   1. explicit hint (`--language` flag / phase-1 manifest `project.language`),
 *   2. workspace-file markers (D1),
 *   3. the dossier-resolved language read back from phase 3,
 *   4. the Rust default (D2).
 */
export function resolveScaffoldLanguage(input: {
  markers?: WorkspaceLanguageMarkers;
  explicitLanguage?: string | null;
  phase3Language?: string | null;
}): ResolvedLanguage {
  const explicit = normalizeLanguage(input.explicitLanguage);
  if (explicit) {
    return {
      primary: explicit,
      fallbacks: defaultFallbacks(explicit),
      confidence: 1.0,
      rationale: `Explicit language hint: ${explicit}`,
    };
  }

  const marker = detectWorkspaceMarkerLanguage(input.markers);
  if (marker) {
    return {
      primary: marker.lang,
      fallbacks: defaultFallbacks(marker.lang),
      confidence: Math.max(0.85, Math.min(0.95, marker.weight)),
      rationale: `Workspace marker: ${marker.evidence}`,
    };
  }

  const dossier = normalizeLanguage(input.phase3Language);
  if (dossier) {
    return {
      primary: dossier,
      fallbacks: defaultFallbacks(dossier),
      confidence: DOSSIER_RESOLVED_CONFIDENCE,
      rationale: `Phase 3 language resolver: ${dossier}`,
    };
  }

  return {
    primary: LANGUAGE_PREFERENCE_DEFAULT,
    fallbacks: defaultFallbacks(LANGUAGE_PREFERENCE_DEFAULT),
    confidence: RUST_DEFAULT_CONFIDENCE,
    rationale: 'Defaulted to Rust — no explicit language, workspace markers, or dossier signal (ADR-PIPELINE-115 §D2)',
  };
}

// ============================================================================
// Public: Pipeline Stage Entry Point
// ============================================================================

/**
 * Pipeline stage entry point for language resolution. Reads Phase 2 artifacts
 * from the context, delegates to the pure {@link resolveLanguage} builder, and
 * records the result on the context with telemetry spans.
 *
 * @param context - The Phase 3 pipeline context
 * @returns Stage output describing success or failure
 */
export async function resolveImplementationLanguage(
  context: Phase3Context,
): Promise<Phase3StageOutput> {
  const rootSpan = createSpan('language-resolution', 'resolve-language', {
    phase2Dir: context.phase2Dir,
  });

  try {
    const resolution = resolveLanguage(
      context.phase2Artifacts.sparc,
      context.phase2Artifacts.adrs,
      context.phase2Artifacts.domainModel,
      context.scenarioQuery,
    );

    const timing = Date.now() - rootSpan.startTime;

    const stageOutput: Phase3StageOutput = {
      stage: 'language-resolution',
      status: 'completed',
      data: resolution,
      artifacts: [],
      timing,
      summary: `Language: ${resolution.language}`,
    };

    // Store on context
    context.stageOutputs.set('language-resolution', stageOutput);

    const finalSpan = endSpan(rootSpan, 'ok', {
      language: resolution.language,
      rustScore: resolution.rust_score,
      tsScore: resolution.typescript_score,
      signalCount: resolution.signals.length,
    });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    console.error(
      `  [OK] Language resolved: ${resolution.language} ` +
      `(TS: ${resolution.typescript_score.toFixed(2)}, Rust: ${resolution.rust_score.toFixed(2)})`,
    );

    return stageOutput;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const timing = Date.now() - rootSpan.startTime;

    const failedOutput: Phase3StageOutput = {
      stage: 'language-resolution',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `Language resolution failed: ${errorMessage}`,
    };

    context.stageOutputs.set('language-resolution', failedOutput);

    const finalSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    console.error(`  [FAIL] Language resolution failed: ${errorMessage}`);

    return failedOutput;
  }
}
