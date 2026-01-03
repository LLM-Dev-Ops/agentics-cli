/**
 * Orchestration Engine Unit Tests
 *
 * SPARC Architecture Reference: §2.3
 * Tests sequencing of downstream service calls
 */

import { OrchestrationEngine, createOrchestrationEngine } from '../../../src/modules/orchestration-engine.js';
import type { IDownstreamAdapter } from '../../../src/adapters/base-adapter.js';
import type { AdapterResponse, HealthStatus, EndpointConfig } from '../../../src/types/index.js';

// Mock adapter for testing
class MockAdapter implements IDownstreamAdapter {
  private response: AdapterResponse;
  public invokeCalls: Array<{ endpoint: string; method: string; body: unknown }> = [];

  constructor(response: AdapterResponse) {
    this.response = response;
  }

  async invoke(request: { endpoint: string; method: string; body?: unknown }): Promise<AdapterResponse> {
    this.invokeCalls.push({
      endpoint: request.endpoint,
      method: request.method,
      body: request.body,
    });
    return this.response;
  }

  async health(): Promise<HealthStatus> {
    return { healthy: true, latency: 10 };
  }

  getEndpointConfig(): EndpointConfig {
    return { baseUrl: 'https://mock.api', version: 'v1', timeout: 5000 };
  }
}

describe('OrchestrationEngine', () => {
  let engine: OrchestrationEngine;

  beforeEach(() => {
    engine = createOrchestrationEngine('test-correlation-id') as OrchestrationEngine;
  });

  describe('execute', () => {
    it('should execute a single stage successfully', async () => {
      const mockResponse: AdapterResponse = {
        status: 200,
        headers: {},
        body: { id: 'test-123', type: 'PlanReference', repository: 'test' },
        timing: 100,
      };

      const mockAdapter = new MockAdapter(mockResponse);

      const result = await engine.execute(
        [
          {
            name: 'test-stage',
            adapter: mockAdapter,
            request: {
              endpoint: '/api/test',
              method: 'POST',
              buildBody: () => ({ data: 'test' }),
            },
          },
        ],
        { timeout: 5000 }
      );

      expect(result.success).toBe(true);
      expect(result.stages).toHaveLength(1);
      expect(result.stages[0]?.status).toBe('complete');
      expect(mockAdapter.invokeCalls).toHaveLength(1);
    });

    it('should execute stages in dependency order', async () => {
      const executionOrder: string[] = [];

      const mockResponse1: AdapterResponse = {
        status: 200,
        headers: {},
        body: { id: 'ref-1', type: 'ManifestReference', repository: 'manifests' },
        timing: 50,
      };

      const mockResponse2: AdapterResponse = {
        status: 200,
        headers: {},
        body: { id: 'ref-2', type: 'PlanReference', repository: 'planner' },
        timing: 100,
      };

      class OrderTrackingAdapter implements IDownstreamAdapter {
        private response: AdapterResponse;
        private name: string;

        constructor(response: AdapterResponse, name: string) {
          this.response = response;
          this.name = name;
        }

        async invoke(): Promise<AdapterResponse> {
          executionOrder.push(this.name);
          return this.response;
        }

        async health(): Promise<HealthStatus> {
          return { healthy: true, latency: 10 };
        }

        getEndpointConfig(): EndpointConfig {
          return { baseUrl: 'https://mock.api', version: 'v1', timeout: 5000 };
        }
      }

      const result = await engine.execute(
        [
          {
            name: 'stage-1',
            adapter: new OrderTrackingAdapter(mockResponse1, 'stage-1'),
            request: {
              endpoint: '/api/manifests',
              method: 'POST',
              buildBody: () => ({}),
            },
          },
          {
            name: 'stage-2',
            adapter: new OrderTrackingAdapter(mockResponse2, 'stage-2'),
            request: {
              endpoint: '/api/plans',
              method: 'POST',
              buildBody: (prev) => ({ ref: prev.get('stage-1') }),
            },
            dependsOn: ['stage-1'],
          },
        ],
        { timeout: 5000 }
      );

      expect(result.success).toBe(true);
      expect(executionOrder).toEqual(['stage-1', 'stage-2']);
    });

    it('should fail fast on error', async () => {
      const failingAdapter: IDownstreamAdapter = {
        invoke: async () => {
          throw new Error('Network error');
        },
        health: async () => ({ healthy: false, latency: 0 }),
        getEndpointConfig: () => ({ baseUrl: '', version: '', timeout: 0 }),
      };

      const result = await engine.execute(
        [
          {
            name: 'failing-stage',
            adapter: failingAdapter,
            request: {
              endpoint: '/api/fail',
              method: 'POST',
              buildBody: () => ({}),
            },
          },
        ],
        { timeout: 5000 }
      );

      expect(result.success).toBe(false);
      expect(result.stages[0]?.status).toBe('failed');
    });
  });
});
