/**
 * Role Permissions
 *
 * Lookup table for role-based access control.
 * Three roles: owner, admin, member.
 * Permissions enforced server-side.
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

const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    'plan:read', 'plan:create', 'plan:delete', 'plan:approve',
    'simulate:read', 'simulate:create', 'simulate:run', 'simulate:delete',
    'deploy:read', 'deploy:create', 'deploy:run', 'deploy:rollback',
    'export:read', 'export:create',
    'policy:read', 'policy:create', 'policy:edit', 'policy:delete',
    'org:read', 'org:manage',
    'usage:read', 'usage:reset',
  ]),
  admin: new Set<Permission>([
    'plan:read', 'plan:create', 'plan:delete', 'plan:approve',
    'simulate:read', 'simulate:create', 'simulate:run', 'simulate:delete',
    'deploy:read', 'deploy:create', 'deploy:run', 'deploy:rollback',
    'export:read', 'export:create',
    'policy:read', 'policy:create', 'policy:edit', 'policy:delete',
    'org:read',
    'usage:read',
  ]),
  member: new Set<Permission>([
    'plan:read', 'plan:create',
    'simulate:read', 'simulate:create', 'simulate:run',
    'deploy:read',
    'export:read', 'export:create',
    'policy:read',
    'org:read',
    'usage:read',
  ]),
};

export function hasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function getPermissions(role: OrgRole): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role] ?? new Set();
}
