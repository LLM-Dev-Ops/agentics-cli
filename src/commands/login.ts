/**
 * Login Command (agentics login)
 *
 * SPARC Architecture Reference: CLI Authentication
 *
 * PURPOSE: Initiate CLI authentication using OAuth Device Flow
 *
 * WORKFLOW:
 * 1. Call API to create auth session (code stored in DB)
 * 2. Display verification URL and open in browser
 * 3. Poll API for completion
 * 4. API returns API key automatically when user approves
 * 5. Securely store API key locally
 *
 * FORBIDDEN:
 * - Storing credentials in plaintext in code
 * - Logging credential values
 * - Bypassing the authorization flow
 */

import type { CommandOptions } from '../types/index.js';
import { AuthError } from '../errors/index.js';
import { createCredentialStore } from '../utils/credentials.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface LoginCommandInput {
  noBrowser?: boolean;
}

export interface LoginCommandResult {
  success: boolean;
  message: string;
  credentialsPath?: string;
}

interface DeviceAuthSession {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  status: 'pending' | 'completed' | 'expired' | 'denied';
  api_key?: string;
  error?: string;
}

// ============================================================================
// Configuration
// ============================================================================

import { isLocalhostUrl, isLocalDevMode, LocalhostInProductionError } from '../config/endpoints.js';

// Platform URL for authentication - uses AGENTICS_PLATFORM_URL for consistency with docs
const PLATFORM_URL = process.env['AGENTICS_PLATFORM_URL'] ?? 'https://platform.agentics.dev';
const CLI_NAME = 'Agentics CLI';
const CLI_VERSION = '1.4.5';
const DEFAULT_POLL_INTERVAL = 5000; // 5 seconds

/**
 * Validate platform URL - apply same localhost safeguard as other endpoints
 */
function validatePlatformUrl(): void {
  if (isLocalhostUrl(PLATFORM_URL) && !isLocalDevMode()) {
    throw new LocalhostInProductionError('agentics-platform', PLATFORM_URL);
  }
}
const MAX_POLL_ATTEMPTS = 60; // 5 minutes max (60 * 5s)

// ============================================================================
// Login Command Implementation
// ============================================================================

export async function executeLoginCommand(
  input: LoginCommandInput,
  options: CommandOptions
): Promise<LoginCommandResult> {
  // Validate platform URL - fail fast if localhost without local dev mode
  validatePlatformUrl();

  const correlationId = options.trace_id ?? crypto.randomUUID();
  const credentialStore = createCredentialStore();

  // Check if already authenticated
  const existingCredentials = await credentialStore.load();
  if (existingCredentials) {
    if (options.verbose) {
      console.error('Existing credentials found. Re-authenticating...');
    }
  }

  // Step 1: Call API to create auth session
  console.log('');
  console.log('Initiating authentication...');

  let session: DeviceAuthSession;
  try {
    session = await createAuthSession(correlationId, options);
  } catch (error) {
    throw new AuthError({
      type: 'network',
      message: `Failed to initiate authentication: ${error instanceof Error ? error.message : 'Unknown error'}`,
      correlationId,
    });
  }

  // Step 2: Display verification URL and user code
  console.log('');
  console.log('To authenticate, open this URL in your browser:');
  console.log('');
  console.log(`  ${session.verification_url}`);
  console.log('');
  console.log(`Your verification code: ${session.user_code}`);
  console.log('');

  // Step 3: Optionally open URL in browser
  if (!input.noBrowser) {
    await openBrowser(session.verification_url, options);
    console.log('(Browser opened automatically)');
    console.log('');
  }

  console.log('Waiting for authorization...');
  if (options.verbose) {
    console.error(`Session expires in ${session.expires_in} seconds`);
  }

  // Step 4: Poll for completion
  const pollInterval = (session.interval ?? DEFAULT_POLL_INTERVAL / 1000) * 1000;
  let apiKey: string | undefined;

  try {
    apiKey = await pollForCompletion(session.device_code, pollInterval, correlationId, options);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError({
      type: 'network',
      message: `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      correlationId,
    });
  }

  if (!apiKey) {
    throw new AuthError({
      type: 'expired',
      message: 'Authentication session expired. Please try again.',
      correlationId,
    });
  }

  // Step 5: Store credentials securely (include email if available)
  const userEmail = process.env['AGENTICS_USER_EMAIL'];
  await credentialStore.save({
    api_key: apiKey,
    created_at: new Date().toISOString(),
    email: userEmail,
  });

  const credentialsPath = (credentialStore as { getCredentialsPath?: () => string }).getCredentialsPath?.() ?? '~/.agentics/credentials.json';

  console.log('');
  console.log('✓ Authentication successful!');
  console.log(`  API key stored at: ${credentialsPath}`);

  return {
    success: true,
    message: 'Authentication successful',
    credentialsPath,
  };
}

// ============================================================================
// API Functions
// ============================================================================

async function createAuthSession(
  correlationId: string,
  options: CommandOptions
): Promise<DeviceAuthSession> {
  const response = await fetch(`${PLATFORM_URL}/v1/cli/auth/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-ID': correlationId,
    },
    body: JSON.stringify({
      cli_name: CLI_NAME,
      cli_version: CLI_VERSION,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json() as DeviceAuthSession;

  if (options.verbose) {
    console.error(`Session created: device_code=${data.device_code}`);
  }

  return data;
}

async function pollForCompletion(
  deviceCode: string,
  intervalMs: number,
  correlationId: string,
  options: CommandOptions
): Promise<string | undefined> {
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    await sleep(intervalMs);
    attempts++;

    if (options.verbose) {
      console.error(`Polling attempt ${attempts}/${MAX_POLL_ATTEMPTS}...`);
    }

    try {
      const response = await fetch(`${PLATFORM_URL}/v1/cli/auth/sessions/${deviceCode}`, {
        headers: {
          'X-Correlation-ID': correlationId,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new AuthError({
            type: 'expired',
            message: 'Session not found or expired.',
            correlationId,
          });
        }
        continue; // Retry on other errors
      }

      const result = await response.json() as PollResponse;

      switch (result.status) {
        case 'completed':
          return result.api_key;

        case 'denied':
          throw new AuthError({
            type: 'denied',
            message: 'Authorization was denied by the user.',
            correlationId,
          });

        case 'expired':
          throw new AuthError({
            type: 'expired',
            message: 'Authentication session expired.',
            correlationId,
          });

        case 'pending':
          // Show progress indicator
          process.stdout.write('.');
          break;
      }
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      // Network error, continue polling
      if (options.verbose) {
        console.error(`Poll error: ${error instanceof Error ? error.message : 'Unknown'}`);
      }
    }
  }

  return undefined;
}

// ============================================================================
// Helper Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openBrowser(url: string, options: CommandOptions): Promise<void> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const platform = process.platform;
    let command: string;

    if (platform === 'darwin') {
      command = `open "${url}"`;
    } else if (platform === 'win32') {
      command = `start "" "${url}"`;
    } else {
      // Linux and others
      command = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null`;
    }

    await execAsync(command);

    if (options.verbose) {
      console.error('Opened browser for authentication');
    }
  } catch {
    // Browser opening failed, user can manually navigate
    if (options.verbose) {
      console.error('Could not open browser automatically. Please navigate to the URL manually.');
    }
  }
}
