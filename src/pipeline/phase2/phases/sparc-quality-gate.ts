/**
 * Phase 2 Quality Gate: SPARC Output Validator
 *
 * Validates SPARC specification + pseudocode before DDD generation.
 * Prevents empty entity types by ensuring pseudocode contains:
 * - dataStructures with typed fields (not just type names)
 * - Algorithm steps (not empty arrays)
 * - Service definitions with API signatures
 *
 * Error codes:
 *   ECLI-P2-040  SPARC output quality too low for DDD generation
 *   ECLI-P2-041  SPARC output not available on context
 */

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2PseudocodeModule,
  Phase2ServiceDefinition,
} from '../types.js';

// ============================================================================
// Quality Report Types
// ============================================================================

export interface SPARCQualityReport {
  readonly passed: boolean;
  readonly score: number; // 0-100
  readonly issues: string[];
  readonly servicesWithPseudocode: number;
  readonly totalServices: number;
  readonly modulesWithDataStructures: number;
  readonly modulesWithAlgorithms: number;
  readonly totalModules: number;
  readonly apisWithSignatures: number;
  readonly truncatedContentDetected: boolean;
  readonly errorMessagesDetected: boolean;
}

// ============================================================================
// Detection Patterns
// ============================================================================

/**
 * Patterns indicating typed field definitions in data structures.
 * Matches formats like "fieldName: string", "amount: number", "{ name: Type }".
 */
const TYPED_FIELD_PATTERNS: readonly RegExp[] = [
  /\w+\s*:\s*(?:string|number|boolean|Date|int|float|double|bigint|uuid|decimal)\b/gi,
  /\w+\s*:\s*(?:Array|List|Set|Map|Record|Optional|Nullable)<?\s*\w+/gi,
  /\w+\s*:\s*[A-Z][a-z]+(?:[A-Z][a-z]+)+/g,  // fieldName: PascalCaseType
  /(?:readonly|public|private|protected)\s+\w+\s*:\s*\w+/gi,
];

/**
 * Patterns indicating truncated or corrupt JSON content.
 */
const TRUNCATION_PATTERNS: readonly RegExp[] = [
  /\.\.\.\s*$/m,                           // ends with "..."
  /\{\s*$/m,                               // ends with opening brace
  /,\s*$/m,                                // ends with trailing comma
  /(?:truncated|maximum\s+length|token\s+limit|cut\s+off)\b/gi,
];

/**
 * Patterns indicating error messages leaked into content.
 */
const ERROR_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:Error|Exception|ENOENT|EACCES|EPERM|EISDIR)\b.*:/g,
  /\bstack\s*trace\b/gi,
  /\bat\s+\w+\s*\(.*:\d+:\d+\)/g,        // "at functionName (file:line:col)"
  /\b(?:undefined|null)\s+is\s+not\s+(?:a\s+function|an?\s+object|iterable)\b/gi,
  /\b(?:Cannot\s+read\s+propert(?:y|ies)\s+of\s+(?:undefined|null))\b/gi,
];

/**
 * Patterns indicating API signatures with input/output types.
 */
const API_SIGNATURE_PATTERNS: readonly RegExp[] = [
  /\b\w+\s*\(.*\)\s*(?:=>|->|:)\s*\w+/g,                      // func(args) => ReturnType
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/\w+/g,                   // HTTP method + path
  /\b(?:input|request|params?)\s*:\s*\{[^}]+\}/gi,             // input: { ... }
  /\b(?:output|response|returns?)\s*:\s*(?:\{[^}]+\}|\w+)/gi,  // output: { ... } or Type
  /\b(?:rpc|grpc|graphql)\b/gi,                                 // RPC protocol mentions
];

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check whether a pseudocode module has real typed data structures
 * (not just empty type names or generic placeholders).
 */
