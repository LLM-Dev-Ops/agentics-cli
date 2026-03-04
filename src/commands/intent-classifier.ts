/**
 * Semantic Intent Classifier
 *
 * Replaces brittle `.includes()` keyword matching with a multi-signal
 * scoring system that understands natural language intent.
 *
 * Pure functions, zero I/O, zero external dependencies.
 *
 * Signals:
 *  1. Token overlap — query words that appear in candidate keywords
 *  2. Stem matching — suffix-stripped matching (simulate ↔ simulation)
 *  3. Concept clusters — domain-level semantic groupings
 *  4. Enterprise simulation boost — multi-cluster cross-signal
 */

// ============================================================================
// Types (import-compatible with agents.ts)
// ============================================================================

export interface KeywordRule {
  domain: string;
  agent: string;
  keywords: string[];
}

export interface MultiAgentCombo {
  id: string;
  keywords: string[];
  agents: Array<{ domain: string; agent: string }>;
}

export interface ScoredIntent {
  domain: string;
  agent: string;
  confidence: number;
  reasoning: string;
}

export interface ScoredMultiIntent {
  comboId: string;
  agents: Array<{ domain: string; agent: string }>;
  confidence: number;
  reasoning: string;
}

export interface EnterpriseSimulationResult {
  detected: boolean;
  confidence: number;
  reasoning: string;
}

// ============================================================================
// Tokenizer
// ============================================================================

// Common words that should not contribute to intent scoring
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'this', 'that', 'these', 'those', 'which', 'who',
  'what', 'where', 'when', 'how', 'why',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'into', 'about', 'between', 'through', 'during', 'before', 'after',
  'and', 'or', 'but', 'not', 'no', 'if', 'then', 'so', 'up', 'out',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
  'also', 'just', 'than', 'very', 'too', 'only',
  'get', 'got', 'make', 'made', 'go', 'going', 'use', 'using', 'used',
  'want', 'like', 'know', 'take', 'see', 'look', 'find', 'give',
  'tell', 'say', 'said', 'think', 'come', 'let', 'try', 'run',
  'check', 'set', 'put', 'keep', 'start', 'show', 'help',
]);

/**
 * Split text into lowercase word tokens.
 * Preserves hyphenated compounds (e.g., "what-if") as single tokens
 * AND splits them into parts so both "what-if" and "what", "if" match.
 */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const tokens = new Set<string>();
  for (const t of raw) {
    tokens.add(t);
    // Also add parts of hyphenated words
    if (t.includes('-')) {
      for (const part of t.split('-')) {
        if (part.length > 1) tokens.add(part);
      }
    }
  }
  return [...tokens];
}

/**
 * Filter tokens to only meaningful words (remove stop words).
 * Used for scoring to prevent generic words from inflating matches.
 */
export function filterStopWords(tokens: string[]): string[] {
  return tokens.filter(t => !STOP_WORDS.has(t) && t.length > 2);
}

// ============================================================================
// Stemmer (light suffix stripping — no dependencies)
// ============================================================================

// Ordered longest-first so we strip the most specific suffix
const SUFFIXES = [
  'ization', 'isation', 'ational', 'fulness',
  'lessly', 'nesses', 'ations', 'ements',
  'ingly', 'ation', 'ement', 'iness', 'ively',
  'ment', 'ness', 'able', 'ible', 'tion',
  'sion', 'ence', 'ance', 'ious', 'eous',
  'ical', 'ized', 'ised', 'ting', 'ing',
  'ive', 'ful', 'ous', 'ize', 'ise', 'ate',
  'ity', 'ent', 'ant', 'ism', 'ist', 'ual',
  'ive', 'ory', 'ary', 'ure', 'ess',
  'fy', 'ly', 'al', 'er', 'ed', 'es',
];

const MIN_STEM_LENGTH = 3;

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= MIN_STEM_LENGTH) return w;

  for (const suffix of SUFFIXES) {
    if (w.endsWith(suffix) && (w.length - suffix.length) >= MIN_STEM_LENGTH) {
      return w.slice(0, -suffix.length);
    }
  }
  return w;
}

