/**
 * Contract Validator Tests
 *
 * Verifies that the contract validation system:
 * 1. Rejects malformed requests BEFORE network calls
 * 2. Rejects responses missing execution_metadata
 * 3. Requires multi-layer execution proof (layers_executed OR execution_graph)
 * 4. Enforces strict schema validation
 * 5. Has no bypass flags or soft-fail behavior
 */

import {
  validateRequest,
  validateResponse,
  ContractValidationError,
  RequestSchemas,
  ResponseSchemas,
} from '../../../src/contracts/validator.js';

describe('Contract Validator', () => {
  // ============================================================================
  // REQUEST VALIDATION TESTS
  // ============================================================================

  describe('Request Validation', () => {
    describe('Plan Request', () => {
      it('should accept valid plan request', () => {
        const validRequest = {
          query: 'enterprise-deployment-manifest',
          params: { environment: 'production' },
        };

        expect(() => {
          validateRequest(RequestSchemas.PLAN, validRequest);
        }).not.toThrow();
      });

      it('should reject plan request with missing query', () => {
        const invalidRequest = {
          params: { environment: 'production' },
        };

        expect(() => {
          validateRequest(RequestSchemas.PLAN, invalidRequest);
        }).toThrow(ContractValidationError);
      });

      it('should reject plan request with empty query', () => {
        const invalidRequest = {
          query: '',
        };

        expect(() => {
          validateRequest(RequestSchemas.PLAN, invalidRequest);
        }).toThrow(ContractValidationError);
      });
    });

    describe('Simulate Request', () => {
      it('should accept valid simulate request with plan_ref', () => {
        const validRequest = {
          plan_ref: {
            id: 'plan-abc123',
            type: 'PlanReference',
            repository: 'agentics-simulation-planner',
            created_at: '2024-01-15T10:30:00Z',
            checksum: 'a'.repeat(64),
          },
          iterations: 5,
        };

        expect(() => {
          validateRequest(RequestSchemas.SIMULATE, validRequest);
        }).not.toThrow();
      });

      it('should accept valid simulate request with scenario', () => {
        const validRequest = {
          scenario: {
            scenarioId: 'scenario-abc123',
            version: '1.0.0',
            name: 'Test Simulation',
            description: 'A test simulation scenario',
            category: 'general',
            tags: ['test', 'cli'],
            preconditions: ['System is operational'],
            setup: {
              environment: { mode: 'test' },
              fixtures: [],
            },
            steps: [
              {
                stepId: 'step-1',
                action: 'execute_test',
                params: {},
                expected: 'Success',
              },
            ],
            teardown: {
              cleanup: ['Reset state'],
            },
            expectations: {
              success_criteria: ['Test completes'],
              metrics: {},
            },
          },
          iterations: 1,
        };

        expect(() => {
          validateRequest(RequestSchemas.SIMULATE, validRequest);
        }).not.toThrow();
      });

      it('should reject simulate request with invalid checksum format', () => {
        const invalidRequest = {
          plan_ref: {
            id: 'plan-abc123',
            type: 'PlanReference',
            repository: 'agentics-simulation-planner',
            created_at: '2024-01-15T10:30:00Z',
            checksum: 'invalid-checksum', // Not 64 hex chars
          },
        };

        expect(() => {
          validateRequest(RequestSchemas.SIMULATE, invalidRequest);
        }).toThrow(ContractValidationError);
      });

      it('should reject simulate request with scenario missing required fields', () => {
        const invalidRequest = {
          scenario: {
            // Missing all required fields - scenarioId, version, name, etc.
            name: 'Test',
          },
          iterations: 1,
        };

        expect(() => {
          validateRequest(RequestSchemas.SIMULATE, invalidRequest);
        }).toThrow(ContractValidationError);
      });

      it('should reject simulate request with scenario missing steps', () => {
        const invalidRequest = {
          scenario: {
            scenarioId: 'scenario-abc123',
            version: '1.0.0',
            name: 'Test',
            description: 'Test',
            category: 'general',
            tags: [],
            preconditions: [],
            setup: {},
            steps: [], // Empty steps array should fail
            teardown: {},
            expectations: {},
          },
          iterations: 1,
        };

        expect(() => {
          validateRequest(RequestSchemas.SIMULATE, invalidRequest);
        }).toThrow(ContractValidationError);
      });
    });

    describe('Quantify Request', () => {
      it('should accept valid quantify request with structured ref', () => {
        const validRequest = {
          sim_ref: {
            id: 'sim-abc123',
            type: 'SimulationReference',
            repository: 'agentics-simulation-runner',
            created_at: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          report_type: 'cfo-grade',
        };

        expect(() => {
          validateRequest(RequestSchemas.QUANTIFY, validRequest);
        }).not.toThrow();
      });

      it('should accept valid quantify request with natural language', () => {
        const validRequest = {
          sim_ref: {
            natural_language: 'Generate ROI report for latest simulation',
          },
          report_type: 'executive-summary',
        };

        expect(() => {
          validateRequest(RequestSchemas.QUANTIFY, validRequest);
        }).not.toThrow();
      });

      it('should reject quantify request with invalid report type', () => {
        const invalidRequest = {
          sim_ref: {
            natural_language: 'test',
          },
          report_type: 'invalid-type',
        };

        expect(() => {
          validateRequest(RequestSchemas.QUANTIFY, invalidRequest);
        }).toThrow(ContractValidationError);
      });
    });

    describe('Export Request', () => {
      it('should accept valid export request', () => {
        const validRequest = {
          intent_ref: {
            id: 'intent-abc123',
            type: 'IntentReference',
            repository: 'agentics-deployment-intent',
            created_at: '2024-01-15T10:30:00Z',
            checksum: 'c'.repeat(64),
          },
          format_spec: {
            format: 'terraform',
            output_path: '/exports/terraform',
          },
        };

        expect(() => {
          validateRequest(RequestSchemas.EXPORT, validRequest);
        }).not.toThrow();
      });

      it('should reject export request with invalid format', () => {
        const invalidRequest = {
          intent_ref: {
            natural_language: 'export latest',
          },
          format_spec: {
            format: 'invalid-format',
          },
        };

        expect(() => {
          validateRequest(RequestSchemas.EXPORT, invalidRequest);
        }).toThrow(ContractValidationError);
      });
    });

    describe('Diligence Request', () => {
      it('should accept valid diligence request with refs array', () => {
        const validRequest = {
          refs: [
            {
              id: 'ref-1',
              type: 'SimulationReference',
              repository: 'agentics-simulation-runner',
              created_at: '2024-01-15T10:30:00Z',
              checksum: 'd'.repeat(64),
            },
          ],
          frameworks: ['SOC2', 'HIPAA'],
        };

        expect(() => {
          validateRequest(RequestSchemas.DILIGENCE, validRequest);
        }).not.toThrow();
      });

      it('should reject diligence request with empty frameworks', () => {
        const invalidRequest = {
          refs: {
            natural_language: 'audit everything',
          },
          frameworks: [],
        };

        expect(() => {
          validateRequest(RequestSchemas.DILIGENCE, invalidRequest);
        }).toThrow(ContractValidationError);
      });
    });
  });

  // ============================================================================
  // RESPONSE VALIDATION TESTS
  // ============================================================================

  describe('Response Validation', () => {
    describe('Execution Metadata Requirement', () => {
      it('should reject response without execution_metadata', () => {
        const responseWithoutMetadata = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          // Missing execution_metadata
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, responseWithoutMetadata);
        }).toThrow(ContractValidationError);
      });

      it('should reject response with incomplete execution_metadata', () => {
        const responseWithIncompleteMetadata = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            // Missing layer, timestamp, checksum
          },
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, responseWithIncompleteMetadata);
        }).toThrow(ContractValidationError);
      });
    });

    describe('Multi-Layer Execution Proof Requirement', () => {
      it('should reject response with execution_metadata but no multi-layer proof', () => {
        const responseWithoutProof = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          // Missing layers_executed OR execution_graph
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, responseWithoutProof);
        }).toThrow(ContractValidationError);
      });

      it('should accept response with layers_executed array', () => {
        const validResponse = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          layers_executed: [
            {
              layer: 'foundational',
              execution_id: 'exec-foundation1234',
              timestamp: '2024-01-15T10:30:00Z',
              status: 'completed',
            },
            {
              layer: 'intelligence',
              execution_id: 'exec-intel12345678',
              timestamp: '2024-01-15T10:30:01Z',
              status: 'completed',
            },
            {
              layer: 'core',
              execution_id: 'exec-core12345678',
              timestamp: '2024-01-15T10:30:02Z',
              status: 'completed',
            },
          ],
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, validResponse);
        }).not.toThrow();
      });

      it('should accept response with execution_graph', () => {
        const validResponse = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          execution_graph: {
            graph_id: 'graph-12345678',
            root_node: 'node-root12345',
            nodes: [
              {
                node_id: 'node-root12345',
                type: 'service',
                layer: 'core',
                timestamp: '2024-01-15T10:30:00Z',
                status: 'completed',
              },
            ],
            created_at: '2024-01-15T10:30:00Z',
          },
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, validResponse);
        }).not.toThrow();
      });

      it('should accept response with both layers_executed and execution_graph', () => {
        const validResponse = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          layers_executed: [
            {
              layer: 'core',
              execution_id: 'exec-layer12345678',
              timestamp: '2024-01-15T10:30:00Z',
              status: 'completed',
            },
          ],
          execution_graph: {
            graph_id: 'graph-12345678',
            root_node: 'node-root12345',
            nodes: [
              {
                node_id: 'node-root12345',
                type: 'service',
                layer: 'core',
                timestamp: '2024-01-15T10:30:00Z',
                status: 'completed',
              },
            ],
            created_at: '2024-01-15T10:30:00Z',
          },
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, validResponse);
        }).not.toThrow();
      });

      it('should reject layers_executed with invalid layer value', () => {
        const invalidResponse = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          layers_executed: [
            {
              layer: 'invalid-layer', // Not a valid platform layer
              execution_id: 'exec-layer12345678',
              timestamp: '2024-01-15T10:30:00Z',
              status: 'completed',
            },
          ],
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, invalidResponse);
        }).toThrow(ContractValidationError);
      });

      it('should reject execution_graph missing required fields', () => {
        const invalidResponse = {
          id: 'plan-123',
          type: 'PlanReference',
          repository: 'agentics-simulation-planner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          execution_graph: {
            // Missing graph_id, root_node, nodes, created_at
          },
        };

        expect(() => {
          validateResponse(ResponseSchemas.PLAN, invalidResponse);
        }).toThrow(ContractValidationError);
      });
    });

    describe('Simulation Response', () => {
      it('should accept valid simulation response', () => {
        const validResponse = {
          id: 'sim-123',
          type: 'SimulationReference',
          repository: 'agentics-simulation-runner',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          plan_ref: {
            id: 'plan-123',
            type: 'PlanReference',
            repository: 'agentics-simulation-planner',
            created_at: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'intelligence',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'c'.repeat(64),
          },
          layers_executed: [
            {
              layer: 'intelligence',
              execution_id: 'exec-sim12345678',
              timestamp: '2024-01-15T10:30:00Z',
              status: 'completed',
            },
          ],
        };

        expect(() => {
          validateResponse(ResponseSchemas.SIMULATION, validResponse);
        }).not.toThrow();
      });
    });

    describe('ROI Report Response', () => {
      it('should accept valid ROI report response', () => {
        const validResponse = {
          id: 'roi-123',
          type: 'RoiReportReference',
          repository: 'enterprise-roi-engine',
          created_at: '2024-01-15T10:30:00Z',
          checksum: 'a'.repeat(64),
          sim_ref: {
            id: 'sim-123',
            type: 'SimulationReference',
            repository: 'agentics-simulation-runner',
            created_at: '2024-01-15T10:30:00Z',
            checksum: 'b'.repeat(64),
          },
          report_type: 'cfo-grade',
          execution_metadata: {
            execution_id: 'exec-12345678',
            layer: 'core',
            timestamp: '2024-01-15T10:30:00Z',
            checksum: 'c'.repeat(64),
          },
          layers_executed: [
            {
              layer: 'core',
              execution_id: 'exec-roi12345678',
              timestamp: '2024-01-15T10:30:00Z',
              status: 'completed',
            },
          ],
        };

        expect(() => {
          validateResponse(ResponseSchemas.ROI_REPORT, validResponse);
        }).not.toThrow();
      });
    });
  });

  // ============================================================================
  // ERROR HANDLING TESTS
  // ============================================================================

  describe('Error Handling', () => {
    it('should include validation errors in ContractValidationError', () => {
      const invalidRequest = {
        query: '', // Empty string should fail minLength
      };

      try {
        validateRequest(RequestSchemas.PLAN, invalidRequest);
        fail('Expected ContractValidationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContractValidationError);
        const contractError = error as ContractValidationError;
        expect(contractError.validationErrors).toBeDefined();
        expect(contractError.validationErrors.length).toBeGreaterThan(0);
      }
    });

    it('should set correct error category for request validation failures', () => {
      const invalidRequest = {};

      try {
        validateRequest(RequestSchemas.PLAN, invalidRequest);
        fail('Expected ContractValidationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContractValidationError);
        const contractError = error as ContractValidationError;
        expect(contractError.category).toBe('INPUT_ERROR');
        expect(contractError.code).toBe('ECLI-CONTRACT-REQ-001');
      }
    });

    it('should set correct error category for response validation failures', () => {
      const invalidResponse = {
        id: 'test',
        // Missing execution_metadata
      };

      try {
        validateResponse(ResponseSchemas.PLAN, invalidResponse);
        fail('Expected ContractValidationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContractValidationError);
        const contractError = error as ContractValidationError;
        expect(contractError.category).toBe('DOWNSTREAM_ERROR');
        expect(contractError.code).toBe('ECLI-CONTRACT-RES-001');
      }
    });

    it('should include correlation ID in errors when provided', () => {
      const correlationId = 'test-correlation-123';

      try {
        validateRequest(RequestSchemas.PLAN, {}, correlationId);
        fail('Expected ContractValidationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContractValidationError);
        const contractError = error as ContractValidationError;
        expect(contractError.correlationId).toBe(correlationId);
      }
    });
  });

  // ============================================================================
  // NO BYPASS TESTS
  // ============================================================================

  describe('No Bypass Behavior', () => {
    it('should not coerce types', () => {
      const requestWithWrongTypes = {
        query: 123, // Should be string
      };

      expect(() => {
        validateRequest(RequestSchemas.PLAN, requestWithWrongTypes);
      }).toThrow(ContractValidationError);
    });

    it('should not apply default values', () => {
      // Iterations should remain undefined, not get a default
      const request = {
        scenario: {
          scenarioId: 'scenario-test',
          version: '1.0.0',
          name: 'Test',
          description: 'Test',
          category: 'general',
          tags: [],
          preconditions: [],
          setup: {},
          steps: [{ stepId: 'step-1', action: 'test' }],
          teardown: {},
          expectations: {},
        },
      };

      const validated = validateRequest(RequestSchemas.SIMULATE, request);
      expect(validated).not.toHaveProperty('iterations');
    });

    it('should reject null values for required fields', () => {
      const requestWithNull = {
        query: null,
      };

      expect(() => {
        validateRequest(RequestSchemas.PLAN, requestWithNull);
      }).toThrow(ContractValidationError);
    });

    it('should reject undefined as valid response', () => {
      expect(() => {
        validateResponse(ResponseSchemas.PLAN, undefined);
      }).toThrow(ContractValidationError);
    });

    it('should reject null as valid response', () => {
      expect(() => {
        validateResponse(ResponseSchemas.PLAN, null);
      }).toThrow(ContractValidationError);
    });
  });
});
