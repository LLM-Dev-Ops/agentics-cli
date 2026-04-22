/**
 * ADR-PIPELINE-089 §1 — transient / terminal failure classifier tests.
 *
 * The old inline substring allowlist in src/commands/agents.ts:4154-4161
 * was narrow enough that several transient signals ("unreachable", raw
 * HTTP 503/504, error.code=ECONNRESET) bailed the retry loop on attempt
 * 1. These tests lock in the widened behaviour so the classifier can't
 * silently narrow again.
 */

import { describe, it, expect } from '@jest/globals';
import { isTransientFailure, isTerminalFailure, classifyFailure } from '../../../src/errors/transient.js';

describe('isTransientFailure', () => {
  describe('message-based detection', () => {
    it('returns true for "service unreachable"', () => {
      expect(isTransientFailure(new Error('Cloud Run service unreachable'))).toBe(true);
    });

    it('returns true for "unavailable" (preserved from legacy list)', () => {
      expect(isTransientFailure(new Error('Service unavailable'))).toBe(true);
    });

    it('returns true for lowercase "timeout"', () => {
      expect(isTransientFailure(new Error('request timeout'))).toBe(true);
    });

    it('returns true for "socket hang up" (new)', () => {
      expect(isTransientFailure(new Error('socket hang up'))).toBe(true);
    });

    it('returns true for "rate limit" (new; previously only "rate exceeded")', () => {
      expect(isTransientFailure(new Error('rate limit exceeded on upstream'))).toBe(true);
    });

    it('returns false for an obviously-terminal message', () => {
      expect(isTransientFailure(new Error('contract_violation: intent_description required'))).toBe(false);
    });

    it('returns false for a raw string that has no transient keyword', () => {
      expect(isTransientFailure('agent produced empty response')).toBe(false);
    });
  });

  describe('code-based detection', () => {
    it('returns true for ECONNRESET on error.code', () => {
      const e = Object.assign(new Error('x'), { code: 'ECONNRESET' });
      expect(isTransientFailure(e)).toBe(true);
    });

    it('returns true for ETIMEDOUT on error.code', () => {
      const e = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
      expect(isTransientFailure(e)).toBe(true);
    });

    it('returns true for ENOTFOUND (DNS failure)', () => {
      const e = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
      expect(isTransientFailure(e)).toBe(true);
    });

    it('returns true for AbortError name-alike code', () => {
      const e = Object.assign(new Error('x'), { code: 'AbortError' });
      expect(isTransientFailure(e)).toBe(true);
    });
  });

  describe('HTTP status-based detection', () => {
    it('returns true for status=503', () => {
      const e = Object.assign(new Error('x'), { status: 503 });
      expect(isTransientFailure(e)).toBe(true);
    });

    it('returns true for response.status=504', () => {
      const e = Object.assign(new Error('x'), { response: { status: 504 } });
      expect(isTransientFailure(e)).toBe(true);
    });

    it('returns true when the status digits appear inside message', () => {
      expect(isTransientFailure(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    });

    it('returns true for 429 Too Many Requests', () => {
      const e = Object.assign(new Error('x'), { statusCode: 429 });
      expect(isTransientFailure(e)).toBe(true);
    });
  });

  describe('cause chain', () => {
    it('walks .cause to find a transient signal two levels deep', () => {
      const inner = Object.assign(new Error('inner'), { code: 'ECONNRESET' });
      const middle = Object.assign(new Error('middle'), { cause: inner });
      const outer = Object.assign(new Error('outer wrapper'), { cause: middle });
      expect(isTransientFailure(outer)).toBe(true);
    });
  });
});

describe('isTerminalFailure', () => {
  it('returns true for contract_violation message', () => {
    expect(isTerminalFailure(new Error('contract_violation: intent_description required'))).toBe(true);
  });

  it('returns true for 401 Unauthorized', () => {
    expect(isTerminalFailure(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
  });

  it('returns true for 403 Forbidden via response.status', () => {
    expect(isTerminalFailure(Object.assign(new Error('x'), { response: { status: 403 } }))).toBe(true);
  });

  it('returns true for 400 Bad Request', () => {
    expect(isTerminalFailure(Object.assign(new Error('x'), { status: 400 }))).toBe(true);
  });

  it('returns false for 503 (transient, not terminal)', () => {
    expect(isTerminalFailure(Object.assign(new Error('x'), { status: 503 }))).toBe(false);
  });

  it('returns false for a plain network timeout', () => {
    expect(isTerminalFailure(new Error('request timeout'))).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('returns "terminal" when error is terminal', () => {
    expect(classifyFailure(new Error('unauthorized'))).toBe('terminal');
  });

  it('returns "transient" when error is transient', () => {
    expect(classifyFailure(new Error('service unreachable'))).toBe('transient');
  });

  it('returns "unknown" when neither pattern matches', () => {
    expect(classifyFailure(new Error('agent produced empty response'))).toBe('unknown');
  });

  it('prefers "terminal" over "transient" when both-ish signals coexist', () => {
    // 401 status + message-level "timeout" keyword — still terminal.
    const e = Object.assign(new Error('request timeout during handshake'), { status: 401 });
    expect(classifyFailure(e)).toBe('terminal');
  });
});
