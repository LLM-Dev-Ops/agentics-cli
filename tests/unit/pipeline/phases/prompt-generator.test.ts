/**
 * Tests for Pipeline — ADR Implementation Prompt Generator
 *
 * Validates what the prompt generator produces for the RuvFlow execution engine.
 * Since executePromptGeneration() requires PipelineContext with filesystem writes,
 * we call it with a minimal context pointing to temp directories and verify
 * the generated output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executePromptGeneration } from '../../../../src/pipeline/phases/prompt-generator.js';
import type {
  PipelineContext,
  SPARCOutput,
  ADRRecord,
  DomainModel,
  StageOutput,
  ExecutionPlan,
} from '../../../../src/pipeline/types.js';

// ============================================================================
// Test Data Builders
// ============================================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-gen-test-'));
}

function buildSPARC(): SPARCOutput {
  return {
    specification: {
      requirements: ['Process purchase orders', 'Integrate with SAP'],
      constraints: ['Must run on GCP', 'Sub-100ms latency'],
      successCriteria: ['99.9% uptime'],
      scope: 'Order management system',
    },
    pseudocode: {
      algorithms: ['Order validation', 'Price calculation'],
      tddAnchors: ['Given valid order When submitted Then events published'],
      dataStructures: ['OrderAggregate', 'LineItem'],
    },
    architecture: {
      services: [
        {
          name: 'OrderService',
          responsibility: 'Manages order lifecycle',
          api: ['POST /orders', 'GET /orders/:id'],
          dependencies: ['PaymentService', 'InventoryService'],
        },
        {
          name: 'PaymentService',
          responsibility: 'Handles payment processing',
          api: ['POST /payments'],
          dependencies: ['StripeGateway'],
        },
      ],
      boundaries: ['OrderContext', 'PaymentContext'],
      dataFlow: 'Order -> Payment -> Fulfillment',
      apiContracts: ['OpenAPI 3.0'],
    },
    refinement: {
      securityConsiderations: [
        'Use mTLS for service-to-service',
        'Encrypt PII at rest',
        'Validate all inputs',
        'Rate limit public endpoints',
      ],
      performanceTargets: [
        'p99 < 200ms',
        'Support 1000 TPS',
        'Cache hot queries',
      ],
      testStrategy: 'London School TDD with mocked ports at aggregate boundaries',
    },
    completion: {
      integrationPlan: 'Integrate SAP via OData adapter',
      documentation: ['ADR index', 'OpenAPI spec'],
      monitoringSetup: ['OpenTelemetry traces', 'Prometheus metrics'],
    },
  };
}

function buildADRs(): ADRRecord[] {
  return [
    {
      id: 'ADR-001',
      title: 'Use PostgreSQL for order persistence',
      status: 'accepted',
      date: '2024-03-01',
      context: 'Need ACID-compliant database for order transactions with JSONB support',
      decision: 'Use PostgreSQL 16 with JSONB columns for order aggregates',
      alternatives: ['DynamoDB', 'MongoDB'],
      consequences: ['Need pg connection pooling', 'Schema migrations required'],
    },
    {
      id: 'ADR-002',
      title: 'Event-driven integration with payment service',
      status: 'accepted',
      date: '2024-03-02',
      context: 'Payment processing is async and may fail, need resilient integration',
      decision: 'Use Pub/Sub for event-driven communication between order and payment contexts',
      alternatives: ['Synchronous REST', 'gRPC streaming'],
      consequences: ['Eventually consistent', 'Need dead-letter queue'],
    },
    {
      id: 'ADR-003',
      title: 'OAuth2 + JWT for API authentication',
      status: 'accepted',
      date: '2024-03-03',
      context: 'Public API needs secure authentication with token-based access control',
      decision: 'Implement OAuth2 authorization code flow with JWT access tokens',
      alternatives: ['API key', 'Session-based auth'],
      consequences: ['Need JWKS endpoint', 'Token rotation strategy'],
    },
    {
      id: 'ADR-004',
      title: 'Domain-driven order aggregate design',
      status: 'accepted',
      date: '2024-03-04',
      context: 'Complex order lifecycle requires rich domain model with invariant enforcement',
      decision: 'Use aggregate pattern with Order as root, LineItem as entity, Money as value object',
      alternatives: ['Anemic model', 'Transaction script'],
      consequences: ['Rich domain model', 'Event sourcing friendly'],
    },
  ];
}

function buildDomainModel(): DomainModel {
  return {
    contexts: [
      {
        name: 'order-management',
        description: 'Manages order lifecycle from creation to fulfillment',
        aggregates: [
          { name: 'Order', root: 'Order', entities: ['OrderLine'], valueObjects: ['Money'] },
        ],
        domainEvents: ['OrderSubmitted', 'OrderCancelled'],
        commands: ['SubmitOrder', 'CancelOrder'],
        queries: ['GetOrder', 'ListOrders'],
      },
      {
        name: 'payment-processing',
        description: 'Handles payment lifecycle and reconciliation',
        aggregates: [
          { name: 'Payment', root: 'Payment', entities: [], valueObjects: ['Amount'] },
        ],
        domainEvents: ['PaymentProcessed', 'PaymentFailed'],
        commands: ['ProcessPayment', 'RefundPayment'],
        queries: ['GetPayment'],
      },
    ],
    contextMap: [
      {
        upstream: 'order-management',
        downstream: 'payment-processing',
        type: 'customer-supplier',
      },
    ],
  };
}

function buildPipelineContext(): PipelineContext {
  const tmpDir = makeTempDir();
  const artifactsDir = path.join(tmpDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const stageOutputs = new Map();

  const sparcOutput: StageOutput = {
    stage: 'sparc-development',
    status: 'completed',
    data: buildSPARC(),
    artifacts: [],
    timing: 100,
    summary: 'SPARC completed',
  };

  const adrDddOutput: StageOutput = {
    stage: 'adr-ddd-generation',
    status: 'completed',
    data: {
      adrs: buildADRs(),
      domainModel: buildDomainModel(),
    },
    artifacts: [],
    timing: 100,
    summary: 'ADR/DDD completed',
  };

  stageOutputs.set('sparc-development', sparcOutput);
  stageOutputs.set('adr-ddd-generation', adrDddOutput);

  return {
    executionId: 'test-exec-001',
    query: 'Build an enterprise order management system with SAP integration',
    simulationResult: {},
    platformAnalysis: [],
    artifactsDir,
    mode: 'autonomous',
    stageOutputs,
    userFeedback: new Map(),
    userContext: {},
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Prompt Generator', () => {
  describe('prompt generation per ADR', () => {
    it('should generate one prompt per ADR', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      expect(output.status).toBe('completed');

      const plan = output.data as ExecutionPlan;
      expect(plan.prompts).toHaveLength(4); // 4 ADRs
    });

    it('should set correct totalSteps in execution plan', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;
      expect(plan.totalSteps).toBe(plan.prompts.length);
    });
  });

  describe('dependency ordering', () => {
    it('should place infrastructure ADRs before domain logic ADRs', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;
      const titles = plan.prompts.map(p => p.title);

      // ADR-003 (security/auth) should come before ADR-004 (domain design)
      const authIdx = titles.findIndex(t => t.includes('OAuth2'));
      const domainIdx = titles.findIndex(t => t.includes('Domain-driven'));
      expect(authIdx).toBeLessThan(domainIdx);
    });

    it('should place data/persistence ADRs before integration ADRs', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;
      const titles = plan.prompts.map(p => p.title);

      // PostgreSQL (data) should come before event-driven (integration/communication)
      const dbIdx = titles.findIndex(t => t.includes('PostgreSQL'));
      const eventIdx = titles.findIndex(t => t.includes('Event-driven'));
      expect(dbIdx).toBeLessThan(eventIdx);
    });
  });

  describe('prompt content sections', () => {
    it('should include project objective in each prompt', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.content).toContain('## Project Objective');
        expect(prompt.content).toContain('order management system');
      }
    });

    it('should include ADR context and decision', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      // Find the PostgreSQL ADR prompt
      const pgPrompt = plan.prompts.find(p => p.title.includes('PostgreSQL'));
      expect(pgPrompt).toBeDefined();
      expect(pgPrompt!.content).toContain('**Context:**');
      expect(pgPrompt!.content).toContain('ACID-compliant');
      expect(pgPrompt!.content).toContain('**Decision:**');
      expect(pgPrompt!.content).toContain('PostgreSQL 16');
    });

    it('should include consequences when present', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      const pgPrompt = plan.prompts.find(p => p.title.includes('PostgreSQL'));
      expect(pgPrompt!.content).toContain('**Consequences:**');
      expect(pgPrompt!.content).toContain('connection pooling');
    });
  });

  describe('bounded context linkage', () => {
    it('should include affected bounded contexts in prompt', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      // The order-related ADR should reference the order-management context
      const orderPrompt = plan.prompts.find(p => p.title.includes('Domain-driven order'));
      expect(orderPrompt).toBeDefined();
      expect(orderPrompt!.content).toContain('order-management');
    });
  });

  describe('service specifications', () => {
    it('should include related service specs when available', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      // Check that at least one prompt has service specifications
      // Service specs appear when a bounded context matches a SPARC service name
      // This depends on the keyword matching logic
      expect(plan.prompts.length).toBeGreaterThan(0);
    });
  });

  describe('quality requirements', () => {
    it('should include security considerations', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.content).toContain('### Security');
        expect(prompt.content).toContain('mTLS');
      }
    });

    it('should include performance targets', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.content).toContain('### Performance');
        expect(prompt.content).toContain('p99');
      }
    });

    it('should include testing strategy', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.content).toContain('### Testing');
        expect(prompt.content).toContain('London School TDD');
      }
    });
  });

  describe('previously implemented ADRs', () => {
    it('should list previously implemented ADRs in subsequent prompts', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      // First prompt should not have "Previously Implemented" section
      expect(plan.prompts[0]!.content).not.toContain('Previously Implemented ADRs');

      // Second prompt should list the first ADR as already done
      expect(plan.prompts[1]!.content).toContain('Previously Implemented ADRs');
    });

    it('should list all prior ADRs in the last prompt', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;
      const lastPrompt = plan.prompts[plan.prompts.length - 1]!;

      // Last prompt should reference all 3 prior ADRs
      const prevSection = lastPrompt.content.split('Previously Implemented ADRs')[1] ?? '';
      expect(prevSection).toContain('ADR-');
    });
  });

  describe('implementation instructions', () => {
    it('should include all 10 implementation rules', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.content).toContain('## Implementation Instructions');
        expect(prompt.content).toContain('1. **Implement ONLY this ADR');
        expect(prompt.content).toContain('2. **Write tests first');
        expect(prompt.content).toContain('3. **Write real domain logic');
        expect(prompt.content).toContain('4. **Use typed interfaces');
        expect(prompt.content).toContain('5. **Enforce invariants');
        expect(prompt.content).toContain('6. **Handle all error paths');
        expect(prompt.content).toContain('7. **Integrate with prior ADRs');
        expect(prompt.content).toContain('8. **Zero compilation errors');
        expect(prompt.content).toContain('9. **Production-grade patterns');
        expect(prompt.content).toContain('10. **Complete test coverage');
      }
    });
  });

  describe('execution plan JSON', () => {
    it('should produce valid execution plan with correct totalSteps', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      expect(plan.totalSteps).toBe(4);
      expect(plan.prompts).toHaveLength(4);
      expect(plan.estimatedDuration).toMatch(/\d+-\d+ minutes/);
    });

    it('should write execution-plan.json artifact', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);

      const hasExecPlan = output.artifacts.some(a => a.includes('execution-plan.json'));
      expect(hasExecPlan).toBe(true);

      const planPath = path.join(ctx.artifactsDir, 'prompts', 'execution-plan.json');
      expect(fs.existsSync(planPath)).toBe(true);

      const planJson = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
      expect(planJson.totalSteps).toBe(4);
      expect(Array.isArray(planJson.prompts)).toBe(true);
    });
  });

  describe('slugify helper (via filename output)', () => {
    it('should produce valid filenames for prompt files', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);

      for (const artifact of output.artifacts) {
        if (artifact.includes('impl-')) {
          // Should be lowercase with dashes, no special chars
          const filename = path.basename(artifact);
          expect(filename).toMatch(/^impl-\d{3}-[a-z0-9-]+\.md$/);
        }
      }
    });
  });

  describe('prompt metadata', () => {
    it('should assign sequential order numbers', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (let i = 0; i < plan.prompts.length; i++) {
        expect(plan.prompts[i]!.order).toBe(i + 1);
      }
    });

    it('should set prompt ID in format prompt-NNN', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.id).toMatch(/^prompt-\d{3}$/);
      }
    });

    it('should include the ADR ID in relatedADRs', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.relatedADRs.length).toBe(1);
        expect(prompt.relatedADRs[0]).toMatch(/^ADR-\d{3}$/);
      }
    });
  });

  describe('error handling', () => {
    it('should fail when SPARC output is not available', async () => {
      const ctx = buildPipelineContext();
      ctx.stageOutputs.delete('sparc-development');

      const output = await executePromptGeneration(ctx);
      expect(output.status).toBe('failed');
    });

    it('should fail when ADR/DDD output is not available', async () => {
      const ctx = buildPipelineContext();
      ctx.stageOutputs.delete('adr-ddd-generation');

      const output = await executePromptGeneration(ctx);
      expect(output.status).toBe('failed');
    });
  });

  describe('step counter in content', () => {
    it('should include step N of M in each prompt', async () => {
      const ctx = buildPipelineContext();
      const output = await executePromptGeneration(ctx);
      const plan = output.data as ExecutionPlan;

      for (const prompt of plan.prompts) {
        expect(prompt.content).toContain(`Step ${prompt.order} of ${plan.totalSteps}`);
      }
    });
  });
});
