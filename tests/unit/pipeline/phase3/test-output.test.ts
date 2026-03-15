/**
 * Tests for Phase 3 — Test Generator Output
 *
 * Validates what the London School TDD test generator produces for end users.
 * We import buildTestFiles() (the pure builder) and pass minimal TDD plans
 * with a Phase2DomainModel to verify the generated string content.
 */

import { buildTestFiles } from '../../../../src/pipeline/phase3/phases/test-generator.js';
import type {
  TDDPlan,
  TDDTestSuite,
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2Command,
  Phase2Query,
} from '../../../../src/pipeline/phase2/types.js';

// ============================================================================
// Test Data Builders
// ============================================================================

function buildCommand(overrides?: Partial<Phase2Command>): Phase2Command {
  return {
    name: 'SubmitOrder',
    description: 'Submit a new order for processing',
    input: ['orderId', 'customerId', 'amount'],
    preconditions: ['Order must have at least one line item'],
    postconditions: ['OrderSubmitted event published'],
    ...overrides,
  };
}

function buildQuery(overrides?: Partial<Phase2Query>): Phase2Query {
  return {
    name: 'GetOrderById',
    description: 'Get an order by its ID',
    parameters: ['orderId'],
    returns: 'OrderView',
    ...overrides,
  };
}

function buildBoundedContext(_overrides?: Partial<Phase2DDDBoundedContext>): Phase2DDDBoundedContext {
  return {
    name: 'OrderManagement',
    description: 'Handles order lifecycle',
    aggregates: [
      {
        name: 'Order',
        root: 'Order',
        entities: ['OrderLine'],
        valueObjects: ['Money', 'Address'],
        invariants: ['Total must be positive'],
        commands: [
          buildCommand(),
          buildCommand({
            name: 'CancelOrder',
            description: 'Cancel an existing order',
            input: ['orderId', 'reason'],
            preconditions: [],
            postconditions: ['OrderCancelled event published'],
          }),
        ],
        queries: [
          buildQuery(),
          buildQuery({
            name: 'ListOrdersByCustomer',
            description: 'List orders for a customer',
            parameters: ['customerId', 'status'],
            returns: 'OrderListView',
          }),
        ],
        domainEvents: ['OrderSubmitted', 'OrderCancelled'],
      },
    ],
    domainEvents: [
      { name: 'OrderSubmitted', payload: ['orderId', 'amount'], trigger: 'SubmitOrder command' },
      { name: 'OrderCancelled', payload: ['orderId', 'reason'], trigger: 'CancelOrder command' },
    ],
    commands: [
      buildCommand(),
      buildCommand({
        name: 'CancelOrder',
        description: 'Cancel an existing order',
        input: ['orderId', 'reason'],
        preconditions: [],
        postconditions: ['OrderCancelled event published'],
      }),
    ],
    queries: [
      buildQuery(),
      buildQuery({
        name: 'ListOrdersByCustomer',
        description: 'List orders for a customer',
        parameters: ['customerId', 'status'],
        returns: 'OrderListView',
      }),
    ],
    ubiquitousLanguage: [],
    adrRefs: ['ADR-001'],
  } as unknown as Phase2DDDBoundedContext;
}

function buildDomainModel(): Phase2DomainModel {
  return {
    contexts: [buildBoundedContext()],
    contextMap: [],
    ubiquitousLanguageGlossary: [],
  };
}

function buildMinimalTDDPlan(overrides?: Partial<TDDPlan>): TDDPlan {
  return {
    approach: 'london-school' as const,
    testPyramid: {
      unit: { count: 1, percentage: 100 },
      integration: { count: 0, percentage: 0 },
      acceptance: { count: 0, percentage: 0 },
      e2e: { count: 0, percentage: 0 },
    },
    testSuites: [
      {
        id: 'TS-001',
        name: 'Order Processing Suite',
        description: 'Tests for order processing',
        boundedContext: 'OrderManagement',
        layer: 'unit',
        tests: [],
        mockDependencies: [],
        adrRefs: [],
      } as TDDTestSuite,
    ],
    mockContracts: [],
    seamDefinitions: [],
    executionOrder: ['TS-001'],
    ...overrides,
  } as TDDPlan;
}

// ============================================================================
// Tests
// ============================================================================

