/**
 * simulator-agents Cloud Function (Gen 2)
 *
 * Handles INTERNAL PLATFORM simulation — what-if scenarios about the
 * agentics platform itself (model switches, agent deployment, scaling, etc.)
 *
 * Routes:
 *   POST /v1/simulator/scenario  — platform scenario analysis
 *   POST /v1/simulator/what-if   — platform impact assessment
 *
 * Deploy:
 *   gcloud functions deploy simulator-agents --gen2 --runtime nodejs20 \
 *     --trigger-http --region us-central1 --project agentics-dev \
 *     --entry-point handler --memory 512MB --timeout 300s
 */

import * as ff from '@google-cloud/functions-framework';
import { scenarioInputSchema, whatIfInputSchema } from './types.js';
import { analyzeScenario } from './scenario-engine.js';
import { analyzeWhatIf } from './whatif-engine.js';
import { enhanceScenario, enhanceWhatIf } from './llm-enhance.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getApiKey(req: ff.Request): string | undefined {
  return (
    req.headers['x-anthropic-api-key'] as string | undefined
    ?? process.env['ANTHROPIC_API_KEY']
  );
}

function errorResponse(res: ff.Response, code: string, message: string, status: number): void {
  res.status(status).json({ error: { code, message } });
}

// ─── Route Handling ────────────────────────────────────────────────────────────

ff.http('handler', async (req: ff.Request, res: ff.Response) => {
  // CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-ID, X-Anthropic-Api-Key');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  const path = req.path || '/';
  const traceId = (req.headers['x-correlation-id'] as string) ?? generateUUID();
  const apiKey = getApiKey(req);

  // GET / — discovery
  if (req.method === 'GET' && (path === '/' || path === '/v1/simulator')) {
    res.json({
      domain: 'simulator',
      agents: ['what-if', 'scenario'],
      version: 'v1',
      total_agents: 2,
      capabilities: {
        llm_enhanced: !!apiKey,
        analysis_method: apiKey ? 'llm-enhanced' : 'rule-based',
      },
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && path === '/health') {
    res.json({ status: 'healthy', service: 'simulator-agents', timestamp: new Date().toISOString() });
    return;
  }

  // Only POST allowed for agent invocation
  if (req.method !== 'POST') {
    errorResponse(res, 'METHOD_NOT_ALLOWED', `${req.method} not allowed`, 405);
    return;
  }

  // ─── Route: POST /v1/simulator/scenario ────────────────────────────────────

  if (path === '/v1/simulator/scenario' || path === '/scenario') {
    const startMs = Date.now();

    const parsed = scenarioInputSchema.safeParse(req.body);
    if (!parsed.success) {
      errorResponse(res, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
      return;
    }

    let result = analyzeScenario(parsed.data);
    result = await enhanceScenario(apiKey, result);

    const durationMs = Date.now() - startMs;
    const executionId = generateUUID();
    const timestamp = new Date().toISOString();

    res.json({
      data: {
        result,
        execution_metadata: {
          trace_id: traceId,
          agent: 'scenario',
          domain: 'simulator',
          timestamp,
        },
      },
      execution_metadata: {
        trace_id: traceId,
        timestamp,
        service: 'simulator-agents',
        execution_id: executionId,
      },
      layers_executed: [
        { layer: 'AGENT_ROUTING', status: 'completed' },
        { layer: 'SIMULATOR_SCENARIO', status: 'completed', duration_ms: durationMs },
      ],
    });
    return;
  }

  // ─── Route: POST /v1/simulator/what-if ─────────────────────────────────────

  if (path === '/v1/simulator/what-if' || path === '/what-if') {
    const startMs = Date.now();

    const parsed = whatIfInputSchema.safeParse(req.body);
    if (!parsed.success) {
      errorResponse(res, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
      return;
    }

    let result = analyzeWhatIf(parsed.data);
    result = await enhanceWhatIf(apiKey, result);

    const durationMs = Date.now() - startMs;
    const executionId = generateUUID();
    const timestamp = new Date().toISOString();

    res.json({
      data: {
        result,
        execution_metadata: {
          trace_id: traceId,
          agent: 'what-if',
          domain: 'simulator',
          timestamp,
        },
      },
      execution_metadata: {
        trace_id: traceId,
        timestamp,
        service: 'simulator-agents',
        execution_id: executionId,
      },
      layers_executed: [
        { layer: 'AGENT_ROUTING', status: 'completed' },
        { layer: 'SIMULATOR_WHAT_IF', status: 'completed', duration_ms: durationMs },
      ],
    });
    return;
  }

  // ─── 404 ───────────────────────────────────────────────────────────────────

  errorResponse(res, 'NOT_FOUND', `Unknown route: ${req.method} ${path}. Valid: POST /v1/simulator/scenario, POST /v1/simulator/what-if`, 404);
});
