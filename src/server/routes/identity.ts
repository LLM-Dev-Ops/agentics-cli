/**
 * Identity Route
 *
 * GET /v1/identity/whoami - Resolve API key into user + org + role context.
 */

import { Hono } from 'hono';
import { deriveUserId, deriveOrgId } from '../../auth/identity-resolver.js';
import { hasPermission, type Permission } from '../../auth/role-permissions.js';
import type { OrgRole } from '../../types/index.js';

const identity = new Hono();

/**
 * GET /whoami
 *
 * Resolves API key from Authorization header into full identity context.
 * Creates user + org lazily (deterministic from key).
 * Default role for key holder: owner.
 */
identity.get('/whoami', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({
        error: { code: 'AUTH_REQUIRED', message: 'Missing or invalid Authorization header' },
      }, 401);
    }

    const apiKey = authHeader.slice('Bearer '.length);
    if (!apiKey.startsWith('agentics_sk_')) {
      return c.json({
        error: { code: 'INVALID_KEY', message: 'Invalid API key format' },
      }, 401);
    }

    const user_id = deriveUserId(apiKey);
    const org_id = deriveOrgId(user_id);
    const role: OrgRole = 'owner';
    const now = new Date().toISOString();

    return c.json({
      authenticated: true,
      user: {
        user_id,
        display_name: 'key_user',
        created_at: now,
      },
      org: {
        org_id,
        org_name: 'default',
        role,
        created_at: now,
      },
      entitlement: 'paid',
      execution_enabled: true,
      resolved_at: now,
    });
  } catch (error) {
    console.error('Identity whoami error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    }, 500);
  }
});

/**
 * POST /check-permission
 *
 * Server-side permission enforcement.
 * Body: { role: OrgRole, permission: Permission }
 */
identity.post('/check-permission', async (c) => {
  try {
    const body = await c.req.json() as { role?: OrgRole; permission?: Permission };

    if (!body.role || !body.permission) {
      return c.json({
        error: { code: 'INVALID_REQUEST', message: 'Missing role or permission' },
      }, 400);
    }

    const allowed = hasPermission(body.role, body.permission);

    if (!allowed) {
      return c.json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: `Role '${body.role}' lacks permission '${body.permission}'`,
        },
        allowed: false,
      }, 403);
    }

    return c.json({ allowed: true });
  } catch (error) {
    console.error('Permission check error:', error);
    return c.json({
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    }, 500);
  }
});

export { identity };