describe('Test Generator Output', () => {
  describe('Vitest imports', () => {
    it('should import describe, it, expect, vi, and beforeEach from vitest', () => {
      const plan = buildMinimalTDDPlan();
      const model = buildDomainModel();
      const result = buildTestFiles(plan, model, 'typescript');

      expect(result.files.length).toBeGreaterThan(0);
      const content = result.files[0]!.content;
      expect(content).toContain("import { describe, it, expect, vi, beforeEach } from 'vitest'");
    });
  });

  describe('mock factories', () => {
    it('should generate createMockRepository factory', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('function createMockRepository()');
      expect(content).toContain('findById: vi.fn()');
      expect(content).toContain('save: vi.fn()');
    });

    it('should generate createMockEventPublisher factory', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('function createMockEventPublisher()');
      expect(content).toContain('publish: vi.fn()');
    });

    it('should generate createMockReadModel factory', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('function createMockReadModel()');
      expect(content).toContain('query: vi.fn()');
    });
  });

  describe('happy path command handler tests', () => {
    it('should generate test that verifies save + event publish', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should save aggregate and publish domain event on valid input');
      expect(content).toContain('mockRepo.save');
      expect(content).toContain('mockEventPublisher.publish');
      expect(content).toContain('expect(result.success).toBe(true)');
    });

    it('should pass input fields to the handler', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      // SubmitOrder has inputs: orderId, customerId, amount
      expect(content).toContain("order_id: 'test-value'");
    });
  });

  describe('input validation tests', () => {
    it('should generate test that rejects empty input', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should reject when required fields are missing');
      expect(content).toContain('emptyInput');
      expect(content).toContain('rejects.toThrow()');
    });

    it('should verify no save called on validation failure', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('expect(mockRepo.save).not.toHaveBeenCalled()');
    });

    it('should verify no events published on validation failure', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('expect(mockEventPublisher.publish).not.toHaveBeenCalled()');
    });
  });

  describe('repository failure tests', () => {
    it('should generate test for database error propagation', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should propagate repository errors without publishing events');
      expect(content).toContain('Database connection lost');
      expect(content).toContain('mockRepo.save.mockRejectedValue');
    });

    it('should verify no events published on repository failure', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      // After the repo failure test, events should not be published
      const repoFailureSection = content.split('should propagate repository errors')[1] ?? '';
      expect(repoFailureSection).toContain('expect(mockEventPublisher.publish).not.toHaveBeenCalled()');
    });
  });

  describe('idempotency tests', () => {
    it('should generate idempotency test for duplicate handling', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should handle duplicate invocations idempotently');
      expect(content).toContain('result1');
      expect(content).toContain('result2');
      expect(content).toContain('toHaveBeenCalledTimes(2)');
    });
  });

  describe('query handler tests', () => {
    it('should generate test that verifies return shape', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should return expected shape from read model');
      expect(content).toContain('result.rows');
      expect(content).toContain('result.total');
    });

    it('should generate empty result test', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should return empty result when no data matches');
      expect(content).toContain('expect(result.rows).toEqual([])');
      expect(content).toContain('expect(result.total).toBe(0)');
    });
  });

  describe('read model failure tests', () => {
    it('should generate test for read model error propagation', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should propagate read model errors');
      expect(content).toContain('Read model unavailable');
    });
  });

  describe('large dataset tests', () => {
    it('should generate test for handling 1000 items', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('should handle large result sets');
      expect(content).toContain('length: 1000');
      expect(content).toContain('expect(result.rows).toHaveLength(1000)');
    });
  });

  describe('precondition tests', () => {
    it('should generate precondition failure test when preconditions exist', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      // SubmitOrder has a precondition: "Order must have at least one line item"
      expect(content).toContain('should reject when preconditions are not met');
      expect(content).toContain('Order must have at least one line item');
    });

    it('should NOT generate precondition test for commands without preconditions', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      // CancelOrder has no preconditions — split at its section
      const parts = content.split('CancelOrder command handler');
      if (parts.length > 1) {
        // Look within the CancelOrder section only (up to next describe block)
        const cancelSection = parts[1]!.split(/describe\(/)[0] ?? '';
        expect(cancelSection).not.toContain('should reject when preconditions are not met');
      }
    });
  });

  describe('file paths', () => {
    it('should place unit tests in tests/unit/ directory', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      expect(result.files.length).toBeGreaterThan(0);
      const testFile = result.files[0]!;
      expect(testFile.relativePath).toContain('tests/unit/');
      expect(testFile.relativePath).toMatch(/\.test\.ts$/);
    });
  });

  describe('describe blocks structure', () => {
    it('should wrap tests in a top-level describe block', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain("describe('Order Processing Suite'");
    });

    it('should include beforeEach for mock reset', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const content = result.files[0]!.content;
      expect(content).toContain('beforeEach(() => {');
      expect(content).toContain('mockRepo = createMockRepository()');
      expect(content).toContain('mockEventPublisher = createMockEventPublisher()');
      expect(content).toContain('mockReadModel = createMockReadModel()');
    });
  });

  describe('output shape', () => {
    it('should return files array with relativePath and content', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      expect(result).toHaveProperty('files');
      expect(Array.isArray(result.files)).toBe(true);
      for (const file of result.files) {
        expect(file).toHaveProperty('relativePath');
        expect(file).toHaveProperty('content');
        expect(typeof file.relativePath).toBe('string');
        expect(typeof file.content).toBe('string');
      }
    });

    it('should include pyramid distribution in output', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      expect(result).toHaveProperty('pyramidDistribution');
      expect(result.pyramidDistribution).toHaveProperty('unit');
      expect(result.pyramidDistribution.unit).toBeGreaterThanOrEqual(0);
    });
  });

  describe('command handler describe blocks', () => {
    it('should create a describe block for each command handler', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const allContent = result.files.map(f => f.content).join('\n');
      expect(allContent).toContain('SubmitOrder command handler');
      expect(allContent).toContain('CancelOrder command handler');
    });

    it('should create a describe block for each query handler', () => {
      const result = buildTestFiles(buildMinimalTDDPlan(), buildDomainModel(), 'typescript');
      const allContent = result.files.map(f => f.content).join('\n');
      expect(allContent).toContain('GetOrderById query handler');
      expect(allContent).toContain('ListOrdersByCustomer query handler');
    });
  });
});
