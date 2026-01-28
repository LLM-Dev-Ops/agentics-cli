/**
 * Authentication Module
 *
 * GCP Identity-based authentication for Cloud Run services.
 * NO JWTs, NO OAuth, NO API keys - only Google identity tokens.
 */

export {
  acquireIdentityToken,
  hasValidCredentials,
  getActiveAccount,
  clearTokenCache,
  type IdentityTokenResult,
  type IdentityTokenError,
} from './gcp-identity.js';

export {
  deriveUserId,
  deriveOrgId,
  resolveIdentityFromKey,
  resolveAttribution,
} from './identity-resolver.js';

export {
  hasPermission,
  getPermissions,
  type Permission,
} from './role-permissions.js';