function moduleHasTypedDataStructures(mod: Phase2PseudocodeModule): boolean {
  // Check the markdown content for typed field patterns
  const content = `${mod.markdown} ${mod.dataStructures.join(' ')}`;
  for (const pattern of TYPED_FIELD_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(content)) return true;
  }

  // Also accept dataStructures array entries that contain ":" (field: type)
  return mod.dataStructures.some((ds) => /\w+\s*:\s*\w+/.test(ds));
}

/**
 * Check whether a pseudocode module has non-empty algorithm steps.
 */
function moduleHasAlgorithms(mod: Phase2PseudocodeModule): boolean {
  // algorithms array must have real entries (not empty strings)
  if (mod.algorithms.length > 0 && mod.algorithms.some((a) => a.trim().length > 10)) {
    return true;
  }
  // Also check markdown for algorithmic constructs
  return /\b(?:if|for|while|loop|iterate|return|throw|try|catch|switch|case|step\s+\d)\b/i.test(mod.markdown);
}

/**
 * Check whether a service has API signatures with typed inputs/outputs.
 */
function serviceHasTypedAPIs(svc: Phase2ServiceDefinition): boolean {
  const apiText = svc.api.join(' ');
  for (const pattern of API_SIGNATURE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(apiText)) return true;
  }
  return false;
}

/**
 * Detect truncated content across all SPARC output text.
 */
function detectTruncation(sparc: Phase2SPARCOutput): boolean {
  const allText = gatherAllText(sparc);
  for (const pattern of TRUNCATION_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(allText)) return true;
  }
  return false;
}

/**
 * Detect error messages leaked into SPARC content.
 */
function detectErrorMessages(sparc: Phase2SPARCOutput): boolean {
  const allText = gatherAllText(sparc);
  for (const pattern of ERROR_MESSAGE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(allText)) return true;
  }
  return false;
}

/**
 * Concatenate all textual content from SPARC output for scanning.
 */
function gatherAllText(sparc: Phase2SPARCOutput): string {
  const parts: string[] = [];

  // Specification
  parts.push(sparc.specification.scope);
  for (const req of sparc.specification.requirements) parts.push(req.text);
  for (const con of sparc.specification.constraints) parts.push(con.text);
  for (const sc of sparc.specification.successCriteria) parts.push(sc.text);

  // Pseudocode
  for (const mod of sparc.pseudocode.modules) {
    parts.push(mod.markdown);
    parts.push(mod.algorithms.join(' '));
    parts.push(mod.dataStructures.join(' '));
  }

  // Architecture
  for (const svc of sparc.architecture.services) {
    parts.push(svc.responsibility);
    parts.push(svc.api.join(' '));
  }
  parts.push(sparc.architecture.dataFlow);
  parts.push(sparc.architecture.apiContracts.join(' '));

  // Refinement
  for (const sec of sparc.refinement.securityConsiderations) parts.push(sec.text);
  for (const perf of sparc.refinement.performanceTargets) parts.push(perf.text);
  parts.push(sparc.refinement.testStrategy);

  // Completion
  parts.push(sparc.completion.integrationPlan);
  parts.push(sparc.completion.documentation.join(' '));

  return parts.join('\n');
}

// ============================================================================
// Main Validation
// ============================================================================

const PASSING_SCORE = 60;

const WEIGHTS = {
  servicesCovered: 25,       // every service has at least 1 pseudocode module
  dataStructures: 25,        // modules have typed data structures
  algorithms: 15,            // modules have real algorithms
  apiSignatures: 15,         // services have typed API signatures
  specCompleteness: 10,      // specification has requirements + constraints
  contentIntegrity: 10,      // no truncation or error messages
} as const;

/**
 * Validate SPARC output quality and produce a detailed report.
 */
