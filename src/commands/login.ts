/**
 * Login Command (agentics login)
 *
 * SPARC Architecture Reference: CLI Authentication
 *
 * PURPOSE: Authenticate the CLI via browser-based auth with API key paste-back.
 *
 * WORKFLOW:
 * 1. Create auth session on the platform backend
 * 2. Open browser to the verification URL where user authenticates
 * 3. Browser shows a copyable API key after authentication
 * 4. CLI prompts user to paste the API key
 * 5. CLI polls the session to resolve the user's email and payment status
 * 6. CLI presents terms and conditions for acceptance
 * 7. Store credentials locally
 *
 * FORBIDDEN:
 * - Storing credentials in plaintext in code
 * - Logging credential values
 * - Bypassing the authorization flow
 */

import * as readline from 'node:readline';
import type { CommandOptions } from '../types/index.js';
import { AuthError } from '../errors/index.js';
import { createCredentialStore } from '../utils/credentials.js';
import { createIdentityStore } from '../utils/identity-store.js';
import { resolveIdentityFromKey } from '../auth/identity-resolver.js';

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
  session_code?: string;
  verification_url: string;
  expires_in: number;
  expires_in_seconds?: number;
  interval: number;
  poll_interval_seconds?: number;
}

interface PollResponse {
  status: 'pending' | 'completed' | 'expired' | 'denied';
  api_key?: string;
  email?: string;
  user_id?: string;
  payment_status?: 'paid' | 'free' | 'unknown';
  error?: string;
}

// ============================================================================
// Configuration
// ============================================================================

import { isLocalhostUrl, isLocalDevMode, LocalhostInProductionError } from '../config/endpoints.js';

const PLATFORM_URL = process.env['AGENTICS_PLATFORM_URL'] ?? 'https://platform.agentics.dev';
const CLI_NAME = 'Agentics CLI';
const CLI_VERSION = '1.4.5';

function validatePlatformUrl(): void {
  if (isLocalhostUrl(PLATFORM_URL) && !isLocalDevMode()) {
    throw new LocalhostInProductionError('agentics-platform', PLATFORM_URL);
  }
}

// ============================================================================
// Terms and Conditions
// ============================================================================

const TERMS_AND_CONDITIONS = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AGENTICS PLATFORM - TERMS OF SERVICE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  By using the Agentics CLI and platform services, you agree to:

  1. ACCEPTABLE USE
     You will use the platform only for lawful purposes and in
     accordance with the Agentics Acceptable Use Policy.

  2. API KEY SECURITY
     You are responsible for keeping your API key secure. Do not
     share your key or commit it to version control.

  3. DATA HANDLING
     The platform processes data you submit for simulation,
     planning, and deployment operations. You retain ownership
     of your data.

  4. SERVICE AVAILABILITY
     The platform is provided "as is". Agentics makes no
     guarantees of uptime or availability.

  5. USAGE LIMITS
     Your account is subject to usage limits based on your plan.
     Exceeding limits may result in throttling or suspension.

  Full terms: https://agentics.dev/terms
  Privacy policy: https://agentics.dev/privacy

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

// ============================================================================
// Login Command Implementation
// ============================================================================

