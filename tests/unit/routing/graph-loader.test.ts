/**
 * Tests for the Ecosystem Graph Loader (ADR-030)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  loadEcosystemGraph,
  clearGraphCache,
  resolveGraphPath,
  getCapabilityByName,
  getCapabilitiesByTag,
  getCapabilitiesByStage,
  resolveDependencies,
} from '../../../src/routing/graph-loader.js';
import type { EcosystemGraph } from '../../../src/routing/graph-loader.js';

// ============================================================================
// Helpers
// ============================================================================

function writeTempGraph(data: unknown): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
  const filePath = path.join(tmpDir, 'ecosystem.graph.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function cleanupTempGraph(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // Best effort cleanup
  }
}

const MINIMAL_VALID_GRAPH = {
  version: '1.1',
  description: 'Test graph',
  stages: ['simulation', 'research', 'build', 'validation', 'deployment'],
  capabilities: [
    {
      name: 'testing_cap',
      repos: ['test-repo'],
      agents: ['Test Agent'],
      stage: 'validation',
      depends_on: [],
      tags: ['test', 'unit'],
    },
    {
      name: 'build_cap',
      repos: ['build-repo'],
      agents: ['Build Agent'],
      stage: 'build',
      depends_on: [],
      tags: ['build', 'compile'],
    },
    {
      name: 'deploy_cap',
      repos: ['deploy-repo'],
      agents: ['Deploy Agent'],
      stage: 'deployment',
      depends_on: ['build_cap'],
      tags: ['deploy', 'release'],
    },
  ],
};

// ============================================================================
// Tests
// ============================================================================

describe('Graph Loader', () => {
  afterEach(() => {
    clearGraphCache();
  });

  describe('loadEcosystemGraph', () => {
    it('loads a valid graph file', () => {
      const filePath = writeTempGraph(MINIMAL_VALID_GRAPH);
      try {
        const graph = loadEcosystemGraph({ graphPath: filePath });
        expect(graph.version).toBe('1.1');
        expect(graph.capabilities).toHaveLength(3);
        expect(graph.stages).toContain('simulation');
        expect(graph.stages).toContain('deployment');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('caches the graph on subsequent calls', () => {
      const filePath = writeTempGraph(MINIMAL_VALID_GRAPH);
      try {
        const g1 = loadEcosystemGraph({ graphPath: filePath });
        const g2 = loadEcosystemGraph({ graphPath: filePath });
        expect(g1).toBe(g2); // Same reference = cached
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('reloads when forceReload is true', () => {
      const filePath = writeTempGraph(MINIMAL_VALID_GRAPH);
      try {
        const g1 = loadEcosystemGraph({ graphPath: filePath });
        const g2 = loadEcosystemGraph({ graphPath: filePath, forceReload: true });
        expect(g1).not.toBe(g2); // Different reference = reloaded
        expect(g1.version).toBe(g2.version);
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for missing file', () => {
      expect(() => loadEcosystemGraph({ graphPath: '/nonexistent/path.json' }))
        .toThrow('Ecosystem graph not found');
    });

    it('throws for invalid JSON', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-test-'));
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, '{invalid json!!!}');
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('invalid JSON');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for missing capabilities array', () => {
      const filePath = writeTempGraph({ version: '1.0' });
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('capabilities must be an array');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for duplicate capability names', () => {
      const filePath = writeTempGraph({
        version: '1.0',
        capabilities: [
          { name: 'dup', repos: ['r1'], agents: ['a1'] },
          { name: 'dup', repos: ['r2'], agents: ['a2'] },
        ],
      });
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('Duplicate capability name: dup');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for empty agents array', () => {
      const filePath = writeTempGraph({
        version: '1.0',
        capabilities: [
          { name: 'empty', repos: ['r1'], agents: [] },
        ],
      });
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('agents must be a non-empty array');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for invalid stage value', () => {
      const filePath = writeTempGraph({
        version: '1.0',
        capabilities: [
          { name: 'bad_stage', repos: ['r1'], agents: ['a1'], stage: 'nonexistent' },
        ],
      });
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('Invalid stage');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for depends_on referencing unknown capability', () => {
      const filePath = writeTempGraph({
        version: '1.0',
        capabilities: [
          { name: 'a', repos: ['r1'], agents: ['a1'], depends_on: ['nonexistent'] },
        ],
      });
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('depends_on references unknown capability: nonexistent');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('throws for circular dependencies', () => {
      const filePath = writeTempGraph({
        version: '1.0',
        capabilities: [
          { name: 'a', repos: ['r1'], agents: ['a1'], depends_on: ['b'] },
          { name: 'b', repos: ['r2'], agents: ['a2'], depends_on: ['a'] },
        ],
      });
      try {
        expect(() => loadEcosystemGraph({ graphPath: filePath }))
          .toThrow('Circular dependency');
      } finally {
        cleanupTempGraph(filePath);
      }
    });

    it('provides default stages when not specified', () => {
      const filePath = writeTempGraph({
        version: '1.0',
        capabilities: [
          { name: 'cap', repos: ['r1'], agents: ['a1'] },
        ],
      });
      try {
        const graph = loadEcosystemGraph({ graphPath: filePath });
        expect(graph.stages).toContain('simulation');
        expect(graph.stages).toContain('governance');
        expect(graph.stages).toHaveLength(8);
      } finally {
        cleanupTempGraph(filePath);
      }
    });
  });

  describe('loadEcosystemGraph with production file', () => {
    it('loads the real docs/ecosystem.graph.json without errors', () => {
      const projectRoot = path.resolve(process.cwd());
      const graphPath = resolveGraphPath(projectRoot);

      // This test validates the actual production graph file
      const graph = loadEcosystemGraph({ graphPath });
      expect(graph.version).toBe('1.1');
      expect(graph.capabilities.length).toBeGreaterThan(20);
      expect(graph.stages).toHaveLength(8);

      // Every capability should have at least one agent and repo
      for (const cap of graph.capabilities) {
        expect(cap.agents.length).toBeGreaterThan(0);
        expect(cap.repos.length).toBeGreaterThan(0);
        expect(cap.name.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Lookup helpers', () => {
    let graph: EcosystemGraph;
    let filePath: string;

    beforeEach(() => {
      filePath = writeTempGraph(MINIMAL_VALID_GRAPH);
      graph = loadEcosystemGraph({ graphPath: filePath });
    });

    afterEach(() => {
      clearGraphCache();
      cleanupTempGraph(filePath);
    });

    it('getCapabilityByName finds existing capability', () => {
      const cap = getCapabilityByName(graph, 'testing_cap');
      expect(cap).toBeDefined();
      expect(cap?.repos).toEqual(['test-repo']);
    });

    it('getCapabilityByName returns undefined for unknown', () => {
      expect(getCapabilityByName(graph, 'nonexistent')).toBeUndefined();
    });

    it('getCapabilitiesByTag finds matching capabilities', () => {
      const caps = getCapabilitiesByTag(graph, 'test');
      expect(caps).toHaveLength(1);
      expect(caps[0]!.name).toBe('testing_cap');
    });

    it('getCapabilitiesByTag is case-insensitive', () => {
      const caps = getCapabilitiesByTag(graph, 'TEST');
      expect(caps).toHaveLength(1);
    });

    it('getCapabilitiesByStage filters by stage', () => {
      const caps = getCapabilitiesByStage(graph, 'build');
      expect(caps).toHaveLength(1);
      expect(caps[0]!.name).toBe('build_cap');
    });

    it('resolveDependencies returns all transitive deps', () => {
      const resolved = resolveDependencies(graph, ['deploy_cap']);
      expect(resolved).toContain('deploy_cap');
      expect(resolved).toContain('build_cap'); // transitive dep
      expect(resolved).toHaveLength(2);
    });

    it('resolveDependencies handles no dependencies', () => {
      const resolved = resolveDependencies(graph, ['testing_cap']);
      expect(resolved).toEqual(['testing_cap']);
    });

    it('resolveDependencies deduplicates', () => {
      const resolved = resolveDependencies(graph, ['deploy_cap', 'build_cap']);
      const unique = new Set(resolved);
      expect(resolved.length).toBe(unique.size);
    });
  });
});
