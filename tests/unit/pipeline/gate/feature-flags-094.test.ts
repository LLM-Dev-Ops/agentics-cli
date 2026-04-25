/**
 * ADR-PIPELINE-094 — Feature flag tests.
 *
 * Verifies the env-var escape hatch (`AGENTICS_DISABLE_094`) and the
 * default-enabled behaviour. The flag does not gate the gate's path
 * resolution (always-on, backwards compatible), but it documents the
 * single switch an operator can use to revert to ADR-093 behaviour.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { is094Enabled, shouldUse094 } from '../../../../src/pipeline/gate/feature-flags.js';

describe('ADR-094 feature flag', () => {
  const KEY = 'AGENTICS_DISABLE_094';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('is enabled by default', () => {
    delete process.env[KEY];
    expect(is094Enabled()).toBe(true);
    expect(shouldUse094()).toBe(true);
  });

  it('respects AGENTICS_DISABLE_094=1 as opt-out', () => {
    process.env[KEY] = '1';
    expect(is094Enabled()).toBe(false);
  });

  it('respects AGENTICS_DISABLE_094=true as opt-out', () => {
    process.env[KEY] = 'true';
    expect(is094Enabled()).toBe(false);
  });

  it('treats other values (e.g. "0", "false") as enabled', () => {
    process.env[KEY] = '0';
    expect(is094Enabled()).toBe(true);
    process.env[KEY] = 'false';
    expect(is094Enabled()).toBe(true);
    process.env[KEY] = 'no';
    expect(is094Enabled()).toBe(true);
  });
});
