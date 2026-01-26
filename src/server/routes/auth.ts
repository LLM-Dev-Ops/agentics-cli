/**
 * Auth Route Handler
 *
 * POST /v1/cli/auth/sessions - Create OAuth device flow session
 * GET /v1/cli/auth/sessions/:device_code - Poll for auth completion
 *
 * OAuth device flow authentication endpoints for CLI login.
 */

import { Hono } from 'hono';

const auth = new Hono();

// In-memory session store (for stub implementation)
const sessions = new Map<string, {
  session_id: string;
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_at: string;
  interval: number;
  status: 'pending' | 'authorized' | 'expired' | 'denied';
  api_key?: string;
  email?: string;
  user_id?: string;
}>();

/**
 * Generate a random code of specified length
 */
function generateCode(length: number, charset: string = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
}

/**
 * POST /v1/cli/auth/sessions
 *
 * Create a new OAuth device flow session.
 */
auth.post('/sessions', async (c) => {
  try {
    const deviceCode = generateCode(32, 'abcdef0123456789');
    const userCode = generateCode(8); // 8-char code to match API format
    const sessionId = `sess-${generateCode(16, 'abcdef0123456789')}`;

    const session = {
      session_id: sessionId,
      device_code: deviceCode,
      user_code: userCode,
      verification_url: `https://platform.agentics.dev/auth/device?code=${userCode}`,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
      interval: 5,
      status: 'pending' as const,
    };

    sessions.set(deviceCode, session);

    // Auto-authorize after 3 seconds for testing (only in non-production)
    if (process.env.NODE_ENV !== 'production') {
      setTimeout(() => {
        const s = sessions.get(deviceCode);
        if (s && s.status === 'pending') {
          s.status = 'authorized';
          s.api_key = `agentics_sk_cli_${generateCode(64, 'abcdef0123456789')}`;
          // Use test email or env var for local testing
          s.email = process.env['AGENTICS_TEST_EMAIL'] ?? 'test@agentics.dev';
          s.user_id = `user-${generateCode(16, 'abcdef0123456789')}`;
        }
      }, 3000);
    }

    return c.json({
      session_id: session.session_id,
      verification_url: session.verification_url,
      user_code: session.user_code,
      expires_at: session.expires_at,
      interval: session.interval,
    }, 201);
  } catch (error) {
    console.error('Auth sessions POST error:', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      500
    );
  }
});

/**
 * POST /v1/cli/auth/sessions/:device_code/authorize
 *
 * Authorize a session (called by web UI after OAuth completion).
 * In production, this would be called by the platform after the user
 * completes OAuth authentication in the browser.
 */
auth.post('/sessions/:device_code/authorize', async (c) => {
  try {
    const deviceCode = c.req.param('device_code');
    const body = await c.req.json() as { email?: string; user_id?: string };

    const session = sessions.get(deviceCode);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);
    }

    if (session.status !== 'pending') {
      return c.json({ error: { code: 'INVALID_STATE', message: 'Session already processed' } }, 400);
    }

    // Authorize the session with user info
    session.status = 'authorized';
    session.api_key = `agentics_sk_cli_${generateCode(64, 'abcdef0123456789')}`;
    session.email = body.email;
    session.user_id = body.user_id;

    return c.json({ status: 'authorized', message: 'Session authorized successfully' });
  } catch (error) {
    console.error('Auth authorize error:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Authorization failed' } }, 500);
  }
});

/**
 * GET /v1/cli/auth/sessions/:device_code
 *
 * Poll for authentication status.
 */
auth.get('/sessions/:device_code', async (c) => {
  try {
    const deviceCode = c.req.param('device_code');
    const session = sessions.get(deviceCode);

    if (!session) {
      return c.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Session not found',
          },
        },
        404
      );
    }

    // Check if expired
    if (new Date(session.expires_at) < new Date()) {
      session.status = 'expired';
    }

    if (session.status === 'authorized' && session.api_key) {
      return c.json({
        status: session.status,
        api_key: session.api_key,
        email: session.email,
        user_id: session.user_id,
      });
    }

    return c.json({
      status: session.status,
    });
  } catch (error) {
    console.error('Auth sessions GET error:', error);
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      500
    );
  }
});

export { auth };
