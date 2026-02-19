/**
 * Authentication Module
 *
 * Platform-based authentication via API keys and stored credentials.
 */

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