// ============================================================================
// Concept Clusters — semantic word groups per domain
// ============================================================================

const CONCEPT_CLUSTERS: Record<string, readonly string[]> = {
  simulation: [
    'simulate', 'simulation', 'simulating', 'simulated', 'simulator',
    'model', 'modeling', 'modelling', 'forecast', 'forecasting',
    'predict', 'prediction', 'predictive', 'scenario', 'scenarios',
    'what-if', 'hypothetical', 'dry-run', 'pretend', 'mock',
    'project', 'projection', 'test-run', 'deterministic', 'stochastic',
    'monte-carlo', 'seed', 'reproducible',
    // MVP / prototype / system design intent (trigger enterprise pipeline)
    'mvp', 'prototype', 'prototyping', 'demonstrate', 'demonstration',
    'proof-of-concept', 'poc', 'end-to-end', 'system', 'architecture',
    'blueprint', 'design', 'implement', 'implementation', 'build',
    'working', 'solution', 'integrate', 'integration',
  ],
  security: [
    'security', 'secure', 'safe', 'safety', 'protect', 'protection',
    'vulnerability', 'injection', 'attack', 'exploit', 'breach',
    'threat', 'pii', 'redact', 'credential', 'secret', 'toxic',
    'toxicity', 'moderation', 'abuse', 'adversarial', 'red-team',
  ],
  cost: [
    'cost', 'spend', 'spending', 'budget', 'price', 'pricing',
    'expense', 'roi', 'dollar', 'saving', 'savings', 'token',
    'tokens', 'billing', 'invoice', 'optimize', 'optimization',
    'cheap', 'expensive', 'affordable', 'cap',
  ],
  governance: [
    'govern', 'governance', 'compliance', 'compliant', 'audit',
    'auditing', 'policy', 'policies', 'regulation', 'regulatory',
    'gdpr', 'hipaa', 'soc2', 'soc-2', 'oversight', 'enforce',
    'enforcement', 'esg', 'sustainability', 'reporting',
  ],
  risk: [
    'risk', 'risky', 'exposure', 'threat', 'vulnerability',
    'failure', 'breach', 'incident', 'mitigation', 'hazard',
    'overrun', 'gap', 'violation',
  ],
  enterprise: [
    'enterprise', 'fortune', 'fortune-500', 'corporate', 'corporation',
    'organization', 'deploy', 'deployment', 'production', 'annual',
    'annually', 'quarterly', 'stakeholder', 'executive', 'board',
    'company', 'firm', 'multinational', 'workflow', 'sla',
    'confidential', 'internal',
    // ERP / SAP / industry-specific
    'sap', 's4hana', 's-4hana', 'erp', 'manufacturing', 'procurement',
    'supply-chain', 'finance', 'billing', 'invoicing', 'invoice',
    'contract', 'contracts', 'ledger', 'journal', 'posting',
    'revenue', 'margin', 'global', 'regional', 'regions',
  ],
  observability: [
    'monitor', 'monitoring', 'observe', 'observability', 'telemetry',
    'metric', 'metrics', 'dashboard', 'health', 'slo', 'sla',
    'uptime', 'alert', 'alerting', 'anomaly', 'anomalies',
    'outage', 'incident', 'post-mortem', 'visualization',
  ],
  data: [
    'data', 'database', 'erp', 'sap', 'oracle', 'netsuite',
    'webhook', 'integration', 'connector', 'sync', 'query',
    'schema', 'migration', 'etl', 'pipeline',
  ],
  performance: [
    'latency', 'slow', 'fast', 'speed', 'performance',
    'throughput', 'p99', 'p95', 'cold-start', 'bottleneck',
    'response-time', 'benchmark', 'optimization',
  ],
  planning: [
    'plan', 'planning', 'decompose', 'break-down', 'organize',
    'prioritize', 'roadmap', 'schedule', 'task', 'workflow',
    'orchestrate', 'coordinate',
  ],
};

// ============================================================================
// Enterprise Simulation Detection
// ============================================================================

/**
 * Detect whether a query is an enterprise simulation request.
 *
 * Returns detected=true when the query shows BOTH:
 *   1. Strong simulation intent (cluster match)
 *   2. Enterprise context (2+ of: enterprise, governance, risk, cost clusters)
 *
 * Also returns true for direct simulation phrases (backward compat).
 */
