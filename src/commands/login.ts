/**
 * Login Command (agentics login)
 *
 * SPARC Architecture Reference: CLI Authentication
 *
 * PURPOSE: Initiate CLI authentication flow (identical to Claude Code)
 *
 * WORKFLOW:
 * 1. Generate authentication URL with session ID
 * 2. Display URL and optionally open in browser
 * 3. User authorizes in browser and receives API key
 * 4. User pastes API key into CLI prompt
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
import { createInterface } from 'node:readline';

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

// ============================================================================
// Configuration
// ============================================================================

const APP_URL = process.env['AGENTICS_APP_URL'] ?? 'https://app.agentics.dev';
const CLI_AUTH_PATH = '/cli/auth';

// ============================================================================
// Login Command Implementation
// ============================================================================

export async function executeLoginCommand(
  input: LoginCommandInput,
  options: CommandOptions
): Promise<LoginCommandResult> {
  const correlationId = options.trace_id ?? crypto.randomUUID();
  const credentialStore = createCredentialStore();

  // Check if already authenticated
  const existingCredentials = await credentialStore.load();
  if (existingCredentials) {
    if (options.verbose) {
      console.error('Existing credentials found. Re-authenticating...');
    }
  }

  // Step 1: Generate authentication URL with session ID
  const sessionId = crypto.randomUUID();
  const authUrl = `${APP_URL}${CLI_AUTH_PATH}?session=${sessionId}&cli=agentics`;

  // Step 2: Display URL
  console.log('');
  console.log('To authenticate, open this URL in your browser:');
  console.log('');
  console.log(`  ${authUrl}`);
  console.log('');

  // Step 3: Optionally open URL in browser
  if (!input.noBrowser) {
    await openBrowser(authUrl, options);
    console.log('(Browser opened automatically)');
    console.log('');
  }

  console.log('After authorizing, copy the API key shown on screen.');
  console.log('');

  // Step 4: Prompt user to paste API key
  const apiKey = await promptForApiKey();

  if (!apiKey || apiKey.trim() === '') {
    throw new AuthError({
      type: 'invalid',
      message: 'No API key provided. Authentication cancelled.',
      correlationId,
    });
  }

  // Validate API key format (basic check)
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length < 20) {
    throw new AuthError({
      type: 'invalid',
      message: 'Invalid API key format. Please try again.',
      correlationId,
    });
  }

  // Step 5: Store credentials securely
  await credentialStore.save({
    api_key: trimmedKey,
    created_at: new Date().toISOString(),
  });

  const credentialsPath = (credentialStore as { getCredentialsPath?: () => string }).getCredentialsPath?.() ?? '~/.agentics/credentials.json';

  console.log('');
  console.log('Authentication successful!');
  console.log(`API key stored at: ${credentialsPath}`);

  return {
    success: true,
    message: 'Authentication successful',
    credentialsPath,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

async function promptForApiKey(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Paste your API key: ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
