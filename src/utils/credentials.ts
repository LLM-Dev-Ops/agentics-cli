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

    // Write credentials with restricted permissions
    const content = JSON.stringify(credentials, null, 2);
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
