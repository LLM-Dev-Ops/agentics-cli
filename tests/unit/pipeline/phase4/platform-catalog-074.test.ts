/**
 * ADR-074: Platform Service Catalog Tests
 *
 * Validates that the catalog is complete, codegen prompts include it,
 * and generated code contains the callPlatformService utility.
 */

import { describe, it, expect } from '@jest/globals';
import {
  PLATFORM_SERVICES,
  getRuntimeServices,
  getBuildTimeServices,
  getServicesByTier,
  buildPlatformCatalogPrompt,
  generatePlatformClientCode,
  generatePlatformEnvBlock,
} from '../../../../src/pipeline/phase4/phases/platform-catalog.js';
import { generateHttpServer } from '../../../../src/pipeline/phase4/phases/http-server-generator.js';
import { generateDeployment } from '../../../../src/pipeline/phase4/phases/deployment-generator.js';
import type { Phase4Context, Phase4StageOutput, ERPResolution } from '../../../../src/pipeline/phase4/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Helpers
// ============================================================================

function buildContext(): Phase4Context {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-074-'));
  const phase4Dir = path.join(tmpDir, 'phase4');
  fs.mkdirSync(phase4Dir, { recursive: true });

  const erpResolution: ERPResolution = {
    erpSystem: 'oracle-fusion', databaseEngine: 'postgresql', sqlDialect: 'postgresql',
    apiOnly: false, detectionSource: 'scenario-query', confidence: 0.9,
    integrationPoints: ['procurement'], constraints: [], cloudProvider: 'gcp',
  } as unknown as ERPResolution;

  const stageOutputs = new Map<string, Phase4StageOutput>();
  stageOutputs.set('erp-target-resolution', {
    stage: 'erp-target-resolution', status: 'completed', data: erpResolution,
    artifacts: [], timing: 10, summary: 'ERP resolved',
  } as Phase4StageOutput);

  return {
    traceId: 'platform074test1234',
    phase2Dir: path.join(tmpDir, 'phase2'),
    phase3Dir: path.join(tmpDir, 'phase3'),
    phase4Dir,
    scenarioQuery: 'enterprise risk management platform',
    phase3Artifacts: {
      manifest: {} as any, implementationLanguage: 'typescript',
      projectDir: path.join(tmpDir, 'project'),
      phase2Artifacts: {
        domainModel: {
          contexts: [{
            name: 'RiskAssessment',
            aggregates: [{
              name: 'Risk', commands: [{ name: 'EvaluateRisk' }],
              queries: [{ name: 'GetRiskProfile' }],
              entities: [{ name: 'RiskFactor', description: 'Factor' }],
              valueObjects: [], domainEvents: [], invariants: [],
            }],
          }],
        },
      },
    },
    stageOutputs,
    telemetrySpans: [],
  } as unknown as Phase4Context;
}

// ============================================================================
// Catalog Tests
// ============================================================================

