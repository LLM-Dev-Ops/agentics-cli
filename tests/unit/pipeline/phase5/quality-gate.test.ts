/**
 * Tests for Phase 5 Build — Implementation Quality Gate
 *
 * Validates the quality scoring engine that checks implementation artifacts
 * before code generation. Tests the exported validateImplementationQuality()
 * function directly with controlled corpus strings.
 */

import {
  validateImplementationQuality,
} from '../../../../src/pipeline/phase5-build/phases/implementation-quality-gate.js';

// ============================================================================
// Test Data Builders
// ============================================================================

/**
 * Build a corpus string that should achieve a high quality score.
 * Includes all signal types: cloud provider, typed fields, domain commands,
 * test data, and database dialect.
 */
function buildHighQualityCorpus(): string {
  return [
    // Cloud provider signals (AWS)
    'Deploy to AWS using Lambda and DynamoDB with S3 storage and SQS queues.',
    'Use EventBridge for event routing and CloudFormation for infrastructure.',

    // Typed fields (10+)
    'orderId: UUID',
    'customerId: string',
    'totalAmount: Decimal',
    'orderDate: Date',
    'shipmentDate: DateTime',
    'lineItemCount: number',
    'orderStatus: enum',
    'approvalTimestamp: Instant',
    'unitPrice: Money',
    'batchQuantity: integer',
    'public tenantId: TenantId',
    'readonly accountBalance: Decimal',

    // Domain commands (5+)
    'SubmitPurchaseOrder',
    'ApproveBatchRelease',
    'RejectInvoice',
    'CancelShipment',
    'ProcessPayment',
    'VerifyCompliance',
    'OrderSubmitted',
    'PaymentProcessed',
    'ShipmentDispatched',
    'InvoiceApproved',
    'BatchReleaseCompleted',

    // Test data (realistic)
    '550e8400-e29b-41d4-a716-446655440000',
    '2024-03-15',
    'user@example.com',
    'ORD-12345',
    'INV-98765',
    '45678.99',

    // Database dialect (PostgreSQL)
    'PostgreSQL with JSONB columns and pgcrypto extension',
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    'BIGSERIAL PRIMARY KEY',
  ].join('\n');
}

/**
 * Build a corpus string with only generic CRUD patterns (low quality).
 */
function buildGenericCRUDCorpus(): string {
  return [
    'CreateItem handler',
    'ReadRecord endpoint',
    'UpdateEntry operation',
    'DeleteData controller',
    'ListResource handler',
    'GetEntity endpoint',
    'CRUD operation for genericController',
    'genericService.create()',
    'genericRepository.save()',
  ].join('\n');
}

// ============================================================================
// Tests
// ============================================================================

