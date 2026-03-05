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
