/**
 * Identity Store
 *
 * Securely store and retrieve cached identity context locally.
 *
 * STORAGE LOCATION:
 * - ~/.agentics/identity.json (Unix/macOS)
 * - %USERPROFILE%\.agentics\identity.json (Windows)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IdentityContext } from '../types/index.js';

// ============================================================================
// Interface Definition
// ============================================================================

export interface IIdentityStore {
  save(identity: IdentityContext): Promise<void>;
  load(): Promise<IdentityContext | null>;
  delete(): Promise<void>;
  exists(): Promise<boolean>;
  isStale(maxAgeMs?: number): Promise<boolean>;
}

// ============================================================================
// Configuration
// ============================================================================

const AGENTICS_CONFIG_DIR = '.agentics';
const IDENTITY_FILE = 'identity.json';
const DEFAULT_MAX_AGE_MS = 3600000; // 1 hour

// ============================================================================
// Identity Store Implementation
// ============================================================================

export class IdentityStore implements IIdentityStore {
  private readonly configDir: string;
  private readonly identityPath: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? path.join(os.homedir(), AGENTICS_CONFIG_DIR);
    this.identityPath = path.join(this.configDir, IDENTITY_FILE);
  }

  async save(identity: IdentityContext): Promise<void> {
    await this.ensureConfigDir();

    const content = JSON.stringify(identity, null, 2);
    await fs.promises.writeFile(this.identityPath, content, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  async load(): Promise<IdentityContext | null> {
    try {
      const content = await fs.promises.readFile(this.identityPath, 'utf-8');
      const identity = JSON.parse(content) as IdentityContext;

      if (!identity.user?.user_id || !identity.org?.org_id || !identity.role) {
        return null;
      }

      return identity;
    } catch {
      return null;
    }
  }

  async delete(): Promise<void> {
    try {
      await fs.promises.unlink(this.identityPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.identityPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async isStale(maxAgeMs?: number): Promise<boolean> {
    const identity = await this.load();
    if (!identity?.resolved_at) {
      return true;
    }

    const resolvedAt = new Date(identity.resolved_at).getTime();
    const age = Date.now() - resolvedAt;
    return age > (maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  }

  getIdentityPath(): string {
    return this.identityPath;
  }

  private async ensureConfigDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.configDir, {
        recursive: true,
        mode: 0o700,
      });
    } catch {
      // Directory may already exist
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createIdentityStore(configDir?: string): IIdentityStore {
  return new IdentityStore(configDir);
}
