/**
 * Phase 5 Build — Stage 3: Integration Inference
 *
 * Scans scenario query, SPARC architecture, ADR titles, DDD domain model
 * contexts, and research dossier items to infer which of the 62+ pre-built
 * integration modules (from LLM-Dev-Ops/integrations) the target organization
 * would use.
 *
 * Produces a scored, ranked list of integrations grouped by category.
 *
 * Reuses:
 *   - detectERPFromText() from src/deps/erp-database-map.ts
 *   - ERP_DATABASE_MAP for ERP→database engine mapping
 *
 * Error codes:
 *   ECLI-P5B-030  Integration inference failed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Phase5BuildContext,
  IntegrationModule,
  InferredIntegration,
  IntegrationInferenceResult,
} from '../types.js';
import { detectERPFromText } from '../../../deps/erp-database-map.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

// ============================================================================
// Integration Catalog — All 62+ modules from LLM-Dev-Ops/integrations
// ============================================================================

const INTEGRATION_CATALOG: readonly IntegrationModule[] = [
  // ── LLM / Model / Inference Providers ──
  { id: 'anthropic',    category: 'llm', repoPath: 'anthropic',    keywords: ['anthropic', 'claude', 'ai assistant'], erpSignals: [], domainSignals: ['ai', 'copilot', 'assistant'], alwaysInclude: false, weight: 0.6, hasRustVariant: true },
  { id: 'openai',       category: 'llm', repoPath: 'openai',       keywords: ['openai', 'gpt', 'chatgpt', 'gpt-4', 'ai copilot', 'ai assistant', 'llm'], erpSignals: [], domainSignals: ['ai', 'copilot', 'assistant', 'summarize', 'analyze', 'predict'], alwaysInclude: false, weight: 0.8, hasRustVariant: true },
  { id: 'gemini',       category: 'llm', repoPath: 'gemini',       keywords: ['gemini', 'google ai', 'vertex ai'], erpSignals: [], domainSignals: ['ai', 'copilot'], alwaysInclude: false, weight: 0.5, hasRustVariant: true },
  { id: 'groq',         category: 'llm', repoPath: 'groq',         keywords: ['groq'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.3, hasRustVariant: true },
  { id: 'cohere',       category: 'llm', repoPath: 'cohere',       keywords: ['cohere', 'rerank', 'embed'], erpSignals: [], domainSignals: ['search', 'semantic'], alwaysInclude: false, weight: 0.3, hasRustVariant: true },
  { id: 'mistral',      category: 'llm', repoPath: 'mistral',      keywords: ['mistral'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.3, hasRustVariant: true },
  { id: 'ollama',       category: 'llm', repoPath: 'ollama',       keywords: ['ollama', 'local llm', 'self-hosted model'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'vllm',         category: 'llm', repoPath: 'vllm',         keywords: ['vllm'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'xai',          category: 'llm', repoPath: 'xai',          keywords: ['xai', 'grok', 'x.ai'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'huggingface',  category: 'llm', repoPath: 'huggingface',  keywords: ['huggingface', 'hugging face', 'transformers'], erpSignals: [], domainSignals: ['embeddings', 'fine-tune'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },

  // ── Cloud Providers — GCP ──
  { id: 'gcp/bigquery',       category: 'cloud', repoPath: 'gcp/bigquery',       keywords: ['bigquery', 'big query', 'data warehouse'], erpSignals: ['sap-s4hana', 'sap-ecc', 'sap-business-one'], domainSignals: ['analytics', 'reporting', 'warehouse'], alwaysInclude: false, weight: 0.5, hasRustVariant: false },
  { id: 'gcp/cloud-logging',  category: 'cloud', repoPath: 'gcp/cloud-logging',  keywords: ['cloud logging', 'gcp logging', 'stackdriver'], erpSignals: ['sap-s4hana', 'sap-ecc', 'sap-business-one'], domainSignals: [], alwaysInclude: false, weight: 0.4, hasRustVariant: false },
  { id: 'gcp/firestore',      category: 'cloud', repoPath: 'gcp/firestore',      keywords: ['firestore', 'gcp firestore'], erpSignals: ['sap-s4hana', 'sap-ecc'], domainSignals: ['cache', 'session', 'state'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'gcp/pubsub',         category: 'cloud', repoPath: 'gcp/pubsub',         keywords: ['pub/sub', 'pubsub', 'gcp pubsub', 'event bus'], erpSignals: ['sap-s4hana', 'sap-ecc', 'sap-business-one'], domainSignals: ['event', 'async', 'message', 'queue'], alwaysInclude: false, weight: 0.5, hasRustVariant: false },
  { id: 'gcp/storage',        category: 'cloud', repoPath: 'gcp/storage',        keywords: ['gcs', 'cloud storage', 'gcp storage'], erpSignals: ['sap-s4hana', 'sap-ecc', 'sap-business-one'], domainSignals: ['document', 'file', 'upload', 'attachment'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },

  // ── Cloud Providers — AWS ──
  { id: 'aws/bedrock',         category: 'cloud', repoPath: 'aws/bedrock',         keywords: ['aws bedrock', 'bedrock'], erpSignals: [], domainSignals: ['ai', 'llm'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'aws/s3',              category: 'cloud', repoPath: 'aws/s3',              keywords: ['aws s3', 's3 bucket'], erpSignals: [], domainSignals: ['document', 'file', 'storage'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'aws/dynamodb',        category: 'cloud', repoPath: 'aws/dynamodb',        keywords: ['dynamodb'], erpSignals: [], domainSignals: ['nosql', 'cache'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'aws/ses',             category: 'cloud', repoPath: 'aws/ses',             keywords: ['aws ses', 'simple email'], erpSignals: [], domainSignals: ['email', 'notification'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'aws/secrets-manager', category: 'cloud', repoPath: 'aws/secrets-manager', keywords: ['aws secrets', 'secrets manager'], erpSignals: [], domainSignals: ['secret', 'credential'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'aws/cloudwatch-logs', category: 'cloud', repoPath: 'aws/cloudwatch-logs', keywords: ['cloudwatch'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'aws/iam',             category: 'cloud', repoPath: 'aws/iam',             keywords: ['aws iam'], erpSignals: [], domainSignals: ['identity', 'role'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },

  // ── Cloud Providers — Azure ──
  { id: 'azure/active-directory', category: 'identity', repoPath: 'azure/active-directory', keywords: ['azure ad', 'entra id', 'active directory'], erpSignals: ['microsoft-dynamics'], domainSignals: ['identity', 'sso'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },
  { id: 'azure/blob-storage',    category: 'cloud',    repoPath: 'azure/blob-storage',    keywords: ['azure blob', 'blob storage'], erpSignals: ['microsoft-dynamics'], domainSignals: ['file', 'document'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'azure/cognitive-search', category: 'cloud',   repoPath: 'azure/cognitive-search', keywords: ['azure search', 'cognitive search'], erpSignals: ['microsoft-dynamics'], domainSignals: ['search', 'semantic'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'azure/key-vault',       category: 'cloud',    repoPath: 'azure/key-vault',       keywords: ['azure key vault'], erpSignals: ['microsoft-dynamics'], domainSignals: ['secret', 'credential'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'azure/openai',          category: 'llm',      repoPath: 'azure/openai',          keywords: ['azure openai'], erpSignals: ['microsoft-dynamics'], domainSignals: ['ai', 'copilot'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },

  // ── Identity / OAuth / SSO ──
  { id: 'oauth2', category: 'identity', repoPath: 'oauth2', keywords: ['oauth', 'oauth2', 'sso', 'identity', 'authentication'], erpSignals: [], domainSignals: ['auth', 'login', 'identity', 'token'], alwaysInclude: true, weight: 0.7, hasRustVariant: true },

  // ── Communication / Messaging ──
  { id: 'slack',           category: 'communication', repoPath: 'slack',           keywords: ['slack', 'slack bot', 'slack webhook'], erpSignals: [], domainSignals: ['notification', 'alert', 'message', 'chat'], alwaysInclude: false, weight: 0.5, hasRustVariant: true },
  { id: 'discord',         category: 'communication', repoPath: 'discord',         keywords: ['discord'], erpSignals: [], domainSignals: ['notification', 'chat'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'microsoft/teams', category: 'communication', repoPath: 'microsoft/teams', keywords: ['microsoft teams', 'teams', 'teams bot'], erpSignals: ['microsoft-dynamics'], domainSignals: ['notification', 'alert', 'enterprise'], alwaysInclude: false, weight: 0.5, hasRustVariant: false },
  { id: 'smtp',            category: 'communication', repoPath: 'smtp',            keywords: ['smtp', 'email', 'mail'], erpSignals: [], domainSignals: ['email', 'notification', 'alert'], alwaysInclude: false, weight: 0.3, hasRustVariant: true },

  // ── Productivity / Document ──
  { id: 'google-drive', category: 'productivity', repoPath: 'google-drive', keywords: ['google drive', 'gdrive'], erpSignals: [], domainSignals: ['document', 'file', 'attachment', 'contract'], alwaysInclude: false, weight: 0.3, hasRustVariant: true },
  { id: 'jira',         category: 'productivity', repoPath: 'jira',         keywords: ['jira', 'atlassian'], erpSignals: [], domainSignals: ['ticket', 'issue', 'project', 'workflow'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'hubspot',      category: 'productivity', repoPath: 'hubspot',      keywords: ['hubspot'], erpSignals: [], domainSignals: ['crm', 'customer', 'lead', 'marketing'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'airtable-api', category: 'productivity', repoPath: 'airtable-api', keywords: ['airtable'], erpSignals: [], domainSignals: ['spreadsheet', 'data entry'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'salesforce',   category: 'automation',   repoPath: 'salesforce',   keywords: ['salesforce', 'sfdc', 'soql'], erpSignals: [], domainSignals: ['crm', 'customer', 'sales', 'procurement'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },

  // ── DevOps / CI-CD ──
  { id: 'github',                    category: 'devops', repoPath: 'github',                    keywords: ['github'], erpSignals: [], domainSignals: [], alwaysInclude: true, weight: 0.5, hasRustVariant: true },
  { id: 'gitlab',                    category: 'devops', repoPath: 'gitlab',                    keywords: ['gitlab'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'jenkins',                   category: 'devops', repoPath: 'jenkins',                   keywords: ['jenkins'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'buildkite',                 category: 'devops', repoPath: 'buildkite',                 keywords: ['buildkite'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'docker-hub',                category: 'devops', repoPath: 'docker-hub',                keywords: ['docker hub', 'dockerhub'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'ghcr',                      category: 'devops', repoPath: 'ghcr',                      keywords: ['ghcr', 'github container'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'amazon-ecr',                category: 'devops', repoPath: 'amazon-ecr',                keywords: ['ecr', 'elastic container'], erpSignals: [], domainSignals: [], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'google-artifact-registry',  category: 'devops', repoPath: 'google-artifact-registry',  keywords: ['artifact registry', 'gar'], erpSignals: ['sap-s4hana', 'sap-ecc'], domainSignals: [], alwaysInclude: false, weight: 0.3, hasRustVariant: false },

  // ── Databases (SQL + NoSQL + ETL) ──
  { id: 'postgresql',           category: 'database', repoPath: 'postgresql',           keywords: ['postgresql', 'postgres', 'pg'], erpSignals: [], domainSignals: ['database', 'sql', 'relational'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },
  { id: 'mysql',                category: 'database', repoPath: 'mysql',                keywords: ['mysql'], erpSignals: [], domainSignals: ['database', 'sql'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'mongodb',              category: 'database', repoPath: 'mongodb',              keywords: ['mongodb', 'mongo'], erpSignals: [], domainSignals: ['nosql', 'document store'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'sqlserver',            category: 'database', repoPath: 'sqlserver',            keywords: ['sql server', 'mssql', 'tsql'], erpSignals: ['microsoft-dynamics', 'sap-business-one', 'epicor', 'sage-x3', 'unit4', 'syspro'], domainSignals: ['database'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },
  { id: 'snowflake',            category: 'database', repoPath: 'snowflake',            keywords: ['snowflake'], erpSignals: [], domainSignals: ['analytics', 'warehouse', 'reporting'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'redshift',             category: 'database', repoPath: 'redshift',             keywords: ['redshift'], erpSignals: [], domainSignals: ['analytics', 'warehouse'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },
  { id: 'databricks-delta-lake', category: 'database', repoPath: 'databricks-delta-lake', keywords: ['databricks', 'delta lake'], erpSignals: [], domainSignals: ['data lake', 'analytics'], alwaysInclude: false, weight: 0.2, hasRustVariant: false },

  // ── Vector Databases ──
  { id: 'pinecone', category: 'vector-db', repoPath: 'pinecone', keywords: ['pinecone'], erpSignals: [], domainSignals: ['embeddings', 'semantic', 'vector', 'search'], alwaysInclude: false, weight: 0.4, hasRustVariant: false },
  { id: 'qdrant',   category: 'vector-db', repoPath: 'qdrant',   keywords: ['qdrant'], erpSignals: [], domainSignals: ['embeddings', 'semantic', 'vector', 'search', 'ai', 'copilot'], alwaysInclude: false, weight: 0.5, hasRustVariant: false },
  { id: 'milvus',   category: 'vector-db', repoPath: 'milvus',   keywords: ['milvus'], erpSignals: [], domainSignals: ['embeddings', 'vector'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'weaviate', category: 'vector-db', repoPath: 'weaviate', keywords: ['weaviate'], erpSignals: [], domainSignals: ['embeddings', 'vector', 'semantic'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },

  // ── Monitoring / Logging / Observability ──
  { id: 'opentelemetry',     category: 'monitoring', repoPath: 'opentelemetry',     keywords: ['opentelemetry', 'otel', 'tracing', 'observability'], erpSignals: [], domainSignals: ['trace', 'span', 'metric'], alwaysInclude: true, weight: 0.7, hasRustVariant: false },
  { id: 'datadog-apm',       category: 'monitoring', repoPath: 'datadog-apm',       keywords: ['datadog'], erpSignals: [], domainSignals: ['monitoring', 'apm'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },
  { id: 'prometheus-metrics', category: 'monitoring', repoPath: 'prometheus-metrics', keywords: ['prometheus', 'grafana'], erpSignals: [], domainSignals: ['metrics', 'monitoring'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },

  // ── Billing / Payments ──
  { id: 'stripe', category: 'billing', repoPath: 'stripe', keywords: ['stripe', 'payment', 'billing', 'subscription'], erpSignals: [], domainSignals: ['billing', 'payment', 'invoice', 'subscription'], alwaysInclude: false, weight: 0.3, hasRustVariant: false },

  // ── Media / File Processing ──
  { id: 'ffmpeg',        category: 'media', repoPath: 'ffmpeg',        keywords: ['ffmpeg', 'video', 'transcode'], erpSignals: [], domainSignals: ['media', 'video', 'audio'], alwaysInclude: false, weight: 0.1, hasRustVariant: false },
  { id: 'cloudflare-r2', category: 'media', repoPath: 'cloudflare-r2', keywords: ['cloudflare r2', 'r2 storage'], erpSignals: [], domainSignals: ['storage', 'cdn'], alwaysInclude: false, weight: 0.1, hasRustVariant: false },
];

// ============================================================================
// Corpus Builder
// ============================================================================

/**
 * Build a unified text corpus from all available pipeline artifacts for keyword scanning.
 */
