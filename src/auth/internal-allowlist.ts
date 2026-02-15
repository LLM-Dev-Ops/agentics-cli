/**
 * Internal Email Allowlist — Deprecated (Platform-Side)
 *
 * ARCHITECTURE:
 *   Internal user classification is now a platform-side concern.
 *   The CLI does NOT maintain email allowlists or determine who is "internal".
 *   When the user authenticates, the platform resolves their entitlement.
 *
 * REMOVED (moved to platform):
 *   - File-based allowlist (~/.agentics/internal-allowlist.json)
 *   - AGENTICS_INTERNAL_EMAILS env var processing
 *   - AGENTICS_INTERNAL_DOMAINS env var processing
 *   - isInternalEmail() local classification
 *
 * WHAT REMAINS:
 *   - Deprecated stubs for backward compatibility
 */

/**
 * @deprecated Internal email classification is now platform-side.
 * The CLI does not determine who is "internal" — the platform does.
 * Always returns false; the platform resolves entitlement on auth.
 */
export function isInternalEmail(_email: string): boolean {
  return false;
}

/**
 * @deprecated Allowlist management is now platform-side.
 * Returns empty string — no local file is written.
 */
export function initAllowlist(_emails: string[], _domains: string[]): string {
  return '';
}
