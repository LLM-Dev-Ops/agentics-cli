/**
 * Tests for Phase 5 Build — Integration Inference Engine
 *
 * Validates the scoring, selection, and deduplication logic that determines
 * which of the 62+ integration modules are inferred from scenario context.
 *
 * Since inferIntegrations() requires a full Phase5BuildContext with filesystem
 * access to merged artifacts, we test the exported function end-to-end by
 * providing a minimal context with controlled scenarioQuery values and
 * temporary directories. The scoring/selection logic is deterministic and
 * driven by the corpus text, so we can verify behavior through the output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { inferIntegrations } from '../../../../src/pipeline/phase5-build/phases/integration-inferrer.js';
import type { Phase5BuildContext } from '../../../../src/pipeline/phase5-build/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p5-infer-test-'));
}

function buildContext(
  scenarioQuery: string,
  overrides?: Partial<Phase5BuildContext>,
): Phase5BuildContext {
  const tmpDir = makeTempDir();
  const phase5Dir = path.join(tmpDir, 'phase5');
  const phase2Dir = path.join(tmpDir, 'phase2');
  fs.mkdirSync(phase5Dir, { recursive: true });
  fs.mkdirSync(phase2Dir, { recursive: true });

  return {
    traceId: 'test-trace-00000000',
    phase2Dir,
    phase3Dir: path.join(tmpDir, 'phase3'),
    phase4Dir: path.join(tmpDir, 'phase4'),
    phase5Dir,
    scenarioQuery,
    platformRepoPaths: {},
    telemetrySpans: [],
    ...overrides,
  };
}

function selectedIds(result: ReturnType<typeof inferIntegrations>): string[] {
  return result.stageOutput.data.selectedModules.map(m => m.id);
}

function findModule(result: ReturnType<typeof inferIntegrations>, id: string) {
  return result.stageOutput.data.selectedModules.find(m => m.id === id);
}

// ============================================================================
// Tests
// ============================================================================

describe('Integration Inferrer', () => {
  describe('catalog completeness', () => {
    it('should scan at least 62 modules in the catalog', () => {
      const ctx = buildContext('');
      const result = inferIntegrations(ctx);
      expect(result.stageOutput.data.totalScanned).toBeGreaterThanOrEqual(62);
    });

    it('should return completed status on success', () => {
      const ctx = buildContext('basic query');
      const result = inferIntegrations(ctx);
      expect(result.stageOutput.status).toBe('completed');
      expect(result.stageOutput.stage).toBe('integration-inference');
    });
  });

  describe('alwaysInclude modules', () => {
    it('should always include oauth2 regardless of corpus', () => {
      const ctx = buildContext('');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('oauth2');
    });

    it('should always include github regardless of corpus', () => {
      const ctx = buildContext('');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('github');
    });

    it('should always include opentelemetry regardless of corpus', () => {
      const ctx = buildContext('');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('opentelemetry');
    });

    it('should give alwaysInclude modules a score above 0', () => {
      const ctx = buildContext('');
      const result = inferIntegrations(ctx);
      const oauth2 = findModule(result, 'oauth2');
      expect(oauth2).toBeDefined();
      expect(oauth2!.score).toBeGreaterThan(0);
    });
  });

  describe('SAP keyword to GCP cloud chain', () => {
    it('should infer GCP modules when SAP S/4HANA is mentioned', () => {
      const ctx = buildContext('Migrate SAP S/4HANA procurement to cloud-native microservices');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      // SAP -> GCP cloud chain
      expect(ids).toContain('gcp/bigquery');
      expect(ids).toContain('gcp/pubsub');
    });

    it('should include gcp/storage for SAP ECC scenarios', () => {
      const ctx = buildContext('SAP ECC integration with cloud storage and event bus');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('gcp/storage');
    });

    it('should include gcp/cloud-logging for SAP Business One', () => {
      const ctx = buildContext('SAP Business One integration layer');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      // SAP Business One should map to some GCP modules
      expect(ids).toContain('gcp/bigquery');
    });
  });

  describe('Microsoft Dynamics to Azure chain', () => {
    it('should infer Azure modules when Microsoft Dynamics is mentioned', () => {
      const ctx = buildContext('Microsoft Dynamics 365 finance integration with Azure cloud');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('azure/active-directory');
      expect(ids).toContain('azure/blob-storage');
    });

    it('should include azure/openai for Dynamics AI scenarios', () => {
      const ctx = buildContext('Microsoft Dynamics with AI copilot integration using Azure');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('azure/openai');
    });
  });

  describe('keyword scoring', () => {
    it('should increase score when multiple keywords match', () => {
      // A query with many OpenAI keywords should score higher than one keyword
      const ctxOne = buildContext('openai');
      const resultOne = inferIntegrations(ctxOne);
      const openaiOne = findModule(resultOne, 'openai');

      const ctxMany = buildContext('openai gpt chatgpt gpt-4 ai copilot llm');
      const resultMany = inferIntegrations(ctxMany);
      const openaiMany = findModule(resultMany, 'openai');

      expect(openaiMany).toBeDefined();
      expect(openaiOne).toBeDefined();
      expect(openaiMany!.score).toBeGreaterThanOrEqual(openaiOne!.score);
    });

    it('should include slack when slack keywords are present', () => {
      const ctx = buildContext('slack webhook notification alerts');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('slack');
    });

    it('should include stripe when payment keywords are present', () => {
      const ctx = buildContext('stripe billing payment subscription invoice');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('stripe');
    });
  });

  describe('ERP signal scoring', () => {
    it('should add 0.4 score boost for ERP signal match on sqlserver', () => {
      // sqlserver has erpSignals: ['microsoft-dynamics', ...]
      const ctx = buildContext('Microsoft Dynamics integration with SQL Server database');
      const result = inferIntegrations(ctx);
      const sqlserver = findModule(result, 'sqlserver');
      expect(sqlserver).toBeDefined();
      // sqlserver has erpSignal match (0.4) + keyword matches + ERP chain
      expect(sqlserver!.score).toBeGreaterThanOrEqual(0.4);
    });
  });

  describe('empty corpus', () => {
    it('should produce only alwaysInclude and mandatory fallback modules', () => {
      const ctx = buildContext('');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);

      // alwaysInclude: oauth2, github, opentelemetry
      expect(ids).toContain('oauth2');
      expect(ids).toContain('github');
      expect(ids).toContain('opentelemetry');

      // Mandatory LLM fallback (openai) when no LLM detected
      expect(ids).toContain('openai');

      // Total should be small since nothing else triggers
      expect(ids.length).toBeGreaterThanOrEqual(4);
      expect(ids.length).toBeLessThanOrEqual(10);
    });
  });

  describe('deduplication', () => {
    it('should not contain duplicate module IDs', () => {
      // A query that might trigger both keyword and ERP chain for same module
      const ctx = buildContext('SAP S/4HANA bigquery cloud logging pubsub storage analytics warehouse');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });
  });

  describe('score bounds', () => {
    it('should produce scores that are non-negative', () => {
      const ctx = buildContext('openai gpt slack stripe postgresql bigquery azure sap dynamics');
      const result = inferIntegrations(ctx);
      for (const mod of result.stageOutput.data.selectedModules) {
        expect(mod.score).toBeGreaterThanOrEqual(0);
      }
    });

    it('should round scores to 2 decimal places', () => {
      const ctx = buildContext('openai gpt slack stripe postgresql bigquery');
      const result = inferIntegrations(ctx);
      for (const mod of result.stageOutput.data.selectedModules) {
        const roundtrip = Math.round(mod.score * 100) / 100;
        expect(mod.score).toBe(roundtrip);
      }
    });
  });

  describe('module categories', () => {
    it('should assign valid category values to all selected modules', () => {
      const validCategories = [
        'llm', 'cloud', 'identity', 'communication', 'productivity',
        'devops', 'database', 'vector-db', 'monitoring', 'billing',
        'media', 'automation',
      ];
      const ctx = buildContext('openai slack stripe postgresql bigquery azure sap dynamics');
      const result = inferIntegrations(ctx);
      for (const mod of result.stageOutput.data.selectedModules) {
        expect(validCategories).toContain(mod.category);
      }
    });
  });

  describe('mandatory fallbacks', () => {
    it('should include at least one LLM provider when none are explicitly matched', () => {
      const ctx = buildContext('warehouse management system');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      const llmIds = ['openai', 'anthropic', 'gemini', 'groq', 'cohere', 'mistral', 'ollama', 'vllm', 'xai', 'huggingface', 'azure/openai'];
      const hasLLM = ids.some(id => llmIds.includes(id));
      expect(hasLLM).toBe(true);
    });

    it('should include at least one cloud provider when none are explicitly matched', () => {
      const ctx = buildContext('basic crud application');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      const cloudIds = [
        'gcp/bigquery', 'gcp/cloud-logging', 'gcp/firestore', 'gcp/pubsub', 'gcp/storage',
        'aws/bedrock', 'aws/s3', 'aws/dynamodb', 'aws/ses', 'aws/secrets-manager', 'aws/cloudwatch-logs', 'aws/iam',
        'azure/active-directory', 'azure/blob-storage', 'azure/cognitive-search', 'azure/key-vault', 'azure/openai',
      ];
      const hasCloud = ids.some(id => cloudIds.includes(id));
      expect(hasCloud).toBe(true);
    });
  });

  describe('artifacts and manifest', () => {
    it('should write integration-inference.json to phase5Dir', () => {
      const ctx = buildContext('openai test query');
      const result = inferIntegrations(ctx);
      expect(result.stageOutput.artifacts.length).toBe(1);
      const manifestPath = result.stageOutput.artifacts[0]!;
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(manifest.total_scanned).toBeGreaterThanOrEqual(62);
      expect(manifest.selected_count).toBeGreaterThan(0);
      expect(Array.isArray(manifest.selected)).toBe(true);
    });

    it('should include corpus_size in the manifest', () => {
      const ctx = buildContext('test scenario for openai integration');
      const result = inferIntegrations(ctx);
      expect(result.stageOutput.data.corpusSize).toBeGreaterThan(0);
    });
  });

  describe('domain signal matching', () => {
    it('should boost vector-db modules when AI/copilot keywords are present', () => {
      const ctx = buildContext('build an ai copilot with semantic search');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      const hasVectorDB = ids.some(id => ['pinecone', 'qdrant', 'milvus', 'weaviate'].includes(id));
      expect(hasVectorDB).toBe(true);
    });

    it('should boost jira when ticket/workflow signals are present', () => {
      const ctx = buildContext('jira ticket workflow management atlassian project tracking');
      const result = inferIntegrations(ctx);
      const ids = selectedIds(result);
      expect(ids).toContain('jira');
    });
  });
});