function buildCorpus(context: Phase5BuildContext): string {
  const parts: string[] = [context.scenarioQuery];

  const readJsonSafe = (filePath: string): unknown => {
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* ignore parse errors */ }
    return null;
  };

  // SPARC services
  const mergedDir = path.join(context.phase5Dir, '.phase2-merged');
  const sparcCombined = readJsonSafe(path.join(mergedDir, 'sparc', 'sparc-combined.json')) as Record<string, unknown> | null;
  if (sparcCombined) {
    const arch = sparcCombined['architecture'] as Record<string, unknown> | undefined;
    if (arch && Array.isArray(arch['services'])) {
      for (const svc of arch['services']) {
        const s = svc as Record<string, unknown>;
        if (s['name']) parts.push(String(s['name']));
        if (s['description']) parts.push(String(s['description']));
      }
    }
    const spec = sparcCombined['specification'] as Record<string, unknown> | undefined;
    if (spec) {
      if (Array.isArray(spec['requirements'])) parts.push(...(spec['requirements'] as string[]));
      if (Array.isArray(spec['constraints'])) parts.push(...(spec['constraints'] as string[]));
    }
    const comp = sparcCombined['completion'] as Record<string, unknown> | undefined;
    if (comp) {
      if (typeof comp['integrationPlan'] === 'string') parts.push(comp['integrationPlan']);
    }
  }

  // ADRs
  const adrIndex = readJsonSafe(path.join(mergedDir, 'adrs', 'adr-index.json')) as Array<Record<string, unknown>> | null;
  if (adrIndex) {
    for (const adr of adrIndex) {
      if (adr['title']) parts.push(String(adr['title']));
      if (adr['context']) parts.push(String(adr['context']));
      if (adr['decision']) parts.push(String(adr['decision']));
    }
  }

  // DDD domain model
  const domainModel = readJsonSafe(path.join(mergedDir, 'ddd', 'domain-model.json')) as Record<string, unknown> | null;
  if (domainModel && Array.isArray(domainModel['contexts'])) {
    for (const ctx of domainModel['contexts']) {
      const c = ctx as Record<string, unknown>;
      if (c['name']) parts.push(String(c['name']));
      if (c['description']) parts.push(String(c['description']));
      if (Array.isArray(c['aggregates'])) {
        for (const agg of c['aggregates']) {
          const a = agg as Record<string, unknown>;
          if (a['name']) parts.push(String(a['name']));
          if (Array.isArray(a['commands'])) {
            for (const cmd of a['commands']) parts.push(String((cmd as Record<string, unknown>)['name'] ?? ''));
          }
          if (Array.isArray(a['queries'])) {
            for (const q of a['queries']) parts.push(String((q as Record<string, unknown>)['name'] ?? ''));
          }
        }
      }
    }
  }

  // Research dossier
  const dossier = readJsonSafe(path.join(mergedDir, 'research-dossier.json')) as Record<string, unknown> | null;
  if (dossier && Array.isArray(dossier['items'])) {
    for (const item of dossier['items']) {
      const it = item as Record<string, unknown>;
      if (it['title']) parts.push(String(it['title']));
      if (it['content']) parts.push(String(it['content']));
    }
  }

  // Scenario manifest
  const scenarioJson = readJsonSafe(path.join(context.phase2Dir, '..', 'scenario.json')) as Record<string, unknown> | null;
  if (scenarioJson) {
    const scenario = scenarioJson['scenario'] as Record<string, unknown> | undefined;
    if (scenario?.['description']) parts.push(String(scenario['description']));
  }

  return parts.filter(Boolean).join(' ').toLowerCase();
}

