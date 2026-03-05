/**
 * Healthcare supply-chain RBAC access-control module.
 * Provides role extraction, route-level permission checks, and Hono middleware.
 */
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';

export type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN' | 'AUDITOR';

export const ROLE_HIERARCHY: Record<Role, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  AUDITOR: 2,
  ADMIN: 3,
} as const;

export interface RoutePermission {
  readonly method: string;
  readonly pathPattern: RegExp;
  readonly minRole: Role;
  readonly description: string;
}

const ROUTE_PERMISSIONS: readonly RoutePermission[] = [
  { method: 'GET', pathPattern: /^\/api\/v1\/audit(\/|$)/, minRole: 'AUDITOR', description: 'audit trail access' },
  { method: 'POST', pathPattern: /^\/api\/v1\/inventory(\/|$)/, minRole: 'OPERATOR', description: 'inventory operations' },
  { method: 'POST', pathPattern: /^\/api\/v1\/transfers(\/|$)/, minRole: 'OPERATOR', description: 'transfer operations' },
  { method: 'POST', pathPattern: /^\/api\/v1\/procurement(\/|$)/, minRole: 'OPERATOR', description: 'procurement operations' },
  { method: 'POST', pathPattern: /^\/api\/v1\/risk\/scan$/, minRole: 'OPERATOR', description: 'risk scan' },
  { method: 'POST', pathPattern: /^\/api\/v1\/risk\/alerts\/[^/]+\/resolve$/, minRole: 'OPERATOR', description: 'resolve risk alert' },
  { method: 'POST', pathPattern: /^\/api\/v1\/risk\/recommendations\/[^/]+\/execute$/, minRole: 'OPERATOR', description: 'execute risk recommendation' },
  { method: 'POST', pathPattern: /^\/api\/v1\/forecasts(\/|$)/, minRole: 'OPERATOR', description: 'forecast operations' },
  { method: 'GET', pathPattern: /^\/api\/v1(\/|$)/, minRole: 'VIEWER', description: 'all reads' },
  { method: 'PUT', pathPattern: /^\/api\/v1(\/|$)/, minRole: 'ADMIN', description: 'config changes' },
  { method: 'DELETE', pathPattern: /^\/api\/v1(\/|$)/, minRole: 'ADMIN', description: 'deletions' },
] as const;

const VALID_ROLES = new Set<string>(['VIEWER', 'OPERATOR', 'ADMIN', 'AUDITOR']);

function isValidRole(value: unknown): value is Role {
  return typeof value === 'string' && VALID_ROLES.has(value);
}

function highestRole(roles: unknown[]): Role | undefined {
  let best: Role | undefined;
  let bestLevel = 0;
  for (const r of roles) {
    if (isValidRole(r) && ROLE_HIERARCHY[r] > bestLevel) {
      best = r;
      bestLevel = ROLE_HIERARCHY[r];
    }
  }
  return best;
}

export function extractRole(iamClaims: unknown): Role {
  if (iamClaims === null || iamClaims === undefined || typeof iamClaims !== 'object') {
    return 'VIEWER';
  }

  const claims = iamClaims as Record<string, unknown>;

  if (isValidRole(claims['role'])) {
    return claims['role'];
  }

  if (Array.isArray(claims['roles'])) {
    const found = highestRole(claims['roles']);
    if (found) return found;
  }

  if (isValidRole(claims['custom:role'])) {
    return claims['custom:role'];
  }

  return 'VIEWER';
}

export function checkAccess(
  role: Role,
  method: string,
  path: string,
): { allowed: boolean; reason?: string } {
  const upperMethod = method.toUpperCase();

  if (role === 'ADMIN') {
    return { allowed: true };
  }

  if (role === 'AUDITOR') {
    if (upperMethod === 'GET') {
      return { allowed: true };
    }
    return { allowed: false, reason: `Role AUDITOR cannot ${upperMethod} ${path}` };
  }

  for (const perm of ROUTE_PERMISSIONS) {
    if (perm.method !== upperMethod || !perm.pathPattern.test(path)) {
      continue;
    }

    if (perm.minRole === 'AUDITOR') {
      return { allowed: false, reason: `Role ${role} cannot ${upperMethod} ${path}` };
    }

    if (ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[perm.minRole]) {
      return { allowed: true };
    }

    return { allowed: false, reason: `Role ${role} cannot ${upperMethod} ${path}` };
  }

  return { allowed: true };
}

export function createAccessControlMiddleware(
  onDenied?: (
    correlationId: string,
    actor: string,
    role: Role,
    method: string,
    path: string,
  ) => Promise<void>,
): MiddlewareHandler {
  return createMiddleware(async (c, next): Promise<Response | void> => {
    if (c.req.path.startsWith('/health')) {
      await next();
      return;
    }

    const iamClaims = c.get('iamClaims' as never);
    const role = extractRole(iamClaims);
    const result = checkAccess(role, c.req.method, c.req.path);

    if (!result.allowed) {
      const correlationId = (c.get('correlationId' as never) as string) ?? crypto.randomUUID();
      const actor = (iamClaims as Record<string, unknown> | undefined)?.['sub'] as string ?? 'unknown';

      if (onDenied) {
        await onDenied(correlationId, actor, role, c.req.method, c.req.path);
      }

      return c.json(
        {
          error: { code: 'FORBIDDEN', message: result.reason },
          correlationId,
        },
        403,
      );
    }

    c.set('userRole' as never, role as never);
    await next();
  });
}
