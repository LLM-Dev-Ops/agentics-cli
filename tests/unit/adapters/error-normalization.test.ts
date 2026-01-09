/**
 * Error Normalization Tests
 *
 * Verifies that upstream error payloads are normalized to human-readable messages.
 * Ensures [object Object] never appears in any error message.
 */

import { normalizeUpstreamError, safeStringify } from '../../../src/adapters/base-adapter.js';

describe('normalizeUpstreamError', () => {
  // ============================================================================
  // Primitive Types
  // ============================================================================

  describe('primitive types', () => {
    it('should handle null', () => {
      const result = normalizeUpstreamError(null);
      expect(result.message).toBe('No error details provided');
      expect(result.message).not.toContain('[object Object]');
    });

    it('should handle undefined', () => {
      const result = normalizeUpstreamError(undefined);
      expect(result.message).toBe('No error details provided');
    });

    it('should handle string messages', () => {
      const result = normalizeUpstreamError('Something went wrong');
      expect(result.message).toBe('Something went wrong');
    });

    it('should handle empty string', () => {
      const result = normalizeUpstreamError('');
      expect(result.message).toBe('Empty error response');
    });

    it('should trim whitespace from strings', () => {
      const result = normalizeUpstreamError('  error message  ');
      expect(result.message).toBe('error message');
    });

    it('should handle numbers', () => {
      const result = normalizeUpstreamError(500);
      expect(result.message).toBe('500');
    });

    it('should handle booleans', () => {
      const result = normalizeUpstreamError(false);
      expect(result.message).toBe('false');
    });
  });

  // ============================================================================
  // Object with message field
  // ============================================================================

  describe('object with message field', () => {
    it('should extract message from { message: "..." }', () => {
      const result = normalizeUpstreamError({ message: 'Database connection failed' });
      expect(result.message).toBe('Database connection failed');
    });

    it('should extract message from { error: "..." }', () => {
      const result = normalizeUpstreamError({ error: 'Authentication failed' });
      expect(result.message).toBe('Authentication failed');
    });

    it('should extract message from { detail: "..." }', () => {
      const result = normalizeUpstreamError({ detail: 'Invalid request format' });
      expect(result.message).toBe('Invalid request format');
    });

    it('should extract message from { reason: "..." }', () => {
      const result = normalizeUpstreamError({ reason: 'Rate limit exceeded' });
      expect(result.message).toBe('Rate limit exceeded');
    });

    it('should prefer message over other fields', () => {
      const result = normalizeUpstreamError({
        message: 'Primary message',
        error: 'Secondary error',
        detail: 'Tertiary detail',
      });
      expect(result.message).toBe('Primary message');
    });
  });

  // ============================================================================
  // Nested error objects
  // ============================================================================

  describe('nested error objects', () => {
    it('should handle { error: { message: "..." } }', () => {
      const result = normalizeUpstreamError({
        error: { message: 'Nested error message' },
      });
      expect(result.message).toBe('Nested error message');
    });

    it('should handle deeply nested errors', () => {
      const result = normalizeUpstreamError({
        error: { detail: { message: 'Deep nested message' } },
      });
      expect(result.message).toBe('Deep nested message');
    });

    it('should handle { message: { text: "..." } } by stringifying', () => {
      const result = normalizeUpstreamError({
        message: { text: 'Structured message' },
      });
      expect(result.message).toContain('Structured message');
      expect(result.message).not.toContain('[object Object]');
    });
  });

  // ============================================================================
  // Error codes and trace IDs
  // ============================================================================

  describe('error codes and trace IDs', () => {
    it('should extract and prepend error code', () => {
      const result = normalizeUpstreamError({
        code: 'ERR_001',
        message: 'Something failed',
      });
      expect(result.message).toBe('[ERR_001] Something failed');
      expect(result.code).toBe('ERR_001');
    });

    it('should not duplicate code if already in message', () => {
      const result = normalizeUpstreamError({
        code: 'ERR_001',
        message: 'ERR_001: Something failed',
      });
      expect(result.message).toBe('ERR_001: Something failed');
    });

    it('should extract trace_id', () => {
      const result = normalizeUpstreamError({
        message: 'Error',
        trace_id: 'abc-123',
      });
      expect(result.upstreamTraceId).toBe('abc-123');
    });

    it('should extract correlationId', () => {
      const result = normalizeUpstreamError({
        message: 'Error',
        correlationId: 'xyz-789',
      });
      expect(result.upstreamTraceId).toBe('xyz-789');
    });

    it('should extract request_id', () => {
      const result = normalizeUpstreamError({
        message: 'Error',
        request_id: 'req-456',
      });
      expect(result.upstreamTraceId).toBe('req-456');
    });
  });

  // ============================================================================
  // Arrays
  // ============================================================================

  describe('arrays', () => {
    it('should handle empty array', () => {
      const result = normalizeUpstreamError([]);
      expect(result.message).toBe('Empty error array');
    });

    it('should join messages from array of strings', () => {
      const result = normalizeUpstreamError(['Error 1', 'Error 2', 'Error 3']);
      expect(result.message).toBe('Error 1; Error 2; Error 3');
    });

    it('should extract messages from array of objects', () => {
      const result = normalizeUpstreamError([
        { message: 'First error' },
        { message: 'Second error' },
      ]);
      expect(result.message).toBe('First error; Second error');
    });

    it('should limit array messages to 5 items', () => {
      const result = normalizeUpstreamError([
        'Err 1', 'Err 2', 'Err 3', 'Err 4', 'Err 5', 'Err 6', 'Err 7',
      ]);
      expect(result.message).toBe('Err 1; Err 2; Err 3; Err 4; Err 5');
    });
  });

  // ============================================================================
  // Objects without known fields
  // ============================================================================

  describe('objects without known fields', () => {
    it('should stringify unknown object structure', () => {
      const result = normalizeUpstreamError({ foo: 'bar', baz: 123 });
      expect(result.message).toContain('foo');
      expect(result.message).toContain('bar');
      expect(result.message).not.toContain('[object Object]');
    });

    it('should handle object with only status field', () => {
      const result = normalizeUpstreamError({ status: 500 });
      expect(result.message).toBe('HTTP error 500');
    });

    it('should handle object with status and code', () => {
      const result = normalizeUpstreamError({ status: 400, code: 'BAD_REQUEST' });
      expect(result.message).toContain('400');
      expect(result.code).toBe('BAD_REQUEST');
      expect(result.message).not.toContain('[object Object]');
    });

    it('should handle object with only code', () => {
      const result = normalizeUpstreamError({ code: 'INTERNAL_ERROR' });
      expect(result.code).toBe('INTERNAL_ERROR');
      expect(result.message).not.toContain('[object Object]');
    });

    it('should handle empty object', () => {
      const result = normalizeUpstreamError({});
      expect(result.message).toBe('{}');
      expect(result.message).not.toContain('[object Object]');
    });
  });

  // ============================================================================
  // Never produces [object Object]
  // ============================================================================

  describe('never produces [object Object]', () => {
    const testCases = [
      { input: {}, name: 'empty object' },
      { input: { foo: {} }, name: 'nested empty object' },
      { input: { message: {} }, name: 'message is empty object' },
      { input: { error: { nested: {} } }, name: 'deeply nested empty object' },
      { input: [{}], name: 'array with empty object' },
      { input: { a: { b: { c: {} } } }, name: 'triple nested object' },
      { input: { message: { code: { value: {} } } }, name: 'complex nested structure' },
    ];

    testCases.forEach(({ input, name }) => {
      it(`should not produce [object Object] for ${name}`, () => {
        const result = normalizeUpstreamError(input);
        expect(result.message).not.toContain('[object Object]');
      });
    });
  });
});

describe('safeStringify', () => {
  it('should stringify simple objects', () => {
    const result = safeStringify({ foo: 'bar' });
    expect(result).toBe('{"foo":"bar"}');
  });

  it('should truncate long strings', () => {
    const longObject = { data: 'x'.repeat(1000) };
    const result = safeStringify(longObject, 100);
    expect(result.length).toBeLessThanOrEqual(120); // 100 + "... (truncated)"
    expect(result).toContain('... (truncated)');
  });

  it('should handle circular references gracefully', () => {
    const circular: Record<string, unknown> = { foo: 'bar' };
    circular['self'] = circular;
    const result = safeStringify(circular);
    expect(result).toContain('foo');
    expect(result).not.toContain('[object Object]');
  });

  it('should describe empty objects', () => {
    // This tests the catch path with an empty object that somehow fails
    // In practice, {} won't fail, but we verify the fallback message
    expect(safeStringify({})).toBe('{}');
  });
});
