/**
 * Provenance Tracker — Unit Tests (ADR-039)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ProvenanceTracker,
  provenanceKey,
  provenanceTags,
} from '../../../../src/pipeline/enterprise/provenance-tracker.js';

describe('ProvenanceTracker (ADR-039)', () => {
  let tracker: ProvenanceTracker;

  beforeEach(() => {
    tracker = new ProvenanceTracker('exec-test-001');
  });

  // ==========================================================================
  // Key & Tag Format
  // ==========================================================================

  describe('provenanceKey', () => {
    test('generates provenance:{executionId}:{traceId}', () => {
      expect(provenanceKey('exec-001', 'trace-1')).toBe('provenance:exec-001:trace-1');
    });
  });

  describe('provenanceTags', () => {
    test('generates correct tags from a trace record', () => {
      const record = tracker.recordInvocation({
        agent: { domain: 'costops', agent: 'roi', role: 'ROI' },
        pass: 4, passName: 'Governance', workstream: 'financial-modeling',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 100, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 0.9,
      });

      const tags = provenanceTags(record);
      expect(tags).toContain('agent:costops/roi');
      expect(tags).toContain('pass:4');
      expect(tags).toContain('execution:exec-test-001');
      expect(tags).toContain('status:success');
      expect(tags).toContain('workstream:financial-modeling');
    });
  });

  // ==========================================================================
  // Recording
  // ==========================================================================

  describe('recordInvocation', () => {
    test('records a trace with all fields', () => {
      const record = tracker.recordInvocation({
        agent: { domain: 'costops', agent: 'roi', role: 'ROI estimator' },
        pass: 4, passName: 'Governance', workstream: 'Financial Modeling',
        startedAt: '2026-03-17T10:00:00Z', completedAt: '2026-03-17T10:00:02Z',
        durationMs: 2000, inputNodeIds: ['node-1'], outputNodeIds: ['node-3'],
        artifactNumbers: [6], status: 'success', confidence: 0.92,
        tokensUsed: 1500, modelUsed: 'claude-sonnet-4-6', estimatedCost: 0.003,
      });

      expect(record.executionId).toBe('exec-test-001');
      expect(record.agent.domain).toBe('costops');
      expect(record.agent.agentId).toBe('costops/roi');
      expect(record.pass).toBe(4);
      expect(record.durationMs).toBe(2000);
      expect(record.outputs.status).toBe('success');
      expect(record.resources.tokensUsed).toBe(1500);
      // Code provenance is populated
      expect(record.codeProvenance.package).toBe('@agentics/costops');
      expect(record.codeProvenance.entryPoint).toContain('costops/roi');
      expect(record.codeProvenance.commitHash).toBeTruthy();
    });

    test('auto-generates unique trace IDs', () => {
      const r1 = tracker.recordInvocation({
        agent: { domain: 'test', agent: 'a', role: 'test' },
        pass: 1, passName: 'Test', workstream: 'Test',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 100, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 1.0,
      });
      const r2 = tracker.recordInvocation({
        agent: { domain: 'test', agent: 'b', role: 'test' },
        pass: 1, passName: 'Test', workstream: 'Test',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 200, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 1.0,
      });

      expect(r1.traceId).not.toBe(r2.traceId);
    });
  });

  describe('recordFromResult', () => {
    test('records from AgentInvocationResult', () => {
      const record = tracker.recordFromResult(
        {
          agent: { domain: 'shield', agent: 'pii', role: 'PII Detector' },
          status: 200, response: { found: false }, durationMs: 500, pass: 4,
          timestamp: '2026-03-17T10:00:00Z',
        },
        'Governance', 'Security',
      );

      expect(record.agent.domain).toBe('shield');
      expect(record.outputs.status).toBe('success');
    });

    test('records failed status for non-2xx', () => {
      const record = tracker.recordFromResult(
        {
          agent: { domain: 'shield', agent: 'pii', role: 'PII Detector' },
          status: 500, response: { error: 'timeout' }, durationMs: 30000, pass: 4,
          timestamp: '2026-03-17T10:00:00Z',
        },
        'Governance', 'Security',
      );

      expect(record.outputs.status).toBe('failed');
      expect(record.outputs.confidence).toBe(0);
    });
  });

  // ==========================================================================
  // Querying
  // ==========================================================================

  describe('Querying', () => {
    beforeEach(() => {
      tracker.recordInvocation({
        agent: { domain: 'copilot', agent: 'planner', role: 'Planner' },
        pass: 1, passName: 'Problem Intelligence', workstream: 'copilot',
        startedAt: '2026-03-17T10:00:00Z', completedAt: '2026-03-17T10:00:01Z',
        durationMs: 1000, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 0.9, tokensUsed: 500, modelUsed: 'claude-sonnet-4-6', estimatedCost: 0.001,
      });
      tracker.recordInvocation({
        agent: { domain: 'simulator', agent: 'what-if', role: 'Simulator' },
        pass: 2, passName: 'Simulation', workstream: 'scenario-gen',
        startedAt: '2026-03-17T10:00:01Z', completedAt: '2026-03-17T10:00:03Z',
        durationMs: 2000, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 0.85, tokensUsed: 800, modelUsed: 'claude-opus-4-6', estimatedCost: 0.005,
      });
      tracker.recordInvocation({
        agent: { domain: 'costops', agent: 'roi', role: 'ROI' },
        pass: 4, passName: 'Governance', workstream: 'financial-modeling',
        startedAt: '2026-03-17T10:00:03Z', completedAt: '2026-03-17T10:00:04Z',
        durationMs: 1500, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [6],
        status: 'failed', confidence: 0, tokensUsed: 600, modelUsed: 'claude-sonnet-4-6', estimatedCost: 0.002,
      });
    });

    test('getAllRecords returns all', () => {
      expect(tracker.getAllRecords()).toHaveLength(3);
    });

    test('getRecordsByPass', () => {
      expect(tracker.getRecordsByPass(1)).toHaveLength(1);
      expect(tracker.getRecordsByPass(2)).toHaveLength(1);
      expect(tracker.getRecordsByPass(3)).toHaveLength(0);
      expect(tracker.getRecordsByPass(4)).toHaveLength(1);
    });

    test('getRecordsByAgent', () => {
      expect(tracker.getRecordsByAgent('simulator', 'what-if')).toHaveLength(1);
      expect(tracker.getRecordsByAgent('costops', 'roi')).toHaveLength(1);
      expect(tracker.getRecordsByAgent('unknown', 'agent')).toHaveLength(0);
    });

    test('getRecordsByWorkstream', () => {
      expect(tracker.getRecordsByWorkstream('copilot')).toHaveLength(1);
      expect(tracker.getRecordsByWorkstream('financial-modeling')).toHaveLength(1);
    });

    test('getRecordsByStatus', () => {
      expect(tracker.getRecordsByStatus('success')).toHaveLength(2);
      expect(tracker.getRecordsByStatus('failed')).toHaveLength(1);
    });

    test('getRecordByTraceId', () => {
      const all = tracker.getAllRecords();
      const found = tracker.getRecordByTraceId(all[0]!.traceId);
      expect(found).toBeDefined();
      expect(found!.agent.agent).toBe('planner');
    });

    test('getUniqueAgentCount', () => {
      expect(tracker.getUniqueAgentCount()).toBe(3);
    });

    test('getTotalTokens', () => {
      expect(tracker.getTotalTokens()).toBe(1900);
    });

    test('getTotalCost', () => {
      expect(tracker.getTotalCost()).toBeCloseTo(0.008, 4);
    });

    test('getLongestAgent', () => {
      const longest = tracker.getLongestAgent();
      expect(longest!.agentId).toBe('simulator/what-if');
      expect(longest!.durationMs).toBe(2000);
    });
  });

  // ==========================================================================
  // Audit Queries (ADR-039)
  // ==========================================================================

  describe('Audit Queries', () => {
    beforeEach(() => {
      tracker.recordInvocation({
        agent: { domain: 'costops', agent: 'roi', role: 'ROI Estimator' },
        pass: 4, passName: 'Governance', workstream: 'financial-modeling',
        startedAt: '2026-03-17T10:00:00Z', completedAt: '2026-03-17T10:00:01Z',
        durationMs: 1000, inputNodeIds: ['node-1', 'node-2'], outputNodeIds: ['node-3'],
        artifactNumbers: [6], status: 'success', confidence: 0.92,
        tokensUsed: 500, modelUsed: 'claude-sonnet-4-6', estimatedCost: 0.001,
      });
    });

    test('auditWho returns agent identity', () => {
      const traceId = tracker.getAllRecords()[0]!.traceId;
      const who = tracker.auditWho(traceId);
      expect(who).toBeDefined();
      expect(who!.agentDomain).toBe('costops');
      expect(who!.agentName).toBe('roi');
      expect(who!.role).toBe('ROI Estimator');
    });

    test('auditWhat returns code provenance', () => {
      const traceId = tracker.getAllRecords()[0]!.traceId;
      const what = tracker.auditWhat(traceId);
      expect(what).toBeDefined();
      expect(what!.package).toBe('@agentics/costops');
      expect(what!.commitHash).toBeTruthy();
      expect(what!.entryPoint).toContain('costops/roi');
    });

    test('auditReproducibility returns re-execution info', () => {
      const traceId = tracker.getAllRecords()[0]!.traceId;
      const repro = tracker.auditReproducibility(traceId);
      expect(repro).toBeDefined();
      expect(repro!.commitHash).toBeTruthy();
      expect(repro!.inputNodeIds).toEqual(['node-1', 'node-2']);
      expect(repro!.codePackage).toBe('@agentics/costops');
    });

    test('audit queries return undefined for unknown traceId', () => {
      expect(tracker.auditWho('nonexistent')).toBeUndefined();
      expect(tracker.auditWhat('nonexistent')).toBeUndefined();
      expect(tracker.auditReproducibility('nonexistent')).toBeUndefined();
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('Statistics', () => {
    test('computes aggregate statistics', () => {
      tracker.recordInvocation({
        agent: { domain: 'copilot', agent: 'planner', role: 'P' },
        pass: 1, passName: 'Pass 1', workstream: 'copilot',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 100, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 0.9, tokensUsed: 100, estimatedCost: 0.001,
      });
      tracker.recordInvocation({
        agent: { domain: 'shield', agent: 'pii', role: 'PII' },
        pass: 4, passName: 'Pass 4', workstream: 'security',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 200, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'failed', confidence: 0,
      });

      const stats = tracker.getStatistics();
      expect(stats.totalRecords).toBe(2);
      expect(stats.uniqueAgents).toBe(2);
      expect(stats.byPass).toEqual({ 1: 1, 4: 1 });
      expect(stats.byStatus).toEqual({ success: 1, failed: 1 });
      expect(stats.byWorkstream).toEqual({ copilot: 1, security: 1 });
    });
  });

  // ==========================================================================
  // Manifest Generation
  // ==========================================================================

  describe('generateManifest', () => {
    beforeEach(() => {
      tracker.recordInvocation({
        agent: { domain: 'copilot', agent: 'planner', role: 'Planner' },
        pass: 1, passName: 'Problem Intelligence', workstream: 'CoPilot',
        startedAt: '2026-03-17T10:00:00Z', completedAt: '2026-03-17T10:00:01Z',
        durationMs: 1000, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 0.9, tokensUsed: 500, modelUsed: 'claude-sonnet-4-6', estimatedCost: 0.001,
      });
    });

    test('generates markdown with all ADR-039 sections', () => {
      const manifest = tracker.generateManifest({
        passesCompleted: 7, passesDegraded: [],
        artifactOwnership: [{ number: 1, name: 'Executive Decision Memo', agent: 'Decision Memo Agent', pass: 5 }],
      });

      expect(manifest).toContain('# Agent & Code Provenance Manifest');
      expect(manifest).toContain('## Agent Inventory');
      expect(manifest).toContain('## Code Inventory');
      expect(manifest).toContain('## Execution Flow');
      expect(manifest).toContain('## Artifact Ownership');
      expect(manifest).toContain('## Quality Scores');
      expect(manifest).toContain('## Resource Summary');
      expect(manifest).toContain('## Auditability');
      expect(manifest).toContain('## Privacy & Redaction');
      expect(manifest).toContain('Schema v1.0 (ADR-039)');
    });

    test('includes code provenance in code inventory', () => {
      const manifest = tracker.generateManifest({
        passesCompleted: 7, passesDegraded: [], artifactOwnership: [],
      });
      expect(manifest).toContain('@agentics/copilot');
      expect(manifest).toContain('Git Commit');
    });

    test('reports degraded passes', () => {
      const manifest = tracker.generateManifest({
        passesCompleted: 5, passesDegraded: [3, 4], artifactOwnership: [],
      });
      expect(manifest).toContain('3, 4');
    });
  });

  // ==========================================================================
  // Persistence & Load
  // ==========================================================================

  describe('persist and load', () => {
    test('round-trips trace records', () => {
      tracker.recordInvocation({
        agent: { domain: 'test', agent: 'test', role: 'test' },
        pass: 1, passName: 'Test', workstream: 'Test',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 100, inputNodeIds: [], outputNodeIds: [], artifactNumbers: [],
        status: 'success', confidence: 1.0,
      });
      tracker.recordInvocation({
        agent: { domain: 'test', agent: 'test2', role: 'test2' },
        pass: 2, passName: 'Test 2', workstream: 'Test',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        durationMs: 200, inputNodeIds: ['a'], outputNodeIds: ['b'], artifactNumbers: [1],
        status: 'failed', confidence: 0,
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-test-'));
      tracker.persist(tmpDir);

      const loaded = ProvenanceTracker.load('exec-test-001', tmpDir);
      expect(loaded.getAllRecords()).toHaveLength(2);
      expect(loaded.getRecordsByPass(1)).toHaveLength(1);
      expect(loaded.getRecordsByPass(2)).toHaveLength(1);
      expect(loaded.getRecordsByStatus('failed')).toHaveLength(1);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('load returns empty tracker when no file exists', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-empty-'));
      const loaded = ProvenanceTracker.load('no-file', tmpDir);
      expect(loaded.getAllRecords()).toHaveLength(0);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
