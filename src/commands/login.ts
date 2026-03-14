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
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandOptions } from '../types/index.js';
import { AuthError } from '../errors/index.js';
import { createCredentialStore } from '../utils/credentials.js';
import { createIdentityStore } from '../utils/identity-store.js';
import { resolveIdentityFromKey } from '../auth/identity-resolver.js';
import { isInternalEmail } from '../auth/internal-allowlist.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface LoginCommandInput {
  noBrowser?: boolean;
  apiKey?: string;
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

  // =========================================================================
  // Fast-path: API key via --api-key flag or AGENTICS_API_KEY env var
  // =========================================================================
  const envApiKey = input.apiKey ?? process.env['AGENTICS_API_KEY'] ?? process.env['AGENTICS_INTERNAL_KEY'];
  if (envApiKey) {
    if (!envApiKey.startsWith('agentics_sk_') && !envApiKey.startsWith('agentics_internal_')) {
      throw new AuthError({
        type: 'denied',
        message: 'Invalid API key format. Keys start with "agentics_sk_" or "agentics_internal_".',
        correlationId,
      });
    }

    const envEmail = process.env['AGENTICS_EMAIL'];
    const isInternal = envApiKey.startsWith('agentics_internal_') || (envEmail != null && isInternalEmail(envEmail));
    const paymentStatus: 'paid' | 'free' | 'unknown' = isInternal ? 'paid' : 'unknown';

    // Prompt for Anthropic API key (for NL routing via `agentics ask`)
    const anthropicKeyEnv = process.env['ANTHROPIC_API_KEY'];
    let anthropicKey = anthropicKeyEnv;
    if (!anthropicKey && process.stdin.isTTY) {
      anthropicKey = await promptForAnthropicKey() || undefined;
    }

    await credentialStore.save({
      api_key: envApiKey,
      created_at: new Date().toISOString(),
      email: envEmail,
      payment_status: paymentStatus,
      ...(anthropicKey ? { anthropic_api_key: anthropicKey } : {}),
    });

    // Cache identity
    try {
      const identityStore = createIdentityStore();
      const identityContext = resolveIdentityFromKey(envApiKey, envEmail);
      await identityStore.save(identityContext);
    } catch {
      // Non-fatal
    }

    const credentialsPath = (credentialStore as { getCredentialsPath?: () => string }).getCredentialsPath?.() ?? '~/.agentics/credentials.json';

    console.log('');
    console.log('Authentication successful!');
    if (envEmail) {
      console.log(`  Logged in as: ${envEmail}`);
    }
    if (isInternal) {
      console.log('  Access tier:  internal (no payment required)');
    }
    console.log(`  Credentials stored at: ${credentialsPath}`);

    // Set up Claude Code integration (MCP, statusline, hooks)
    await installClaudeCodeIntegration(options.verbose ?? false);

    console.log('');

    return { success: true, message: 'Authentication successful', credentialsPath };
  }

  // =========================================================================
  // Standard browser-based login flow
  // =========================================================================

  // Step 1: Create auth session on the platform
  console.log('');
  console.log('Initiating authentication...');

  let session: DeviceAuthSession | null = null;
  let deviceFlowFailed = false;
  try {
    session = await createAuthSession(correlationId, options);
  } catch (error) {
    // Device flow failed (platform may be unreachable or returning 403).
    // Fall back to direct API key entry so users can still authenticate.
    deviceFlowFailed = true;
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    if (options.verbose) {
      console.error(`Device flow failed: ${errMsg}`);
    }
    console.log('');
    console.log('Could not reach the authentication server.');
    console.log('Falling back to direct API key login.');
    console.log('');
    console.log('To get your API key:');
    console.log(`  1. Go to ${PLATFORM_URL} in your browser`);
    console.log('  2. Sign in or create an account');
    console.log('  3. Copy your API key from the dashboard');
    console.log('');
  }

  // Step 2: Open browser to verification URL (if device flow succeeded)
  if (session) {
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
  }

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

  if (session && !deviceFlowFailed) {
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
  }

  // Step 4b: Check internal allowlist — override payment status for approved emails
  if (email && isInternalEmail(email)) {
    paymentStatus = 'paid';
    if (options.verbose) {
      console.error(`Internal email detected: ${email}`);
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

  // Step 6: Prompt for Anthropic API key (for NL routing via `agentics ask`)
  const anthropicKey = await promptForAnthropicKey();

  // Step 7: Store credentials
  await credentialStore.save({
    api_key: apiKey,
    created_at: new Date().toISOString(),
    email,
    user_id: userId,
    payment_status: paymentStatus,
    ...(anthropicKey ? { anthropic_api_key: anthropicKey } : {}),
  });

  const credentialsPath = (credentialStore as { getCredentialsPath?: () => string }).getCredentialsPath?.() ?? '~/.agentics/credentials.json';

  // Step 8: Resolve and cache identity (deterministic from API key)
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
  if (email && isInternalEmail(email)) {
    console.log('  Access tier:  internal (no payment required)');
  }
  if (identityUserId) {
    console.log(`  User ID:      ${identityUserId}`);
  }
  if (identityOrgId) {
    console.log(`  Org ID:       ${identityOrgId}`);
    console.log(`  Role:         owner`);
  }
  console.log(`  Credentials stored at: ${credentialsPath}`);

  // Set up Claude Code integration (MCP, statusline, hooks)
  await installClaudeCodeIntegration(options.verbose ?? false);

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
      'Accept': 'application/json',
      'User-Agent': `${CLI_NAME}/${CLI_VERSION}`,
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

function promptForAnthropicKey(): Promise<string> {
  return new Promise((resolve) => {
    // Skip if not interactive (piped input, CI, etc.)
    if (!process.stdin.isTTY) {
      resolve('');
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ANTHROPIC API KEY (optional)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('  If you have Claude Code installed with Claude Max, agents run');
    console.log('  locally through your Claude subscription — no API key needed.');
    console.log('  Set AGENTICS_LOCAL_AGENTS=true to enable local mode.');
    console.log('');
    console.log('  Otherwise, the `agentics ask` command forwards your Anthropic API');
    console.log('  key to cloud agents for LLM-powered analysis. Inference is billed');
    console.log('  to your own Anthropic account, not ours.');
    console.log('  The key is stored locally in ~/.agentics/credentials.json.');
    console.log('');
    console.log('  You can also set ANTHROPIC_API_KEY as an environment variable.');
    console.log('  Press Enter to skip (you can add it later by re-running login).');
    console.log('');

    rl.question('  Anthropic API key (sk-ant-...): ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed && !trimmed.startsWith('sk-ant-')) {
        console.error('  Warning: Key does not start with "sk-ant-". Skipping.');
        resolve('');
        return;
      }
      resolve(trimmed);
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

/**
 * Full Claude Code integration setup after successful login.
 * Registers MCP server, installs statusline, hooks, and session tracking.
 */
async function installClaudeCodeIntegration(verbose: boolean): Promise<void> {
  console.log('');
  console.log('Setting up Claude Code integration...');

  // Step 1: Register MCP server (makes agentics tools available to Claude Code)
  await registerMcpServer(verbose);

  // Step 2: Install statusline + hooks into .claude/settings.json
  installSettingsJson(verbose);

  // Step 3: Initialize session tracking
  initSessionTracking(verbose);
}

/**
 * Register agentics as an MCP server with Claude Code.
 * Uses `claude mcp add` at user scope so it's available in all projects.
 */
async function registerMcpServer(verbose: boolean): Promise<void> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    // Check if claude CLI is available
    try {
      await execAsync('claude --version', { timeout: 5000 });
    } catch {
      if (verbose) {
        console.error('  Claude Code CLI not found — skipping MCP registration.');
        console.error('  Install Claude Code and run: claude mcp add agentics -s user -- npx agentics');
      }
      console.log('  ⚠ Claude Code CLI not detected. To register manually:');
      console.log('    claude mcp add agentics -s user -- npx agentics');
      return;
    }

    // Check if already registered
    try {
      const { stdout } = await execAsync('claude mcp list 2>&1', { timeout: 10000 });
      if (stdout.includes('agentics')) {
        if (verbose) {
          console.error('  MCP server "agentics" already registered.');
        }
        console.log('  ✓ MCP server already registered');
        return;
      }
    } catch {
      // List failed — try to register anyway
    }

    // Register at user scope so it works across all projects
    await execAsync('claude mcp add agentics -s user -- npx agentics', { timeout: 15000 });
    console.log('  ✓ MCP server registered (claude mcp add agentics)');
  } catch (err) {
    // Non-fatal
    if (verbose) {
      console.error(`  Could not register MCP server: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    console.log('  ⚠ Could not auto-register MCP server. Run manually:');
    console.log('    claude mcp add agentics -s user -- npx agentics');
  }
}

/**
 * Install statusline and hooks into .claude/settings.json (project-level).
 */
function installSettingsJson(verbose: boolean): void {
  const settingsPath = path.join(process.cwd(), '.claude', 'settings.json');
  const settingsDir = path.dirname(settingsPath);

  try {
    // Ensure .claude directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Load existing settings or start fresh
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        if (verbose) {
          console.error('  Warning: existing .claude/settings.json was invalid, preserving as backup.');
        }
        // Back up corrupted file
        try {
          fs.renameSync(settingsPath, settingsPath + '.bak');
        } catch { /* ignore */ }
      }
    }

    let changed = false;

    // Inject statusLine if not present
    if (!settings['statusLine']) {
      settings['statusLine'] = {
        type: 'command',
        command: 'npx agentics statusline 2>/dev/null || echo "◇ Agentics.dev"',
        refreshMs: 5000,
        enabled: true,
      };
      changed = true;
    }

    // Inject hooks if not present
    if (!settings['hooks']) {
      settings['hooks'] = buildDefaultHooks();
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log('  ✓ Claude Code statusline + hooks installed (.claude/settings.json)');
    } else if (verbose) {
      console.log('  Claude Code settings already configured.');
    }
  } catch (err) {
    if (verbose) {
      console.error(`  Could not install settings: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}

/**
 * Build the default hooks configuration for Claude Code integration.
 * Tracks prompts, edits, commands, and agent spawns for the statusline.
 */
function buildDefaultHooks(): Record<string, unknown[]> {
  const sessionCounterCmd = (field: string) =>
    `if [ -f ~/.agentics/session.json ]; then TMP=$(mktemp) && jq '.${field} += 1' ~/.agentics/session.json > "$TMP" 2>/dev/null && mv "$TMP" ~/.agentics/session.json; fi`;

  return {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: `mkdir -p ~/.agentics/agents ~/.agentics/calls && rm -f ~/.agentics/agents/*.json ~/.agentics/calls/*.json && printf '{"started_at":"%s","edits":0,"commands":0,"prompts":0,"agents_spawned":0}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ~/.agentics/session.json`,
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command',
            command: sessionCounterCmd('prompts'),
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [
          {
            type: 'command',
            command: sessionCounterCmd('edits'),
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
      {
        matcher: '^Bash$',
        hooks: [
          {
            type: 'command',
            command: sessionCounterCmd('commands'),
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
      {
        matcher: '^Task$',
        hooks: [
          {
            type: 'command',
            command: `mkdir -p ~/.agentics/agents && HASH=$(printf '%s' "\${TOOL_INPUT_prompt:-noid}" | cksum | cut -d' ' -f1) && printf '{"type":"%s","started_at":"%s"}' "\${TOOL_INPUT_subagent_type:-agent}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ~/.agentics/agents/\${HASH}.json; ${sessionCounterCmd('agents_spawned')}`,
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '^Task$',
        hooks: [
          {
            type: 'command',
            command: `HASH=$(printf '%s' "\${TOOL_INPUT_prompt:-noid}" | cksum | cut -d' ' -f1) && rm -f ~/.agentics/agents/\${HASH}.json`,
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: `rm -f ~/.agentics/agents/*.json ~/.agentics/calls/*.json ~/.agentics/session.json 2>/dev/null; echo '{"ok": true}'`,
            timeout: 1000,
          },
        ],
      },
    ],
  };
}

/**
 * Initialize session tracking directory and files.
 */
function initSessionTracking(verbose: boolean): void {
  const agenticsDir = path.join(process.env['HOME'] ?? '~', '.agentics');
  try {
    fs.mkdirSync(path.join(agenticsDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(agenticsDir, 'calls'), { recursive: true });

    // Create initial session file if not present
    const sessionFile = path.join(agenticsDir, 'session.json');
    if (!fs.existsSync(sessionFile)) {
      fs.writeFileSync(sessionFile, JSON.stringify({
        started_at: new Date().toISOString(),
        edits: 0,
        commands: 0,
        prompts: 0,
        agents_spawned: 0,
      }));
    }
    if (verbose) {
      console.log('  Session tracking initialized.');
    }
  } catch {
    // Non-fatal
  }
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