// ============================================================================
// ERP→Cloud Mapping
// ============================================================================

const ERP_CLOUD_MAP: Record<string, string[]> = {
  'sap-s4hana':          ['gcp/bigquery', 'gcp/cloud-logging', 'gcp/pubsub', 'gcp/storage', 'google-artifact-registry'],
  'sap-ecc':             ['gcp/bigquery', 'gcp/cloud-logging', 'gcp/pubsub', 'gcp/storage'],
  'sap-business-one':    ['gcp/bigquery', 'gcp/storage'],
  'microsoft-dynamics':  ['azure/blob-storage', 'azure/key-vault', 'azure/active-directory', 'azure/openai'],
  'oracle-erp':          ['aws/s3', 'aws/secrets-manager', 'aws/cloudwatch-logs'],
  'oracle-netsuite':     ['aws/s3', 'aws/secrets-manager'],
  'oracle-jd-edwards':   ['aws/s3'],
  'oracle-peoplesoft':   ['aws/s3'],
  'epicor':              ['azure/blob-storage', 'azure/key-vault'],
  'infor':               ['aws/s3', 'aws/secrets-manager'],
};

// ============================================================================
// Scoring
// ============================================================================

function scoreModule(
  module: IntegrationModule,
  corpus: string,
  detectedERP: string | null,
): { score: number; rationale: string } {
  let score = 0;
  const reasons: string[] = [];

  // Always-include baseline
  if (module.alwaysInclude) {
    score += module.weight;
    reasons.push('mandatory enterprise module');
  }

  // Keyword matches
  let keywordHits = 0;
  for (const kw of module.keywords) {
    if (corpus.includes(kw.toLowerCase())) {
      keywordHits++;
    }
  }
  if (keywordHits > 0) {
    const kwScore = Math.min(keywordHits * 0.3, 0.6);
    score += kwScore;
    reasons.push(`${keywordHits} keyword match(es)`);
  }

  // ERP signal matches
  if (detectedERP && module.erpSignals.includes(detectedERP)) {
    score += 0.4;
    reasons.push(`ERP match: ${detectedERP}`);
  }

  // ERP→Cloud chain match
  if (detectedERP) {
    const cloudModules = ERP_CLOUD_MAP[detectedERP];
    if (cloudModules?.includes(module.id)) {
      score += 0.35;
      reasons.push(`ERP→cloud chain: ${detectedERP}→${module.id}`);
    }
  }

  // Domain signal matches
  let domainHits = 0;
  for (const sig of module.domainSignals) {
    if (corpus.includes(sig.toLowerCase())) {
      domainHits++;
    }
  }
  if (domainHits > 0) {
    const domScore = Math.min(domainHits * 0.2, 0.5);
    score += domScore;
    reasons.push(`${domainHits} domain signal(s)`);
  }

  return { score, rationale: reasons.join('; ') || 'no match' };
}

