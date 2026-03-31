/**
 * ADR-070: Secure ID Generation and Oracle ACL Hardening Tests
 *
 * Validates that the generated template code includes:
 * 1. Rejection reason minimum length at domain level
 * 2. Lineage validation on approve (not just execute)
 * 3. Read audit logging on GET decision endpoints
 * 4. crypto.randomUUID() for IDs (not Math.random())
 */

import { describe, it, expect } from 'vitest';
import { generateHttpServer } from '../../../../src/pipeline/phase4/phases/http-server-generator.js';
import type { Phase4Context, Phase4StageOutput, ERPResolution } from '../../../../src/pipeline/phase4/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Helpers
// ============================================================================

function buildContext(): Phase4Context {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-acl070-'));
  const phase4Dir = path.join(tmpDir, 'phase4');
  fs.mkdirSync(phase4Dir, { recursive: true });

  const erpResolution: ERPResolution = {
    erpSystem: 'oracle-fusion',
    databaseEngine: 'postgresql',
    sqlDialect: 'postgresql',
    apiOnly: false,
    detectionSource: 'scenario-query',
    confidence: 0.9,
    integrationPoints: ['procurement'],
    constraints: [],
    cloudProvider: 'gcp',
  } as unknown as ERPResolution;

  const stageOutputs = new Map<string, Phase4StageOutput>();
  stageOutputs.set('erp-target-resolution', {
    stage: 'erp-target-resolution',
    status: 'completed',
    data: erpResolution,
    artifacts: [],
    timing: 10,
    summary: 'ERP resolved',
  } as Phase4StageOutput);

  return {
    traceId: 'acl070test12345678',
    phase2Dir: path.join(tmpDir, 'phase2'),
    phase3Dir: path.join(tmpDir, 'phase3'),
    phase4Dir,
    scenarioQuery: 'test enterprise scenario with risk management',
    phase3Artifacts: {
      manifest: {} as any,
      implementationLanguage: 'typescript',
      projectDir: path.join(tmpDir, 'project'),
      phase2Artifacts: {
        domainModel: {
          contexts: [{
            name: 'RiskManagement',
            aggregates: [{
              name: 'RiskAssessment',
              commands: [{ name: 'AssessRisk', description: 'Assess risk', input: ['supplierId'] }],
              queries: [{ name: 'GetRiskScore', description: 'Get score', parameters: ['supplierId'] }],
              entities: [{ name: 'Supplier', description: 'A supplier' }],
              valueObjects: [{ name: 'RiskScore', description: 'Score' }],
              domainEvents: [],
              invariants: [],
            }],
          }],
        },
      },
    },
    stageOutputs,
    telemetrySpans: [],
  } as unknown as Phase4Context;
}

function getFileContent(output: Phase4StageOutput, fileName: string): string {
  const data = output.data as { files: Array<{ relativePath: string; content: string }> };
  const file = data.files.find(f => f.relativePath.includes(fileName));
  return file?.content ?? '';
}

// ============================================================================
// Tests
// ============================================================================

describe('ADR-070: ACL Hardening', () => {
  // Force template path by unsetting AGENTICS_CLAUDE_BIN and setting env to skip LLM
  const origBin = process.env['AGENTICS_CLAUDE_BIN'];
  process.env['AGENTICS_CLAUDE_BIN'] = '/nonexistent/claude-binary-does-not-exist';

  const ctx = buildContext();
  const output = generateHttpServer(ctx);
  const routeContent = getFileContent(output, 'routes.ts');
  const depsContent = getFileContent(output, 'dependencies.ts');

  // Restore env
  if (origBin !== undefined) {
    process.env['AGENTICS_CLAUDE_BIN'] = origBin;
  } else {
    delete process.env['AGENTICS_CLAUDE_BIN'];
  }

  it('should generate successfully', () => {
    expect(output.status).toBe('completed');
    expect(routeContent.length).toBeGreaterThan(0);
    expect(depsContent.length).toBeGreaterThan(0);
  });

  describe('rejection reason validation at domain level', () => {
    it('should enforce 10-character minimum in DecisionAdapter.reject()', () => {
      expect(depsContent).toContain('reason.trim().length < 10');
    });

    it('should throw an error with descriptive message for short reasons', () => {
      expect(depsContent).toContain('Rejection reason must be at least 10 characters');
    });
  });

  describe('lineage validation on approve', () => {
    it('should call validateLineage before approval', () => {
      // The approve handler (between the approve route definition and its closing)
      // must call validateLineage — same as the execute handler
      expect(routeContent).toContain("approve:lineage_failed");
    });

    it('should return LINEAGE_INVALID on approve if hash does not match', () => {
      // There should be TWO occurrences of LINEAGE_INVALID — one in approve, one in execute
      const matches = routeContent.match(/LINEAGE_INVALID/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('should call validateLineage in the approve handler', () => {
      // validateLineage should appear at least twice in routes —
      // once for approve, once for execute, once for lineage read
      const matches = routeContent.match(/validateLineage/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('read audit logging', () => {
    it('should audit-log GET /decisions/:id reads', () => {
      // The route file should contain audit.log with 'read' action for decision reads
      expect(routeContent).toContain("'read'");
      expect(routeContent).toContain("'decisions', id, 'read'");
    });

    it('should audit-log GET /decisions list reads', () => {
      expect(routeContent).toContain("'decisions', correlationId, 'list'");
    });

    it('should audit-log GET /decisions/:id/lineage reads', () => {
      expect(routeContent).toContain("'read_lineage'");
    });

    it('should extract actor identity in GET decision handlers', () => {
      // Count how many times iamClaims is extracted — should be in ALL handlers including GETs
      // Before ADR-070, GET handlers didn't extract actor. Now they do.
      const iamClaimsMatches = routeContent.match(/iamClaims/g) ?? [];
      // At minimum: requireRole function + approve + reject + execute + submit + GET/:id + GET list + GET lineage
      expect(iamClaimsMatches.length).toBeGreaterThanOrEqual(8);
    });
  });

  describe('secure ID generation', () => {
    it('should use randomUUID for decision IDs', () => {
      expect(depsContent).toContain('randomUUID()');
    });

    it('should import crypto for UUID generation', () => {
      expect(depsContent).toContain("crypto");
    });

    it('should not use Math.random() for ID generation', () => {
      // Math.random is acceptable for jitter in retry backoff,
      // but should not appear near id/ID/requestId generation
      const idGenerationLines = depsContent.split('\n')
        .filter(line => line.includes('Math.random') && (line.includes('id') || line.includes('ID') || line.includes('requestId')));
      expect(idGenerationLines).toHaveLength(0);
    });
  });
});
