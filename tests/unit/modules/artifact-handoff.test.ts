/**
 * Artifact Handoff Unit Tests
 *
 * SPARC Architecture Reference: §2.5
 * Tests artifact passthrough functionality
 */

import {
  ArtifactHandoff,
  createArtifactHandoff,
  isPlanReference,
  isSimulationReference,
} from '../../../src/modules/artifact-handoff.js';
import type { PlanReference, SimulationReference, BaseReference } from '../../../src/types/index.js';

describe('ArtifactHandoff', () => {
  let handoff: ArtifactHandoff;

  beforeEach(() => {
    handoff = createArtifactHandoff() as ArtifactHandoff;
  });

  describe('passthrough', () => {
    it('should return artifact unchanged', () => {
      const artifact: PlanReference = {
        id: 'plan-123',
        type: 'PlanReference',
        repository: 'agentics-simulation-planner',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'abc123',
      };

      const result = handoff.passthrough(artifact);

      expect(result).toEqual(artifact);
      expect(result).toBe(artifact); // Same reference
    });
  });

  describe('extractReference', () => {
    it('should extract reference from valid body', () => {
      const body = {
        id: 'ref-123',
        type: 'PlanReference',
        repository: 'test-repo',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'xyz789',
      };

      const result = handoff.extractReference(body);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('ref-123');
      expect(result?.type).toBe('PlanReference');
    });

    it('should return null for invalid body', () => {
      expect(handoff.extractReference(null)).toBeNull();
      expect(handoff.extractReference(undefined)).toBeNull();
      expect(handoff.extractReference({})).toBeNull();
      expect(handoff.extractReference({ id: 'only-id' })).toBeNull();
    });
  });

  describe('buildPayload', () => {
    it('should merge reference with additional params', () => {
      const ref: BaseReference = {
        id: 'ref-123',
        type: 'PlanReference',
        repository: 'test',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'abc',
      };

      const result = handoff.buildPayload(ref, { extra: 'data' });

      expect(result).toEqual({
        ref,
        extra: 'data',
      });
    });
  });

  describe('type guards', () => {
    it('should identify PlanReference correctly', () => {
      const planRef: PlanReference = {
        id: 'plan-1',
        type: 'PlanReference',
        repository: 'agentics-simulation-planner',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'abc',
      };

      expect(isPlanReference(planRef)).toBe(true);
      expect(isSimulationReference(planRef)).toBe(false);
    });

    it('should identify SimulationReference correctly', () => {
      const simRef: SimulationReference = {
        id: 'sim-1',
        type: 'SimulationReference',
        repository: 'agentics-simulation-runner',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'abc',
        plan_ref: {
          id: 'plan-1',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-01T00:00:00Z',
          checksum: 'xyz',
        },
      };

      expect(isSimulationReference(simRef)).toBe(true);
      expect(isPlanReference(simRef)).toBe(false);
    });
  });
});
