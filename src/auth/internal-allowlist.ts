/**
 * Internal Email Allowlist
 *
 * Determines if an email address belongs to an approved internal user.
 * Internal users get `payment_status: 'paid'` automatically — no payment required.
 *
 * Resolution order:
 *   1. ~/.agentics/internal-allowlist.json  (file-based, operator-managed)
 *   2. AGENTICS_INTERNAL_EMAILS env var     (comma-separated emails)
 *   3. AGENTICS_INTERNAL_DOMAINS env var    (comma-separated domains)
 *
 * File format (~/.agentics/internal-allowlist.json):
 *   {
 *     "emails": ["nick@company.com", "dev@company.com"],
 *     "domains": ["company.com", "internal.dev"]
 *   }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

interface AllowlistConfig {
  emails?: string[];
  domains?: string[];
}

const ALLOWLIST_PATH = path.join(os.homedir(), '.agentics', 'internal-allowlist.json');

/**
 * Load the allowlist from file + env vars.
 */
function loadAllowlist(): AllowlistConfig {
  const emails = new Set<string>();
  const domains = new Set<string>();

  // Source 1: File
  try {
    const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
    const config = JSON.parse(raw) as AllowlistConfig;
    if (Array.isArray(config.emails)) {
      for (const e of config.emails) emails.add(e.toLowerCase().trim());
    }
    if (Array.isArray(config.domains)) {
      for (const d of config.domains) domains.add(d.toLowerCase().trim());
    }
  } catch {
    // File doesn't exist or is invalid — that's fine
  }

  // Source 2: AGENTICS_INTERNAL_EMAILS env var
  const envEmails = process.env['AGENTICS_INTERNAL_EMAILS'];
  if (envEmails) {
    for (const e of envEmails.split(',')) {
      const trimmed = e.toLowerCase().trim();
      if (trimmed) emails.add(trimmed);
    }
  }

  // Source 3: AGENTICS_INTERNAL_DOMAINS env var
  const envDomains = process.env['AGENTICS_INTERNAL_DOMAINS'];
  if (envDomains) {
    for (const d of envDomains.split(',')) {
      const trimmed = d.toLowerCase().trim();
      if (trimmed) domains.add(trimmed);
    }
  }

  return {
    emails: [...emails],
    domains: [...domains],
  };
}

/**
 * Check if an email is on the internal allowlist.
 */
export function isInternalEmail(email: string): boolean {
  if (!email) return false;

  const normalized = email.toLowerCase().trim();
  const allowlist = loadAllowlist();

  // Exact email match
  if (allowlist.emails?.includes(normalized)) {
    return true;
  }

  // Domain match
  const domain = normalized.split('@')[1];
  if (domain && allowlist.domains?.includes(domain)) {
    return true;
  }

  return false;
}

/**
 * Initialize the allowlist file with the given emails/domains.
 * Creates ~/.agentics/ if needed.
 */
export function initAllowlist(emails: string[], domains: string[]): string {
  const dir = path.dirname(ALLOWLIST_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const config: AllowlistConfig = {
    emails: emails.map(e => e.toLowerCase().trim()),
    domains: domains.map(d => d.toLowerCase().trim()),
  };

  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  return ALLOWLIST_PATH;
}
