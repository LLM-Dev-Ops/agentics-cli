/**
 * Endpoint Configuration Tests
 *
 * Verifies the localhost safeguard implementation:
 * 1. isLocalhostUrl correctly identifies localhost patterns
 * 2. isLocalDevMode correctly detects AGENTICS_LOCAL_DEV
 * 3. validateEndpointUrl throws when localhost is used without local dev mode
 * 4. Production defaults resolve to Cloud Run URLs
 */

import {
  isLocalhostUrl,
  isLocalDevMode,
  validateEndpointUrl,
  LocalhostInProductionError,
  DEFAULT_ENDPOINTS,
} from '../../../src/config/endpoints.js';

describe('Endpoint Configuration', () => {
  // Store original env vars
  const originalLocalDev = process.env['AGENTICS_LOCAL_DEV'];

  beforeEach(() => {
    // Ensure local dev mode is off by default
    delete process.env['AGENTICS_LOCAL_DEV'];
  });

  afterEach(() => {
    // Restore original value
    if (originalLocalDev !== undefined) {
      process.env['AGENTICS_LOCAL_DEV'] = originalLocalDev;
    } else {
      delete process.env['AGENTICS_LOCAL_DEV'];
    }
  });

  // ============================================================================
  // isLocalhostUrl Tests
  // ============================================================================

  describe('isLocalhostUrl', () => {
    it('should detect "localhost" as localhost', () => {
      expect(isLocalhostUrl('http://localhost:8080')).toBe(true);
      expect(isLocalhostUrl('https://localhost:443')).toBe(true);
      expect(isLocalhostUrl('http://localhost')).toBe(true);
    });

    it('should detect "127.0.0.1" as localhost', () => {
      expect(isLocalhostUrl('http://127.0.0.1:8080')).toBe(true);
      expect(isLocalhostUrl('https://127.0.0.1:443')).toBe(true);
      expect(isLocalhostUrl('http://127.0.0.1')).toBe(true);
    });

    it('should detect "127.x.x.x" patterns as localhost', () => {
      expect(isLocalhostUrl('http://127.0.0.2:8080')).toBe(true);
      expect(isLocalhostUrl('http://127.255.255.255')).toBe(true);
    });

    it('should detect "::1" (IPv6 localhost) as localhost', () => {
      expect(isLocalhostUrl('http://[::1]:8080')).toBe(true);
    });

    it('should detect "*.localhost" subdomains as localhost', () => {
      expect(isLocalhostUrl('http://api.localhost:8080')).toBe(true);
      expect(isLocalhostUrl('http://dev.localhost')).toBe(true);
    });

    it('should NOT detect production URLs as localhost', () => {
      expect(isLocalhostUrl('https://agentics-simulation-1062287243982.us-central1.run.app')).toBe(false);
      expect(isLocalhostUrl('https://api.agentics.dev')).toBe(false);
      expect(isLocalhostUrl('https://platform.agentics.dev')).toBe(false);
    });

    it('should NOT detect other IP addresses as localhost', () => {
      expect(isLocalhostUrl('http://192.168.1.1:8080')).toBe(false);
      expect(isLocalhostUrl('http://10.0.0.1:8080')).toBe(false);
      expect(isLocalhostUrl('http://8.8.8.8')).toBe(false);
    });
  });

  // ============================================================================
  // isLocalDevMode Tests
  // ============================================================================

  describe('isLocalDevMode', () => {
    it('should return false when AGENTICS_LOCAL_DEV is not set', () => {
      delete process.env['AGENTICS_LOCAL_DEV'];
      expect(isLocalDevMode()).toBe(false);
    });

    it('should return true when AGENTICS_LOCAL_DEV is "true"', () => {
      process.env['AGENTICS_LOCAL_DEV'] = 'true';
      expect(isLocalDevMode()).toBe(true);
    });

    it('should return true when AGENTICS_LOCAL_DEV is "1"', () => {
      process.env['AGENTICS_LOCAL_DEV'] = '1';
      expect(isLocalDevMode()).toBe(true);
    });

    it('should return false for other values', () => {
      process.env['AGENTICS_LOCAL_DEV'] = 'false';
      expect(isLocalDevMode()).toBe(false);

      process.env['AGENTICS_LOCAL_DEV'] = '0';
      expect(isLocalDevMode()).toBe(false);

      process.env['AGENTICS_LOCAL_DEV'] = 'yes';
      expect(isLocalDevMode()).toBe(false);

      process.env['AGENTICS_LOCAL_DEV'] = '';
      expect(isLocalDevMode()).toBe(false);
    });
  });

  // ============================================================================
  // validateEndpointUrl Tests
  // ============================================================================

  describe('validateEndpointUrl', () => {
    it('should throw LocalhostInProductionError for localhost without local dev mode', () => {
      delete process.env['AGENTICS_LOCAL_DEV'];

      expect(() => {
        validateEndpointUrl('test-service', 'http://localhost:8080');
      }).toThrow(LocalhostInProductionError);
    });

    it('should throw LocalhostInProductionError for 127.0.0.1 without local dev mode', () => {
      delete process.env['AGENTICS_LOCAL_DEV'];

      expect(() => {
        validateEndpointUrl('test-service', 'http://127.0.0.1:8080');
      }).toThrow(LocalhostInProductionError);
    });

    it('should NOT throw for localhost when AGENTICS_LOCAL_DEV=true', () => {
      process.env['AGENTICS_LOCAL_DEV'] = 'true';

      expect(() => {
        validateEndpointUrl('test-service', 'http://localhost:8080');
      }).not.toThrow();
    });

    it('should NOT throw for production URLs', () => {
      delete process.env['AGENTICS_LOCAL_DEV'];

      expect(() => {
        validateEndpointUrl('test-service', 'https://api.agentics.dev');
      }).not.toThrow();
    });

    it('should include service name and URL in error', () => {
      delete process.env['AGENTICS_LOCAL_DEV'];

      try {
        validateEndpointUrl('my-service', 'http://localhost:9000');
        throw new Error('Expected LocalhostInProductionError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(LocalhostInProductionError);
        const e = error as LocalhostInProductionError;
        expect(e.serviceName).toBe('my-service');
        expect(e.url).toBe('http://localhost:9000');
        expect(e.message).toContain('my-service');
        expect(e.message).toContain('http://localhost:9000');
      }
    });
  });

  // ============================================================================
  // Production Defaults Tests
  // ============================================================================

  describe('Production Defaults', () => {
    it('should have Cloud Run URLs for all default endpoints', () => {
      // Verify all endpoints default to Cloud Run URLs
      const cloudRunPattern = /^https:\/\/agentics-.*\.us-central1\.run\.app$/;

      for (const [_serviceName, config] of Object.entries(DEFAULT_ENDPOINTS)) {
        expect(config.baseUrl).toMatch(cloudRunPattern);
      }
    });

    it('should have all required services configured', () => {
      const requiredServices = [
        'agentics-org-manifests',
        'agentics-simulation-planner',
        'agentics-simulation-runner',
        'agentics-simulation-engine',
        'enterprise-roi-engine',
        'agentics-deployment-intent',
        'agentics-deployment-exporters',
        'diligence-artifacts',
      ];

      for (const service of requiredServices) {
        expect(DEFAULT_ENDPOINTS).toHaveProperty(service);
      }
    });

    it('should have HTTPS URLs for security', () => {
      for (const [_serviceName, config] of Object.entries(DEFAULT_ENDPOINTS)) {
        expect(config.baseUrl.startsWith('https://')).toBe(true);
      }
    });
  });
});
