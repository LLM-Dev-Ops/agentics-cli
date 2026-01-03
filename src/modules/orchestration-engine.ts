/**
 * Orchestration Engine Module (Module B)
 *
 * SPARC Architecture Reference: §2.3
 *
 * PURPOSE: Sequence calls to downstream services
 *
 * DEPENDENCIES: Downstream Adapters only
 *
 * FORBIDDEN:
 * - Response Interpretation (NO parsing of downstream responses)
 * - Business Logic (NO conditional branching based on data)
 * - Data Transformation (NO field mapping or conversion)
 * - State Management (NO storage of intermediate results)
 */

import type {
  OrchestrationResult,
  StageResult,
  ArtifactReference,
  CommandOptions,
} from '../types/index.js';
import type { IDownstreamAdapter } from '../adapters/base-adapter.js';
import { CLIError } from '../errors/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface IOrchestrationEngine {
  execute(stages: OrchestrationStage[], options: CommandOptions): Promise<OrchestrationResult>;
}

export interface OrchestrationStage {
  name: string;
  adapter: IDownstreamAdapter;
  request: StageRequest;
  dependsOn?: string[];
}

export interface StageRequest {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  buildBody: (previousResults: Map<string, unknown>) => unknown;
}

// ============================================================================
// Orchestration Engine Implementation
// ============================================================================

export class OrchestrationEngine implements IOrchestrationEngine {
  private readonly correlationId: string;

  constructor(correlationId?: string) {
    this.correlationId = correlationId ?? crypto.randomUUID();
  }

  async execute(
    stages: OrchestrationStage[],
    options: CommandOptions
  ): Promise<OrchestrationResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const stageResults: StageResult[] = [];
    const previousResults = new Map<string, unknown>();
    const artifacts: ArtifactReference[] = [];
    const breakdown: Record<string, number> = {};

    // Execute stages in dependency order
    const executed = new Set<string>();
    const pending = [...stages];

    while (pending.length > 0) {
      // Find stages ready to execute (all dependencies satisfied)
      const ready = pending.filter(stage =>
        !stage.dependsOn || stage.dependsOn.every(dep => executed.has(dep))
      );

      if (ready.length === 0 && pending.length > 0) {
        throw new CLIError({
          code: 'ECLI-ORCH-001',
          category: 'INTERNAL_ERROR',
          message: 'Circular dependency detected in orchestration stages',
          module: 'orchestration',
          correlationId: this.correlationId,
        });
      }

      // Execute ready stages sequentially (SPARC: no parallel execution to maintain order)
      for (const stage of ready) {
        const stageStartTime = Date.now();

        try {
          // Build request body from previous results - PASSTHROUGH only
          const body = stage.request.buildBody(previousResults);

          // Invoke downstream adapter
          const response = await stage.adapter.invoke({
            endpoint: stage.request.endpoint,
            method: stage.request.method,
            headers: {},
            body,
            timeout: options.timeout,
          });

          const stageTiming = Date.now() - stageStartTime;
          breakdown[stage.name] = stageTiming;

          // Store raw response for next stages - NO interpretation
          previousResults.set(stage.name, response.body);

          // Extract artifact reference if present - PASSTHROUGH
          const artifact = this.extractArtifact(response.body);
          if (artifact) {
            artifacts.push(artifact);
          }

          stageResults.push({
            name: stage.name,
            status: 'complete',
            response: response.body,
            timing: stageTiming,
          });

          executed.add(stage.name);
        } catch (error) {
          const stageTiming = Date.now() - stageStartTime;
          breakdown[stage.name] = stageTiming;

          stageResults.push({
            name: stage.name,
            status: 'failed',
            response: null,
            error: error instanceof CLIError ? error.toErrorInfo() : {
              code: 'ECLI-ORCH-002',
              category: 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString(),
              module: 'orchestration',
              correlationId: this.correlationId,
            },
            timing: stageTiming,
          });

          // Fail fast - do not continue on error
          const completedAt = new Date().toISOString();
          return {
            stages: stageResults,
            artifacts,
            timing: {
              total: Date.now() - startTime,
              breakdown,
              started_at: startedAt,
              completed_at: completedAt,
            },
            success: false,
          };
        }

        // Remove from pending
        const idx = pending.indexOf(stage);
        if (idx > -1) {
          pending.splice(idx, 1);
        }
      }
    }

    const completedAt = new Date().toISOString();

    return {
      stages: stageResults,
      artifacts,
      timing: {
        total: Date.now() - startTime,
        breakdown,
        started_at: startedAt,
        completed_at: completedAt,
      },
      success: true,
    };
  }

  /**
   * Extract artifact reference from response body - PASSTHROUGH only
   * No validation or transformation of the reference
   */
  private extractArtifact(body: unknown): ArtifactReference | null {
    if (!body || typeof body !== 'object') {
      return null;
    }

    const obj = body as Record<string, unknown>;

    // Check for standard reference fields - PASSTHROUGH
    if ('id' in obj && 'type' in obj) {
      return {
        id: String(obj['id']),
        type: String(obj['type']),
        location: 'location' in obj ? String(obj['location']) : '',
        checksum: 'checksum' in obj ? String(obj['checksum']) : undefined,
        metadata: 'metadata' in obj && typeof obj['metadata'] === 'object'
          ? obj['metadata'] as Record<string, string>
          : undefined,
      };
    }

    return null;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createOrchestrationEngine(correlationId?: string): IOrchestrationEngine {
  return new OrchestrationEngine(correlationId);
}