export function detectEnterpriseSimulation(query: string): EnterpriseSimulationResult {
  const q = query.toLowerCase();
  const tokens = tokenize(q);
  const stems = new Set(tokens.map(stem));

  // Direct phrase match (backward compatibility — these are unambiguous)
  const directPhrases = [
    'simulate a ', 'simulate an ', 'simulate the ',
    'run simulation', 'run a simulation', 'simulation of',
  ];
  for (const phrase of directPhrases) {
    if (q.includes(phrase)) {
      return { detected: true, confidence: 0.95, reasoning: `Direct phrase match: "${phrase.trim()}"` };
    }
  }

  // Cluster scoring
  const clusterScores = scoreAllClusters(tokens, stems);
  const simScore = clusterScores['simulation'] ?? 0;
  const enterpriseScore = clusterScores['enterprise'] ?? 0;
  const governanceScore = clusterScores['governance'] ?? 0;
  const riskScore = clusterScores['risk'] ?? 0;
  const costScore = clusterScores['cost'] ?? 0;

  // Count how many enterprise-adjacent clusters fire
  const contextClusters = [
    enterpriseScore > 0.10,
    governanceScore > 0.10,
    riskScore > 0.10,
    costScore > 0.10,
  ].filter(Boolean).length;

  // Enterprise simulation = simulation intent + enterprise context
  if (simScore >= 0.15 && contextClusters >= 2) {
    const confidence = Math.min(0.95, 0.40 + simScore * 0.3 + contextClusters * 0.10);
    return {
      detected: true,
      confidence,
      reasoning: `Simulation intent (${(simScore * 100).toFixed(0)}%) + ${contextClusters} enterprise context signals`,
    };
  }

  // Strong simulation intent alone (e.g., "run a what-if analysis for reporting automation")
  if (simScore >= 0.30 && (enterpriseScore > 0 || tokens.length > 20)) {
    const confidence = Math.min(0.85, 0.35 + simScore * 0.4);
    return {
      detected: true,
      confidence,
      reasoning: `Strong simulation intent (${(simScore * 100).toFixed(0)}%) with context depth`,
    };
  }

  // Broad enterprise MVP/prototype detection — long queries with strong enterprise
  // context that ask for a system, MVP, or demonstration, even without explicit
  // "simulate" vocabulary. These are clearly enterprise simulation requests.
  const dataScore = clusterScores['data'] ?? 0;
  const allContextClusters = [
    enterpriseScore > 0.10,
    governanceScore > 0.10,
    riskScore > 0.10,
    costScore > 0.10,
    dataScore > 0.10,
  ].filter(Boolean).length;

  if (allContextClusters >= 3 && tokens.length > 30) {
    const confidence = Math.min(0.90, 0.45 + allContextClusters * 0.08);
    return {
      detected: true,
      confidence,
      reasoning: `Broad enterprise query (${allContextClusters} context clusters, ${tokens.length} tokens) — routing to full pipeline`,
    };
  }

  // Enterprise + any simulation/design signal for medium-length queries
  if (enterpriseScore > 0.15 && simScore > 0.05 && contextClusters >= 1 && tokens.length > 15) {
    const confidence = Math.min(0.80, 0.40 + enterpriseScore * 0.2 + simScore * 0.2);
    return {
      detected: true,
      confidence,
      reasoning: `Enterprise context (${(enterpriseScore * 100).toFixed(0)}%) with design intent (${(simScore * 100).toFixed(0)}%)`,
    };
  }

  return { detected: false, confidence: simScore, reasoning: 'Below enterprise simulation threshold' };
}

// ============================================================================
// Engineering Pipeline Detection
// ============================================================================

export interface EngineeringPipelineResult {
  detected: boolean;
  confidence: number;
  reasoning: string;
  hasErpContext: boolean;
  hasSecurityContext: boolean;
  hasPerformanceContext: boolean;
}

