/**
 * Tests for Graph Federation (ADR-031 Phase 4)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isFederatedGraph,
  loadFragments,
  federateGraph,
  fragmentToCapabilityEntry,
} from '../../../src/routing/graph-federation.js';
import type { CapabilityFragment } from '../../../src/routing/graph-federation.js';

// ============================================================================
// Helpers
// ============================================================================

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'federation-test-'));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

function writeFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================================
// Tests
// ============================================================================

describe('Graph Federation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe('isFederatedGraph', () => {
    it('returns true for v2.0 format with fragments_dir', () => {
      expect(isFederatedGraph({ version: '2.0', fragments_dir: 'fragments/' })).toBe(true);
    });

    it('returns false for v1.0 format without fragments_dir', () => {
      expect(isFederatedGraph({ version: '1.0', capabilities: [] })).toBe(false);
    });
  });

  describe('loadFragments', () => {
    it('loads fragments from directory', () => {
      const rootPath = path.join(tmpDir, 'root.graph.json');
      const fragDir = path.join(tmpDir, 'fragments');
      fs.mkdirSync(fragDir, { recursive: true });

      writeFile(rootPath, {
        version: '2.0',
        stages: ['build', 'validation'],
        fragments_dir: 'fragments',
      });

      writeFile(path.join(fragDir, 'security.graph.json'), {
        capability: 'security_validation',
        owner: 'shield-team',
        repos: ['LLM-Shield'],
        agents: ['PII Detection Agent'],
        stage: 'validation',
        tags: ['security'],
      });

      writeFile(path.join(fragDir, 'build.graph.json'), {
        capability: 'workflow_orchestration',
        owner: 'orchestrator-team',
        repos: ['LLM-Orchestrator'],
        agents: ['Workflow Agent'],
        stage: 'build',
        tags: ['workflow'],
      });

      const result = loadFragments(rootPath, 'fragments');
      expect(result.errors).toHaveLength(0);
      expect(result.fragments).toHaveLength(2);
      expect(result.fragments.map(f => f.capability).sort()).toEqual([
        'security_validation',
        'workflow_orchestration',
      ]);
    });

    it('reports error for duplicate capability names', () => {
      const rootPath = path.join(tmpDir, 'root.graph.json');
      const fragDir = path.join(tmpDir, 'fragments');
      fs.mkdirSync(fragDir, { recursive: true });

      writeFile(rootPath, { version: '2.0', fragments_dir: 'fragments' });

      writeFile(path.join(fragDir, 'a.graph.json'), {
        capability: 'dup_cap',
        repos: ['R1'],
        agents: ['A1'],
      });

      writeFile(path.join(fragDir, 'b.graph.json'), {
        capability: 'dup_cap',
        repos: ['R2'],
        agents: ['A2'],
      });

      const result = loadFragments(rootPath, 'fragments');
      expect(result.errors.some(e => e.includes('duplicate'))).toBe(true);
    });

    it('warns for missing owner field', () => {
      const rootPath = path.join(tmpDir, 'root.graph.json');
      const fragDir = path.join(tmpDir, 'fragments');
      fs.mkdirSync(fragDir, { recursive: true });

      writeFile(rootPath, { version: '2.0', fragments_dir: 'fragments' });

      writeFile(path.join(fragDir, 'test.graph.json'), {
        capability: 'test_cap',
        repos: ['R1'],
        agents: ['A1'],
      });

      const result = loadFragments(rootPath, 'fragments');
      expect(result.warnings.some(w => w.includes('owner'))).toBe(true);
    });

    it('applies root overrides', () => {
      const rootPath = path.join(tmpDir, 'root.graph.json');
      const fragDir = path.join(tmpDir, 'fragments');
      fs.mkdirSync(fragDir, { recursive: true });

      writeFile(rootPath, {
        version: '2.0',
        fragments_dir: 'fragments',
        overrides: {
          test_cap: { stage: 'governance' },
        },
      });

      writeFile(path.join(fragDir, 'test.graph.json'), {
        capability: 'test_cap',
        owner: 'test-team',
        repos: ['R1'],
        agents: ['A1'],
        stage: 'build',
      });

      const result = loadFragments(rootPath, 'fragments');
      expect(result.fragments[0]!.stage).toBe('governance'); // Override applied
    });

    it('reports error for missing fragments directory', () => {
      const rootPath = path.join(tmpDir, 'root.graph.json');
      writeFile(rootPath, { version: '2.0', fragments_dir: 'nonexistent' });

      const result = loadFragments(rootPath, 'nonexistent');
      expect(result.errors.some(e => e.includes('not found'))).toBe(true);
    });

    it('reports error for invalid fragment JSON', () => {
      const rootPath = path.join(tmpDir, 'root.graph.json');
      const fragDir = path.join(tmpDir, 'fragments');
      fs.mkdirSync(fragDir, { recursive: true });

      writeFile(rootPath, { version: '2.0', fragments_dir: 'fragments' });
      fs.writeFileSync(path.join(fragDir, 'bad.graph.json'), '{invalid}', 'utf-8');

      const result = loadFragments(rootPath, 'fragments');
      expect(result.errors.some(e => e.includes('failed to parse'))).toBe(true);
    });
  });

  describe('federateGraph', () => {
    it('splits monolithic graph into fragments', () => {
      const graphPath = path.join(tmpDir, 'ecosystem.graph.json');
      const outputDir = path.join(tmpDir, 'fragments');

      writeFile(graphPath, {
        version: '1.1',
        description: 'Test graph',
        stages: ['build', 'validation'],
        capabilities: [
          {
            name: 'cap_a',
            repos: ['R1'],
            agents: ['Agent A'],
            stage: 'build',
            tags: ['tag1'],
          },
          {
            name: 'cap_b',
            repos: ['R2'],
            agents: ['Agent B'],
            stage: 'validation',
            tags: ['tag2'],
          },
        ],
      });

      const result = federateGraph(graphPath, outputDir);
      expect(result.fragmentsCreated).toBe(2);
      expect(result.rootUpdated).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Check fragments were created
      expect(fs.existsSync(path.join(outputDir, 'cap_a.graph.json'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'cap_b.graph.json'))).toBe(true);

      // Check root was updated to v2.0
      const updatedRoot = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      expect(updatedRoot.version).toBe('2.0');
      expect(updatedRoot.fragments_dir).toBeTruthy();

      // Check backup was created
      expect(fs.existsSync(graphPath + '.bak')).toBe(true);
    });

    it('handles missing graph file', () => {
      const result = federateGraph('/nonexistent.json', path.join(tmpDir, 'out'));
      expect(result.fragmentsCreated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('handles graph with no capabilities', () => {
      const graphPath = path.join(tmpDir, 'empty.json');
      writeFile(graphPath, { version: '1.0' });

      const result = federateGraph(graphPath, path.join(tmpDir, 'out'));
      expect(result.fragmentsCreated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('fragmentToCapabilityEntry', () => {
    it('converts fragment to capability format', () => {
      const fragment: CapabilityFragment = {
        capability: 'test_cap',
        description: 'A test capability',
        owner: 'test-team',
        repos: ['test-repo'],
        agents: ['Agent A'],
        stage: 'build',
        depends_on: [],
        tags: ['test'],
      };

      const entry = fragmentToCapabilityEntry(fragment);
      expect(entry['name']).toBe('test_cap');
      expect(entry['repos']).toEqual(['test-repo']);
      expect(entry['agents']).toEqual(['Agent A']);
      expect(entry['stage']).toBe('build');
    });
  });
});
