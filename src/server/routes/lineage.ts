/**
 * Lineage Route Handler (ADR-004)
 *
 * Provides lineage query endpoints for tracing artifacts to simulations
 * and simulations to artifacts.
 *
 * Routes:
 * - POST /v1/lineage           - Store a lineage record
 * - GET  /v1/lineage/artifact/:id  - Trace backward: artifact → simulation
 * - GET  /v1/lineage/simulation/:id/artifacts - Trace forward: simulation → artifacts
 */

import { Hono } from 'hono';
import { generateId, generateChecksum } from '../utils/id-generator.js';

const lineage = new Hono();

// ============================================================================
// In-memory lineage store (stub — production uses Ruvector)
// ============================================================================

interface LineageEntry {
  id: string;
  artifact_id: string;
  artifact_category: string;
  simulation_id: string;
  plan_id?: string;
  decision_context: string;
  attribution: { created_by: string; org_id: string };
  governance: { gate_pipeline_version: string; synthesis_classification: string };
  created_at: string;
}

const lineageStore = new Map<string, LineageEntry>();

// ============================================================================
// POST /v1/lineage — Store a lineage record
// ============================================================================

lineage.post('/', async (c) => {
  try {
    const body = await c.req.json<LineageEntry>();

    // Validate required fields (ADR-004, Invariant 3)
    if (!body.artifact_id || !body.simulation_id) {
      return c.json({
        error: {
          code: 'LINEAGE_VALIDATION_ERROR',
          message: 'artifact_id and simulation_id are required (ADR-004, Invariant 3)',
        },
      }, 400);
    }

    const id = body.id ?? generateId('lin');
    const entry: LineageEntry = {
      ...body,
      id,
      created_at: body.created_at ?? new Date().toISOString(),
    };

    lineageStore.set(id, entry);

    // Also index by artifact_id and simulation_id for queries
    return c.json({
      id,
      type: 'LineageRecord',
      artifact_id: entry.artifact_id,
      simulation_id: entry.simulation_id,
      created_at: entry.created_at,
      checksum: generateChecksum(),
    }, 201);
  } catch (error) {
    console.error('Lineage store error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    }, 500);
  }
});

// ============================================================================
// GET /v1/lineage/artifact/:id — Trace backward: artifact → simulation
// ============================================================================

lineage.get('/artifact/:id', async (c) => {
  const artifactId = c.req.param('id');

  // Find lineage records for this artifact
  const records: LineageEntry[] = [];
  for (const entry of lineageStore.values()) {
    if (entry.artifact_id === artifactId) {
      records.push(entry);
    }
  }

  if (records.length === 0) {
    // Return stub response for demo purposes
    return c.json({
      artifact_id: artifactId,
      lineage: [],
      trace_complete: false,
      message: 'No lineage records found for this artifact',
    });
  }

  return c.json({
    artifact_id: artifactId,
    lineage: records.map(r => ({
      lineage_id: r.id,
      simulation_id: r.simulation_id,
      plan_id: r.plan_id,
      artifact_category: r.artifact_category,
      decision_context: r.decision_context,
      attribution: r.attribution,
      governance: r.governance,
      created_at: r.created_at,
    })),
    trace_complete: true,
  });
});

// ============================================================================
// GET /v1/lineage/simulation/:id/artifacts — Trace forward
// ============================================================================

lineage.get('/simulation/:id/artifacts', async (c) => {
  const simulationId = c.req.param('id');

  // Find all artifacts produced by this simulation
  const records: LineageEntry[] = [];
  for (const entry of lineageStore.values()) {
    if (entry.simulation_id === simulationId) {
      records.push(entry);
    }
  }

  if (records.length === 0) {
    // Return stub response
    return c.json({
      simulation_id: simulationId,
      artifacts: [],
      count: 0,
      message: 'No artifacts found for this simulation',
    });
  }

  return c.json({
    simulation_id: simulationId,
    artifacts: records.map(r => ({
      lineage_id: r.id,
      artifact_id: r.artifact_id,
      artifact_category: r.artifact_category,
      plan_id: r.plan_id,
      created_at: r.created_at,
    })),
    count: records.length,
  });
});

export { lineage };