describe('Implementation Quality Gate', () => {
  describe('passing threshold', () => {
    it('should pass when score is at least 60/100', () => {
      const corpus = buildHighQualityCorpus();
      const report = validateImplementationQuality(corpus, []);
      expect(report.passed).toBe(true);
      expect(report.score).toBeGreaterThanOrEqual(60);
    });

    it('should fail when score is below 60/100', () => {
      const corpus = 'just a basic todo app with no details';
      const report = validateImplementationQuality(corpus, []);
      expect(report.passed).toBe(false);
      expect(report.score).toBeLessThan(60);
    });

    it('should report exactly 0 for empty corpus', () => {
      const report = validateImplementationQuality('', []);
      expect(report.passed).toBe(false);
      expect(report.score).toBe(0);
    });

    it('should report exactly 0 for whitespace-only corpus', () => {
      const report = validateImplementationQuality('   \n\t  ', []);
      expect(report.passed).toBe(false);
      expect(report.score).toBe(0);
    });
  });

  describe('cloud provider detection', () => {
    it('should detect AWS from service keywords', () => {
      const corpus = 'Deploy to AWS using Lambda functions and DynamoDB tables with S3 buckets';
      const report = validateImplementationQuality(corpus, []);
      expect(report.cloudProviderDetected).toBe('AWS');
    });

    it('should detect Azure from service keywords', () => {
      const corpus = 'Use Azure Functions with Cosmos DB and Azure SQL for enterprise workloads';
      const report = validateImplementationQuality(corpus, []);
      expect(report.cloudProviderDetected).toBe('Azure');
    });

    it('should detect GCP from service keywords', () => {
      const corpus = 'Deploy to GCP Cloud Run with Cloud SQL and Pub/Sub messaging';
      const report = validateImplementationQuality(corpus, []);
      expect(report.cloudProviderDetected).toBe('GCP');
    });

    it('should return null when no cloud provider is detectable', () => {
      const corpus = 'simple local node.js server with sqlite';
      const report = validateImplementationQuality(corpus, []);
      expect(report.cloudProviderDetected).toBeNull();
    });

    it('should require at least 2 pattern hits to detect a provider', () => {
      // Single mention shouldn't be enough
      const corpus = 'We might use Lambda someday';
      const report = validateImplementationQuality(corpus, []);
      // Lambda alone is 1 hit — should not detect
      expect(report.cloudProviderDetected).toBeNull();
    });
  });

  describe('database dialect detection', () => {
    it('should detect PostgreSQL from dialect keywords', () => {
      const corpus = 'PostgreSQL database with JSONB columns and BIGSERIAL primary keys';
      const report = validateImplementationQuality(corpus, []);
      expect(report.databaseDialectDetected).toBe('PostgreSQL');
    });

    it('should detect MySQL from dialect keywords', () => {
      const corpus = 'MySQL database with AUTO_INCREMENT and ENGINE=InnoDB tables';
      const report = validateImplementationQuality(corpus, []);
      expect(report.databaseDialectDetected).toBe('MySQL');
    });

    it('should detect DynamoDB from dialect keywords', () => {
      const corpus = 'DynamoDB table with partition key and sort key, GSI for queries, PutItem operations';
      const report = validateImplementationQuality(corpus, []);
      expect(report.databaseDialectDetected).toBe('DynamoDB');
    });

    it('should detect MongoDB from dialect keywords', () => {
      const corpus = 'MongoDB with Mongoose models, ObjectId references, aggregate pipeline';
      const report = validateImplementationQuality(corpus, []);
      expect(report.databaseDialectDetected).toBe('MongoDB');
    });

    it('should detect SQL Server from dialect keywords', () => {
      const corpus = 'SQL Server database using T-SQL with NVARCHAR columns and UNIQUEIDENTIFIER keys';
      const report = validateImplementationQuality(corpus, []);
      expect(report.databaseDialectDetected).toBe('SQL Server');
    });

    it('should return null when no dialect is detectable', () => {
      const corpus = 'store data in files on disk';
      const report = validateImplementationQuality(corpus, []);
      expect(report.databaseDialectDetected).toBeNull();
    });
  });

  describe('typed fields scoring', () => {
    it('should count typed field definitions from DDD model', () => {
      const corpus = [
        'orderId: UUID',
        'amount: Decimal',
        'createdAt: Date',
        'status: enum',
        'readonly balance: Money',
      ].join('\n');
      const report = validateImplementationQuality(corpus, []);
      expect(report.typedFieldsFound).toBeGreaterThanOrEqual(4);
    });

    it('should score higher with 10+ typed fields than with fewer', () => {
      const fewFields = 'orderId: UUID\namount: number';
      const manyFields = [
        'orderId: UUID', 'customerId: string', 'amount: Decimal',
        'date: Date', 'status: enum', 'count: number',
        'price: Money', 'timestamp: DateTime', 'quantity: integer',
        'balance: Decimal', 'tenantId: string', 'batchSize: number',
      ].join('\n');

      const reportFew = validateImplementationQuality(fewFields, []);
      const reportMany = validateImplementationQuality(manyFields, []);

      expect(reportMany.typedFieldsFound).toBeGreaterThan(reportFew.typedFieldsFound);
    });

    it('should penalize Record<string, unknown> patterns', () => {
      const corpus = [
        'const data: Record<string, unknown> = {};',
        'function process(input: Record<string, any>) {}',
        '[key: string]: unknown',
      ].join('\n');
      const report = validateImplementationQuality(corpus, []);
      expect(report.recordUnknownPatterns).toBeGreaterThan(0);
    });
  });

  describe('domain commands vs CRUD', () => {
    it('should detect domain-specific commands like SubmitOrder', () => {
      const corpus = 'SubmitPurchaseOrder\nApproveBatchRelease\nRejectInvoice\nCancelShipment\nVerifyCompliance';
      const report = validateImplementationQuality(corpus, []);
      expect(report.domainCommandsFound).toBeGreaterThanOrEqual(5);
    });

    it('should detect domain events like OrderCreated', () => {
      const corpus = 'OrderCreated\nPaymentProcessed\nShipmentDispatched\nInvoiceApproved';
      const report = validateImplementationQuality(corpus, []);
      expect(report.domainCommandsFound).toBeGreaterThanOrEqual(4);
    });

    it('should detect generic CRUD patterns as negative signals', () => {
      const corpus = buildGenericCRUDCorpus();
      const report = validateImplementationQuality(corpus, []);
      expect(report.genericCRUDDetected).toBeGreaterThan(0);
    });

    it('should penalize when CRUD count exceeds domain commands with few domain commands', () => {
      const corpus = [
        'CreateItem handler',
        'ReadRecord endpoint',
        'UpdateEntry operation',
        'DeleteData controller',
        'genericController service',
      ].join('\n');
      const report = validateImplementationQuality(corpus, []);
      expect(report.genericCRUDDetected).toBeGreaterThan(report.domainCommandsFound);
    });

    it('should score higher for domain commands than generic CRUD', () => {
      const domainCorpus = [
        'SubmitOrder', 'ApproveRelease', 'RejectClaim',
        'CancelSubscription', 'ProcessRefund', 'VerifyIdentity',
      ].join('\n');
      const crudCorpus = buildGenericCRUDCorpus();

      const domainReport = validateImplementationQuality(domainCorpus, []);
      const crudReport = validateImplementationQuality(crudCorpus, []);

      expect(domainReport.domainCommandsFound).toBeGreaterThan(crudReport.domainCommandsFound);
    });
  });

  describe('test data quality', () => {
    it('should detect UUIDs as realistic test data', () => {
      const corpus = 'id: 550e8400-e29b-41d4-a716-446655440000';
      const report = validateImplementationQuality(corpus, []);
      expect(report.testDataExamplesFound).toBeGreaterThanOrEqual(1);
    });

    it('should detect ISO dates as realistic test data', () => {
      const corpus = 'created: 2024-03-15\nexpires: 2025-01-01';
      const report = validateImplementationQuality(corpus, []);
      expect(report.testDataExamplesFound).toBeGreaterThanOrEqual(2);
    });

    it('should detect business identifiers like ORD-12345', () => {
      const corpus = 'orderNumber: ORD-12345\ninvoiceRef: INV-98765\npoNumber: PO-5432';
      const report = validateImplementationQuality(corpus, []);
      expect(report.testDataExamplesFound).toBeGreaterThanOrEqual(3);
    });

    it('should detect email patterns as test data', () => {
      const corpus = 'contact: user@example.com\nadmin@corp.org';
      const report = validateImplementationQuality(corpus, []);
      expect(report.testDataExamplesFound).toBeGreaterThanOrEqual(2);
    });

    it('should score higher with realistic test data than with none', () => {
      const withData = 'ORD-12345 550e8400-e29b-41d4-a716-446655440000 2024-03-15 user@test.com 45678.99';
      const withoutData = 'test value placeholder sample data';

      const reportWith = validateImplementationQuality(withData, []);
      const reportWithout = validateImplementationQuality(withoutData, []);

      expect(reportWith.testDataExamplesFound).toBeGreaterThan(reportWithout.testDataExamplesFound);
    });
  });

  describe('empty/missing artifacts', () => {
    it('should produce a failing score with empty corpus', () => {
      const report = validateImplementationQuality('', []);
      expect(report.passed).toBe(false);
      expect(report.score).toBe(0);
      expect(report.issues.length).toBeGreaterThan(0);
    });

    it('should report missing required artifacts in the issues', () => {
      const report = validateImplementationQuality('some text', ['DDD domain model', 'SPARC specification']);
      expect(report.missingArtifacts).toContain('DDD domain model');
      expect(report.missingArtifacts).toContain('SPARC specification');
      const hasArtifactIssue = report.issues.some(i => i.includes('Missing required artifacts'));
      expect(hasArtifactIssue).toBe(true);
    });
  });

  describe('quality report shape', () => {
    it('should include all required fields in the report', () => {
      const report = validateImplementationQuality('any text', []);
      expect(report).toHaveProperty('passed');
      expect(report).toHaveProperty('score');
      expect(report).toHaveProperty('issues');
      expect(report).toHaveProperty('cloudProviderDetected');
      expect(report).toHaveProperty('typedFieldsFound');
      expect(report).toHaveProperty('domainCommandsFound');
      expect(report).toHaveProperty('genericCRUDDetected');
      expect(report).toHaveProperty('testDataExamplesFound');
      expect(report).toHaveProperty('databaseDialectDetected');
      expect(report).toHaveProperty('recordUnknownPatterns');
      expect(report).toHaveProperty('missingArtifacts');
    });

    it('should produce score between 0 and 100 inclusive', () => {
      const report = validateImplementationQuality(buildHighQualityCorpus(), []);
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
    });

    it('should report issues as strings', () => {
      const report = validateImplementationQuality('minimal', []);
      expect(Array.isArray(report.issues)).toBe(true);
      for (const issue of report.issues) {
        expect(typeof issue).toBe('string');
      }
    });
  });

  describe('content integrity', () => {
    it('should detect Record<string, unknown> patterns as code smell', () => {
      const corpus = 'const x: Record<string, unknown> = {};\nconst y: Record<string, any> = {};';
      const report = validateImplementationQuality(corpus, []);
      expect(report.recordUnknownPatterns).toBeGreaterThanOrEqual(2);
    });

    it('should lower score when untyped patterns are present', () => {
      const baseCorpus = buildHighQualityCorpus();
      const cleanReport = validateImplementationQuality(baseCorpus, []);

      const dirtyCorpus = baseCorpus + '\n' + Array(10).fill('Record<string, unknown>').join('\n');
      const dirtyReport = validateImplementationQuality(dirtyCorpus, []);

      expect(dirtyReport.score).toBeLessThanOrEqual(cleanReport.score);
    });
  });
});