export function validateSPARCQuality(sparc: Phase2SPARCOutput): SPARCQualityReport {
  const issues: string[] = [];

  const modules = sparc.pseudocode.modules;
  const services = sparc.architecture.services;
  const spec = sparc.specification;

  const totalModules = modules.length;
  const totalServices = services.length;

  // ---- Empty output fast-path ----
  if (totalModules === 0 && totalServices === 0) {
    return {
      passed: false,
      score: 0,
      issues: ['SPARC output contains zero pseudocode modules and zero services. Generation may have failed entirely.'],
      servicesWithPseudocode: 0,
      totalServices: 0,
      modulesWithDataStructures: 0,
      modulesWithAlgorithms: 0,
      totalModules: 0,
      apisWithSignatures: 0,
      truncatedContentDetected: false,
      errorMessagesDetected: false,
    };
  }

  // ---- Count signals ----

  // 1. Services with at least one pseudocode module
  const serviceNames = new Set(services.map((s) => s.name.toLowerCase()));
  const moduleMappedServices = new Set<string>();
  for (const mod of modules) {
    // Try to map modules to services by name similarity
    const modNameLower = mod.name.toLowerCase();
    for (const svcName of serviceNames) {
      if (modNameLower.includes(svcName) || svcName.includes(modNameLower)) {
        moduleMappedServices.add(svcName);
      }
    }
  }
  // If no direct mapping, count by ratio of modules to services
  const servicesWithPseudocode = moduleMappedServices.size > 0
    ? moduleMappedServices.size
    : Math.min(totalServices, totalModules);

  // 2. Modules with typed data structures
  const modulesWithDataStructures = modules.filter(moduleHasTypedDataStructures).length;

  // 3. Modules with real algorithms
  const modulesWithAlgorithms = modules.filter(moduleHasAlgorithms).length;

  // 4. Services with typed API signatures
  const apisWithSignatures = services.filter(serviceHasTypedAPIs).length;

  // 5. Content integrity
  const truncatedContentDetected = detectTruncation(sparc);
  const errorMessagesDetected = detectErrorMessages(sparc);

  // ---- Compute sub-scores ----
  const servicesCoveredRatio = totalServices > 0
    ? servicesWithPseudocode / totalServices
    : (totalModules > 0 ? 1 : 0);
  const servicesCoveredScore = servicesCoveredRatio * WEIGHTS.servicesCovered;

  const dsRatio = totalModules > 0 ? modulesWithDataStructures / totalModules : 0;
  const dataStructuresScore = dsRatio * WEIGHTS.dataStructures;

  const algoRatio = totalModules > 0 ? modulesWithAlgorithms / totalModules : 0;
  const algorithmsScore = algoRatio * WEIGHTS.algorithms;

  const apiRatio = totalServices > 0 ? apisWithSignatures / totalServices : 0;
  const apiScore = apiRatio * WEIGHTS.apiSignatures;

  // Spec completeness: has requirements, constraints, and success criteria
  const specParts = [
    spec.requirements.length > 0 ? 1 : 0,
    spec.constraints.length > 0 ? 1 : 0,
    spec.successCriteria.length > 0 ? 1 : 0,
  ];
  const specRatio = specParts.reduce((a, b) => a + b, 0) / 3;
  const specScore = specRatio * WEIGHTS.specCompleteness;

  // Content integrity penalty
  let integrityPenalty = 0;
  if (truncatedContentDetected) integrityPenalty += WEIGHTS.contentIntegrity / 2;
  if (errorMessagesDetected) integrityPenalty += WEIGHTS.contentIntegrity / 2;
  const integrityScore = WEIGHTS.contentIntegrity - integrityPenalty;

  const rawScore = servicesCoveredScore + dataStructuresScore + algorithmsScore +
    apiScore + specScore + integrityScore;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // ---- Collect actionable issues ----
  if (totalModules === 0) {
    issues.push('No pseudocode modules generated. SPARC pseudocode phase may have been skipped.');
  }

  if (totalServices === 0) {
    issues.push('No services defined in SPARC architecture. Architecture phase may have been skipped.');
  }

  if (totalServices > 0 && servicesWithPseudocode < totalServices) {
    issues.push(
      `Only ${servicesWithPseudocode}/${totalServices} services have corresponding pseudocode modules. ` +
      'Each service needs at least one pseudocode module for DDD generation.',
    );
  }

  if (totalModules > 0 && modulesWithDataStructures < totalModules) {
    issues.push(
      `Only ${modulesWithDataStructures}/${totalModules} modules have typed data structures. ` +
      'Add "{ fieldName: type }" definitions to dataStructures arrays.',
    );
  }

  if (totalModules > 0 && modulesWithAlgorithms < totalModules) {
    issues.push(
      `Only ${modulesWithAlgorithms}/${totalModules} modules have non-trivial algorithms. ` +
      'Algorithm arrays should contain real control flow, not empty strings.',
    );
  }

  if (totalServices > 0 && apisWithSignatures < totalServices) {
    issues.push(
      `Only ${apisWithSignatures}/${totalServices} services have typed API signatures. ` +
      'API entries should include input/output types (e.g. "createOrder(input: CreateOrderDTO) => OrderConfirmation").',
    );
  }

  if (spec.requirements.length === 0) {
    issues.push('Specification has no requirements. At least one "must" requirement is expected.');
  }

  if (spec.constraints.length === 0) {
    issues.push('Specification has no constraints defined.');
  }

  if (truncatedContentDetected) {
    issues.push('Truncated content detected in SPARC output. LLM response may have been cut off by token limits.');
  }

  if (errorMessagesDetected) {
    issues.push('Error messages or stack traces detected in SPARC content. Generation may have partially failed.');
  }

  const passed = score >= PASSING_SCORE;

  return {
    passed,
    score,
    issues,
    servicesWithPseudocode,
    totalServices,
    modulesWithDataStructures,
    modulesWithAlgorithms,
    totalModules,
    apisWithSignatures,
    truncatedContentDetected,
    errorMessagesDetected,
  };
}