/**
 * Detect whether a query is an engineering/implementation request
 * (build, implement, develop, integrate, create a system, etc.)
 * as distinct from a pure simulation or advisory request.
 *
 * Engineering requests should dispatch the FULL agent fleet:
 * research, SPARC decomposition, TDD planning, ADR/DDD, integration,
 * security, cost analysis, and ruvector simulation.
 */
export function detectEngineeringPipeline(query: string): EngineeringPipelineResult {
  const q = query.toLowerCase();
  const tokens = tokenize(q);
  const stems = new Set(tokens.map(stem));

  // Direct engineering phrases — unambiguous build/implement intent
  const engineeringPhrases = [
    'build a ', 'build an ', 'build the ', 'build me ',
    'implement a ', 'implement an ', 'implement the ',
    'develop a ', 'develop an ', 'develop the ',
    'create a system', 'create an app', 'create a platform',
    'create a service', 'create an api', 'create a solution',
    'design and build', 'design and implement', 'design and develop',
    'architect a ', 'architect an ', 'architect the ',
    'set up a ', 'set up an ', 'set up the ',
    'integrate with ', 'integrate into ',
    'connect to dynamics', 'connect to salesforce', 'connect to sap',
    'integrate dynamics', 'integrate salesforce', 'integrate sap',
    'full stack', 'end-to-end implementation', 'production-ready',
    'write the code', 'code this up', 'implementation plan',
  ];
  for (const phrase of engineeringPhrases) {
    if (q.includes(phrase)) {
      return {
        detected: true,
        confidence: 0.95,
        reasoning: `Direct engineering phrase: "${phrase.trim()}"`,
        hasErpContext: hasErpIntent(q, tokens),
        hasSecurityContext: hasSecurityIntent(tokens, stems),
        hasPerformanceContext: hasPerformanceIntent(tokens, stems),
      };
    }
  }

  // Cluster scoring for engineering intent
  const clusterScores = scoreAllClusters(tokens, stems);
  const simScore = clusterScores['simulation'] ?? 0; // includes build, implement, design, etc.
  const enterpriseScore = clusterScores['enterprise'] ?? 0;
  const dataScore = clusterScores['data'] ?? 0;
  const planningScore = clusterScores['planning'] ?? 0;

  // Engineering-specific word detection (NOT in simulation cluster)
  const engineeringWords = [
    'build', 'implement', 'develop', 'create', 'architect',
    'integrate', 'deploy', 'ship', 'launch', 'deliver',
    'code', 'program', 'engineering', 'tdd', 'sparc',
    'adr', 'ddd', 'domain-driven', 'test-driven',
    'microservice', 'api', 'backend', 'frontend', 'fullstack',
    'database', 'schema', 'migration', 'cicd', 'pipeline',
  ];
  const engWordCount = tokens.filter(t => engineeringWords.includes(t)).length;
  const engScore = Math.min(1.0, engWordCount * 0.15);

  // Engineering = strong build/implement intent + system/enterprise context
  // Distinguish from pure "simulate" by checking for explicit action verbs
  const hasActionVerb = tokens.some(t =>
    ['build', 'implement', 'develop', 'create', 'architect', 'integrate', 'deploy', 'ship', 'code', 'program'].includes(t),
  );

  if (hasActionVerb && (enterpriseScore > 0.05 || dataScore > 0.05 || planningScore > 0.05 || engScore > 0.15)) {
    const confidence = Math.min(0.95, 0.50 + engScore * 0.3 + simScore * 0.1 + enterpriseScore * 0.1);
    return {
      detected: true,
      confidence,
      reasoning: `Engineering intent (${(engScore * 100).toFixed(0)}% eng, action verb present) + context signals`,
      hasErpContext: hasErpIntent(q, tokens),
      hasSecurityContext: hasSecurityIntent(tokens, stems),
      hasPerformanceContext: hasPerformanceIntent(tokens, stems),
    };
  }

  // Broad engineering detection: long query with multiple engineering signals
  if (engScore > 0.20 && tokens.length > 10) {
    const confidence = Math.min(0.85, 0.40 + engScore * 0.3);
    return {
      detected: true,
      confidence,
      reasoning: `Broad engineering query (${(engScore * 100).toFixed(0)}% engineering signal, ${tokens.length} tokens)`,
      hasErpContext: hasErpIntent(q, tokens),
      hasSecurityContext: hasSecurityIntent(tokens, stems),
      hasPerformanceContext: hasPerformanceIntent(tokens, stems),
    };
  }

  return {
    detected: false,
    confidence: engScore,
    reasoning: 'Below engineering pipeline threshold',
    hasErpContext: false,
    hasSecurityContext: false,
    hasPerformanceContext: false,
  };
}