export async function executeLoginCommand(
  input: LoginCommandInput,
  options: CommandOptions
): Promise<LoginCommandResult> {
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

  // Step 1: Create auth session on the platform
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

  // Step 2: Open browser to verification URL
  console.log('');
  console.log('Open this URL in your browser to authenticate:');
  console.log('');
  console.log(`  ${session.verification_url}`);
  console.log('');

  if (!input.noBrowser) {
    await openBrowser(session.verification_url, options);
    console.log('(Browser opened automatically)');
    console.log('');
  }

  console.log('After authenticating, copy the API key shown in your browser.');
  console.log('');

  // Step 3: Prompt user to paste API key
  const apiKey = await promptForApiKey();

  if (!apiKey) {
    throw new AuthError({
      type: 'denied',
      message: 'No API key provided. Authentication cancelled.',
      correlationId,
    });
  }

  // Validate key format
  if (!apiKey.startsWith('agentics_sk_')) {
    throw new AuthError({
      type: 'denied',
      message: 'Invalid API key format. Keys start with "agentics_sk_". Please try again.',
      correlationId,
    });
  }

  console.log('');
  console.log('Verifying...');

  // Step 4: Poll session to resolve email and payment status
  let email: string | undefined;
  let userId: string | undefined;
  let paymentStatus: 'paid' | 'free' | 'unknown' = 'unknown';

  try {
    const sessionData = await fetchSessionData(session.device_code, correlationId);
    if (sessionData) {
      email = sessionData.email;
      userId = sessionData.user_id;
      paymentStatus = sessionData.payment_status ?? 'unknown';
    }
  } catch {
    // Session data fetch failed — proceed with key only.
    // The key itself is the proof of authentication.
    if (options.verbose) {
      console.error('Could not fetch session metadata. Proceeding with API key only.');
    }
  }

  // Step 5: Show terms and conditions
  console.log('');
  console.log(TERMS_AND_CONDITIONS);
  console.log('');

  const accepted = await promptForTermsAcceptance();

  if (!accepted) {
    throw new AuthError({
      type: 'denied',
      message: 'You must accept the terms of service to use the Agentics CLI.',
      correlationId,
    });
  }

  // Step 6: Store credentials
  await credentialStore.save({
    api_key: apiKey,
    created_at: new Date().toISOString(),
    email,
    user_id: userId,
    payment_status: paymentStatus,
  });

  const credentialsPath = (credentialStore as { getCredentialsPath?: () => string }).getCredentialsPath?.() ?? '~/.agentics/credentials.json';

  // Step 7: Resolve and cache identity (deterministic from API key)
  let identityUserId: string | undefined;
  let identityOrgId: string | undefined;
  try {
    const identityStore = createIdentityStore();
    const identityContext = resolveIdentityFromKey(apiKey, email);
    await identityStore.save(identityContext);
    identityUserId = identityContext.user.user_id;
    identityOrgId = identityContext.org.org_id;
  } catch {
    // Identity caching failed — non-fatal
    if (options.verbose) {
      console.error('Could not cache identity. Continuing with credentials only.');
    }
  }

  console.log('');
  console.log('Authentication successful!');
  if (email) {
    console.log(`  Logged in as: ${email}`);
  }
  if (identityUserId) {
    console.log(`  User ID:      ${identityUserId}`);
  }
  if (identityOrgId) {
    console.log(`  Org ID:       ${identityOrgId}`);
    console.log(`  Role:         owner`);
  }
  console.log(`  Credentials stored at: ${credentialsPath}`);
  console.log('');

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

/**
 * Fetch session data once to resolve email and payment status.
 * The session should be completed by the time the user has their API key.
 */
async function fetchSessionData(
  deviceCode: string,
  correlationId: string,
): Promise<PollResponse | null> {
  // Try a few times since there may be a brief delay between the user
  // copying the key and the session being marked complete
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${PLATFORM_URL}/v1/cli/auth/sessions/${deviceCode}`, {
        headers: {
          'X-Correlation-ID': correlationId,
        },
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json() as PollResponse;

      if (result.status === 'completed') {
        return result;
      }

      // Brief wait between attempts
      await sleep(1000);
    } catch {
      return null;
    }
  }

  return null;
}

// ============================================================================
// Interactive Prompts
// ============================================================================

function promptForApiKey(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.question('Paste your API key: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptForTermsAcceptance(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.question('Do you accept the terms of service? (yes/no): ', (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'yes' || normalized === 'y');
    });
  });
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
      command = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || x-www-browser "${url}" 2>/dev/null`;
    }

    await execAsync(command);

    if (options.verbose) {
      console.error('Opened browser for authentication');
    }
  } catch {
    if (options.verbose) {
      console.error('Could not open browser automatically. Please navigate to the URL manually.');
    }
  }
}
