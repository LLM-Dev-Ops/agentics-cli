/**
 * Output Renderer Unit Tests
 *
 * SPARC Architecture Reference: §2.6
 * Tests output formatting functionality
 */

import { OutputRenderer, createOutputRenderer } from '../../../src/modules/output-renderer.js';

describe('OutputRenderer', () => {
  let renderer: OutputRenderer;

  beforeEach(() => {
    renderer = createOutputRenderer() as OutputRenderer;
  });

  describe('render', () => {
    it('should render JSON format', () => {
      const data = { name: 'test', value: 123 };
      const result = renderer.render(data, { format: 'json' });
      expect(result).toBe('{"name":"test","value":123}');
    });

    it('should render pretty JSON format', () => {
      const data = { name: 'test' };
      const result = renderer.render(data, { format: 'json', pretty: true });
      expect(result).toBe('{\n  "name": "test"\n}');
    });

    it('should render text format', () => {
      const result = renderer.render('hello', { format: 'text' });
      expect(result).toBe('hello');
    });

    it('should render table format for objects', () => {
      const data = { name: 'test', value: 123 };
      const result = renderer.render(data, { format: 'table' });
      expect(result).toContain('name: test');
      expect(result).toContain('value: 123');
    });

    it('should render CSV format for arrays', () => {
      const data = [
        { name: 'a', value: 1 },
        { name: 'b', value: 2 },
      ];
      const result = renderer.render(data, { format: 'csv' });
      expect(result).toContain('name,value');
      expect(result).toContain('a,1');
      expect(result).toContain('b,2');
    });
  });

  describe('renderReference', () => {
    it('should render reference in JSON format', () => {
      const ref = {
        id: 'ref-123',
        type: 'PlanReference' as const,
        repository: 'test',
        created_at: '2024-01-01T00:00:00Z',
        checksum: 'abc',
      };

      const result = renderer.renderReference(ref, { format: 'json' });
      const parsed = JSON.parse(result);

      expect(parsed.id).toBe('ref-123');
      expect(parsed.type).toBe('PlanReference');
    });
  });

  describe('renderError', () => {
    it('should render error in text format', () => {
      const error = {
        code: 'ECLI-TEST-001',
        category: 'INPUT_ERROR' as const,
        message: 'Test error message',
        timestamp: '2024-01-01T00:00:00Z',
        module: 'test',
      };

      const result = renderer.renderError(error, { format: 'text' });

      expect(result).toContain('ECLI-TEST-001');
      expect(result).toContain('Test error message');
    });

    it('should render error in JSON format', () => {
      const error = {
        code: 'ECLI-TEST-001',
        category: 'INPUT_ERROR' as const,
        message: 'Test error',
        timestamp: '2024-01-01T00:00:00Z',
        module: 'test',
      };

      const result = renderer.renderError(error, { format: 'json' });
      const parsed = JSON.parse(result);

      expect(parsed.code).toBe('ECLI-TEST-001');
    });
  });
});