function hasErpIntent(q: string, tokens: string[]): boolean {
  const erpTerms = ['erp', 'dynamics', 'dynamics-365', 'salesforce', 'sap', 's4hana', 'netsuite', 'oracle'];
  return tokens.some(t => erpTerms.includes(t)) || q.includes('dynamics 365');
}

function hasSecurityIntent(tokens: string[], stems: Set<string>): boolean {
  const secTerms = ['security', 'secure', 'auth', 'authentication', 'authorization', 'encryption', 'compliance', 'gdpr', 'hipaa'];
  return tokens.some(t => secTerms.includes(t)) || stems.has('secur');
}

function hasPerformanceIntent(tokens: string[], stems: Set<string>): boolean {
  const perfTerms = ['performance', 'latency', 'throughput', 'scalable', 'scaling', 'optimization'];
  return tokens.some(t => perfTerms.includes(t)) || stems.has('perform') || stems.has('scal');
}

// ============================================================================
// Multi-Agent Combo Classification
// ============================================================================

/**
 * Score all multi-agent combos against the query.
 * Returns the best-scoring combo if it exceeds the threshold, or null.
 */
export function classifyMultiIntent(
  query: string,
  combos: MultiAgentCombo[],
): ScoredMultiIntent | null {
  const q = query.toLowerCase();
  const tokens = tokenize(q);
  const stems = new Set(tokens.map(stem));

  let best: ScoredMultiIntent | null = null;
  let bestScore = 0;

  for (const combo of combos) {
    const score = scoreCandidateKeywords(tokens, stems, combo.keywords);
    if (score > bestScore) {
      bestScore = score;
      best = {
        comboId: combo.id,
        agents: combo.agents,
        confidence: Math.min(0.90, score),
        reasoning: `Semantic match for combo "${combo.id}" (score: ${(score * 100).toFixed(0)}%)`,
      };
    }
  }

  // Threshold: 0.25 for multi-agent combos
  if (best && bestScore >= 0.25) return best;
  return null;
}

// ============================================================================
// Single-Agent Classification
// ============================================================================

/**
 * Score all keyword rules against the query.
 * Returns the best-scoring intent if it exceeds the threshold, or null.
 */
export function classifyIntent(
  query: string,
  rules: KeywordRule[],
): ScoredIntent | null {
  const q = query.toLowerCase();
  const tokens = tokenize(q);
  const stems = new Set(tokens.map(stem));

  let best: ScoredIntent | null = null;
  let bestScore = 0;

  for (const rule of rules) {
    const score = scoreCandidateKeywords(tokens, stems, rule.keywords);
    if (score > bestScore) {
      bestScore = score;
      best = {
        domain: rule.domain,
        agent: rule.agent,
        confidence: Math.min(0.85, score),
        reasoning: `Semantic match for ${rule.domain}/${rule.agent} (score: ${(score * 100).toFixed(0)}%)`,
      };
    }
  }

  // Threshold: 0.15 for single-agent
  if (best && bestScore >= 0.15) return best;
  return null;
}

// ============================================================================
// Scoring Engine
// ============================================================================

/**
 * Score a candidate's keyword set against query tokens.
 *
 * Combines:
 *  - Token overlap: what fraction of keyword tokens appear in the query
 *  - Stem overlap: same but using stemmed forms
 *  - Phrase proximity: bonus for multi-word keyword phrases appearing together
 */