describe('ADR-074: Platform Service Catalog', () => {
  describe('service catalog completeness', () => {
    it('should contain at least 40 services', () => {
      expect(PLATFORM_SERVICES.length).toBeGreaterThanOrEqual(40);
    });

    it('should have unique env vars for each service', () => {
      const envVars = PLATFORM_SERVICES.map(s => s.envVar);
      const unique = new Set(envVars);
      expect(unique.size).toBe(envVars.length);
    });

    it('should cover all 9 phases + Layer 4', () => {
      const phases = new Set(PLATFORM_SERVICES.map(s => s.phase));
      expect(phases.has('1')).toBe(true);
      expect(phases.has('2')).toBe(true);
      expect(phases.has('3')).toBe(true);
      expect(phases.has('4')).toBe(true);
      expect(phases.has('5')).toBe(true);
      expect(phases.has('6')).toBe(true);
      expect(phases.has('7')).toBe(true);
      expect(phases.has('8')).toBe(true);
      expect(phases.has('9')).toBe(true);
      expect(phases.has('L4')).toBe(true);
    });

    it('should include critical services: Shield, CostOps, Observatory, Sentinel', () => {
      const names = PLATFORM_SERVICES.map(s => s.name);
      expect(names).toContain('LLM-Shield');
      expect(names).toContain('LLM-CostOps');
      expect(names).toContain('LLM-Observatory');
      expect(names).toContain('LLM-Sentinel');
    });

    it('should include all Phase 8 Core Bundles', () => {
      const names = PLATFORM_SERVICES.map(s => s.name);
      expect(names).toContain('LLM-Security-Core');
      expect(names).toContain('LLM-Governance-Core');
      expect(names).toContain('LLM-Intelligence-Core');
      expect(names).toContain('LLM-Automation-Core');
      expect(names).toContain('LLM-Data-Core');
    });

    it('should include Apex Platform', () => {
      const apex = PLATFORM_SERVICES.find(s => s.name === 'Agentics-Dev-Platform');
      expect(apex).toBeDefined();
      expect(apex!.agents).toContain('decision');
      expect(apex!.agents).toContain('executive-summary');
    });

    it('should include Layer 4 infrastructure services', () => {
      const names = PLATFORM_SERVICES.map(s => s.name);
      expect(names).toContain('enterprise-roi-engine');
      expect(names).toContain('erp-surface');
      expect(names).toContain('agentics-results-index');
      expect(names).toContain('agentics-execution-engine');
      expect(names).toContain('agentics-enforcement');
    });
  });

  describe('tier helpers', () => {
    it('should return must-have services including Shield and Policy-Engine', () => {
      const mustHave = getServicesByTier('must-have');
      const names = mustHave.map(s => s.name);
      expect(names).toContain('LLM-Shield');
      expect(names).toContain('LLM-Policy-Engine');
    });

    it('should return runtime services excluding build-only', () => {
      const runtime = getRuntimeServices();
      const buildOnly = runtime.filter(s => s.usedAt === 'build');
      expect(buildOnly).toHaveLength(0);
    });

    it('should return build-time services', () => {
      const buildTime = getBuildTimeServices();
      expect(buildTime.length).toBeGreaterThan(0);
      const names = buildTime.map(s => s.name);
      expect(names).toContain('LLM-Forge');
    });
  });

  describe('prompt generation', () => {
    it('should generate a catalog prompt containing all runtime services', () => {
      const prompt = buildPlatformCatalogPrompt();
      expect(prompt).toContain('ADR-074');
      expect(prompt).toContain('AGENTICS_SHIELD_URL');
      expect(prompt).toContain('AGENTICS_COSTOPS_URL');
      expect(prompt).toContain('AGENTICS_OBSERVATORY_URL');
      expect(prompt).toContain('must-have');
      expect(prompt).toContain('should-have');
      expect(prompt).toContain('operational');
      expect(prompt).toContain('callPlatformService');
    });
  });

  describe('platform client code generation', () => {
    it('should generate callPlatformService function', () => {
      const code = generatePlatformClientCode();
      expect(code).toContain('export async function callPlatformService');
      expect(code).toContain('AvailabilityTier');
      expect(code).toContain('must-have');
      expect(code).toContain('should-have');
      expect(code).toContain('operational');
      expect(code).toContain('Metadata-Flavor');
      expect(code).toContain('X-Correlation-ID');
    });

    it('should handle GCP identity token auth', () => {
      const code = generatePlatformClientCode();
      expect(code).toContain('metadata.google.internal');
      expect(code).toContain('Bearer');
    });

    it('should implement tier-based failure behavior', () => {
      const code = generatePlatformClientCode();
      // must-have throws
      expect(code).toContain("tier === 'must-have'");
      // should-have logs warning
      expect(code).toContain('PLATFORM_SERVICE_UNAVAILABLE');
    });
  });

  describe('env block generation', () => {
    it('should include all runtime service env vars', () => {
      const envBlock = generatePlatformEnvBlock();
      expect(envBlock).toContain('AGENTICS_SHIELD_URL');
      expect(envBlock).toContain('AGENTICS_COSTOPS_URL');
      expect(envBlock).toContain('AGENTICS_OBSERVATORY_URL');
      expect(envBlock).toContain('AGENTICS_PLATFORM_URL');
      expect(envBlock).toContain('AGENTICS_SECURITY_CORE_URL');
    });
  });
});

describe('ADR-074: Generated Code Integration', () => {
  const ctx = buildContext();

  describe('generated dependencies.ts includes platform client', () => {
    // Force template path
    process.env['AGENTICS_CLAUDE_BIN'] = '/nonexistent';
    const output = generateHttpServer(ctx);
    delete process.env['AGENTICS_CLAUDE_BIN'];

    const data = output.data as { files: Array<{ relativePath: string; content: string }> };
    const depsFile = data.files.find(f => f.relativePath.includes('dependencies.ts'));

    it('should include callPlatformService in generated dependencies', () => {
      expect(depsFile).toBeDefined();
      expect(depsFile!.content).toContain('callPlatformService');
    });

    it('should include availability tier types', () => {
      expect(depsFile!.content).toContain('AvailabilityTier');
    });
  });

  describe('generated .env.example includes platform URLs', () => {
    const deployCtx = buildContext();
    const output = generateDeployment(deployCtx);
    const data = output.data as { files: Array<{ relativePath: string; content: string }> };
    const envFile = data.files.find(f => f.relativePath.includes('.env.example'));

    it('should include platform service URLs in .env.example', () => {
      expect(envFile).toBeDefined();
      expect(envFile!.content).toContain('AGENTICS_SHIELD_URL');
      expect(envFile!.content).toContain('AGENTICS_COSTOPS_URL');
      expect(envFile!.content).toContain('ADR-074');
    });
  });
});