// ============================================================================
// Public: inferIntegrations
// ============================================================================

/**
 * Stage 3: Infer which integration modules the target organization would use.
 *
 * @param context - The Phase 5 Build pipeline context (read-only access to prior stage outputs)
 * @returns Integration inference result with selected modules
 */
export function inferIntegrations(context: Phase5BuildContext): {
  stageOutput: {
    stage: 'integration-inference';
    status: 'completed' | 'failed';
    data: IntegrationInferenceResult;
    artifacts: string[];
    timing: number;
    summary: string;
  };
} {
  const startTime = Date.now();
  const span = createSpan('integration-inference', 'infer-integrations', {
    traceId: context.traceId,
  });

  try {
    // Step 1: Build corpus
    const corpus = buildCorpus(context);

    // Step 2: Detect ERP system
    const erpDetections = detectERPFromText(context.scenarioQuery);
    const detectedERP = erpDetections.length > 0 ? erpDetections[0]!.system : null;

    // Step 3: Score all modules
    const scored: Array<{ module: IntegrationModule; score: number; rationale: string }> = [];
    for (const mod of INTEGRATION_CATALOG) {
      const { score, rationale } = scoreModule(mod, corpus, detectedERP);
      scored.push({ module: mod, score, rationale });
    }

    // Step 4: Select modules above threshold + always-include
    const THRESHOLD = 0.3;
    let selected = scored
      .filter(s => s.score >= THRESHOLD || s.module.alwaysInclude)
      .sort((a, b) => b.score - a.score);

    // Step 5: Ensure mandatory enterprise bundle
    const hasLLM = selected.some(s => s.module.category === 'llm');
    if (!hasLLM) {
      const openaiEntry = scored.find(s => s.module.id === 'openai')!;
      selected.push({ ...openaiEntry, score: 0.5, rationale: 'mandatory: at least 1 LLM provider' });
    }

    const hasCloud = selected.some(s => s.module.category === 'cloud');
    if (!hasCloud) {
      // Default to GCP for SAP scenarios, Azure for Microsoft, AWS otherwise
      const fallbackCloud = detectedERP?.startsWith('sap') ? 'gcp/storage'
        : detectedERP === 'microsoft-dynamics' ? 'azure/blob-storage'
        : 'aws/s3';
      const cloudEntry = scored.find(s => s.module.id === fallbackCloud);
      if (cloudEntry) {
        selected.push({ ...cloudEntry, score: 0.4, rationale: 'mandatory: at least 1 cloud provider' });
      }
    }

    const hasVectorDB = selected.some(s => s.module.category === 'vector-db');
    if (!hasVectorDB && corpus.includes('ai') || corpus.includes('copilot') || corpus.includes('semantic')) {
      const qdrantEntry = scored.find(s => s.module.id === 'qdrant');
      if (qdrantEntry) {
        selected.push({ ...qdrantEntry, score: 0.4, rationale: 'inferred: AI copilot requires vector storage' });
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    selected = selected.filter(s => {
      if (seen.has(s.module.id)) return false;
      seen.add(s.module.id);
      return true;
    });

    // Build result
    const selectedModules: InferredIntegration[] = selected.map(s => ({
      id: s.module.id,
      category: s.module.category,
      score: Math.round(s.score * 100) / 100,
      rationale: s.rationale,
      repoPath: s.module.repoPath,
      hasRustVariant: s.module.hasRustVariant,
    }));

    const result: IntegrationInferenceResult = {
      selectedModules,
      totalScanned: INTEGRATION_CATALOG.length,
      corpusSize: corpus.length,
    };

    // Write inference manifest
    const manifestPath = path.join(context.phase5Dir, 'integration-inference.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
      _generated: 'Phase 5 Build — Integration Inference',
      trace_id: context.traceId,
      erp_detected: detectedERP,
      corpus_size: corpus.length,
      total_scanned: INTEGRATION_CATALOG.length,
      selected_count: selectedModules.length,
      selected: selectedModules,
    }, null, 2) + '\n', 'utf-8');

    const finalSpan = endSpan(span, 'ok', {
      selectedCount: selectedModules.length,
      totalScanned: INTEGRATION_CATALOG.length,
      detectedERP: detectedERP ?? 'none',
    });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    const timing = Date.now() - startTime;
    const moduleNames = selectedModules.slice(0, 5).map(m => m.id).join(', ');
    const suffix = selectedModules.length > 5 ? `, +${selectedModules.length - 5} more` : '';

    return {
      stageOutput: {
        stage: 'integration-inference',
        status: 'completed',
        data: result,
        artifacts: [manifestPath],
        timing,
        summary: `     Inferred ${selectedModules.length} integrations from scenario (${moduleNames}${suffix})`,
      },
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const finalSpan = endSpan(span, 'error', { error: errorMessage });
    emitSpan(finalSpan);
    context.telemetrySpans.push(finalSpan);

    return {
      stageOutput: {
        stage: 'integration-inference',
        status: 'failed',
        data: { selectedModules: [], totalScanned: INTEGRATION_CATALOG.length, corpusSize: 0 },
        artifacts: [],
        timing: Date.now() - startTime,
        summary: `  ERROR: Integration inference failed: ${errorMessage}`,
      },
    };
  }
}
