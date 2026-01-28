/**
 * Identity Resolution
 *
 * Deterministic identity derivation from API key.
 * user_id = "usr_" + sha256(api_key).slice(0, 16)
 * org_id  = "org_" + sha256(user_id).slice(0, 16)
 */

import * as crypto from 'node:crypto';
import type { Attribution, IdentityContext } from '../types/index.js';

export function deriveUserId(apiKey: string): string {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  return `usr_${hash.slice(0, 16)}`;
}

export function deriveOrgId(userId: string): string {
  const hash = crypto.createHash('sha256').update(userId).digest('hex');
  return `org_${hash.slice(0, 16)}`;
}

/**
 * Build a full IdentityContext from an API key.
 * Role defaults to 'owner' (key holder owns their default org).
 */
export function resolveIdentityFromKey(apiKey: string, email?: string): IdentityContext {
  const user_id = deriveUserId(apiKey);
  const org_id = deriveOrgId(user_id);
  const now = new Date().toISOString();

  return {
    user: {
      user_id,
      display_name: email ?? 'key_user',
      created_at: now,
    },
    org: {
      org_id,
      org_name: 'default',
      created_at: now,
    },
    role: 'owner',
    resolved_at: now,
  };
}

/**
 * Resolve attribution (created_by + org_id) from cached identity or credentials.
 * Returns 'unknown' fields if neither is available.
 */
export async function resolveAttribution(): Promise<Attribution> {
  // Lazy import to avoid circular deps
  const { createIdentityStore } = await import('../utils/identity-store.js');
  const { createCredentialStore } = await import('../utils/credentials.js');

  const identityStore = createIdentityStore();
  const identity = await identityStore.load();

  if (identity) {
    return {
      created_by: identity.user.user_id,
      org_id: identity.org.org_id,
    };
  }

  // Fallback: derive from credentials
  const credStore = createCredentialStore();
  const creds = await credStore.load();
  if (creds?.api_key) {
    const userId = deriveUserId(creds.api_key);
    return {
      created_by: userId,
      org_id: deriveOrgId(userId),
    };
  }

  return { created_by: 'unknown', org_id: 'unknown' };
}
