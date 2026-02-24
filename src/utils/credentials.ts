/**
 * Credential Storage Utility
 *
 * SPARC Architecture Reference: Authentication Module
 *
 * PURPOSE: Securely store and retrieve API credentials locally
 *
 * STORAGE LOCATION:
 * - ~/.agentics/credentials.json (Unix/macOS)
 * - %USERPROFILE%\.agentics\credentials.json (Windows)
 *
 * FORBIDDEN:
 * - Storing credentials in plaintext in code
 * - Logging credential values
 * - Transmitting credentials to unauthorized endpoints
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuthCredentials } from '../types/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface ICredentialStore {
  save(credentials: AuthCredentials): Promise<void>;
  load(): Promise<AuthCredentials | null>;
  delete(): Promise<void>;
  exists(): Promise<boolean>;
}

// ============================================================================
// Configuration
// ============================================================================

const AGENTICS_CONFIG_DIR = '.agentics';
const CREDENTIALS_FILE = 'credentials.json';

// ============================================================================
// Credential Store Implementation
// ============================================================================

export class CredentialStore implements ICredentialStore {
  private readonly configDir: string;
  private readonly credentialsPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? path.join(os.homedir(), AGENTICS_CONFIG_DIR);
    this.credentialsPath = path.join(this.configDir, CREDENTIALS_FILE);
  }

  async save(credentials: AuthCredentials): Promise<void> {
    // Ensure config directory exists
    await this.ensureConfigDir();

    // Merge with existing credentials to preserve fields like anthropic_api_key
    // across re-login calls
    let merged = { ...credentials };
    try {
      const existing = await this.load();
      if (existing) {
        // Preserve existing fields not present in the new credentials
        merged = { ...existing, ...credentials };
        // If the new credentials don't include an anthropic_api_key but the
        // existing ones do, keep the existing value
        if (!credentials.anthropic_api_key && existing.anthropic_api_key) {
          merged.anthropic_api_key = existing.anthropic_api_key;
        }
      }
    } catch {
      // No existing credentials to merge with
    }

    // Write credentials with restricted permissions
    const content = JSON.stringify(merged, null, 2);
    await fs.promises.writeFile(this.credentialsPath, content, {
      encoding: 'utf-8',
      mode: 0o600, // Owner read/write only
    });
  }

  async load(): Promise<AuthCredentials | null> {
    try {
      const content = await fs.promises.readFile(this.credentialsPath, 'utf-8');
      const credentials = JSON.parse(content) as AuthCredentials;

      // Validate basic structure
      if (!credentials.api_key || typeof credentials.api_key !== 'string') {
        return null;
      }

      // Check expiration if set
      if (credentials.expires_at) {
        const expiresAt = new Date(credentials.expires_at);
        if (expiresAt <= new Date()) {
          return null;
        }
      }

      return credentials;
    } catch {
      return null;
    }
  }

  async delete(): Promise<void> {
    try {
      await fs.promises.unlink(this.credentialsPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.credentialsPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureConfigDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.configDir, {
        recursive: true,
        mode: 0o700, // Owner read/write/execute only
      });
    } catch {
      // Directory may already exist
    }
  }

  getCredentialsPath(): string {
    return this.credentialsPath;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createCredentialStore(configDir?: string): ICredentialStore {
  return new CredentialStore(configDir);
}

// ============================================================================
// Anthropic API Key Resolution
// ============================================================================

/**
 * Resolve the Anthropic API key from (in priority order):
 * 1. ANTHROPIC_API_KEY environment variable
 * 2. Stored credentials (~/.agentics/credentials.json)
 *
 * Returns null if no key is available.
 */
export async function getAnthropicApiKey(): Promise<string | null> {
  // Priority 1: Environment variable
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey && envKey.startsWith('sk-ant-')) {
    return envKey;
  }

  // Priority 2: Stored credentials
  const store = createCredentialStore();
  const credentials = await store.load();
  if (credentials?.anthropic_api_key) {
    return credentials.anthropic_api_key;
  }

  return null;
}

/**
 * Get the Agentics platform API key from available sources.
 * Priority order:
 * 1. AGENTICS_API_KEY environment variable
 * 2. AGENTICS_INTERNAL_KEY environment variable
 * 3. Stored credentials (~/.agentics/credentials.json)
 *
 * Returns null if no key is available.
 */
export async function getPlatformApiKey(): Promise<string | null> {
  // Priority 1: AGENTICS_API_KEY env var
  const envKey = process.env['AGENTICS_API_KEY'];
  if (envKey && (envKey.startsWith('agentics_sk_') || envKey.startsWith('agentics_internal_'))) {
    return envKey;
  }

  // Priority 2: AGENTICS_INTERNAL_KEY env var
  const internalKey = process.env['AGENTICS_INTERNAL_KEY'];
  if (internalKey && internalKey.startsWith('agentics_internal_')) {
    return internalKey;
  }

  // Priority 3: Stored credentials
  const store = createCredentialStore();
  const credentials = await store.load();
  if (credentials?.api_key) {
    return credentials.api_key;
  }

  return null;
}