// ============================================================================
// Pipeline Stage Entry Point
// ============================================================================

/**
 * Execute the SPARC quality gate as a Phase 2 pipeline stage.
 *
 * Reads the SPARC output from context stage outputs, validates it,
 * and returns a stage output indicating pass or fail.
 *
 * @throws Error with ECLI-P2-041 if SPARC output is not on context
 */
export async function executeSPARCQualityGate(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const start = Date.now();

  const sparcOutput = context.stageOutputs.get('sparc-specification');
  if (!sparcOutput || sparcOutput.status !== 'completed' || !sparcOutput.data) {
    throw new Error(
      'ECLI-P2-041: SPARC output not available on context. ' +
      'The sparc-specification stage must complete successfully before the SPARC quality gate.',
    );
  }

  const sparc = sparcOutput.data as Phase2SPARCOutput;
  const report = validateSPARCQuality(sparc);
  const elapsed = Date.now() - start;

  if (!report.passed) {
    console.error(`  [QUALITY-GATE] SPARC output FAILED (score: ${report.score}/100)`);
    for (const issue of report.issues) {
      console.error(`    - ${issue}`);
    }

    return {
      stage: 'sparc-specification',
      status: 'failed',
      data: report,
      artifacts: [],
      timing: elapsed,
      summary:
        `ECLI-P2-040: SPARC output quality too low (score: ${report.score}/100, minimum: ${PASSING_SCORE}). ` +
        `Issues: ${report.issues.join(' | ')}`,
    };
  }

  console.error(`  [QUALITY-GATE] SPARC output PASSED (score: ${report.score}/100)`);
  console.error(`    Modules: ${report.totalModules}, Services: ${report.totalServices}, ` +
    `Data structures OK: ${report.modulesWithDataStructures}, APIs typed: ${report.apisWithSignatures}`);

  return {
    stage: 'sparc-specification',
    status: 'completed',
    data: report,
    artifacts: [],
    timing: elapsed,
    summary:
      `SPARC quality gate passed (score: ${report.score}/100). ` +
      `${report.totalModules} modules, ${report.totalServices} services validated.`,
  };
}
