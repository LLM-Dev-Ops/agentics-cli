/**
 * Error Handling Unit Tests
 *
 * SPARC Architecture Reference: §2.7
 * Tests error classes and handler
 */

import {
  CLIError,
  ValidationError,
  ServiceError,
  ContractViolationError,
  ConfigError,
  AuthError,
  ErrorHandler,
  errorHandler,
} from '../../../src/errors/index.js';

describe('Error Classes', () => {
  describe('CLIError', () => {
    it('should create base error with all fields', () => {
      const error = new CLIError({
        code: 'TEST-001',
        category: 'INPUT_ERROR',
        message: 'Test message',
        module: 'test',
        correlationId: 'corr-123',
        recoverable: true,
        exitCode: 100,
      });

      expect(error.code).toBe('TEST-001');
      expect(error.category).toBe('INPUT_ERROR');
      expect(error.message).toBe('Test message');
      expect(error.module).toBe('test');
      expect(error.correlationId).toBe('corr-123');
      expect(error.recoverable).toBe(true);
      expect(error.exitCode).toBe(100);
      expect(error.timestamp).toBeDefined();
    });

    it('should convert to ErrorInfo', () => {
      const error = new CLIError({
        code: 'TEST-001',
        category: 'INPUT_ERROR',
        message: 'Test message',
        module: 'test',
      });

      const info = error.toErrorInfo();

      expect(info.code).toBe('TEST-001');
      expect(info.category).toBe('INPUT_ERROR');
      expect(info.message).toBe('Test message');
      expect(info.module).toBe('test');
    });
  });

  describe('ValidationError', () => {
    it('should create validation error', () => {
      const error = new ValidationError({
        message: 'Invalid input',
        field: 'timeout',
        expected: 'number',
        actual: 'string',
      });

      expect(error.code).toBe('ECLI-ARG-002');
      expect(error.category).toBe('INPUT_ERROR');
      expect(error.exitCode).toBe(100);
    });
  });

  describe('ServiceError', () => {
    it('should create unavailable error', () => {
      const error = new ServiceError({
        service: 'test-service',
        operation: 'test-op',
        type: 'unavailable',
      });

      expect(error.code).toBe('ECLI-SVC-001');
      expect(error.exitCode).toBe(69);
    });

    it('should create timeout error', () => {
      const error = new ServiceError({
        service: 'test-service',
        operation: 'test-op',
        type: 'timeout',
      });

      expect(error.code).toBe('ECLI-NET-002');
      expect(error.exitCode).toBe(75);
    });

    it('should create internal error', () => {
      const error = new ServiceError({
        service: 'test-service',
        operation: 'test-op',
        type: 'internal_error',
      });

      expect(error.code).toBe('ECLI-SVC-002');
      expect(error.exitCode).toBe(140);
    });
  });

  describe('ContractViolationError', () => {
    it('should create contract violation error', () => {
      const error = new ContractViolationError({
        service: 'test-service',
        expectedContract: 'PlanResponse',
        actualResponse: { unexpected: 'data' },
        violationType: 'schema_mismatch',
      });

      expect(error.code).toBe('ECLI-SVC-003');
      expect(error.violation.service).toBe('test-service');
      expect(error.violation.violation_type).toBe('schema_mismatch');
    });
  });

  describe('ConfigError', () => {
    it('should create config error', () => {
      const error = new ConfigError({
        message: 'Config not found',
        configPath: '/path/to/config',
      });

      expect(error.code).toBe('ECLI-CFG-002');
      expect(error.exitCode).toBe(78);
    });
  });

  describe('AuthError', () => {
    it('should create auth error', () => {
      const error = new AuthError({
        type: 'missing',
        message: 'No token provided',
      });

      expect(error.code).toBe('ECLI-AUTH-001');
      expect(error.exitCode).toBe(77);
    });
  });
});

describe('ErrorHandler', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = new ErrorHandler();
  });

  describe('handle', () => {
    it('should handle CLIError', () => {
      const error = new ValidationError({ message: 'Test' });
      const info = handler.handle(error, { command: 'test' });

      expect(info.code).toBe('ECLI-ARG-002');
    });

    it('should handle unknown errors', () => {
      const error = new Error('Unknown error');
      const info = handler.handle(error, { command: 'test', correlationId: 'test-id' });

      expect(info.code).toBe('ECLI-INT-001');
      expect(info.category).toBe('INTERNAL_ERROR');
      expect(info.correlationId).toBe('test-id');
    });
  });

  describe('format', () => {
    it('should format as JSON', () => {
      const info = {
        code: 'TEST-001',
        category: 'INPUT_ERROR' as const,
        message: 'Test',
        timestamp: '2024-01-01T00:00:00Z',
        module: 'test',
      };

      const result = handler.format(info, { format: 'json' });
      const parsed = JSON.parse(result);

      expect(parsed.code).toBe('TEST-001');
    });

    it('should format as text', () => {
      const info = {
        code: 'TEST-001',
        category: 'INPUT_ERROR' as const,
        message: 'Test message',
        timestamp: '2024-01-01T00:00:00Z',
        module: 'test',
      };

      const result = handler.format(info, { format: 'text' });

      expect(result).toContain('TEST-001');
      expect(result).toContain('Test message');
    });
  });
});

describe('errorHandler singleton', () => {
  it('should be an instance of ErrorHandler', () => {
    expect(errorHandler).toBeInstanceOf(ErrorHandler);
  });
});