function scoreCandidateKeywords(
  queryTokens: string[],
  _queryStems: Set<string>,
  keywords: string[],
): number {
  if (keywords.length === 0) return 0;

  // Filter stop words from query tokens so common words like "check", "for",
  // "this" don't inflate scores for unrelated candidates.
  const meaningfulTokens = filterStopWords(queryTokens);
  const meaningfulStems = new Set(meaningfulTokens.map(stem));

  const queryTokenSet = new Set(meaningfulTokens);
  const queryText = meaningfulTokens.join(' ');

  let totalTokenScore = 0;
  let totalStemScore = 0;
  let totalPhraseScore = 0;
  let keywordCount = 0;

  for (const kw of keywords) {
    const kwTokensRaw = tokenize(kw);
    // Filter stop words from keyword tokens too — "check for anomalies" → ["anomalies"]
    const kwTokens = filterStopWords(kwTokensRaw);
    if (kwTokens.length === 0) continue;
    keywordCount++;

    // Token overlap for this keyword
    const tokenMatches = kwTokens.filter(t => queryTokenSet.has(t)).length;
    const tokenRatio = tokenMatches / kwTokens.length;

    // Stem overlap for this keyword
    const kwStems = kwTokens.map(stem);
    const stemMatches = kwStems.filter(s => meaningfulStems.has(s)).length;
    const stemRatio = stemMatches / kwStems.length;

    // Phrase bonus: if the full keyword phrase appears as substring (use raw for phrase matching)
    const phraseBonus = queryText.includes(kw.toLowerCase()) ? 0.3 : 0;

    totalTokenScore += tokenRatio;
    totalStemScore += stemRatio;
    totalPhraseScore += phraseBonus;
  }

  if (keywordCount === 0) return 0;

  // Average across all keywords, keeping the best-scoring keyword's contribution dominant
  // This way, matching even ONE keyword well can score the candidate
  const avgToken = totalTokenScore / keywordCount;
  const avgStem = totalStemScore / keywordCount;
  const avgPhrase = totalPhraseScore / keywordCount;

  // Use max of any individual keyword match to avoid dilution
  // (if ONE keyword matches perfectly, that's a strong signal)
  let maxSingleKw = 0;
  for (const kw of keywords) {
    const kwTokensRaw2 = tokenize(kw);
    const kwTokens2 = filterStopWords(kwTokensRaw2);
    if (kwTokens2.length === 0) continue;
    const tokenMatches = kwTokens2.filter(t => queryTokenSet.has(t)).length;
    const stemMatches = kwTokens2.map(stem).filter(s => meaningfulStems.has(s)).length;
    const best = Math.max(tokenMatches, stemMatches) / kwTokens2.length;
    const phraseBonus = queryText.includes(kw.toLowerCase()) ? 0.3 : 0;
    maxSingleKw = Math.max(maxSingleKw, best + phraseBonus);
  }

  // Final score: blend of average across keywords + best single keyword
  // The max-single prevents dilution when one keyword matches perfectly
  return (avgToken * 0.15) + (avgStem * 0.15) + (avgPhrase * 0.20) + (maxSingleKw * 0.50);
}

/**
 * Score all concept clusters against query tokens.
 * Returns a map of cluster name → match ratio (0.0 to 1.0).
 */
function scoreAllClusters(
  tokens: string[],
  stems: Set<string>,
): Record<string, number> {
  const scores: Record<string, number> = {};

  for (const [cluster, words] of Object.entries(CONCEPT_CLUSTERS)) {
    const clusterStems = new Set(words.map(stem));
    let matches = 0;

    for (const s of stems) {
      if (clusterStems.has(s)) matches++;
    }

    // Also check direct token membership (handles short words the stemmer might mangle)
    const wordSet = new Set(words.map(w => w.toLowerCase()));
    for (const t of tokens) {
      if (wordSet.has(t)) matches++;
    }

    // Normalize: how many cluster words appeared in query (deduplicated)
    const uniqueMatches = new Set<string>();
    for (const t of tokens) {
      if (wordSet.has(t)) uniqueMatches.add(t);
    }
    for (const s of stems) {
      if (clusterStems.has(s)) uniqueMatches.add(s);
    }

    // Score = unique matches / cluster size, capped at 1.0
    scores[cluster] = Math.min(1.0, uniqueMatches.size / Math.max(1, words.length * 0.3));
  }

  return scores;
}
