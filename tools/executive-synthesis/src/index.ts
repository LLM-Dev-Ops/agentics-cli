#!/usr/bin/env node
/**
 * Executive Synthesis Tool (agentics-diligence-artifacts)
 *
 * Produces executive decision memos from simulation output
 * and persists learning events to RuVector.
 *
 * USAGE:
 *   echo '{"simulation": ...}' | node dist/index.js --objective "intent" --command "agentics simulate"
 *
 * OUTPUT:
 *   - decision-summary.md written to current directory
 *   - Decision record persisted to ruvector-service
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

interface SimulationOutput {
  id: string;
  type: string;
  repository: string;
  created_at: string;
  checksum: string;
  scenario?: {
    scenarioId: string;
    name: string;
    description: string;
    category: string;
    version: string;
  };
  status: string;
  iteration_count: number;
  started_at: string;
  completed_at: string;
  steps_executed?: Array<{
    stepId: string;
    action: string;
    status: string;
    duration_ms: number;
  }>;
  results?: {
    total_iterations: number;
    successful_iterations: number;
    failed_iterations: number;
    success_rate?: number;
    average_duration_ms?: number;
    metrics?: Record<string, unknown>;
  };
  execution_metadata?: {
    execution_id: string;
    layer: string;
    timestamp: string;
    checksum: string;
    trace_id: string;
  };
}

interface DecisionRecord {
  id: string;
  objective: string;
  command: string;
  raw_output_hash: string;
  recommendation: string;
  confidence: string;
  signals: {
    financial: string;
    risk: string;
    complexity: string;
  };
  embedding_text: string;
  graph_relations: {
    objective_to_repos: string[];
    repos_to_signals: Record<string, string[]>;
    signals_to_recommendation: string[];
  };
  created_at: string;
}

// ============================================================================
// Signal Analysis
// ============================================================================

function analyzeFinancialSignals(output: SimulationOutput): string {
  const results = output.results;
  if (!results) return 'No financial metrics available';

  const successRate = results.success_rate ?? (results.successful_iterations / results.total_iterations);
  const avgDuration = results.average_duration_ms ?? 0;

  if (successRate >= 0.95) {
    return `High viability (${(successRate * 100).toFixed(1)}% success). Estimated ROI positive based on simulation metrics.`;
  } else if (successRate >= 0.8) {
    return `Moderate viability (${(successRate * 100).toFixed(1)}% success). ROI dependent on implementation quality.`;
  } else {
    return `Low viability (${(successRate * 100).toFixed(1)}% success). Financial risk elevated.`;
  }
}

function analyzeRiskSignals(output: SimulationOutput): string {
  const results = output.results;
  const failedIterations = results?.failed_iterations ?? 0;
  const totalIterations = results?.total_iterations ?? 1;
  const failureRate = failedIterations / totalIterations;

  const risks: string[] = [];

  if (failureRate > 0.1) {
    risks.push(`${(failureRate * 100).toFixed(1)}% failure rate indicates execution risk`);
  }

  if (!output.execution_metadata) {
    risks.push('Missing execution metadata (incomplete simulation)');
  }

  const category = output.scenario?.category?.toLowerCase() ?? '';
  if (category.includes('enterprise') || category.includes('erp')) {
    risks.push('Enterprise scope requires phased rollout');
  }

  if (risks.length === 0) {
    return 'Low risk profile. Standard deployment protocols apply.';
  }

  return risks.join('. ') + '.';
}

function analyzeComplexitySignals(output: SimulationOutput): string {
  const stepsCount = output.steps_executed?.length ?? 0;
  const iterationCount = output.iteration_count ?? 1;
  const category = output.scenario?.category ?? 'general';

  const complexityFactors: string[] = [];

  if (stepsCount > 5) {
    complexityFactors.push(`${stepsCount} execution steps`);
  }

  if (iterationCount > 1) {
    complexityFactors.push(`${iterationCount} iterations`);
  }

  if (category === 'enterprise' || category === 'integration') {
    complexityFactors.push(`${category} category (elevated complexity)`);
  }

  if (complexityFactors.length === 0) {
    return 'Standard complexity. No special handling required.';
  }

  return `Elevated complexity: ${complexityFactors.join(', ')}.`;
}

function generateConfidence(output: SimulationOutput): string {
  const results = output.results;
  if (!results) return 'LOW - Insufficient data';

  const successRate = results.success_rate ?? (results.successful_iterations / results.total_iterations);
  const hasMetadata = !!output.execution_metadata;
  const iterationCount = output.iteration_count ?? 1;

  let score = 0;

  // Success rate contribution (0-40 points)
  score += successRate * 40;

  // Metadata presence (20 points)
  if (hasMetadata) score += 20;

  // Iteration depth (0-20 points)
  score += Math.min(iterationCount * 5, 20);

  // Status completion (20 points)
  if (output.status === 'completed') score += 20;

  if (score >= 80) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  return 'LOW';
}

function generateRecommendation(output: SimulationOutput, objective: string): string {
  const confidence = generateConfidence(output);
  const results = output.results;
  const successRate = results?.success_rate ?? (results?.successful_iterations ?? 0) / (results?.total_iterations ?? 1);

  if (confidence === 'HIGH' && successRate >= 0.9) {
    return `PROCEED: The simulation for "${objective}" demonstrates strong viability with ${(successRate * 100).toFixed(0)}% success rate. Recommend proceeding to deployment planning phase.`;
  } else if (confidence === 'MEDIUM' || successRate >= 0.7) {
    return `CONDITIONAL PROCEED: The simulation for "${objective}" shows moderate viability (${(successRate * 100).toFixed(0)}% success). Recommend pilot deployment with monitoring.`;
  } else {
    return `DEFER: The simulation for "${objective}" indicates elevated risk (${(successRate * 100).toFixed(0)}% success). Recommend additional analysis or scope refinement.`;
  }
}

// ============================================================================
// Decision Summary Generation
// ============================================================================

function generateDecisionSummary(
  output: SimulationOutput,
  objective: string,
  command: string
): string {
  const now = new Date().toISOString();
  const financialSignal = analyzeFinancialSignals(output);
  const riskSignal = analyzeRiskSignals(output);
  const complexitySignal = analyzeComplexitySignals(output);
  const confidence = generateConfidence(output);
  const recommendation = generateRecommendation(output, objective);

  return `# Executive Decision Summary

## Objective
${objective}

## Command Executed
\`${command}\`

## Recommendation
${recommendation}

## Confidence Level
**${confidence}**

## Signal Analysis

### Financial Assessment
${financialSignal}

### Risk Assessment
${riskSignal}

### Complexity Assessment
${complexitySignal}

## Simulation Metrics

| Metric | Value |
|--------|-------|
| Simulation ID | \`${output.id}\` |
| Status | ${output.status} |
| Success Rate | ${((output.results?.success_rate ?? 0) * 100).toFixed(1)}% |
| Total Iterations | ${output.results?.total_iterations ?? output.iteration_count ?? 1} |
| Successful | ${output.results?.successful_iterations ?? 'N/A'} |
| Failed | ${output.results?.failed_iterations ?? 'N/A'} |
| Category | ${output.scenario?.category ?? 'general'} |

## Execution Details

- **Started**: ${output.started_at}
- **Completed**: ${output.completed_at}
- **Trace ID**: ${output.execution_metadata?.trace_id ?? output.id}

---
*Generated: ${now}*
*Source: agentics-diligence-artifacts executive synthesis*
`;
}

// ============================================================================
// RuVector Persistence
// ============================================================================

async function persistToRuvector(record: DecisionRecord): Promise<void> {
  const ruvectorUrl = process.env['RUVECTOR_SERVICE_URL'] ??
    'https://ruvvector-service-1062287243982.us-central1.run.app';

  try {
    const response = await fetch(`${ruvectorUrl}/v1/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': record.id,
        'X-API-Version': 'v1',
      },
      body: JSON.stringify(record),
    });

    if (!response.ok) {
      // Best-effort persistence - log warning but don't fail
      console.error(JSON.stringify({
        level: 'WARN',
        message: 'Failed to persist decision record to RuVector',
        status: response.status,
        decision_id: record.id,
      }));
    }
  } catch (error) {
    // Network errors are logged but don't fail synthesis
    console.error(JSON.stringify({
      level: 'WARN',
      message: 'RuVector persistence failed',
      error: error instanceof Error ? error.message : String(error),
      decision_id: record.id,
    }));
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  // Parse arguments
  const args = process.argv.slice(2);
  let objective = '';
  let command = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--objective' && args[i + 1]) {
      objective = args[i + 1];
      i++;
    } else if (args[i] === '--command' && args[i + 1]) {
      command = args[i + 1];
      i++;
    }
  }

  if (!objective || !command) {
    console.error('Usage: node dist/index.js --objective "<intent>" --command "<command>"');
    process.exit(1);
  }

  // Read JSON from stdin
  let inputData = '';

  if (process.stdin.isTTY) {
    console.error('Error: Expected JSON input from stdin');
    process.exit(1);
  }

  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  if (!inputData.trim()) {
    console.error('Error: No input received from stdin');
    process.exit(1);
  }

  let output: SimulationOutput;
  try {
    output = JSON.parse(inputData);
  } catch (e) {
    console.error('Error: Invalid JSON input');
    process.exit(1);
  }

  // Generate decision summary
  const summary = generateDecisionSummary(output, objective, command);

  // Write decision-summary.md
  const outputPath = path.join(process.cwd(), 'decision-summary.md');
  fs.writeFileSync(outputPath, summary, 'utf-8');

  // Build decision record for RuVector
  const rawOutputHash = crypto
    .createHash('sha256')
    .update(inputData)
    .digest('hex');

  const recommendation = generateRecommendation(output, objective);
  const confidence = generateConfidence(output);

  const record: DecisionRecord = {
    id: `decision-${crypto.randomUUID()}`,
    objective,
    command,
    raw_output_hash: rawOutputHash,
    recommendation,
    confidence,
    signals: {
      financial: analyzeFinancialSignals(output),
      risk: analyzeRiskSignals(output),
      complexity: analyzeComplexitySignals(output),
    },
    embedding_text: `${objective} ${recommendation}`,
    graph_relations: {
      objective_to_repos: [output.repository],
      repos_to_signals: {
        [output.repository]: ['financial', 'risk', 'complexity'],
      },
      signals_to_recommendation: [recommendation.split(':')[0]],
    },
    created_at: new Date().toISOString(),
  };

  // Persist to RuVector (best-effort, non-blocking for output)
  await persistToRuvector(record);

  // Output success message to stderr (stdout preserved for JSON passthrough if needed)
  console.error(`[synthesis] Decision summary written to: ${outputPath}`);
}

main().catch((error) => {
  console.error('Synthesis failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
