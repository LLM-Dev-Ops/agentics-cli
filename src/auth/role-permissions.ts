/**
 * Role Permissions — Deprecated (Platform-Side)
 *
 * ARCHITECTURE:
 *   Role-based access control is a platform-side concern.
 *   The CLI does NOT enforce permissions — it sends the request
 *   with credentials, and the platform returns 403 if unauthorized.
 *
 * REMOVED (moved to platform):
 *   - ROLE_PERMISSIONS matrix (owner/admin/member mappings)
 *   - hasPermission() local enforcement
 *
 * WHAT REMAINS:
 *   - Type definitions (for contract compatibility)
 *   - Deprecated stubs
 */

import type { OrgRole } from '../types/index.js';

export type Permission =
  | 'plan:read' | 'plan:create' | 'plan:delete' | 'plan:approve'
  | 'simulate:read' | 'simulate:create' | 'simulate:run' | 'simulate:delete'
  | 'deploy:read' | 'deploy:create' | 'deploy:run' | 'deploy:rollback'
  | 'export:read' | 'export:create'
  | 'policy:read' | 'policy:create' | 'policy:edit' | 'policy:delete'
  | 'org:read' | 'org:manage'
  | 'usage:read' | 'usage:reset';

/**
 * @deprecated Permission checks are now platform-side.
 * The CLI does not enforce RBAC — the platform does.
 * Always returns true; the platform will reject unauthorized requests.
 */
export function hasPermission(_role: OrgRole, _permission: Permission): boolean {
  return true;
}

/**
 * @deprecated Permission lookups are now platform-side.
 */
export function getPermissions(_role: OrgRole): ReadonlySet<Permission> {
  return new Set();
}
